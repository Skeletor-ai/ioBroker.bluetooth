'use strict';

const EventEmitter = require('events');
const dbus = require('dbus-next');
const net = require('net');
const fs = require('fs');
const { Duplex } = require('stream');
const { Interface: DbusInterface } = dbus.interface;

/**
 * Wrap a raw file descriptor (e.g. RFCOMM Bluetooth socket) into a Duplex stream.
 * Node.js net.Socket only supports AF_INET/AF_UNIX; RFCOMM (AF_BLUETOOTH)
 * must be wrapped via low-level fs.read/fs.write.
 */
class FdSocket extends Duplex {
    constructor(fd) {
        super();
        this._fd = fd;
        this._reading = false;
        this._destroyed = false;
        this._readBuf = Buffer.alloc(1024);
        this._startReading();
    }

    _startReading() {
        if (this._reading || this._destroyed) return;
        this._reading = true;
        this._readLoop();
    }

    _readLoop() {
        if (this._destroyed) return;
        fs.read(this._fd, this._readBuf, 0, this._readBuf.length, null, (err, bytesRead) => {
            if (this._destroyed) return;
            if (err) {
                if (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK') {
                    // Retry after short delay
                    setTimeout(() => this._readLoop(), 50);
                    return;
                }
                this.destroy(err);
                return;
            }
            if (bytesRead === 0) {
                this.push(null); // EOF
                return;
            }
            // MUST copy — _readBuf is reused; a mere view would be
            // overwritten by the next fs.read before the stream consumes it.
            const chunk = Buffer.allocUnsafe(bytesRead);
            this._readBuf.copy(chunk, 0, 0, bytesRead);
            this.push(chunk);
            // Continue reading
            setImmediate(() => this._readLoop());
        });
    }

    _read() {
        // Reading is driven by _readLoop
    }

    _write(chunk, encoding, callback) {
        if (this._destroyed) return callback(new Error('Socket destroyed'));
        fs.write(this._fd, chunk, 0, chunk.length, null, (err) => {
            callback(err);
        });
    }

    _destroy(err, callback) {
        this._destroyed = true;
        try { fs.closeSync(this._fd); } catch (_) { /* */ }
        callback(err);
    }

    setEncoding(enc) {
        // Duplex supports this natively
        super.setEncoding(enc);
        return this;
    }

    setNoDelay() { /* no-op for RFCOMM */ return this; }
}

// We register as HFP-HF (Hands-Free unit). BlueZ matches this to remote
// devices that have HFP-AG (0000111f). Role=client means we initiate.
const HFP_HF_UUID = '0000111e-0000-1000-8000-00805f9b34fb';
const PROFILE_PATH = '/org/iobroker/bluetooth/hfp';
const PROFILE_MANAGER_IFACE = 'org.bluez.ProfileManager1';

// HFP-HF features bitmask (we advertise as a car-kit/hands-free)
// Must include codec negotiation for modern Android phones (HFP 1.7+)
const HF_FEATURES =
    (1 << 0) |  // EC/NR (echo cancel/noise reduction)
    (1 << 1) |  // Call waiting / 3-way calling
    (1 << 2) |  // CLI presentation (caller ID)
    (1 << 4) |  // Remote volume control
    (1 << 5) |  // Enhanced Call Status
    (1 << 7);   // Codec negotiation (WBS/mSBC)

// AT command timeout
const AT_TIMEOUT = 5000;

// Keepalive interval – Android kills HFP without SCO audio after ~9s.
// We poll once during each connection window to refresh indicators.
const KEEPALIVE_INTERVAL = 5000;

/**
 * HFP Hands-Free Profile implementation.
 *
 * Registers as HFP-HF (Hands-Free unit) with BlueZ ProfileManager1.
 * When a phone (Audio Gateway) connects, exchanges AT commands over RFCOMM
 * to establish a Service Level Connection and monitor/control calls.
 *
 * @emits connected       (mac)
 * @emits disconnected    (mac)
 * @emits callState       (mac, { state, number, name })
 * @emits indicator       (mac, { name, value })
 * @emits batteryLevel    (mac, level)
 * @emits signalStrength  (mac, level)
 * @emits operatorName    (mac, name)
 */
class HfpProfile extends EventEmitter {

    /**
     * @param {object} opts
     * @param {import('dbus-next').MessageBus} opts.bus
     * @param {object} opts.log
     */
    constructor(opts) {
        super();
        this.bus = opts.bus;
        this.log = opts.log;

        /** @type {boolean} */
        this._registered = false;

        /**
         * Active RFCOMM connections: MAC → connection state
         * @type {Map<string, { socket: net.Socket, buffer: string, indicators: object, slcReady: boolean }>}
         */
        this._connections = new Map();
    }

    /**
     * Register HFP-HF profile with BlueZ.
     */
    async register() {
        // Export our Profile1 interface
        this._exportProfile();

        // Register with ProfileManager
        const proxy = await this.bus.getProxyObject('org.bluez', '/org/bluez');
        const profileMgr = proxy.getInterface(PROFILE_MANAGER_IFACE);

        const options = {
            Name: new dbus.Variant('s', 'ioBroker HFP'),
            Role: new dbus.Variant('s', 'client'),       // We initiate connection to phone's AG
            RequireAuthentication: new dbus.Variant('b', true),
            RequireAuthorization: new dbus.Variant('b', false),
            AutoConnect: new dbus.Variant('b', true),
            Features: new dbus.Variant('q', HF_FEATURES),
            Version: new dbus.Variant('q', 0x0108),       // HFP 1.8
        };

        try {
            await profileMgr.RegisterProfile(PROFILE_PATH, HFP_HF_UUID, options);
            this._registered = true;
            this.log.info('HFP Hands-Free profile registered');
        } catch (e) {
            if (e.message && (e.message.includes('AlreadyExists') || e.message.includes('already registered'))) {
                this.log.debug('HFP profile already registered, re-registering…');
                try { await profileMgr.UnregisterProfile(PROFILE_PATH); } catch (_) { /* */ }
                await profileMgr.RegisterProfile(PROFILE_PATH, HFP_HF_UUID, options);
                this._registered = true;
                this.log.info('HFP Hands-Free profile re-registered');
            } else {
                throw e;
            }
        }
    }

    /**
     * Unregister the profile and close all connections.
     */
    async unregister() {
        // Close all RFCOMM connections
        for (const [mac, conn] of this._connections) {
            try { conn.socket.destroy(); } catch (_) { /* */ }
            this._connections.delete(mac);
        }

        if (!this._registered) return;

        try {
            const proxy = await this.bus.getProxyObject('org.bluez', '/org/bluez');
            const profileMgr = proxy.getInterface(PROFILE_MANAGER_IFACE);
            await profileMgr.UnregisterProfile(PROFILE_PATH);
            this.log.info('HFP profile unregistered');
        } catch (e) {
            this.log.debug(`HFP unregister: ${e.message}`);
        }

        try { this.bus.unexport(PROFILE_PATH); } catch (_) { /* */ }
        this._registered = false;
    }

    /**
     * Check if a device has an active HFP connection.
     * @param {string} mac
     * @returns {boolean}
     */
    isConnected(mac) {
        const key = this._normalise(mac);
        const conn = this._connections.get(key);
        return !!(conn && conn.slcReady);
    }

    // ─── Call control ────────────────────────────────────────────────

    /**
     * Answer an incoming call.
     * @param {string} mac
     */
    async answer(mac) {
        await this._sendCommand(mac, 'ATA');
    }

    /**
     * Hang up the current call.
     * @param {string} mac
     */
    async hangup(mac) {
        await this._sendCommand(mac, 'AT+CHUP');
    }

    /**
     * Reject an incoming call.
     * @param {string} mac
     */
    async reject(mac) {
        await this._sendCommand(mac, 'AT+CHUP');
    }

    /**
     * Dial a number.
     * @param {string} mac
     * @param {string} number
     */
    async dial(mac, number) {
        const clean = number.replace(/[^0-9+*#]/g, '');
        await this._sendCommand(mac, `ATD${clean};`);
    }

    /**
     * Redial last number (AT+BLDN).
     * @param {string} mac
     */
    async redial(mac) {
        await this._sendCommand(mac, 'AT+BLDN');
    }

    /**
     * Send a raw AT command (for debugging).
     * @param {string} mac
     * @param {string} cmd
     * @returns {Promise<string>}
     */
    async sendRawAT(mac, cmd) {
        return await this._sendCommand(mac, cmd);
    }

    /**
     * Send DTMF tone during active call.
     * @param {string} mac
     * @param {string} tone – single char 0-9, *, #
     */
    async sendDTMF(mac, tone) {
        await this._sendCommand(mac, `AT+VTS=${tone}`);
    }

    /**
     * Query current calls (CLCC).
     * @param {string} mac
     */
    async queryCurrentCalls(mac) {
        await this._sendCommand(mac, 'AT+CLCC');
    }

    /**
     * Set speaker volume (0–15).
     * @param {string} mac
     * @param {number} vol
     */
    async setVolume(mac, vol) {
        const v = Math.max(0, Math.min(15, Math.round(vol)));
        await this._sendCommand(mac, `AT+VGS=${v}`);
    }

    // ─── D-Bus Profile1 interface export ─────────────────────────────

    /**
     * Export the Profile1 interface on D-Bus.
     * @private
     */
    _exportProfile() {
        const self = this;

        class Profile1 extends DbusInterface {
            NewConnection(device, fd, fdProperties) {
                self._onNewConnection(device, fd, fdProperties);
            }

            RequestDisconnection(device) {
                self._onRequestDisconnection(device);
            }

            Release() {
                self.log.info('HFP profile released by BlueZ');
            }
        }

        Profile1.configureMembers({
            methods: {
                NewConnection:        { inSignature: 'oha{sv}', outSignature: '' },
                RequestDisconnection: { inSignature: 'o',       outSignature: '' },
                Release:              { inSignature: '',        outSignature: '' },
            },
        });

        this._profileIface = new Profile1('org.bluez.Profile1');
        this.bus.export(PROFILE_PATH, this._profileIface);
    }

    /**
     * Handle new RFCOMM connection from BlueZ.
     * @param {string} devicePath
     * @param {number} fd – file descriptor for the RFCOMM socket
     * @param {object} fdProperties
     * @private
     */
    _onNewConnection(devicePath, fd, fdProperties) {
        const mac = this._devicePathToMac(devicePath);
        this.log.info(`HFP NewConnection from ${mac} (fd=${fd}, type=${typeof fd})`);

        // Emit preConnect so consumers can create state objects before SLC fires indicators
        this.emit('preConnect', mac);

        try {
            // The fd from dbus-next/usocket is a raw integer file descriptor
            const fdNum = typeof fd === 'object' && fd.fd !== undefined ? fd.fd : Number(fd);
            this.log.info(`HFP using fd=${fdNum} for RFCOMM socket`);

            // Wrap the RFCOMM file descriptor — can't use net.Socket (AF_BLUETOOTH ≠ AF_INET)
            const socket = new FdSocket(fdNum);
            socket.setEncoding('utf8');
            socket.setNoDelay(true);

            const conn = {
                socket,
                buffer: '',
                indicators: {},
                indicatorMap: [],   // ordered list of CIND indicator names
                slcReady: false,
                mac,
            };

            this._connections.set(this._normalise(mac), conn);

            socket.on('data', (data) => this._onData(mac, data));
            socket.on('error', (err) => {
                // ECONNRESET is expected (Android drops HFP after ~9s without SCO audio)
                if (err.code === 'ECONNRESET') {
                    this.log.debug(`HFP RFCOMM reset by ${mac} (expected Android behavior)`);
                } else {
                    this.log.warn(`HFP socket error ${mac}: ${err.message}`);
                }
                this._cleanup(mac);
            });
            socket.on('close', () => {
                this.log.debug(`HFP socket closed: ${mac}`);
                this._cleanup(mac);
            });

            // Start Service Level Connection (SLC) setup
            this._initSLC(mac);

        } catch (e) {
            this.log.error(`HFP NewConnection failed for ${mac}: ${e.message}`);
        }
    }

    /**
     * Handle disconnect request from BlueZ.
     * @param {string} devicePath
     * @private
     */
    _onRequestDisconnection(devicePath) {
        const mac = this._devicePathToMac(devicePath);
        this.log.info(`HFP RequestDisconnection from ${mac}`);
        this._cleanup(mac);
    }

    // ─── SLC (Service Level Connection) setup ────────────────────────

    /**
     * Perform the HFP Service Level Connection initialization.
     * This is the AT command handshake that must happen before the
     * connection is usable.
     *
     * @param {string} mac
     * @private
     */
    async _initSLC(mac) {
        try {
            // Step 1: Exchange supported features
            await this._sendCommand(mac, `AT+BRSF=${HF_FEATURES}`);

            // Step 1b: Announce available codecs (required when both sides
            // support codec negotiation — HF feature bit 7 + AG feature bit 9)
            // Codec 1 = CVSD (narrowband), 2 = mSBC (wideband)
            try {
                await this._sendCommand(mac, 'AT+BAC=1,2');
            } catch (e) {
                // Some AGs reject AT+BAC if they don't support codec negotiation — OK
                this.log.debug(`AT+BAC not supported by AG: ${e.message}`);
            }

            // Step 2: Query available indicators
            await this._sendCommand(mac, 'AT+CIND=?');

            // Step 3: Read current indicator values
            await this._sendCommand(mac, 'AT+CIND?');

            // Step 4: Enable indicator event reporting
            await this._sendCommand(mac, 'AT+CMER=3,0,0,1');

            // Step 5: Query call hold/multiparty services (MANDATORY per HFP spec
            // when both AG and HF support 3-way calling)
            const slcConn = this._connections.get(this._normalise(mac));
            const agFeatures = slcConn ? slcConn.agFeatures : 0;
            if (agFeatures & (1 << 0)) { // AG supports 3-way calling
                try {
                    await this._sendCommand(mac, 'AT+CHLD=?');
                } catch (e) {
                    this.log.debug(`AT+CHLD=? not supported: ${e.message}`);
                }
            }

            // Step 5b: Negotiate HF Indicators (if both sides support it)
            // HF bit 8 (not in our bitmask yet) + AG bit 10
            if (agFeatures & (1 << 10)) { // AG supports HF Indicators
                try {
                    // Indicator 1 = enhanced safety, 2 = battery level
                    await this._sendCommand(mac, 'AT+BIND=1,2');
                    await this._sendCommand(mac, 'AT+BIND?');
                } catch (e) {
                    this.log.debug(`AT+BIND not supported: ${e.message}`);
                }
            }

            // Step 6: Enable caller ID presentation
            await this._sendCommand(mac, 'AT+CLIP=1');

            // Step 7: Enable call waiting notifications
            await this._sendCommand(mac, 'AT+CCWA=1');

            // Step 8: Enable extended error codes
            await this._sendCommand(mac, 'AT+CMEE=1');

            // Step 9: Query operator name
            await this._sendCommand(mac, 'AT+COPS?');

            // Mark SLC as ready
            const conn = this._connections.get(this._normalise(mac));
            if (conn) {
                conn.slcReady = true;
                this.log.info(`HFP SLC established with ${mac}`);
                this._startKeepalive(mac);
                this.emit('connected', mac);
            }

        } catch (e) {
            this.log.error(`HFP SLC setup failed for ${mac}: ${e.message}`);
            this._cleanup(mac);
        }
    }

    // ─── AT command I/O ──────────────────────────────────────────────

    /**
     * Send an AT command and wait for OK/ERROR.
     * Commands are queued per-connection so keepalive and user actions
     * never interleave on the wire.
     *
     * @param {string} mac
     * @param {string} cmd
     * @returns {Promise<string>} – response lines before OK
     * @private
     */
    _sendCommand(mac, cmd) {
        const key = this._normalise(mac);
        const conn = this._connections.get(key);
        if (!conn) return Promise.reject(new Error(`No HFP connection for ${mac}`));

        return new Promise((resolve, reject) => {
            if (!conn._cmdQueue) conn._cmdQueue = [];
            conn._cmdQueue.push({ cmd, resolve, reject });

            // Kick processing if this is the only queued command
            if (conn._cmdQueue.length === 1) {
                this._sendNextCommand(mac, conn);
            }
        });
    }

    /**
     * Send the head-of-queue AT command over the wire.
     * Guards against double-send: if a command is already in-flight,
     * skip (the in-flight completion will call us again).
     * @private
     */
    _sendNextCommand(mac, conn) {
        if (!conn._cmdQueue || conn._cmdQueue.length === 0) return;
        if (conn._cmdInFlight) return; // already processing head of queue

        conn._cmdInFlight = true;
        const { cmd, resolve, reject } = conn._cmdQueue[0];

        const timer = setTimeout(() => {
            conn._cmdQueue.shift();
            conn._cmdInFlight = false;
            reject(new Error(`AT command timeout: ${cmd}`));
            this._sendNextCommand(mac, conn);
        }, AT_TIMEOUT);

        conn._pendingResolve = (response) => {
            clearTimeout(timer);
            conn._cmdQueue.shift();
            conn._cmdInFlight = false;
            resolve(response);
            // Let the resolved promise handler queue the next command;
            // if nothing is queued, _sendNextCommand is a no-op.
            setImmediate(() => this._sendNextCommand(mac, conn));
        };
        conn._pendingReject = (err) => {
            clearTimeout(timer);
            conn._cmdQueue.shift();
            conn._cmdInFlight = false;
            reject(err);
            setImmediate(() => this._sendNextCommand(mac, conn));
        };

        this.log.debug(`HFP TX [${mac}]: ${cmd}`);
        conn.socket.write(`${cmd}\r`);
    }

    /**
     * Handle incoming data from RFCOMM socket.
     * @param {string} mac
     * @param {string} data
     * @private
     */
    _onData(mac, data) {
        const key = this._normalise(mac);
        const conn = this._connections.get(key);
        if (!conn) return;

        conn.buffer += data;

        // Process complete lines (terminated by \r\n or \r)
        let lines = conn.buffer.split(/\r\n|\r/);
        conn.buffer = lines.pop() || ''; // keep incomplete last line

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // Log all received data at info level temporarily for debugging
            this.log.info(`HFP RX [${mac}]: ${trimmed}`);
            this._processLine(mac, trimmed, conn);
        }
    }

    /**
     * Process a single AT response line.
     * @param {string} mac
     * @param {string} line
     * @param {object} conn
     * @private
     */
    _processLine(mac, line, conn) {
        // ── Final responses ──
        if (line === 'OK') {
            if (conn._pendingResolve) {
                conn._pendingResolve('OK');
                conn._pendingResolve = null;
                conn._pendingReject = null;
            }
            return;
        }
        if (line.startsWith('ERROR') || line.startsWith('+CME ERROR')) {
            if (conn._pendingReject) {
                conn._pendingReject(new Error(line));
                conn._pendingResolve = null;
                conn._pendingReject = null;
            }
            return;
        }

        // ── Unsolicited results & intermediate responses ──

        // +BRSF: <AG features>
        if (line.startsWith('+BRSF:')) {
            const agFeatures = parseInt(line.split(':')[1].trim(), 10);
            this.log.info(`HFP AG features for ${mac}: 0x${agFeatures.toString(16)} (${agFeatures})`);
            conn.agFeatures = agFeatures;
            this.emit('agFeatures', mac, agFeatures);
            return;
        }

        // +CHLD: supported call hold modes (response to AT+CHLD=?)
        // e.g. +CHLD: (0,1,1x,2,2x,3,4)
        if (line.startsWith('+CHLD:')) {
            this.log.info(`HFP CHLD modes for ${mac}: ${line}`);
            return;
        }

        // +BIND: HF indicator response
        if (line.startsWith('+BIND:')) {
            this.log.info(`HFP BIND for ${mac}: ${line}`);
            return;
        }

        // +CIND: indicator definitions (response to AT+CIND=?)
        // e.g. +CIND: ("call",(0,1)),("callsetup",(0-3)),("battchg",(0-5)),("signal",(0-5)),...
        if (line.startsWith('+CIND:') && line.includes('(')) {
            const match = line.match(/\+CIND:\s*(.*)/);
            if (match) {
                this._parseIndicatorDefinitions(mac, match[1], conn);
            }
            return;
        }

        // +CIND: indicator values (response to AT+CIND?)
        // e.g. +CIND: 0,0,1,5,3,0,0
        if (line.startsWith('+CIND:') && !line.includes('(')) {
            const values = line.split(':')[1].trim().split(',').map(Number);
            this._processIndicatorValues(mac, values, conn);
            return;
        }

        // +CIEV: <index>,<value> – indicator event
        if (line.startsWith('+CIEV:')) {
            const parts = line.split(':')[1].trim().split(',');
            const idx = parseInt(parts[0], 10);
            const val = parseInt(parts[1], 10);
            this._processIndicatorEvent(mac, idx, val, conn);
            return;
        }

        // +CLIP: "<number>",<type>[,"<name>"] – incoming caller ID
        if (line.startsWith('+CLIP:')) {
            const match = line.match(/\+CLIP:\s*"([^"]*)",(\d+)(?:,,"([^"]*)")?/);
            if (match) {
                const number = match[1];
                const name = match[3] || '';
                this.log.info(`HFP incoming call from ${number} ${name ? `(${name})` : ''}`);
                this.emit('callState', mac, { state: 'incoming', number, name });
            }
            return;
        }

        // +CCWA: "<number>",<type> – call waiting
        if (line.startsWith('+CCWA:')) {
            const match = line.match(/\+CCWA:\s*"([^"]*)",(\d+)/);
            if (match) {
                this.log.info(`HFP call waiting from ${match[1]}`);
                this.emit('callState', mac, { state: 'waiting', number: match[1], name: '' });
            }
            return;
        }

        // +CLCC: list current calls response
        if (line.startsWith('+CLCC:')) {
            this._processClcc(mac, line);
            return;
        }

        // +COPS: "<operator>"
        if (line.startsWith('+COPS:')) {
            const match = line.match(/"([^"]*)"/);
            if (match) {
                this.log.info(`HFP operator for ${mac}: ${match[1]}`);
                this.emit('operatorName', mac, match[1]);
            }
            return;
        }

        // RING – incoming call ring
        if (line === 'RING') {
            this.log.info(`📞 HFP RING from ${mac}`);
            this.emit('callState', mac, { state: 'ringing', number: '', name: '' });
            return;
        }

        // NO CARRIER – call ended
        if (line === 'NO CARRIER') {
            this.emit('callState', mac, { state: 'idle', number: '', name: '' });
            return;
        }

        // +BCS: codec negotiation (just acknowledge immediately — bypasses queue
        // because this is an unsolicited AG command that expects a fast reply)
        if (line.startsWith('+BCS:')) {
            const codec = line.split(':')[1].trim();
            this.log.info(`HFP codec negotiation: ${codec}`);
            conn.socket.write(`AT+BCS=${codec}\r`);
            return;
        }

        // +VGS / +VGM – volume sync from AG
        if (line.startsWith('+VGS:') || line.startsWith('+VGM:')) {
            return; // just log
        }
    }

    // ─── Keepalive ──────────────────────────────────────────────────

    /**
     * Start periodic keepalive polling.
     * Sends AT+CIND? to refresh indicator values AND prevent the phone
     * from closing the RFCOMM channel due to inactivity.
     * @param {string} mac
     * @private
     */
    _startKeepalive(mac) {
        const key = this._normalise(mac);
        const conn = this._connections.get(key);
        if (!conn) return;

        if (conn._keepaliveTimer) clearInterval(conn._keepaliveTimer);

        conn._keepaliveTimer = setInterval(async () => {
            if (!conn.slcReady) return;
            try {
                await this._sendCommand(mac, 'AT+CIND?');
            } catch (e) {
                this.log.debug(`HFP keepalive failed for ${mac}: ${e.message}`);
            }
        }, KEEPALIVE_INTERVAL);

        this.log.debug(`HFP keepalive started for ${mac} (every ${KEEPALIVE_INTERVAL / 1000}s)`);
    }

    // ─── Indicator handling ──────────────────────────────────────────

    /**
     * Parse +CIND=? response to build indicator name map.
     * @private
     */
    _parseIndicatorDefinitions(mac, str, conn) {
        // Extract indicator names from format: ("name",(range)),("name2",(range)),...
        const regex = /\("([^"]+)"/g;
        let match;
        const indicators = [];
        while ((match = regex.exec(str)) !== null) {
            indicators.push(match[1].toLowerCase());
        }
        conn.indicatorMap = indicators;
        this.log.debug(`HFP indicators for ${mac}: ${indicators.join(', ')}`);
    }

    /**
     * Process indicator values from +CIND? response (both initial SLC and keepalive polls).
     * @private
     */
    _processIndicatorValues(mac, values, conn) {
        let callChanged = false;
        for (let i = 0; i < values.length && i < conn.indicatorMap.length; i++) {
            const name = conn.indicatorMap[i];
            const prev = conn.indicators[name];
            conn.indicators[name] = values[i];
            this._emitIndicator(mac, name, values[i]);

            if ((name === 'call' || name === 'callsetup' || name === 'callheld') && prev !== values[i]) {
                callChanged = true;
            }
        }
        // Derive call state whenever a call-related indicator changed
        if (callChanged) {
            this._deriveCallState(mac, conn);
        }
    }

    /**
     * Process an indicator change event (+CIEV).
     * @private
     */
    _processIndicatorEvent(mac, idx, val, conn) {
        // CIEV indices are 1-based
        const name = conn.indicatorMap[idx - 1];
        if (!name) {
            this.log.debug(`HFP unknown indicator index ${idx} for ${mac}`);
            return;
        }

        const prev = conn.indicators[name];
        conn.indicators[name] = val;

        // Log call-related indicator changes at info level
        if (name === 'call' || name === 'callsetup' || name === 'callheld') {
            this.log.info(`📞 HFP ${name}: ${prev}→${val} [${mac}]`);
        } else {
            this.log.debug(`HFP indicator ${name}=${val} for ${mac}`);
        }
        this._emitIndicator(mac, name, val);

        // Derive call state from standard HFP indicators
        if (name === 'call' || name === 'callsetup' || name === 'callheld') {
            this._deriveCallState(mac, conn);
        }
    }

    /**
     * Emit indicator event + specific high-level events.
     * @private
     */
    _emitIndicator(mac, name, value) {
        this.emit('indicator', mac, { name, value });

        switch (name) {
            case 'battchg':
                this.emit('batteryLevel', mac, value);
                break;
            case 'signal':
                this.emit('signalStrength', mac, value);
                break;
        }
    }

    /**
     * Derive call state from HFP indicators.
     *
     * call:      0=no call, 1=call active
     * callsetup: 0=none, 1=incoming, 2=outgoing dialing, 3=outgoing alerting
     * callheld:  0=none, 1=held+active, 2=held only
     *
     * @private
     */
    _deriveCallState(mac, conn) {
        const call = conn.indicators.call ?? 0;
        const callsetup = conn.indicators.callsetup ?? 0;
        const callheld = conn.indicators.callheld ?? 0;

        let state = 'idle';
        if (call === 1 && callsetup === 0) {
            state = callheld === 2 ? 'held' : 'active';
        } else if (callsetup === 1) {
            state = 'incoming';
        } else if (callsetup === 2) {
            state = 'dialing';
        } else if (callsetup === 3) {
            state = 'alerting';
        } else if (callheld === 2) {
            state = 'held';
        }

        this.emit('callState', mac, { state, number: '', name: '' });
    }

    /**
     * Process +CLCC response line (list current calls).
     * +CLCC: <idx>,<dir>,<stat>,<mode>,<mpty>[,<number>,<type>]
     * @private
     */
    _processClcc(mac, line) {
        const match = line.match(/\+CLCC:\s*(\d+),(\d+),(\d+),(\d+),(\d+)(?:,"([^"]*)",(\d+))?/);
        if (!match) return;

        const stat = parseInt(match[3], 10);
        const number = match[6] || '';
        const states = ['active', 'held', 'dialing', 'alerting', 'incoming', 'waiting'];
        const state = states[stat] || 'unknown';

        this.emit('callState', mac, { state, number, name: '' });
    }

    // ─── Helpers ─────────────────────────────────────────────────────

    /**
     * Clean up a connection.  Only emits 'disconnected' once per MAC.
     * @private
     */
    _cleanup(mac) {
        const key = this._normalise(mac);
        const conn = this._connections.get(key);
        if (!conn) return; // already cleaned up — avoid double 'disconnected'

        if (conn._keepaliveTimer) clearInterval(conn._keepaliveTimer);
        // Reject any pending commands
        if (conn._cmdQueue) {
            for (const entry of conn._cmdQueue) {
                try { entry.reject(new Error('HFP connection closed')); } catch (_) { /* */ }
            }
            conn._cmdQueue = [];
        }
        try { conn.socket.destroy(); } catch (_) { /* */ }
        this._connections.delete(key);

        this.emit('disconnected', mac);
    }

    /** @private */
    _devicePathToMac(path) {
        const match = path.match(/dev_([0-9A-Fa-f_]{17})/);
        if (!match) return path;
        return match[1].replace(/_/g, ':').toUpperCase();
    }

    /** @private */
    _normalise(mac) {
        return mac.replace(/[-]/g, ':').toUpperCase();
    }
}

module.exports = HfpProfile;

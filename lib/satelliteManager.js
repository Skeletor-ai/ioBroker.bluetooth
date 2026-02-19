'use strict';

const net = require('net');
const { EventEmitter } = require('events');

/**
 * SatelliteManager – TCP server accepting JSONL connections from remote BLE scanners.
 *
 * Events:
 *   'deviceFound' (peripheral)  – normalized peripheral object (same shape as bleManager)
 *   'satelliteConnected' (name, info)
 *   'satelliteDisconnected' (name)
 */
class SatelliteManager extends EventEmitter {

    /**
     * @param {object} opts
     * @param {object} opts.adapter – ioBroker adapter instance
     * @param {number} [opts.port=8734]
     * @param {string[]} [opts.allowFrom=[]] – allowed IPs (empty = all)
     * @param {object} [opts.log] – logger
     */
    constructor(opts) {
        super();
        this.adapter = opts.adapter;
        this.port = opts.port || 8734;
        this.allowFrom = (opts.allowFrom || []).filter(Boolean);
        this.log = opts.log || console;

        /** @type {net.Server|null} */
        this._server = null;

        /** name → { socket, name, platform, version, ip, lastSeen, pingTimer, scanning } */
        this._satellites = new Map();

        this._PING_INTERVAL = 30000;
        this._PING_TIMEOUT = 90000;
    }

    /**
     * Start the TCP server.
     */
    async start() {
        return new Promise((resolve, reject) => {
            this._server = net.createServer((socket) => this._onConnection(socket));
            this._server.on('error', (err) => {
                this.log.error(`Satellite TCP server error: ${err.message}`);
                reject(err);
            });
            this._server.listen(this.port, () => {
                this.log.info(`Satellite TCP server listening on port ${this.port}`);
                resolve();
            });
        });
    }

    /**
     * Stop server, disconnect all satellites.
     */
    async stop() {
        // Clear all satellite timers
        for (const [name, sat] of this._satellites) {
            this._clearTimers(sat);
            try { sat.socket.destroy(); } catch (_) {}
        }
        this._satellites.clear();

        if (this._server) {
            return new Promise((resolve) => {
                this._server.close(() => resolve());
            });
        }
    }

    /**
     * Handle new TCP connection.
     * @param {net.Socket} socket
     */
    _onConnection(socket) {
        const remoteIp = socket.remoteAddress?.replace(/^::ffff:/, '') || 'unknown';
        this.log.info(`Satellite connection from ${remoteIp}`);

        // Check allowlist
        if (this.allowFrom.length > 0 && !this.allowFrom.includes(remoteIp)) {
            this.log.warn(`Satellite connection from ${remoteIp} rejected (not in allowFrom)`);
            socket.destroy();
            return;
        }

        let satName = null;
        let lineBuffer = '';

        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
            lineBuffer += chunk;
            let newlineIdx;
            while ((newlineIdx = lineBuffer.indexOf('\n')) !== -1) {
                const line = lineBuffer.slice(0, newlineIdx).trim();
                lineBuffer = lineBuffer.slice(newlineIdx + 1);
                if (line) {
                    try {
                        const msg = JSON.parse(line);
                        satName = this._handleMessage(socket, msg, satName, remoteIp);
                    } catch (e) {
                        this.log.warn(`Satellite JSONL parse error from ${remoteIp}: ${e.message}`);
                    }
                }
            }
        });

        socket.on('close', () => {
            if (satName && this._satellites.has(satName)) {
                this.log.info(`Satellite '${satName}' disconnected`);
                const sat = this._satellites.get(satName);
                this._clearTimers(sat);
                this._satellites.delete(satName);
                this._updateSatelliteState(satName, false);
                this.emit('satelliteDisconnected', satName);
            }
        });

        socket.on('error', (err) => {
            this.log.debug(`Satellite socket error (${satName || remoteIp}): ${err.message}`);
        });
    }

    /**
     * Process a parsed JSONL message.
     * @returns {string|null} satellite name
     */
    _handleMessage(socket, msg, currentName, remoteIp) {
        switch (msg.type) {
            case 'hello': {
                const name = msg.name || `satellite-${remoteIp}`;
                // If a satellite with same name exists, disconnect old one
                if (this._satellites.has(name)) {
                    const old = this._satellites.get(name);
                    this._clearTimers(old);
                    try { old.socket.destroy(); } catch (_) {}
                }
                const sat = {
                    socket,
                    name,
                    platform: msg.platform || 'unknown',
                    version: msg.version || '0.0.0',
                    ip: remoteIp,
                    lastSeen: Date.now(),
                    scanning: false,
                    pingTimer: null,
                    timeoutTimer: null,
                };
                this._satellites.set(name, sat);
                this._startPing(sat);
                this.log.info(`Satellite '${name}' registered (platform: ${sat.platform}, version: ${sat.version})`);

                // Send config
                this._send(socket, { type: 'config', scanDuration: 0, scanInterval: 0, services: [] });
                this._send(socket, { type: 'command', action: 'startScan' });

                this._updateSatelliteState(name, true, sat);
                this.emit('satelliteConnected', name, { platform: sat.platform, version: sat.version, ip: remoteIp });
                return name;
            }

            case 'discover': {
                if (!currentName) {
                    this.log.warn(`Satellite discover before hello from ${remoteIp}`);
                    return currentName;
                }
                const sat = this._satellites.get(currentName);
                if (sat) sat.lastSeen = Date.now();

                // Normalize to peripheral object matching bleManager format
                const peripheral = {
                    address: (msg.address || '').toUpperCase(),
                    addressType: msg.addressType || 'unknown',
                    rssi: msg.rssi ?? -100,
                    name: msg.name || '',
                    serviceData: this._decodeServiceData(msg.serviceData),
                    manufacturerData: msg.manufacturerData ? Buffer.from(msg.manufacturerData, 'base64') : null,
                    source: `satellite:${currentName}`,
                };

                this.emit('deviceFound', peripheral);
                this._updateSatelliteLastSeen(currentName);
                return currentName;
            }

            case 'status': {
                if (currentName) {
                    const sat = this._satellites.get(currentName);
                    if (sat) {
                        sat.scanning = !!msg.scanning;
                        sat.lastSeen = Date.now();
                    }
                }
                return currentName;
            }

            case 'pong': {
                if (currentName) {
                    const sat = this._satellites.get(currentName);
                    if (sat) {
                        sat.lastSeen = Date.now();
                        // Clear timeout timer
                        if (sat.timeoutTimer) {
                            clearTimeout(sat.timeoutTimer);
                            sat.timeoutTimer = null;
                        }
                    }
                }
                return currentName;
            }

            default:
                this.log.debug(`Unknown satellite message type: ${msg.type}`);
                return currentName;
        }
    }

    /**
     * Decode serviceData array from base64.
     * @param {Array<{uuid:string,data:string}>|undefined} sd
     * @returns {Array<{uuid:string,data:Buffer}>}
     */
    _decodeServiceData(sd) {
        if (!Array.isArray(sd)) return [];
        return sd.map(entry => ({
            uuid: entry.uuid,
            data: Buffer.from(entry.data || '', 'base64'),
        }));
    }

    /**
     * Send JSONL message to socket.
     */
    _send(socket, obj) {
        try {
            socket.write(JSON.stringify(obj) + '\n');
        } catch (e) {
            this.log.debug(`Satellite send error: ${e.message}`);
        }
    }

    /**
     * Start ping/pong keepalive for a satellite.
     */
    _startPing(sat) {
        sat.pingTimer = setInterval(() => {
            this._send(sat.socket, { type: 'ping' });
            // Set timeout for pong
            sat.timeoutTimer = setTimeout(() => {
                const elapsed = Date.now() - sat.lastSeen;
                if (elapsed > this._PING_TIMEOUT) {
                    this.log.warn(`Satellite '${sat.name}' timed out (no pong for ${Math.round(elapsed / 1000)}s)`);
                    sat.socket.destroy();
                }
            }, this._PING_TIMEOUT);
        }, this._PING_INTERVAL);
    }

    _clearTimers(sat) {
        if (sat.pingTimer) clearInterval(sat.pingTimer);
        if (sat.timeoutTimer) clearTimeout(sat.timeoutTimer);
        sat.pingTimer = null;
        sat.timeoutTimer = null;
    }

    /**
     * Write satellite connection state to ioBroker.
     */
    async _updateSatelliteState(name, connected, sat) {
        const id = `satellites.${name}`;
        try {
            await this.adapter.setObjectNotExistsAsync(id, {
                type: 'channel', common: { name: `Satellite: ${name}` }, native: {},
            });
            await this.adapter.setObjectNotExistsAsync(`${id}.connected`, {
                type: 'state',
                common: { name: 'Connected', type: 'boolean', role: 'indicator.connected', read: true, write: false },
                native: {},
            });
            await this.adapter.setObjectNotExistsAsync(`${id}.lastSeen`, {
                type: 'state',
                common: { name: 'Last seen', type: 'number', role: 'date', read: true, write: false },
                native: {},
            });
            await this.adapter.setObjectNotExistsAsync(`${id}.platform`, {
                type: 'state',
                common: { name: 'Platform', type: 'string', role: 'text', read: true, write: false },
                native: {},
            });

            await this.adapter.setStateAsync(`${id}.connected`, { val: connected, ack: true });
            if (sat) {
                await this.adapter.setStateAsync(`${id}.lastSeen`, { val: Date.now(), ack: true });
                await this.adapter.setStateAsync(`${id}.platform`, { val: sat.platform, ack: true });
            }
        } catch (e) {
            this.log.debug(`Failed to update satellite state for ${name}: ${e.message}`);
        }
    }

    async _updateSatelliteLastSeen(name) {
        try {
            await this.adapter.setStateAsync(`satellites.${name}.lastSeen`, { val: Date.now(), ack: true });
        } catch (_) {}
    }

    /**
     * Get list of connected satellites.
     */
    getSatellites() {
        const result = [];
        for (const [name, sat] of this._satellites) {
            result.push({ name, platform: sat.platform, version: sat.version, ip: sat.ip, scanning: sat.scanning });
        }
        return result;
    }
}

module.exports = SatelliteManager;

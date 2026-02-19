'use strict';

const EventEmitter = require('events');
const dbus = require('@deltachat/dbus-next');
const { Message, Variant, MessageType } = dbus;
const fs = require('fs');

const OBEX_SERVICE = 'org.bluez.obex';
const OBEX_PATH = '/org/bluez/obex';
const CLIENT_IFACE = 'org.bluez.obex.Client1';
const MSG_ACCESS_IFACE = 'org.bluez.obex.MessageAccess1';
const MESSAGE_IFACE = 'org.bluez.obex.Message1';
const PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties';
const OBJ_MANAGER_IFACE = 'org.freedesktop.DBus.ObjectManager';

/** MAP Message Access Server UUID (on the phone) */
const MAP_MAS_UUID = '00001132-0000-1000-8000-00805f9b34fb';

/**
 * MapClient – accesses phone messages via BlueZ OBEX MAP (Message Access Profile).
 *
 * obexd runs on the **session** D-Bus (not system bus).
 * Each connected phone that supports MAP gets an OBEX session.
 * The client polls the inbox periodically and emits events for new messages.
 *
 * @emits connected        (mac, sessionPath)
 * @emits disconnected     (mac)
 * @emits newMessage       (mac, messageInfo)
 * @emits messagesUpdated  (mac, messages[], unreadCount)
 * @emits error            (mac, Error)
 */
class MapClient extends EventEmitter {

    /**
     * @param {object} opts
     * @param {object} opts.log – ioBroker-style logger
     * @param {number} [opts.pollIntervalMs=30000] – inbox poll interval
     * @param {number} [opts.connectTimeoutMs=20000] – session creation timeout
     */
    constructor(opts) {
        super();
        this.log = opts.log;
        this._bus = null;
        /** @type {Map<string, {path:string, pollTimer:NodeJS.Timeout|null, knownHandles:Map<string,object>}>} */
        this._sessions = new Map(); // MAC → session info
        this._pollMs = opts.pollIntervalMs || 30000;
        this._connectTimeoutMs = opts.connectTimeoutMs || 20000;
        this._destroying = false;
    }

    // ─────────────────────────────────────────────────────────────
    //  Lifecycle
    // ─────────────────────────────────────────────────────────────

    /**
     * Connect to the session D-Bus and verify obexd is available.
     */
    async init() {
        // obexd lives on the session bus
        this._ensureSessionBusAddr();
        this._bus = dbus.sessionBus();

        // Verify obexd responds
        await this._call('/', OBJ_MANAGER_IFACE, 'GetManagedObjects');
        this.log.info('MAP: obexd available on session bus');

        // Watch for OBEX InterfacesAdded (MNS push – new message objects)
        await this._addMatchRule(
            "type='signal',sender='org.bluez.obex',interface='org.freedesktop.DBus.ObjectManager'"
        );
        this._messageHandler = (msg) => this._onDbusMessage(msg);
        this._bus.on('message', this._messageHandler);
    }

    /**
     * Tear down all MAP sessions and disconnect from D-Bus.
     */
    destroy() {
        this._destroying = true;
        for (const [mac, session] of this._sessions) {
            if (session.pollTimer) clearInterval(session.pollTimer);
            this._removeSession(session.path).catch(() => {});
        }
        this._sessions.clear();
        if (this._bus) {
            if (this._messageHandler) {
                this._bus.removeListener('message', this._messageHandler);
            }
            this._bus.disconnect();
            this._bus = null;
        }
    }

    // ─────────────────────────────────────────────────────────────
    //  Session management
    // ─────────────────────────────────────────────────────────────

    /**
     * Check whether a device UUID list includes MAP MAS.
     * @param {string[]} uuids
     * @returns {boolean}
     */
    static supportsMap(uuids) {
        if (!Array.isArray(uuids)) return false;
        return uuids.some(u => u.toLowerCase() === MAP_MAS_UUID);
    }

    /**
     * Create a MAP OBEX session to a device and start inbox polling.
     * The phone may prompt the user for permission on first connect.
     *
     * @param {string} mac – e.g. "AA:BB:CC:DD:EE:FF"
     */
    async connectDevice(mac) {
        const norm = this._norm(mac);
        if (this._sessions.has(norm)) {
            this.log.debug(`MAP: ${norm} already has a session`);
            return;
        }

        this.log.info(`MAP: connecting ${norm}…`);
        try {
            const reply = await this._callWithTimeout(
                OBEX_PATH, CLIENT_IFACE, 'CreateSession',
                'sa{sv}', [norm, { Target: new Variant('s', 'map') }],
                this._connectTimeoutMs,
            );

            const sessionPath = reply[0];
            const session = {
                path: sessionPath,
                pollTimer: null,
                knownHandles: new Map(),
            };
            this._sessions.set(norm, session);
            this.log.info(`MAP: session created for ${norm} → ${sessionPath}`);
            this.emit('connected', norm, sessionPath);

            // Initial inbox fetch
            await this._pollInbox(norm);

            // Start periodic polling
            session.pollTimer = setInterval(() => {
                if (!this._destroying) {
                    this._pollInbox(norm).catch(err => {
                        this.log.warn(`MAP: poll error for ${norm}: ${err.message}`);
                    });
                }
            }, this._pollMs);

        } catch (err) {
            this.log.warn(`MAP: connect failed for ${norm}: ${err.message}`);
            this.emit('error', norm, err);
        }
    }

    /**
     * Remove the MAP session for a device and stop polling.
     * @param {string} mac
     */
    async disconnectDevice(mac) {
        const norm = this._norm(mac);
        const session = this._sessions.get(norm);
        if (!session) return;

        if (session.pollTimer) clearInterval(session.pollTimer);
        this._sessions.delete(norm);

        try {
            await this._removeSession(session.path);
        } catch (err) {
            this.log.debug(`MAP: RemoveSession error for ${norm}: ${err.message}`);
        }

        this.log.info(`MAP: disconnected ${norm}`);
        this.emit('disconnected', norm);
    }

    /**
     * @param {string} mac
     * @returns {boolean}
     */
    hasSession(mac) {
        return this._sessions.has(this._norm(mac));
    }

    /**
     * Force an immediate inbox refresh for a device.
     * @param {string} mac
     */
    async refreshInbox(mac) {
        await this._pollInbox(this._norm(mac));
    }

    // ─────────────────────────────────────────────────────────────
    //  Inbox polling
    // ─────────────────────────────────────────────────────────────

    /**
     * Navigate to the SMS/MMS inbox and list recent messages.
     * Compares against known handles to detect new arrivals.
     *
     * @param {string} mac – normalised MAC
     * @private
     */
    async _pollInbox(mac) {
        const session = this._sessions.get(mac);
        if (!session) return;

        try {
            // Navigate to telecom/msg folder
            await this._navigateToFolder(session.path, ['telecom', 'msg']);

            // List messages in inbox subfolder
            const raw = await this._call(
                session.path, MSG_ACCESS_IFACE, 'ListMessages',
                'sa{sv}', ['inbox', {
                    MaxCount: new Variant('q', 50),
                    SubjectLength: new Variant('y', 255),
                }],
            );

            if (!raw || !raw[0]) return;

            const dict = this._unwrapDict(raw[0]);
            let unreadCount = 0;
            const messageList = [];
            const newMessages = [];

            for (const [path, props] of Object.entries(dict)) {
                const handle = path.split('/').pop();
                const info = this._buildMessageInfo(handle, path, props);

                if (!info.read) unreadCount++;
                messageList.push(info);

                // Detect new messages
                if (!session.knownHandles.has(handle)) {
                    newMessages.push(info);
                }
                session.knownHandles.set(handle, info);
            }

            // Sort newest first
            messageList.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

            this.emit('messagesUpdated', mac, messageList, unreadCount);

            for (const msg of newMessages) {
                this.log.info(`MAP: new message for ${mac} from ${msg.sender || msg.senderAddress}: ${msg.subject}`);
                this.emit('newMessage', mac, msg);
            }

        } catch (err) {
            this.log.warn(`MAP: inbox poll failed for ${mac}: ${err.message}`);
        }
    }

    /**
     * Navigate to a folder by stepping through path parts.
     * @param {string} sessionPath
     * @param {string[]} parts – e.g. ['telecom', 'msg']
     * @private
     */
    async _navigateToFolder(sessionPath, parts) {
        // Go to root
        await this._call(sessionPath, MSG_ACCESS_IFACE, 'SetFolder', 's', ['']);
        // Step into each sub-folder
        for (const part of parts) {
            await this._call(sessionPath, MSG_ACCESS_IFACE, 'SetFolder', 's', [part]);
        }
    }

    /**
     * Build a normalised message info object from MAP properties.
     * @param {string} handle
     * @param {string} path
     * @param {object} props – unwrapped properties
     * @returns {object}
     * @private
     */
    _buildMessageInfo(handle, path, props) {
        return {
            handle,
            path,
            sender: props.Sender || '',
            senderAddress: props.SenderAddress || '',
            recipient: props.Recipient || '',
            recipientAddress: props.RecipientAddress || '',
            subject: props.Subject || '',
            timestamp: this._parseMapTimestamp(props.Timestamp),
            type: (props.Type || 'sms').toLowerCase(),
            size: Number(props.Size || 0),
            read: props.Read ?? false,
            priority: props.Priority ?? false,
            protected: props.Protected ?? false,
        };
    }

    /**
     * Parse MAP timestamp format (YYYYMMDDTHHMMSS[±HHMM]) to ISO string.
     * @param {string} ts
     * @returns {string} ISO-8601 string or original
     * @private
     */
    _parseMapTimestamp(ts) {
        if (!ts || typeof ts !== 'string') return '';
        // Example: "20260130T221700" or "20260130T221700+0100"
        const m = ts.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})([+-]\d{4})?$/);
        if (!m) return ts;
        const [, Y, M, D, h, min, s, tz] = m;
        let iso = `${Y}-${M}-${D}T${h}:${min}:${s}`;
        if (tz) {
            iso += `${tz.slice(0, 3)}:${tz.slice(3)}`;
        }
        return iso;
    }

    // ─────────────────────────────────────────────────────────────
    //  D-Bus signal handling (MNS push)
    // ─────────────────────────────────────────────────────────────

    /**
     * Central D-Bus message handler for the session bus.
     * @param {object} msg
     * @private
     */
    _onDbusMessage(msg) {
        if (this._destroying || !msg || !msg.interface) return;
        try {
            if (msg.interface !== OBJ_MANAGER_IFACE || !msg.body) return;

            if (msg.member === 'InterfacesAdded') {
                this._onObexInterfacesAdded(msg.body[0], msg.body[1]);
            } else if (msg.member === 'InterfacesRemoved') {
                this._onObexInterfacesRemoved(msg.body[0], msg.body[1]);
            }
        } catch (e) {
            this.log.debug(`MAP: signal handler error: ${e.message}`);
        }
    }

    /**
     * New object appeared in obexd – could be a new message from MNS.
     * @private
     */
    _onObexInterfacesAdded(path, interfaces) {
        if (!interfaces || !interfaces[MESSAGE_IFACE]) return;

        // Find which session this belongs to
        for (const [mac, session] of this._sessions) {
            if (path.startsWith(session.path)) {
                this.log.info(`MAP: MNS push – new message object for ${mac}`);
                this._pollInbox(mac).catch(() => {});
                break;
            }
        }
    }

    /**
     * Object removed from obexd – could be session teardown.
     * @private
     */
    _onObexInterfacesRemoved(path, interfaces) {
        if (!Array.isArray(interfaces)) return;

        // Check if an entire session was removed externally
        if (interfaces.includes('org.bluez.obex.Session1')) {
            for (const [mac, session] of this._sessions) {
                if (session.path === path) {
                    this.log.info(`MAP: session removed externally for ${mac}`);
                    if (session.pollTimer) clearInterval(session.pollTimer);
                    this._sessions.delete(mac);
                    this.emit('disconnected', mac);
                    break;
                }
            }
        }
    }

    // ─────────────────────────────────────────────────────────────
    //  D-Bus helpers
    // ─────────────────────────────────────────────────────────────

    /**
     * Send a method call to obexd.
     * @param {string} path
     * @param {string} iface
     * @param {string} method
     * @param {string} [signature]
     * @param {Array} [body]
     * @returns {Promise<Array>}
     * @private
     */
    async _call(path, iface, method, signature, body) {
        const msg = new Message({
            destination: OBEX_SERVICE,
            path,
            interface: iface,
            member: method,
        });
        if (signature) msg.signature = signature;
        if (body) msg.body = body;

        const reply = await this._bus.call(msg);
        if (reply.errorName) {
            throw new Error(`${reply.errorName}: ${reply.body?.[0] || ''}`);
        }
        return reply.body;
    }

    /**
     * Call with a timeout (CreateSession can block waiting for phone approval).
     * @private
     */
    async _callWithTimeout(path, iface, method, signature, body, timeoutMs) {
        return Promise.race([
            this._call(path, iface, method, signature, body),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('timeout waiting for phone approval')), timeoutMs)
            ),
        ]);
    }

    /** @private */
    async _removeSession(sessionPath) {
        return this._call(OBEX_PATH, CLIENT_IFACE, 'RemoveSession', 'o', [sessionPath]);
    }

    /** @private */
    async _addMatchRule(rule) {
        await this._bus.call(new Message({
            type: MessageType.METHOD_CALL,
            destination: 'org.freedesktop.DBus',
            path: '/org/freedesktop/DBus',
            interface: 'org.freedesktop.DBus',
            member: 'AddMatch',
            signature: 's',
            body: [rule],
        }));
    }

    /**
     * Ensure DBUS_SESSION_BUS_ADDRESS is set.
     * obexd runs on the session bus; if we're a system service this may be missing.
     * @private
     */
    _ensureSessionBusAddr() {
        if (process.env.DBUS_SESSION_BUS_ADDRESS) return;

        const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
        const socketPath = `/run/user/${uid}/bus`;
        if (fs.existsSync(socketPath)) {
            process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${socketPath}`;
            this.log.info(`MAP: using session bus at ${socketPath}`);
        } else {
            throw new Error(
                `No session bus available (DBUS_SESSION_BUS_ADDRESS not set, ${socketPath} not found)`
            );
        }
    }

    /**
     * Unwrap a dict of {objectPath: {prop: Variant}} from D-Bus.
     * @param {object} dict
     * @returns {object}
     * @private
     */
    _unwrapDict(dict) {
        if (!dict || typeof dict !== 'object') return {};
        const result = {};
        for (const [path, props] of Object.entries(dict)) {
            result[path] = {};
            for (const [key, val] of Object.entries(props || {})) {
                result[path][key] = this._unwrapValue(val);
            }
        }
        return result;
    }

    /** @private */
    _unwrapValue(val) {
        if (val === null || val === undefined) return val;
        if (val && typeof val === 'object' && 'value' in val && 'signature' in val) {
            return this._unwrapValue(val.value);
        }
        if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Buffer)) {
            const result = {};
            for (const [k, v] of Object.entries(val)) {
                result[k] = this._unwrapValue(v);
            }
            return result;
        }
        return val;
    }

    /**
     * Normalise MAC to upper-case colon-separated.
     * @param {string} mac
     * @returns {string}
     * @private
     */
    _norm(mac) {
        return mac.toUpperCase().replace(/-/g, ':');
    }
}

module.exports = MapClient;

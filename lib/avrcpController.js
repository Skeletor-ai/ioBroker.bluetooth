'use strict';

const EventEmitter = require('events');
const dbus = require('@deltachat/dbus-next');

const BLUEZ_SERVICE = 'org.bluez';
const MEDIA_PLAYER_IFACE = 'org.bluez.MediaPlayer1';
const PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties';

/**
 * AVRCP media controller – provides play/pause/stop/next/prev controls
 * and track metadata via BlueZ's MediaPlayer1 D-Bus interface.
 *
 * BlueZ exposes AVRCP-capable devices as /org/bluez/hciX/dev_XX_XX/playerN
 * with the org.bluez.MediaPlayer1 interface.
 *
 * @emits playerFound    (mac, playerPath, props)
 * @emits playerRemoved  (mac, playerPath)
 * @emits playerChanged  (mac, playerPath, changed)
 */
class AvrcpController extends EventEmitter {

    /**
     * @param {object} opts
     * @param {import('@deltachat/dbus-next').MessageBus} opts.bus  – system D-Bus
     * @param {object} opts.log – ioBroker-style logger
     * @param {string} [opts.adapterPath] – e.g. /org/bluez/hci0
     */
    constructor(opts) {
        super();
        this._bus = opts.bus;
        this.log = opts.log;
        this._adapterPath = opts.adapterPath || '/org/bluez/hci0';

        /** @type {Map<string, {mac: string, path: string, props: object}>} path → player info */
        this._players = new Map();
    }

    // ─────────────────────────────────────────────────────────────
    //  Lifecycle
    // ─────────────────────────────────────────────────────────────

    /**
     * Scan existing D-Bus objects for MediaPlayer1 interfaces and
     * start watching for new players.
     */
    async init() {
        try {
            await this._enumerateExistingPlayers();
            this.log.info(`AVRCP: ${this._players.size} media player(s) found`);
        } catch (err) {
            this.log.warn(`AVRCP init failed: ${err.message}`);
        }
    }

    /**
     * Clean up.
     */
    destroy() {
        this._players.clear();
    }

    // ─────────────────────────────────────────────────────────────
    //  Player enumeration
    // ─────────────────────────────────────────────────────────────

    /**
     * Enumerate existing MediaPlayer1 objects via GetManagedObjects.
     * @private
     */
    async _enumerateExistingPlayers() {
        const msg = new dbus.Message({
            destination: BLUEZ_SERVICE,
            path: '/',
            interface: 'org.freedesktop.DBus.ObjectManager',
            member: 'GetManagedObjects',
        });

        const reply = await this._bus.call(msg);
        if (!reply || !reply.body || !reply.body[0]) return;

        const objects = reply.body[0];
        for (const [path, interfaces] of Object.entries(objects)) {
            if (interfaces[MEDIA_PLAYER_IFACE]) {
                this._addPlayer(path, interfaces[MEDIA_PLAYER_IFACE]);
            }
        }
    }

    /**
     * Called when InterfacesAdded signals arrive (from bluezManager's signal handler).
     * @param {string} path
     * @param {object} interfaces
     */
    onInterfacesAdded(path, interfaces) {
        if (!interfaces[MEDIA_PLAYER_IFACE]) return;
        if (!path.startsWith(this._adapterPath)) return;

        this._addPlayer(path, interfaces[MEDIA_PLAYER_IFACE]);
    }

    /**
     * Called when InterfacesRemoved signals arrive.
     * @param {string} path
     * @param {string[]} interfaces
     */
    onInterfacesRemoved(path, interfaces) {
        if (!interfaces.includes(MEDIA_PLAYER_IFACE)) return;

        const player = this._players.get(path);
        if (player) {
            this.log.info(`AVRCP: player removed – ${player.mac} (${path})`);
            this._players.delete(path);
            this.emit('playerRemoved', player.mac, path);
        }
    }

    /**
     * Called on PropertiesChanged for MediaPlayer1.
     * @param {string} path
     * @param {object} changed – already unwrapped properties
     */
    onPropertiesChanged(path, changed) {
        const player = this._players.get(path);
        if (!player) return;

        // Update cached props
        Object.assign(player.props, changed);

        this.emit('playerChanged', player.mac, path, changed);
    }

    /**
     * @param {string} path
     * @param {object} rawProps – Variant-wrapped properties
     * @private
     */
    _addPlayer(path, rawProps) {
        const mac = this._pathToMac(path);
        if (!mac) return;

        const props = this._unwrapVariants(rawProps);
        const info = { mac, path, props };
        this._players.set(path, info);

        this.log.info(`AVRCP: player found – ${mac} "${props.Name || '?'}" (${props.Status || '?'})`);
        this.emit('playerFound', mac, path, props);
    }

    // ─────────────────────────────────────────────────────────────
    //  Media controls
    // ─────────────────────────────────────────────────────────────

    /** @param {string} mac */
    async play(mac) { await this._callMethod(mac, 'Play'); }

    /** @param {string} mac */
    async pause(mac) { await this._callMethod(mac, 'Pause'); }

    /** @param {string} mac */
    async stop(mac) { await this._callMethod(mac, 'Stop'); }

    /** @param {string} mac */
    async next(mac) { await this._callMethod(mac, 'Next'); }

    /** @param {string} mac */
    async previous(mac) { await this._callMethod(mac, 'Previous'); }

    /** @param {string} mac */
    async fastForward(mac) { await this._callMethod(mac, 'FastForward'); }

    /** @param {string} mac */
    async rewind(mac) { await this._callMethod(mac, 'Rewind'); }

    /**
     * Set a writable property (Repeat, Shuffle, Equalizer).
     * @param {string} mac
     * @param {string} prop – property name
     * @param {string} value – property value
     */
    async setProperty(mac, prop, value) {
        const playerPath = this._findPlayerPath(mac);
        if (!playerPath) {
            this.log.warn(`AVRCP: no player for ${mac}`);
            return;
        }

        const msg = new dbus.Message({
            destination: BLUEZ_SERVICE,
            path: playerPath,
            interface: PROPERTIES_IFACE,
            member: 'Set',
            signature: 'ssv',
            body: [MEDIA_PLAYER_IFACE, prop, new dbus.Variant('s', value)],
        });

        try {
            await this._bus.call(msg);
            this.log.debug(`AVRCP: ${mac} Set ${prop}=${value}`);
        } catch (err) {
            this.log.warn(`AVRCP: Set ${prop} failed for ${mac}: ${err.message}`);
        }
    }

    /**
     * Read all current properties for a player.
     * @param {string} mac
     * @returns {object|null}
     */
    async getProperties(mac) {
        const playerPath = this._findPlayerPath(mac);
        if (!playerPath) return null;

        const msg = new dbus.Message({
            destination: BLUEZ_SERVICE,
            path: playerPath,
            interface: PROPERTIES_IFACE,
            member: 'GetAll',
            signature: 's',
            body: [MEDIA_PLAYER_IFACE],
        });

        try {
            const reply = await this._bus.call(msg);
            if (reply && reply.body && reply.body[0]) {
                return this._unwrapVariants(reply.body[0]);
            }
        } catch (err) {
            this.log.warn(`AVRCP: GetAll failed for ${mac}: ${err.message}`);
        }
        return null;
    }

    // ─────────────────────────────────────────────────────────────
    //  Helpers
    // ─────────────────────────────────────────────────────────────

    /**
     * Get all known players.
     * @returns {Map<string, {mac: string, path: string, props: object}>}
     */
    getPlayers() {
        return this._players;
    }

    /**
     * Find a player by MAC address.
     * @param {string} mac – e.g. "AA:BB:CC:DD:EE:FF"
     * @returns {object|null}
     */
    getPlayer(mac) {
        const normalized = mac.toUpperCase().replace(/-/g, ':');
        for (const player of this._players.values()) {
            if (player.mac === normalized) return player;
        }
        return null;
    }

    /**
     * Call a MediaPlayer1 method.
     * @param {string} mac
     * @param {string} method
     * @private
     */
    async _callMethod(mac, method) {
        const playerPath = this._findPlayerPath(mac);
        if (!playerPath) {
            this.log.warn(`AVRCP: no player for ${mac} – cannot call ${method}`);
            return;
        }

        const msg = new dbus.Message({
            destination: BLUEZ_SERVICE,
            path: playerPath,
            interface: MEDIA_PLAYER_IFACE,
            member: method,
        });

        try {
            await this._bus.call(msg);
            this.log.debug(`AVRCP: ${mac} ${method}()`);
        } catch (err) {
            this.log.warn(`AVRCP: ${method} failed for ${mac}: ${err.message}`);
        }
    }

    /**
     * Find the player D-Bus path for a given MAC.
     * @param {string} mac
     * @returns {string|null}
     * @private
     */
    _findPlayerPath(mac) {
        const normalized = mac.toUpperCase().replace(/-/g, ':');
        for (const [path, player] of this._players) {
            if (player.mac === normalized) return path;
        }
        return null;
    }

    /**
     * Extract MAC from a player path like /org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF/player0
     * @param {string} path
     * @returns {string|null}
     * @private
     */
    _pathToMac(path) {
        const match = path.match(/dev_([0-9A-F]{2}_[0-9A-F]{2}_[0-9A-F]{2}_[0-9A-F]{2}_[0-9A-F]{2}_[0-9A-F]{2})/i);
        if (!match) return null;
        return match[1].replace(/_/g, ':').toUpperCase();
    }

    /**
     * Recursively unwrap D-Bus Variant objects.
     * @param {object} dict
     * @returns {object}
     * @private
     */
    _unwrapVariants(dict) {
        if (!dict || typeof dict !== 'object') return dict;
        const result = {};
        for (const [key, val] of Object.entries(dict)) {
            result[key] = this._unwrapValue(val);
        }
        return result;
    }

    /**
     * @param {*} val
     * @returns {*}
     * @private
     */
    _unwrapValue(val) {
        if (val === null || val === undefined) return val;
        if (val && typeof val === 'object' && 'value' in val && 'signature' in val) {
            return this._unwrapValue(val.value);
        }
        if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Buffer)) {
            return this._unwrapVariants(val);
        }
        return val;
    }
}

module.exports = AvrcpController;

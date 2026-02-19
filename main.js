'use strict';

const utils = require('@iobroker/adapter-core');
const BluezManager = require('./lib/bluezManager');
const DeviceManager = require('./lib/deviceManager');
const HfpProfile = require('./lib/hfpProfile');
const AvrcpController = require('./lib/avrcpController');
const MapClient = require('./lib/mapClient');
const { parseAdvertisement } = require('./lib/advertisementParser');
const { parseBTHome, findBTHomeData } = require('./lib/bthomeParser');
const ShellyGateway = require('./lib/shellyGateway');

/**
 * ioBroker.bluetooth – Bluetooth adapter (Classic + BLE via BlueZ/D-Bus)
 *
 * Lifecycle:
 *   onReady   → init BlueZ, start discovery, react to D-Bus signals
 *   onUnload  → stop discovery, clean up
 */
class BluetoothAdapter extends utils.Adapter {

    constructor(options) {
        super({ ...options, name: 'bluetooth' });

        /** @type {BluezManager|null} */
        this.bluez = null;
        /** @type {DeviceManager|null} */
        this.deviceMgr = null;
        /** @type {HfpProfile|null} */
        this.hfp = null;
        /** @type {AvrcpController|null} */
        this.avrcp = null;
        /** @type {MapClient|null} */
        this.map = null;
        /** @type {ShellyGateway|null} */
        this.shellyGw = null;

        this._stopping = false;

        /**
         * Track which source(s) have seen each device: 'bluez', 'shelly:<id>', or both.
         * @type {Map<string, Set<string>>}
         */
        this._deviceSources = new Map();

        /** MAC → reconnect state */
        this._reconnect = new Map();

        /** Discovery list: MAC → { mac, name, rssi, type, paired, adopted, transient, lastSeen } */
        this._discovery = new Map();
        /** Set of adopted device MACs (upper-case dashed) – persisted in state */
        this._adopted = new Set();
        /** Timer for periodic discovery list flush */
        this._discoveryFlushTimer = null;

        /** Track devices for which telephony objects have been created */
        this._telephonyReady = new Set();

        /** In-flight _ensureTelephonyObjects promises (dedup concurrent calls) */
        this._telephonyPending = new Map();

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    // ─────────────────────────────────────────────────────────────────
    //  Lifecycle
    // ─────────────────────────────────────────────────────────────────

    async onReady() {
        // Read native config
        const cfg = this.config || {};
        const hciDevice = cfg.hciDevice ?? 0;
        const transport = cfg.transport || 'auto';
        const allowlist = (cfg.allowlist || []).map((e) => {
            const raw = typeof e === 'string' ? e : (e.mac || '');
            return raw.toUpperCase().replace(/[:-]/g, '-');
        }).filter(Boolean);
        const autoConnect = cfg.autoConnect !== false && allowlist.length > 0;
        const reconnectEnabled = cfg.reconnectEnabled !== false;
        const reconnectBaseDelay = (cfg.reconnectBaseDelay || 5) * 1000;
        const reconnectMaxDelay = (cfg.reconnectMaxDelay || 300) * 1000;

        this._cfg = {
            hciDevice, transport, allowlist, autoConnect,
            reconnectEnabled, reconnectBaseDelay, reconnectMaxDelay,
        };

        this.log.info(`Bluetooth adapter starting (hci${hciDevice}, transport: ${transport}, allowlist: ${allowlist.length > 0 ? allowlist.join(', ') : 'none (scan-only mode)'})`);

        // Read system name for Bluetooth alias (visible to other devices)
        let btAlias = 'ioBroker';
        try {
            const sysConfig = await this.getForeignObjectAsync('system.config');
            if (sysConfig && sysConfig.common && sysConfig.common.siteName) {
                btAlias = sysConfig.common.siteName;
            }
        } catch (e) {
            this.log.debug(`Could not read system config: ${e.message}`);
        }

        // Create managers
        this.bluez = new BluezManager({ log: this.log, hciDevice, alias: btAlias });
        this.deviceMgr = new DeviceManager({ adapter: this, bluezManager: this.bluez });

        // Load adopted devices BEFORE BluezManager init (which enumerates existing devices)
        await this._initDiscovery();

        // Ensure info.connection state exists
        await this.setObjectNotExistsAsync('info.connection', {
            type: 'state',
            common: { name: 'Bluetooth adapter connected', type: 'boolean', role: 'indicator.connected', read: true, write: false },
            native: {},
        });

        // Wire up BluezManager events BEFORE init (init enumerates existing devices)
        this.bluez.on('deviceFound', (mac, props) => this._onDeviceFound(mac, props));
        this.bluez.on('deviceChanged', (mac, changed) => this._onDeviceChanged(mac, changed));
        this.bluez.on('deviceRemoved', (mac) => this._onDeviceRemoved(mac));

        try {
            await this.bluez.init();
            this.log.info('BlueZ adapter initialized');
            await this.setStateAsync('info.connection', true, true);
        } catch (err) {
            this.log.error(`BlueZ init failed: ${err.message}`);
            await this.setStateAsync('info.connection', false, true);
            return;
        }

        // Wire up pairing agent
        const agent = this.bluez.getAgent();
        if (agent) {
            agent.onPairingRequest((req) => this._onPairingRequest(req));
        }

        // Register HFP Hands-Free profile
        try {
            this.hfp = new HfpProfile({ bus: this.bluez._bus, log: this.log });
            await this.hfp.register();
            this._wireHfpEvents();
        } catch (err) {
            this.log.warn(`HFP profile registration failed: ${err.message}`);
            this.hfp = null;
        }

        // Initialize AVRCP media control
        try {
            this.avrcp = new AvrcpController({
                bus: this.bluez._bus,
                log: this.log,
                adapterPath: this.bluez.adapterPath,
            });
            await this.avrcp.init();
            this._wireAvrcpEvents();
        } catch (err) {
            this.log.warn(`AVRCP init failed: ${err.message}`);
            this.avrcp = null;
        }

        // Initialize MAP message access (uses session D-Bus → obexd)
        try {
            this.map = new MapClient({
                log: this.log,
                pollIntervalMs: 30000,
                connectTimeoutMs: 20000,
            });
            await this.map.init();
            this._wireMapEvents();
        } catch (err) {
            this.log.warn(`MAP init failed: ${err.message}`);
            this.map = null;
        }

        // ── Shelly BLE Gateway (parallel to BlueZ) ─────────────────
        const shellyCfg = cfg.shellyGateway || {};
        if (shellyCfg.enabled) {
            try {
                this.shellyGw = new ShellyGateway({ config: shellyCfg, log: this.log });
                this.shellyGw.on('deviceFound', (event) => this._onShellyDeviceFound(event));
                this.shellyGw.on('error', (err) => this.log.warn(`ShellyGateway error: ${err.message}`));
                await this.shellyGw.start();
                this.log.info('Shelly BLE Gateway started');
            } catch (err) {
                this.log.warn(`Shelly BLE Gateway failed to start: ${err.message}`);
                this.shellyGw = null;
            }
        }

        // Subscribe to all state changes under our namespace
        this.subscribeStates('*');

        // Start discovery
        try {
            await this.bluez.startDiscovery(transport);
        } catch (err) {
            this.log.error(`Failed to start discovery: ${err.message}`);
        }

        // Auto-connect MAP for already-connected devices
        if (this.map) {
            for (const [mac, device] of this.bluez.getDevices()) {
                if (device.connected && device.paired && device.uuids) {
                    this._tryMapConnect(mac, device.uuids);
                }
            }
        }
    }

    async onUnload(callback) {
        this._stopping = true;

        try {
            // Clear timers
            if (this._discoveryFlushTimer) clearInterval(this._discoveryFlushTimer);
            for (const [, rs] of this._reconnect) {
                if (rs.timer) clearTimeout(rs.timer);
            }
            this._reconnect.clear();

            if (this.shellyGw) {
                await this.shellyGw.stop();
            }
            if (this.hfp) {
                await this.hfp.unregister();
            }
            if (this.avrcp) {
                this.avrcp.destroy();
            }
            if (this.map) {
                this.map.destroy();
            }
            if (this.deviceMgr) {
                await this.deviceMgr.destroy();
            }
            if (this.bluez) {
                await this.bluez.destroy();
            }
            this.log.info('Bluetooth adapter stopped');
        } catch (e) {
            this.log.warn(`Error during unload: ${e.message}`);
        }

        await this.setStateAsync('info.connection', false, true);
        callback();
    }

    // ─────────────────────────────────────────────────────────────────
    //  Admin messages (sendTo from config UI)
    // ─────────────────────────────────────────────────────────────────

    /**
     * Handle messages from admin UI (sendTo).
     * @param {ioBroker.Message} msg
     */
    async onMessage(msg) {
        if (!msg || !msg.command) return;

        switch (msg.command) {
            case 'getDiscoveredDevices': {
                // Return device list for selectSendTo dropdown
                // Format: [{value: "MAC", label: "Name (MAC) RSSI"}, ...]
                const devices = [...this._discovery.values()].sort((a, b) => {
                    if (a.paired !== b.paired) return a.paired ? -1 : 1;
                    return (b.rssi || -999) - (a.rssi || -999);
                });
                const options = devices
                    .filter(d => !d.transient) // hide random-MAC BLE spam
                    .map(d => {
                        const mac = d.mac.replace(/-/g, ':');
                        const parts = [d.name || 'Unnamed'];
                        parts.push(`(${mac})`);
                        if (d.rssi != null) parts.push(`${d.rssi} dBm`);
                        if (d.paired) parts.push('✓ paired');
                        if (d.type && d.type !== 'unknown') parts.push(`[${d.type}]`);
                        return { value: d.mac, label: parts.join(' ') };
                    });
                this.sendTo(msg.from, msg.command, options, msg.callback);
                break;
            }
            case 'addToAllowlist': {
                // Add selected device to allowlist (used by Admin UI sendTo + useNative)
                const data = msg.message || {};
                const mac = String(data.mac || '').toUpperCase().replace(/[:-]/g, '-').trim();
                if (!mac || !/^[0-9A-F]{2}(-[0-9A-F]{2}){5}$/.test(mac)) {
                    this.sendTo(msg.from, msg.command, { error: 'Invalid or empty MAC' }, msg.callback);
                    break;
                }
                // Read current config to get existing allowlist
                try {
                    const obj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
                    const native = (obj && obj.native) || {};
                    const currentList = Array.isArray(native.allowlist) ? native.allowlist : [];

                    // Check if already in list
                    const exists = currentList.some(e => {
                        const m = typeof e === 'string' ? e : (e.mac || '');
                        return m.toUpperCase().replace(/[:-]/g, '-') === mac;
                    });
                    if (exists) {
                        this.sendTo(msg.from, msg.command, { error: 'Device already in allowlist' }, msg.callback);
                        break;
                    }

                    // Find device info from discovery
                    const entry = this._discovery.get(mac.replace(/-/g, ':')) || this._discovery.get(mac);
                    const deviceName = entry ? (entry.name || '') : '';
                    const deviceType = entry ? (entry.type || 'auto') : 'auto';

                    const newEntry = { mac, name: deviceName, type: deviceType, autoConnect: true };
                    const updatedList = [...currentList, newEntry];

                    // Also adopt internally
                    await this._adoptDevice(mac);

                    // Return updated native → Admin merges it and prompts to save
                    this.sendTo(msg.from, msg.command, {
                        native: { allowlist: updatedList },
                        saveConfig: true,
                    }, msg.callback);
                } catch (e) {
                    this.log.warn(`addToAllowlist failed: ${e.message}`);
                    this.sendTo(msg.from, msg.command, { error: e.message }, msg.callback);
                }
                break;
            }
            case 'adoptDevice': {
                const mac = String(msg.message || '').toUpperCase().replace(/[:-]/g, '-').trim();
                if (/^[0-9A-F]{2}(-[0-9A-F]{2}){5}$/.test(mac)) {
                    await this._adoptDevice(mac);
                    this.sendTo(msg.from, msg.command, { success: true, mac }, msg.callback);
                } else {
                    this.sendTo(msg.from, msg.command, { success: false, error: 'Invalid MAC' }, msg.callback);
                }
                break;
            }
            case 'removeDevice': {
                const mac = String(msg.message || '').toUpperCase().replace(/[:-]/g, '-').trim();
                if (/^[0-9A-F]{2}(-[0-9A-F]{2}){5}$/.test(mac)) {
                    await this._removeAdoptedDevice(mac);
                    this.sendTo(msg.from, msg.command, { success: true, mac }, msg.callback);
                } else {
                    this.sendTo(msg.from, msg.command, { success: false, error: 'Invalid MAC' }, msg.callback);
                }
                break;
            }
            default:
                this.log.debug(`Unknown message command: ${msg.command}`);
                if (msg.callback) {
                    this.sendTo(msg.from, msg.command, { error: 'Unknown command' }, msg.callback);
                }
        }
    }

    //  State changes (write operations)
    // ─────────────────────────────────────────────────────────────────

    async onStateChange(id, state) {
        if (!state || state.ack) return;
        if (this._stopping) return;

        const localId = this.removeNamespace(id);

        // ── Discovery: adopt / remove device ────────────────────────
        if (localId === 'discovery.addDevice' && state.val) {
            const mac = String(state.val).toUpperCase().replace(/[:-]/g, '-').trim();
            if (/^[0-9A-F]{2}(-[0-9A-F]{2}){5}$/.test(mac)) {
                await this._adoptDevice(mac);
            } else {
                this.log.warn(`Invalid MAC for adoption: ${state.val}`);
            }
            await this.setStateAsync(localId, '', true);
            return;
        }
        if (localId === 'discovery.removeDevice' && state.val) {
            const mac = String(state.val).toUpperCase().replace(/[:-]/g, '-').trim();
            if (/^[0-9A-F]{2}(-[0-9A-F]{2}){5}$/.test(mac)) {
                await this._removeAdoptedDevice(mac);
            }
            await this.setStateAsync(localId, '', true);
            return;
        }

        // ── Action buttons ───────────────────────────────────────────
        if (localId.endsWith('.actions.connect')) {
            const mac = this._extractMacFromId(localId);
            if (mac) {
                this.log.info(`User triggered connect for ${mac}`);
                try {
                    const devicePath = this.bluez.macToDevicePath(mac.replace(/-/g, ':'));
                    await this.bluez.connect(devicePath);
                } catch (e) {
                    this.log.warn(`Connect failed for ${mac}: ${e.message}`);
                }
            }
            await this.setStateAsync(localId, false, true);
            return;
        }
        if (localId.endsWith('.actions.disconnect')) {
            const mac = this._extractMacFromId(localId);
            if (mac) {
                this.log.info(`User triggered disconnect for ${mac}`);
                try {
                    const devicePath = this.bluez.macToDevicePath(mac.replace(/-/g, ':'));
                    await this.bluez.disconnect(devicePath);
                } catch (e) {
                    this.log.warn(`Disconnect failed for ${mac}: ${e.message}`);
                }
            }
            await this.setStateAsync(localId, false, true);
            return;
        }
        // ── Telephony actions (HFP) ──────────────────────────────────
        if (localId.endsWith('.telephony.actions.answer')) {
            const mac = this._extractMacFromId(localId);
            if (mac && this.hfp) {
                this.log.info(`User triggered answer for ${mac}`);
                try { await this.hfp.answer(mac.replace(/-/g, ':')); }
                catch (e) { this.log.warn(`Answer failed for ${mac}: ${e.message}`); }
            }
            await this.setStateAsync(localId, false, true);
            return;
        }
        if (localId.endsWith('.telephony.actions.hangup')) {
            const mac = this._extractMacFromId(localId);
            if (mac && this.hfp) {
                this.log.info(`User triggered hangup for ${mac}`);
                try { await this.hfp.hangup(mac.replace(/-/g, ':')); }
                catch (e) { this.log.warn(`Hangup failed for ${mac}: ${e.message}`); }
            }
            await this.setStateAsync(localId, false, true);
            return;
        }
        if (localId.endsWith('.telephony.actions.reject')) {
            const mac = this._extractMacFromId(localId);
            if (mac && this.hfp) {
                this.log.info(`User triggered reject for ${mac}`);
                try { await this.hfp.reject(mac.replace(/-/g, ':')); }
                catch (e) { this.log.warn(`Reject failed for ${mac}: ${e.message}`); }
            }
            await this.setStateAsync(localId, false, true);
            return;
        }
        if (localId.endsWith('.telephony.actions.dial')) {
            const mac = this._extractMacFromId(localId);
            if (mac && this.hfp && state.val) {
                this.log.info(`User triggered dial for ${mac}: ${state.val}`);
                try { await this.hfp.dial(mac.replace(/-/g, ':'), String(state.val)); }
                catch (e) { this.log.warn(`Dial failed for ${mac}: ${e.message}`); }
            }
            await this.setStateAsync(localId, '', true);
            return;
        }
        if (localId.endsWith('.telephony.actions.redial')) {
            const mac = this._extractMacFromId(localId);
            if (mac && this.hfp && state.val) {
                this.log.info(`User triggered redial for ${mac}`);
                try { await this.hfp.redial(mac.replace(/-/g, ':')); }
                catch (e) { this.log.warn(`Redial failed for ${mac}: ${e.message}`); }
            }
            await this.setStateAsync(localId, false, true);
            return;
        }
        if (localId.endsWith('.telephony.actions.rawAT')) {
            const mac = this._extractMacFromId(localId);
            if (mac && this.hfp && state.val) {
                this.log.info(`User sending raw AT for ${mac}: ${state.val}`);
                try {
                    const resp = await this.hfp.sendRawAT(mac.replace(/-/g, ':'), String(state.val));
                    this.log.info(`Raw AT response for ${mac}: ${resp}`);
                } catch (e) {
                    this.log.warn(`Raw AT failed for ${mac}: ${e.message}`);
                }
            }
            await this.setStateAsync(localId, '', true);
            return;
        }

        // ── Media controls (AVRCP) ──────────────────────────────────
        const mediaActions = {
            '.media.play': 'play',
            '.media.pause': 'pause',
            '.media.stop': 'stop',
            '.media.next': 'next',
            '.media.previous': 'previous',
            '.media.forward': 'fastForward',
            '.media.rewind': 'rewind',
        };

        for (const [suffix, method] of Object.entries(mediaActions)) {
            if (localId.endsWith(suffix)) {
                const mac = this._extractMacFromId(localId);
                if (mac && this.avrcp) {
                    this.log.info(`AVRCP: ${method} for ${mac}`);
                    try { await this.avrcp[method](mac.replace(/-/g, ':')); }
                    catch (e) { this.log.warn(`AVRCP ${method} failed for ${mac}: ${e.message}`); }
                }
                await this.setStateAsync(localId, false, true);
                return;
            }
        }

        // AVRCP writable properties (shuffle, repeat)
        if (localId.endsWith('.media.shuffle')) {
            const mac = this._extractMacFromId(localId);
            if (mac && this.avrcp && state.val) {
                try { await this.avrcp.setProperty(mac.replace(/-/g, ':'), 'Shuffle', String(state.val)); }
                catch (e) { this.log.warn(`AVRCP Shuffle failed for ${mac}: ${e.message}`); }
            }
            return;
        }
        if (localId.endsWith('.media.repeat')) {
            const mac = this._extractMacFromId(localId);
            if (mac && this.avrcp && state.val) {
                try { await this.avrcp.setProperty(mac.replace(/-/g, ':'), 'Repeat', String(state.val)); }
                catch (e) { this.log.warn(`AVRCP Repeat failed for ${mac}: ${e.message}`); }
            }
            return;
        }

        // ── MAP notifications ────────────────────────────────────────
        if (localId.endsWith('.notifications.refresh')) {
            const mac = this._extractMacFromId(localId);
            if (mac && this.map) {
                this.log.info(`MAP: manual inbox refresh for ${mac}`);
                try { await this.map.refreshInbox(mac.replace(/-/g, ':')); }
                catch (e) { this.log.warn(`MAP refresh failed for ${mac}: ${e.message}`); }
            }
            await this.setStateAsync(localId, false, true);
            return;
        }

        if (localId.endsWith('.actions.confirmPairing')) {
            const mac = this._extractMacFromId(localId);
            if (mac) {
                // Read passkey value for pin/passkey input methods
                let inputValue;
                try {
                    const passkeyState = await this.getStateAsync(`${mac}.pairing.passkey`);
                    inputValue = passkeyState?.val;
                } catch (_) { /* ignore */ }
                this.log.info(`User confirmed pairing for ${mac}${inputValue ? ` (value: ${inputValue})` : ''}`);
                const agent = this.bluez.getAgent();
                if (agent) agent.confirmPairing(mac.replace(/-/g, ':'), inputValue);
            }
            await this.setStateAsync(localId, false, true);
            return;
        }
        if (localId.endsWith('.actions.rejectPairing')) {
            const mac = this._extractMacFromId(localId);
            if (mac) {
                this.log.info(`User rejected pairing for ${mac}`);
                const agent = this.bluez.getAgent();
                if (agent) agent.rejectPairing(mac.replace(/-/g, ':'));
            }
            await this.setStateAsync(localId, false, true);
            return;
        }
        if (localId.endsWith('.actions.pair')) {
            const mac = this._extractMacFromId(localId);
            if (mac) {
                this.log.info(`User triggered pair for ${mac}`);
                try {
                    const devicePath = this.bluez.macToDevicePath(mac.replace(/-/g, ':'));
                    await this.bluez.pair(devicePath);
                } catch (e) {
                    this.log.warn(`Pair failed for ${mac}: ${e.message}`);
                }
            }
            await this.setStateAsync(localId, false, true);
            return;
        }
        if (localId.endsWith('.actions.unpair')) {
            const mac = this._extractMacFromId(localId);
            if (mac) {
                this.log.info(`User triggered unpair for ${mac}`);
                try {
                    const devicePath = this.bluez.macToDevicePath(mac.replace(/-/g, ':'));
                    await this.bluez.unpair(devicePath);
                } catch (e) {
                    this.log.warn(`Unpair failed for ${mac}: ${e.message}`);
                }
            }
            await this.setStateAsync(localId, false, true);
            return;
        }

        // ── Trusted / Blocked toggles ────────────────────────────────
        if (localId.endsWith('.info.trusted')) {
            const mac = this._extractMacFromId(localId);
            if (mac) {
                try {
                    const devicePath = this.bluez.macToDevicePath(mac.replace(/-/g, ':'));
                    await this.bluez.trust(devicePath, !!state.val);
                } catch (e) {
                    this.log.warn(`Set trusted failed for ${mac}: ${e.message}`);
                }
            }
            return;
        }
        if (localId.endsWith('.info.blocked')) {
            const mac = this._extractMacFromId(localId);
            if (mac) {
                try {
                    const devicePath = this.bluez.macToDevicePath(mac.replace(/-/g, ':'));
                    await this.bluez.block(devicePath, !!state.val);
                } catch (e) {
                    this.log.warn(`Set blocked failed for ${mac}: ${e.message}`);
                }
            }
            return;
        }

        // ── On-demand read button ────────────────────────────────────
        if (localId.endsWith('.read')) {
            try {
                await this.deviceMgr.readOnDemand(localId);
            } catch (e) {
                this.log.warn(`On-demand read failed for ${localId}: ${e.message}`);
            }
            await this.setStateAsync(localId, false, true);
            return;
        }

        // ── Write to characteristic ──────────────────────────────────
        try {
            const obj = await this.getObjectAsync(localId);
            if (!obj || !obj.native || !obj.native.mac) return;

            const props = obj.native.properties || [];
            if (!props.includes('write') && !props.includes('write-without-response')) {
                this.log.warn(`${localId} is not writable`);
                return;
            }

            await this.deviceMgr.writeCharacteristic(localId, state.val, obj.native);
            this.log.debug(`Wrote to ${localId}`);

            // Read back if readable
            if (props.includes('read')) {
                try {
                    await this.deviceMgr.readOnDemand(localId);
                } catch (_) { /* best effort */ }
            }
        } catch (e) {
            this.log.warn(`Write failed for ${localId}: ${e.message}`);
        }
    }

    // ─────────────────────────────────────────────────────────────────
    //  D-Bus event handlers
    // ─────────────────────────────────────────────────────────────────

    /**
     * Called when a new device is discovered.
     * @param {string} mac
     * @param {object} deviceProps
     */
    async _onDeviceFound(mac, deviceProps) {
        if (this._stopping) return;

        try {
            const devId = mac.replace(/:/g, '-').toUpperCase();

            // ── Update discovery list (always, for all devices) ──────
            const isTransient = deviceProps.addressType === 'random' && !deviceProps.paired;
            this._discovery.set(mac.toUpperCase(), {
                mac: mac.toUpperCase(),
                name: deviceProps.name || deviceProps.alias || '',
                rssi: deviceProps.rssi ?? null,
                type: deviceProps.type || 'unknown',
                paired: deviceProps.paired ?? false,
                adopted: this._isAdopted(devId),
                transient: isTransient,
                lastSeen: Date.now(),
            });

            // Track source
            if (!this._deviceSources.has(devId)) {
                this._deviceSources.set(devId, new Set());
            }
            this._deviceSources.get(devId).add('bluez');

            // Auto-adopt paired devices on discovery
            if (deviceProps.paired && !this._adopted.has(devId)) {
                this.log.info(`Auto-adopting paired device: ${devId} (${deviceProps.name || 'unnamed'})`);
                await this._adoptDevice(devId);
            }

            // ── Only create ioBroker objects for adopted devices ─────
            if (!this._isAdopted(devId)) {
                return;
            }

            // Create device objects
            await this.deviceMgr.ensureDeviceObjects(devId, deviceProps);

            // ── Advertisement data ───────────────────────────────────
            this._processAdvertisementData(devId, deviceProps);

            // ── BTHome detection ─────────────────────────────────────
            if (deviceProps.serviceData && deviceProps.serviceData.length > 0) {
                this.log.info(`${devId}: serviceData present (${deviceProps.serviceData.length} entries)`);
            }
            this._processBTHome(devId, deviceProps.serviceData);

            // Auto-connect if in allowlist
            const inAllowlist = this._cfg.allowlist.includes(devId);
            if (this._cfg.autoConnect && inAllowlist) {
                await this._connectAndDiscover(mac);
            }
        } catch (e) {
            this.log.warn(`Error processing device ${mac}: ${e.message}`);
        }
    }

    /**
     * Called when device properties change.
     * @param {string} mac
     * @param {object} changed
     */
    async _onDeviceChanged(mac, changed) {
        if (this._stopping) return;

        try {
            const devId = mac.replace(/:/g, '-').toUpperCase();

            // Update discovery list metadata
            const entry = this._discovery.get(mac.toUpperCase());
            if (entry) {
                if ('rssi' in changed) entry.rssi = changed.rssi;
                if ('name' in changed) entry.name = changed.name;
                if ('paired' in changed) entry.paired = changed.paired;
                if ('connected' in changed) entry.connected = changed.connected;
                entry.lastSeen = Date.now();
            }

            // Auto-adopt on pairing (user explicitly paired → they want this device)
            if ('paired' in changed && changed.paired && !this._isAdopted(devId)) {
                await this._adoptDevice(devId);
            }

            // Only process adopted devices further
            if (!this._isAdopted(devId)) return;

            // Ensure objects exist (idempotent – also handles migration of new states)
            const device = this.bluez.getDevice(mac);
            if (device) {
                await this.deviceMgr.ensureDeviceObjects(devId, device);
            }

            // Update ioBroker states
            await this.deviceMgr.updateDeviceStates(devId, changed);

            // Process advertisement updates
            if (changed.manufacturerData || changed.serviceData) {
                const device = this.bluez.getDevice(mac);
                if (device) {
                    this._processAdvertisementData(devId, device);
                }
            }

            // BTHome updates
            if (changed.serviceData) {
                this.log.info(`${devId}: serviceData changed (${changed.serviceData.length} entries)`);
                this._processBTHome(devId, changed.serviceData);
            }

            // When a device gets newly paired, connect and trigger HFP
            if ('paired' in changed && changed.paired) {
                this.log.info(`Device ${mac} paired — initiating connection + HFP`);
                try {
                    const devicePath = this.bluez.macToDevicePath(mac);
                    // Trust the device so it can auto-reconnect in the future
                    try {
                        const proxy = await this.bluez._bus.getProxyObject('org.bluez', devicePath);
                        const props = proxy.getInterface('org.freedesktop.DBus.Properties');
                        await props.Set('org.bluez.Device1', 'Trusted', new (require('@deltachat/dbus-next')).Variant('b', true));
                    } catch (e) { this.log.debug(`Trust set failed: ${e.message}`); }
                    // Connect the device (establishes all profiles)
                    const device = this.bluez.getDevice(mac);
                    if (!device || !device.connected) {
                        await this.bluez.connect(devicePath);
                    }
                    // Give it time to settle, then explicitly request HFP profile
                    await new Promise(r => setTimeout(r, 2000));
                    if (this.hfp && !this.hfp.isConnected(mac)) {
                        try {
                            await this.bluez.connectProfile(devicePath, '0000111f-0000-1000-8000-00805f9b34fb');
                        } catch (e) {
                            this.log.debug(`HFP ConnectProfile after pairing: ${e.message}`);
                        }
                    }
                } catch (e) {
                    this.log.warn(`Post-pairing connect failed for ${mac}: ${e.message}`);
                }
            }

            // When a paired device connects but HFP isn't up, trigger it
            if ('connected' in changed && changed.connected) {
                const device = this.bluez.getDevice(mac);
                if (device && device.paired && this.hfp && !this.hfp.isConnected(mac)) {
                    this.log.info(`Device ${mac} connected but no HFP — requesting HFP profile`);
                    setTimeout(async () => {
                        if (this.hfp.isConnected(mac)) return; // already connected
                        try {
                            const devicePath = this.bluez.macToDevicePath(mac);
                            await this.bluez.connectProfile(devicePath, '0000111f-0000-1000-8000-00805f9b34fb');
                        } catch (e) {
                            this.log.debug(`HFP ConnectProfile on connect: ${e.message}`);
                        }
                    }, 3000);
                }

                // Auto-connect MAP for message notifications
                if (device && device.paired) {
                    const uuids = device.uuids || [];
                    setTimeout(() => this._tryMapConnect(mac, uuids), 5000);
                }
            }

            // Handle disconnect for reconnect
            if ('connected' in changed && !changed.connected) {
                // Tear down MAP session
                this._tryMapDisconnect(mac);
                if (this._cfg.autoConnect && this._isAdopted(devId)) {
                    this.log.info(`${mac} disconnected`);
                    await this.deviceMgr.setDisconnected(devId);
                    this._scheduleReconnect(mac);
                }
            }
        } catch (e) {
            this.log.warn(`Error updating device ${mac}: ${e.message}`);
        }
    }

    /**
     * Called when a device is removed from BlueZ.
     * @param {string} mac
     */
    async _onDeviceRemoved(mac) {
        if (this._stopping) return;
        this.log.info(`Device removed: ${mac}`);
        // Don't delete ioBroker objects — but reset connection/pairing states
        const devId = mac.replace(/:/g, '-').toUpperCase();
        try {
            await this.setStateAsync(`${devId}.info.connected`, { val: false, ack: true });
            await this.setStateAsync(`${devId}.info.paired`, { val: false, ack: true });
        } catch (_) { /* states may not exist */ }
    }

    // ─────────────────────────────────────────────────────────────────
    //  Shelly BLE Gateway events
    // ─────────────────────────────────────────────────────────────────

    /**
     * Handle a BLE device discovered via Shelly gateway.
     * @param {{mac: string, name: string|null, rssi: number|null, source: string,
     *          serviceData: Array, manufacturerData: object|null, txPower: number|null,
     *          bthome: object|null}} event
     */
    async _onShellyDeviceFound(event) {
        if (this._stopping) return;

        try {
            const devId = event.mac.replace(/:/g, '-').toUpperCase();

            // Track source
            if (!this._deviceSources.has(devId)) {
                this._deviceSources.set(devId, new Set());
            }
            this._deviceSources.get(devId).add(`shelly:${event.source}`);

            // Update discovery list
            this._discovery.set(event.mac, {
                mac: event.mac,
                name: event.name || '',
                rssi: event.rssi,
                type: 'le',
                paired: false,
                adopted: this._isAdopted(devId),
                transient: false,
                lastSeen: Date.now(),
            });

            // Only create objects for adopted devices
            if (!this._isAdopted(devId)) return;

            // Ensure device objects exist
            await this.deviceMgr.ensureDeviceObjects(devId, {
                name: event.name || '',
                rssi: event.rssi,
                connected: false,
                type: 'le',
            });

            // Update dynamic states
            await this.deviceMgr.updateDeviceStates(devId, {
                rssi: event.rssi,
                name: event.name,
            });

            // Update source state
            await this._updateSourceState(devId);

            // Process BTHome data if present
            if (event.bthome && event.bthome.values && event.bthome.values.length > 0) {
                await this.deviceMgr.ensureBTHomeObjects(devId, event.bthome.values);
            }

            // Process manufacturer data
            if (event.manufacturerData) {
                const mfrHex = event.manufacturerData.data.toString('hex');
                const companyId = event.manufacturerData.companyId;
                await this.setStateAsync(`${devId}.info.manufacturerData`, {
                    val: `0x${companyId.toString(16).padStart(4, '0')}: ${mfrHex}`,
                    ack: true,
                });
            }

            // Update service data
            if (event.serviceData && event.serviceData.length > 0) {
                const sdJson = event.serviceData.map(sd => ({
                    uuid: sd.uuid,
                    data: sd.data.toString('hex'),
                }));
                await this.setStateAsync(`${devId}.info.serviceData`, {
                    val: JSON.stringify(sdJson),
                    ack: true,
                });
            }
        } catch (e) {
            this.log.warn(`ShellyGateway: error processing ${event.mac}: ${e.message}`);
        }
    }

    /**
     * Update the info.source state for a device.
     * @param {string} devId
     */
    async _updateSourceState(devId) {
        const sources = this._deviceSources.get(devId);
        if (!sources) return;

        const stateId = `${devId}.info.source`;
        await this.setObjectNotExistsAsync(stateId, {
            type: 'state',
            common: {
                name: 'Discovery source',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setStateAsync(stateId, { val: [...sources].join(', '), ack: true });
    }

    // ─────────────────────────────────────────────────────────────────
    //  Advertisement & BTHome processing
    // ─────────────────────────────────────────────────────────────────

    /**
     * Process advertisement data and update ioBroker states.
     * @param {string} devId – ioBroker device ID
     * @param {object} deviceProps – device properties from BluezManager
     */
    _processAdvertisementData(devId, deviceProps) {
        const advParsed = parseAdvertisement({
            manufacturerData: deviceProps.manufacturerData,
            serviceData: deviceProps.serviceData,
            txPowerLevel: deviceProps.txPower,
        });

        // Update manufacturer data
        if (advParsed.manufacturerData) {
            const mfr = advParsed.manufacturerData;
            const label = mfr.companyName
                ? `${mfr.companyName} (0x${mfr.companyId.toString(16).padStart(4, '0')}): ${mfr.data}`
                : mfr.raw;
            this.setStateAsync(`${devId}.info.manufacturerData`, { val: label, ack: true });
            // Resolved manufacturer name (human-readable)
            if (mfr.companyName) {
                this.setStateAsync(`${devId}.info.manufacturer`, { val: mfr.companyName, ack: true });
            }
        }

        // Update TX power level
        if (advParsed.txPowerLevel !== null) {
            this.setStateAsync(`${devId}.info.txPowerLevel`, { val: advParsed.txPowerLevel, ack: true });
        }

        // Update service data
        if (advParsed.serviceData.length > 0) {
            this.setStateAsync(`${devId}.info.serviceData`, {
                val: JSON.stringify(advParsed.serviceData),
                ack: true,
            });
        }
    }

    /**
     * Check for BTHome v2 data in service data and parse it.
     * @param {string} devId – ioBroker device ID (MAC with dashes)
     * @param {Array<{uuid: string, data: Buffer}>|null} serviceData
     */
    async _processBTHome(devId, serviceData) {
        if (!serviceData) return;

        const bthomeRaw = findBTHomeData(serviceData);
        this.log.debug(`${devId}: findBTHomeData result: ${bthomeRaw ? bthomeRaw.length + ' bytes' : 'null'} (UUIDs: ${serviceData.map(s => s.uuid).join(',')})`);
        if (bthomeRaw) {
            const bthomeResult = parseBTHome(bthomeRaw);
            if (bthomeResult && bthomeResult.values.length > 0) {
                const mac = devId;
                this.log.debug(`${mac}: BTHome v${bthomeResult.version} – ${bthomeResult.values.length} value(s)`);
                await this.deviceMgr.ensureBTHomeObjects(mac, bthomeResult.values);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────
    //  Connect / Reconnect
    // ─────────────────────────────────────────────────────────────────

    async _connectAndDiscover(mac) {
        const devId = mac.replace(/:/g, '-').toUpperCase();
        const devicePath = this.bluez.macToDevicePath(mac);

        // Already connected?
        const device = this.bluez.getDevice(mac);
        if (device && device.connected) return;

        try {
            await this.bluez.connect(devicePath);
            await this.setStateAsync(`${devId}.info.connected`, true, true);

            // Reset reconnect state on success
            this._reconnect.delete(mac);

            // GATT discovery
            const services = await this.bluez.discoverServices(devicePath);
            await this.deviceMgr.buildCharacteristicTree(devId, services);
        } catch (e) {
            const msg = e.message || '';
            this.log.warn(`Connect/discover failed for ${mac}: ${msg}`);
            await this.setStateAsync(`${devId}.info.connected`, false, true);

            // Don't retry on permanent errors (missing profile, auth rejected, etc.)
            const permanent = [
                'br-connection-profile-unavailable',
                'br-connection-refused',
                'le-connection-abort-by-local',
                'NotAvailable',
                'AuthenticationFailed',
                'AuthenticationCanceled',
                'AuthenticationRejected',
                'AuthenticationTimeout',
                'ConnectionAttemptFailed',
            ];
            if (permanent.some(p => msg.includes(p))) {
                this.log.info(`Not retrying ${mac} — permanent error: ${msg}`);
                this._reconnect.delete(mac);
                return;
            }

            this._scheduleReconnect(mac);
        }
    }

    _scheduleReconnect(mac) {
        if (this._stopping) return;
        if (!this._cfg.reconnectEnabled) return;

        let rs = this._reconnect.get(mac);
        if (!rs) {
            rs = { attempt: 0, timer: null };
            this._reconnect.set(mac, rs);
        }

        // Exponential backoff
        const delay = Math.min(
            this._cfg.reconnectBaseDelay * Math.pow(2, rs.attempt),
            this._cfg.reconnectMaxDelay
        );
        rs.attempt++;

        this.log.debug(`Scheduling reconnect for ${mac} in ${delay / 1000}s (attempt ${rs.attempt})`);

        if (rs.timer) clearTimeout(rs.timer);
        rs.timer = setTimeout(async () => {
            if (this._stopping) return;
            this.log.info(`Reconnecting to ${mac} (attempt ${rs.attempt}) …`);
            await this._connectAndDiscover(mac);
        }, delay);
    }

    // ─────────────────────────────────────────────────────────────────
    //  HFP Telephony
    // ─────────────────────────────────────────────────────────────────

    /**
     * Wire up HFP profile events to ioBroker states.
     */
    _wireHfpEvents() {
        if (!this.hfp) return;

        // preConnect fires BEFORE SLC — create objects so indicator events
        // during the AT handshake don't produce "no existing object" warnings.
        this.hfp.on('preConnect', async (mac) => {
            const devId = mac.replace(/:/g, '-').toUpperCase();
            this.log.debug(`HFP preConnect for ${devId} — creating telephony objects`);
            await this._ensureTelephonyObjectsOnce(devId);
        });

        this.hfp.on('agFeatures', async (mac, features) => {
            const devId = mac.replace(/:/g, '-').toUpperCase();
            await this._ensureTelephonyObjectsOnce(devId);
            await this.setObjectNotExistsAsync(`${devId}.telephony.agFeatures`, {
                type: 'state', common: { type: 'string', role: 'text', name: 'AG Features (hex)', read: true, write: false }, native: {},
            });
            await this.setStateAsync(`${devId}.telephony.agFeatures`, `0x${features.toString(16)} (${features})`, true);
        });

        this.hfp.on('connected', async (mac) => {
            const devId = mac.replace(/:/g, '-').toUpperCase();
            await this._ensureTelephonyObjectsOnce(devId);
            await this.setStateAsync(`${devId}.telephony.connected`, true, true);
            await this.setStateAsync(`${devId}.telephony.callState`, 'idle', true);
        });

        this.hfp.on('disconnected', async (mac) => {
            const devId = mac.replace(/:/g, '-').toUpperCase();

            // Auto-reconnect HFP if the Bluetooth link is still up.
            // Don't mark as disconnected yet — the reconnect cycle keeps it alive.
            if (!this._stopping) {
                const device = this.bluez.getDevice(mac);
                if (device && device.connected) {
                    // BT link up → expected Android RFCOMM cycle, reconnect silently
                    this._scheduleHfpReconnect(mac);
                    return;
                }
            }
            // BT link down or adapter stopping → genuinely disconnected
            await this.setStateAsync(`${devId}.telephony.connected`, false, true);
            await this.setStateAsync(`${devId}.telephony.callState`, 'idle', true);
        });

        this.hfp.on('callState', async (mac, info) => {
            const devId = mac.replace(/:/g, '-').toUpperCase();
            await this._ensureTelephonyObjectsOnce(devId);
            await this.setStateAsync(`${devId}.telephony.callState`, info.state, true);
            if (info.number) {
                await this.setStateAsync(`${devId}.telephony.callerNumber`, info.number, true);
            }
            if (info.name) {
                await this.setStateAsync(`${devId}.telephony.callerName`, info.name, true);
            }
            // Clear caller info when idle
            if (info.state === 'idle') {
                await this.setStateAsync(`${devId}.telephony.callerNumber`, '', true);
                await this.setStateAsync(`${devId}.telephony.callerName`, '', true);
            }
        });

        this.hfp.on('indicator', async (mac, ind) => {
            const devId = mac.replace(/:/g, '-').toUpperCase();
            await this._ensureTelephonyObjectsOnce(devId);
            await this.setStateAsync(`${devId}.telephony.indicator_${ind.name}`, ind.value, true);
        });

        this.hfp.on('batteryLevel', async (mac, level) => {
            const devId = mac.replace(/:/g, '-').toUpperCase();
            await this._ensureTelephonyObjectsOnce(devId);
            const pct = Math.round((level / 5) * 100);
            await this.setStateAsync(`${devId}.telephony.phoneBattery`, pct, true);
        });

        this.hfp.on('signalStrength', async (mac, level) => {
            const devId = mac.replace(/:/g, '-').toUpperCase();
            await this._ensureTelephonyObjectsOnce(devId);
            await this.setStateAsync(`${devId}.telephony.signalStrength`, level, true);
        });

        this.hfp.on('operatorName', async (mac, name) => {
            const devId = mac.replace(/:/g, '-').toUpperCase();
            await this._ensureTelephonyObjectsOnce(devId);
            await this.setStateAsync(`${devId}.telephony.operator`, name, true);
        });
    }

    // ─────────────────────────────────────────────────────────────────
    //  AVRCP events
    // ─────────────────────────────────────────────────────────────────

    /**
     * Wire up AVRCP controller events + BlueZ MediaPlayer1 signals.
     */
    _wireAvrcpEvents() {
        if (!this.avrcp) return;

        // Player found (on init or InterfacesAdded)
        this.avrcp.on('playerFound', async (mac, _path, props) => {
            const devId = mac.replace(/:/g, '-').toUpperCase();
            await this.deviceMgr.ensureMediaObjects(devId);
            await this.deviceMgr.updateMediaStates(devId, props);
        });

        // Player removed
        this.avrcp.on('playerRemoved', async (mac, _path) => {
            const devId = mac.replace(/:/g, '-').toUpperCase();
            await this.setStateAsync(`${devId}.media.status`, { val: 'stopped', ack: true });
        });

        // Player properties changed (track, status, position, etc.)
        this.avrcp.on('playerChanged', async (mac, _path, changed) => {
            const devId = mac.replace(/:/g, '-').toUpperCase();
            await this.deviceMgr.updateMediaStates(devId, changed);
        });

        // Forward BlueZ D-Bus signals to AVRCP controller
        this.bluez.on('mediaPlayerAdded', (path, interfaces) => {
            this.avrcp.onInterfacesAdded(path, interfaces);
        });
        this.bluez.on('mediaPlayerRemoved', (path, interfaces) => {
            this.avrcp.onInterfacesRemoved(path, interfaces);
        });
        this.bluez.on('mediaPlayerChanged', (path, changed) => {
            this.avrcp.onPropertiesChanged(path, changed);
        });
    }

    // ─────────────────────────────────────────────────────────────────
    //  MAP events
    // ─────────────────────────────────────────────────────────────────

    /**
     * Wire up MAP client events.
     */
    _wireMapEvents() {
        if (!this.map) return;

        this.map.on('connected', async (mac, _sessionPath) => {
            const devId = mac.replace(/:/g, '-').toUpperCase();
            await this.deviceMgr.ensureNotificationObjects(devId);
            await this.setStateAsync(`${devId}.notifications.connected`, { val: true, ack: true });
        });

        this.map.on('disconnected', async (mac) => {
            const devId = mac.replace(/:/g, '-').toUpperCase();
            try {
                await this.setStateAsync(`${devId}.notifications.connected`, { val: false, ack: true });
            } catch (_) { /* state might not exist yet */ }
        });

        this.map.on('messagesUpdated', async (mac, messages, unreadCount) => {
            const devId = mac.replace(/:/g, '-').toUpperCase();
            await this.deviceMgr.updateNotificationStates(devId, messages, unreadCount);
        });

        this.map.on('newMessage', async (mac, msg) => {
            const devId = mac.replace(/:/g, '-').toUpperCase();
            this.log.info(`MAP: [${devId}] new ${msg.type} from ${msg.sender || msg.senderAddress}: ${msg.subject}`);
        });

        this.map.on('error', (mac, err) => {
            this.log.warn(`MAP: error for ${mac}: ${err.message}`);
        });
    }

    /**
     * Called when a device connects – attempt MAP session if supported.
     * @param {string} mac – colon-separated
     * @param {string[]} uuids – device service UUIDs
     */
    async _tryMapConnect(mac, uuids) {
        if (!this.map) return;
        if (!MapClient.supportsMap(uuids)) return;
        if (this.map.hasSession(mac)) return;

        this.log.info(`MAP: device ${mac} supports MAP, attempting session…`);
        // Run async – don't block the caller (can take 20s+ if phone prompts)
        this.map.connectDevice(mac).catch(err => {
            this.log.debug(`MAP: connect attempt for ${mac}: ${err.message}`);
        });
    }

    /**
     * Called when a device disconnects – tear down MAP session.
     * @param {string} mac – colon-separated
     */
    async _tryMapDisconnect(mac) {
        if (!this.map) return;
        if (!this.map.hasSession(mac)) return;

        this.map.disconnectDevice(mac).catch(err => {
            this.log.debug(`MAP: disconnect for ${mac}: ${err.message}`);
        });
    }

    /**
     * Attempt to re-establish HFP RFCOMM by reconnecting the profile.
     * Uses exponential backoff (3s → 6s → 12s → max 60s).
     * @param {string} mac – colon-separated
     */
    _scheduleHfpReconnect(mac) {
        if (this._stopping || !this.hfp) return;

        const key = `hfp:${mac}`;
        let rs = this._reconnect.get(key);
        if (!rs) {
            rs = { attempt: 0, timer: null };
            this._reconnect.set(key, rs);
        }

        // Cap at 10 attempts to avoid infinite loop
        if (rs.attempt >= 10) {
            this.log.info(`HFP reconnect for ${mac} giving up after ${rs.attempt} attempts`);
            this._reconnect.delete(key);
            return;
        }

        const delay = Math.min(5000 * Math.pow(2, rs.attempt), 60000);
        rs.attempt++;

        this.log.debug(`HFP reconnect for ${mac} in ${delay / 1000}s (attempt ${rs.attempt})`);

        if (rs.timer) clearTimeout(rs.timer);
        rs.timer = setTimeout(async () => {
            if (this._stopping) return;
            try {
                // Only reconnect if Bluetooth link is still up
                const device = this.bluez.getDevice(mac);
                if (!device || !device.connected) {
                    this.log.debug(`HFP reconnect skipped for ${mac} — device not BT-connected`);
                    this._reconnect.delete(key);
                    return;
                }
                // Already reconnected by BlueZ AutoConnect?
                if (this.hfp.isConnected(mac)) {
                    this.log.debug(`HFP already reconnected for ${mac}`);
                    this._reconnect.delete(key);
                    return;
                }
                this.log.debug(`HFP reconnecting ${mac} (attempt ${rs.attempt})…`);
                const devicePath = this.bluez.macToDevicePath(mac);
                // Full disconnect+reconnect cycle to trigger the phone's
                // profile auto-connect (ConnectProfile alone fails on Android)
                try { await this.bluez.disconnect(devicePath); } catch (_) { /* may already be disconnected */ }
                await new Promise(r => setTimeout(r, 1000));
                await this.bluez.connect(devicePath);
                // BlueZ + phone should re-establish all profiles including HFP
                this._reconnect.delete(key);
            } catch (e) {
                this.log.warn(`HFP reconnect failed for ${mac}: ${e.message}`);
                // Retry
                this._scheduleHfpReconnect(mac);
            }
        }, delay);
    }

    /**
     * Deduplicated wrapper — ensures objects are created exactly once per
     * device, even when many events fire concurrently during SLC.
     * @param {string} devId
     */
    async _ensureTelephonyObjectsOnce(devId) {
        if (this._telephonyReady.has(devId)) return;

        // Deduplicate concurrent calls
        let pending = this._telephonyPending.get(devId);
        if (pending) return pending;

        pending = this._ensureTelephonyObjects(devId).then(() => {
            this._telephonyReady.add(devId);
            this._telephonyPending.delete(devId);
        }).catch((e) => {
            this._telephonyPending.delete(devId);
            this.log.warn(`Failed to create telephony objects for ${devId}: ${e.message}`);
        });

        this._telephonyPending.set(devId, pending);
        return pending;
    }

    /**
     * Create telephony state objects for a device.
     * @param {string} devId
     */
    async _ensureTelephonyObjects(devId) {
        const channel = `${devId}.telephony`;
        await this.setObjectNotExistsAsync(channel, {
            type: 'channel', common: { name: 'Telephony (HFP)' }, native: {},
        });

        const states = {
            connected:          { type: 'boolean', role: 'indicator.connected',  name: 'HFP connected',   read: true, write: false },
            callState:          { type: 'string',  role: 'text',                name: 'Call state',       read: true, write: false },
            callerNumber:       { type: 'string',  role: 'text',                name: 'Caller number',    read: true, write: false },
            callerName:         { type: 'string',  role: 'text',                name: 'Caller name',      read: true, write: false },
            phoneBattery:       { type: 'number',  role: 'value.battery',       name: 'Phone battery %',  read: true, write: false, unit: '%', min: 0, max: 100 },
            signalStrength:     { type: 'number',  role: 'value',               name: 'Signal strength',  read: true, write: false, min: 0, max: 5 },
            operator:           { type: 'string',  role: 'text',                name: 'Network operator', read: true, write: false },
            // HFP indicator states (raw values from AG)
            indicator_call:     { type: 'number',  role: 'value',  name: 'Call indicator (0=none, 1=active)',       read: true, write: false, min: 0, max: 1 },
            indicator_callsetup:{ type: 'number',  role: 'value',  name: 'Call setup (0=none, 1=in, 2=out, 3=alert)', read: true, write: false, min: 0, max: 3 },
            indicator_callheld: { type: 'number',  role: 'value',  name: 'Call held (0=none, 1=held+active, 2=held)', read: true, write: false, min: 0, max: 2 },
            indicator_service:  { type: 'number',  role: 'value',  name: 'Service availability (0=no, 1=yes)',     read: true, write: false, min: 0, max: 1 },
            indicator_signal:   { type: 'number',  role: 'value',  name: 'Signal level (0-5)',                     read: true, write: false, min: 0, max: 5 },
            indicator_roam:     { type: 'number',  role: 'value',  name: 'Roaming (0=no, 1=yes)',                  read: true, write: false, min: 0, max: 1 },
            indicator_battchg:  { type: 'number',  role: 'value.battery', name: 'Battery level (0-5)',             read: true, write: false, min: 0, max: 5 },
        };

        for (const [id, common] of Object.entries(states)) {
            await this.setObjectNotExistsAsync(`${channel}.${id}`, {
                type: 'state', common, native: {},
            });
        }

        // Actions
        const actions = `${channel}.actions`;
        await this.setObjectNotExistsAsync(actions, {
            type: 'channel', common: { name: 'Telephony actions' }, native: {},
        });

        const actionStates = {
            answer: { type: 'boolean', role: 'button', name: 'Answer call',  read: false, write: true },
            hangup: { type: 'boolean', role: 'button', name: 'Hang up',      read: false, write: true },
            reject: { type: 'boolean', role: 'button', name: 'Reject call',  read: false, write: true },
            dial:   { type: 'string',  role: 'text',   name: 'Dial number',  read: true,  write: true },
            redial: { type: 'boolean', role: 'button', name: 'Redial last number', read: false, write: true },
            rawAT:  { type: 'string',  role: 'text',   name: 'Send raw AT command', read: true, write: true },
        };

        for (const [id, common] of Object.entries(actionStates)) {
            await this.setObjectNotExistsAsync(`${actions}.${id}`, {
                type: 'state', common, native: {},
            });
        }
    }

    // ─────────────────────────────────────────────────────────────────
    //  Pairing Agent
    // ─────────────────────────────────────────────────────────────────

    /**
     * Handle pairing request from BlueZ agent.
     * Creates ioBroker states for passkey display and user confirmation.
     * @param {{ device: string, mac: string, method: string, passkey: string|null }} req
     */
    async _onPairingRequest(req) {
        const devId = req.mac.replace(/:/g, '-').toUpperCase();

        this.log.info(`Pairing request from ${req.mac} (method: ${req.method}, passkey: ${req.passkey || 'n/a'})`);

        // Ensure pairing states exist
        await this.setObjectNotExistsAsync(`${devId}.pairing`, {
            type: 'channel',
            common: { name: 'Pairing' },
            native: {},
        });
        await this.setObjectNotExistsAsync(`${devId}.pairing.passkey`, {
            type: 'state',
            common: { name: 'Passkey / PIN code', type: 'string', role: 'text', read: true, write: true },
            native: {},
        });
        await this.setObjectNotExistsAsync(`${devId}.pairing.method`, {
            type: 'state',
            common: { name: 'Pairing method', type: 'string', role: 'text', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync(`${devId}.pairing.pending`, {
            type: 'state',
            common: { name: 'Pairing pending', type: 'boolean', role: 'indicator', read: true, write: false },
            native: {},
        });

        // Ensure confirm/reject action buttons exist
        await this.setObjectNotExistsAsync(`${devId}.actions.confirmPairing`, {
            type: 'state',
            common: { name: 'Confirm pairing', type: 'boolean', role: 'button', read: false, write: true },
            native: {},
        });
        await this.setObjectNotExistsAsync(`${devId}.actions.rejectPairing`, {
            type: 'state',
            common: { name: 'Reject pairing', type: 'boolean', role: 'button', read: false, write: true },
            native: {},
        });

        // Set pairing info
        await this.setStateAsync(`${devId}.pairing.passkey`, { val: req.passkey || '', ack: true });
        await this.setStateAsync(`${devId}.pairing.method`, { val: req.method, ack: true });
        await this.setStateAsync(`${devId}.pairing.pending`, { val: true, ack: true });

        // When pairing is resolved (either way), clear pending
        const clearPending = async () => {
            await this.setStateAsync(`${devId}.pairing.pending`, { val: false, ack: true });
            await this.setStateAsync(`${devId}.pairing.passkey`, { val: '', ack: true });
        };

        // For interactive methods: wait for user input/confirmation.
        if (req.method === 'confirmation' || req.method === 'passkey' || req.method === 'pin') {
            const label = req.method === 'confirmation'
                ? `passkey ${req.passkey} – confirm via ${devId}.actions.confirmPairing`
                : `enter ${req.method} via ${devId}.pairing.passkey then confirm`;
            this.log.warn(`⚡ Pairing ${req.method} needed for ${req.mac}: ${label}`);

            // Set a watcher to clear pending when the agent resolves
            const agent = this.bluez.getAgent();
            if (agent) {
                const mac = req.mac;
                const key = mac.replace(/[-]/g, ':').toUpperCase();
                // Poll for pending resolution (agent clears its _pending map)
                const checkInterval = setInterval(async () => {
                    if (!agent._pending.has(key)) {
                        clearInterval(checkInterval);
                        await clearPending();
                    }
                }, 1000);
                // Safety timeout
                setTimeout(() => {
                    clearInterval(checkInterval);
                    clearPending();
                }, 35000);
            }
        } else {
            // Non-interactive methods – clear immediately
            setTimeout(() => clearPending(), 2000);
        }
    }

    // ─────────────────────────────────────────────────────────────────
    //  Helpers
    // ─────────────────────────────────────────────────────────────────

    /**
     * Strip adapter namespace prefix from an id.
     * e.g. "bluetooth.0.AA-BB.info.name" → "AA-BB.info.name"
     */
    removeNamespace(id) {
        const ns = `${this.namespace}.`;
        return id.startsWith(ns) ? id.slice(ns.length) : id;
    }

    /**
     * Extract MAC (dashed format) from a local state id.
     * e.g. "AA-BB-CC-DD-EE-FF.actions.connect" → "AA-BB-CC-DD-EE-FF"
     * @param {string} localId
     * @returns {string|null}
     */
    _extractMacFromId(localId) {
        const parts = localId.split('.');
        for (const p of parts) {
            if (/^[0-9A-F]{2}(-[0-9A-F]{2}){5}$/.test(p)) return p;
        }
        return null;
    }

    // ─────────────────────────────────────────────────────────────────
    //  Discovery & Adoption
    // ─────────────────────────────────────────────────────────────────

    /**
     * Initialize discovery states and load persisted adopted devices.
     */
    async _initDiscovery() {
        // ── Create discovery channel + states ────────────────────────
        await this.setObjectNotExistsAsync('discovery', {
            type: 'channel',
            common: { name: 'Device discovery' },
            native: {},
        });
        await this.setObjectNotExistsAsync('discovery.devices', {
            type: 'state',
            common: { name: 'Discovered devices (JSON)', type: 'string', role: 'json', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync('discovery.addDevice', {
            type: 'state',
            common: { name: 'Adopt device (write MAC)', type: 'string', role: 'text', read: false, write: true },
            native: {},
        });
        await this.setObjectNotExistsAsync('discovery.removeDevice', {
            type: 'state',
            common: { name: 'Remove device (write MAC)', type: 'string', role: 'text', read: false, write: true },
            native: {},
        });
        await this.setObjectNotExistsAsync('discovery.adoptedDevices', {
            type: 'state',
            common: { name: 'Adopted device MACs (JSON)', type: 'string', role: 'json', read: true, write: false },
            native: {},
        });

        // ── Load persisted adopted devices ───────────────────────────
        try {
            const state = await this.getStateAsync('discovery.adoptedDevices');
            if (state && state.val) {
                const arr = JSON.parse(String(state.val));
                if (Array.isArray(arr)) {
                    for (const mac of arr) this._adopted.add(mac.toUpperCase());
                }
            }
        } catch (_) { /* first run, no state yet */ }

        // Also consider allowlist entries as adopted
        for (const mac of this._cfg.allowlist) {
            this._adopted.add(mac.toUpperCase());
        }

        this.log.info(`Adopted devices: ${this._adopted.size} (allowlist: ${this._cfg.allowlist.length})`);

        // ── Periodic discovery flush (every 10s) ─────────────────────
        this._discoveryFlushTimer = setInterval(() => {
            this._flushDiscoveryList();
        }, 10000);
    }

    /**
     * Check if a device (dashed MAC) is adopted.
     * Adopted = allowlisted OR explicitly adopted OR currently paired.
     * @param {string} devId – e.g. "AA-BB-CC-DD-EE-FF"
     * @returns {boolean}
     */
    _isAdopted(devId) {
        if (this._adopted.has(devId.toUpperCase())) return true;
        // Also check if paired (paired devices are always "adopted")
        const mac = devId.replace(/-/g, ':');
        const device = this.bluez ? this.bluez.getDevice(mac) : null;
        return device ? device.paired === true : false;
    }

    /**
     * Adopt a device – persist it and create ioBroker objects.
     * @param {string} devId – dashed MAC
     */
    async _adoptDevice(devId) {
        const norm = devId.toUpperCase();
        if (this._adopted.has(norm)) return;

        this._adopted.add(norm);
        await this._persistAdopted();

        // Update discovery entry
        const mac = norm.replace(/-/g, ':');
        const entry = this._discovery.get(mac);
        if (entry) entry.adopted = true;

        this.log.info(`Device adopted: ${norm}`);

        // Create objects for the device
        const device = this.bluez.getDevice(mac);
        if (device) {
            await this.deviceMgr.ensureDeviceObjects(norm, device);
            this._processAdvertisementData(norm, device);
            this._processBTHome(norm, device.serviceData);
        }
    }

    /**
     * Remove a device from the adopted set.
     * Does NOT delete ioBroker objects (they may still be useful).
     * @param {string} devId – dashed MAC
     */
    async _removeAdoptedDevice(devId) {
        const norm = devId.toUpperCase();
        this._adopted.delete(norm);
        await this._persistAdopted();

        const mac = norm.replace(/-/g, ':');
        const entry = this._discovery.get(mac);
        if (entry) entry.adopted = false;

        this.log.info(`Device removed from adopted: ${norm}`);
    }

    /**
     * Persist adopted device list to ioBroker state.
     */
    async _persistAdopted() {
        const arr = [...this._adopted];
        await this.setStateAsync('discovery.adoptedDevices', { val: JSON.stringify(arr), ack: true });
    }

    /**
     * Flush the discovery list to the ioBroker state.
     * Removes stale transient entries (not seen for 5 minutes).
     */
    _flushDiscoveryList() {
        if (this._stopping) return;

        const now = Date.now();
        const STALE_MS = 5 * 60 * 1000; // 5 minutes

        // Remove stale transient devices
        for (const [mac, entry] of this._discovery) {
            if (entry.transient && !entry.adopted && (now - entry.lastSeen) > STALE_MS) {
                this._discovery.delete(mac);
            }
        }

        // Build sorted array (adopted first, then by RSSI)
        const list = [...this._discovery.values()].sort((a, b) => {
            if (a.adopted !== b.adopted) return a.adopted ? -1 : 1;
            if (a.paired !== b.paired) return a.paired ? -1 : 1;
            return (b.rssi || -999) - (a.rssi || -999);
        });

        this.setStateAsync('discovery.devices', { val: JSON.stringify(list), ack: true })
            .catch(() => {});
    }
}

// ─────────────────────────────────────────────────────────────────────
//  Startup
// ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
    new BluetoothAdapter();
} else {
    module.exports = (options) => new BluetoothAdapter(options);
}

'use strict';

const EventEmitter = require('events');
const dbus = require('dbus-next');
const Message = dbus.Message;
const BluezAgent = require('./bluezAgent');

const BLUEZ_SERVICE = 'org.bluez';
const OBJECT_MANAGER_IFACE = 'org.freedesktop.DBus.ObjectManager';
const PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties';
const ADAPTER_IFACE = 'org.bluez.Adapter1';
const DEVICE_IFACE = 'org.bluez.Device1';
const GATT_SERVICE_IFACE = 'org.bluez.GattService1';
const GATT_CHAR_IFACE = 'org.bluez.GattCharacteristic1';
const BATTERY_IFACE = 'org.bluez.Battery1';
const MEDIA_PLAYER_IFACE = 'org.bluez.MediaPlayer1';

/**
 * BluezManager – communicates with BlueZ over D-Bus (system bus) to provide
 * both Classic Bluetooth and BLE scanning, pairing, connecting and GATT operations.
 *
 * Uses low-level D-Bus message handling with explicit AddMatch rules because
 * dbus-next's proxy-based event listeners (`.on('InterfacesAdded')` etc.) do
 * not reliably fire for BlueZ signals.
 *
 * @emits deviceFound   (mac, deviceProps)
 * @emits deviceChanged (mac, changedProps)
 * @emits deviceRemoved (mac)
 * @emits characteristicChanged (charPath, value)
 * @emits mediaPlayerAdded    (path, interfaces)
 * @emits mediaPlayerRemoved  (path, interfaces)
 * @emits mediaPlayerChanged  (path, changed)
 */
class BluezManager extends EventEmitter {

    /**
     * @param {object} opts
     * @param {object} opts.log           – ioBroker-style logger
     * @param {number} [opts.hciDevice=0] – /dev/hciN index
     */
    constructor(opts) {
        super();
        /** @type {object} */
        this.log = opts.log;
        /** @type {number} */
        this.hciDevice = opts.hciDevice ?? 0;
        /** @type {string|null} Desired Bluetooth alias (visible name) */
        this._alias = opts.alias || null;

        /** @type {string} */
        this.adapterPath = `/org/bluez/hci${this.hciDevice}`;

        /** @type {import('dbus-next').MessageBus|null} */
        this._bus = null;
        /** @type {import('dbus-next').ProxyObject|null} */
        this._adapterProxy = null;
        /** @type {object|null} Adapter1 interface proxy */
        this._adapter = null;
        /** @type {object|null} Properties interface on adapter */
        this._adapterProps = null;
        /** @type {object|null} ObjectManager proxy on root */
        this._objectManager = null;

        /** @type {boolean} */
        this._discovering = false;
        /** @type {boolean} */
        this._destroyed = false;

        /**
         * Cached device data: MAC → device info object
         * @type {Map<string, object>}
         */
        this._devices = new Map();

        /**
         * D-Bus ProxyObject cache for device paths.
         * @type {Map<string, import('dbus-next').ProxyObject>}
         */
        this._deviceProxies = new Map();

        /**
         * Notification handlers keyed by characteristic path.
         * @type {Map<string, Function>}
         */
        this._notifyHandlers = new Map();

        /**
         * Cached ProxyObjects for characteristic paths.
         * @type {Map<string, import('dbus-next').ProxyObject>}
         */
        this._charProxies = new Map();

        /** @type {Function|null} bound message handler for cleanup */
        this._messageHandler = null;

        /** @type {BluezAgent|null} pairing agent */
        this._agent = null;
    }

    // ─── Lifecycle ───────────────────────────────────────────────────

    /**
     * Connect to D-Bus, acquire the BlueZ adapter proxy, ensure it is
     * powered on, register D-Bus match rules and wire up signal handling.
     */
    async init() {
        this._bus = dbus.systemBus({ negotiateUnixFd: true });

        // ── Register low-level D-Bus match rules FIRST ──
        // This ensures we receive signals even for devices that appear
        // between GetManagedObjects and StartDiscovery.
        await this._addMatchRule(
            "type='signal',sender='org.bluez',interface='org.freedesktop.DBus.ObjectManager'"
        );
        await this._addMatchRule(
            "type='signal',sender='org.bluez',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged'"
        );

        // ── Install central message handler ──
        this._messageHandler = (msg) => this._onDbusMessage(msg);
        this._bus.on('message', this._messageHandler);

        // Get ObjectManager on BlueZ root (for GetManagedObjects calls)
        const rootProxy = await this._bus.getProxyObject(BLUEZ_SERVICE, '/');
        this._objectManager = rootProxy.getInterface(OBJECT_MANAGER_IFACE);

        // Get adapter proxy
        this._adapterProxy = await this._bus.getProxyObject(BLUEZ_SERVICE, this.adapterPath);
        this._adapter = this._adapterProxy.getInterface(ADAPTER_IFACE);
        this._adapterProps = this._adapterProxy.getInterface(PROPERTIES_IFACE);

        // Ensure adapter is powered on
        const powered = await this._getAdapterProperty('Powered');
        if (!powered) {
            this.log.info(`Powering on hci${this.hciDevice}…`);
            await this._adapterProps.Set(ADAPTER_IFACE, 'Powered', new dbus.Variant('b', true));
            await this._delay(1000);
        }

        const adapterName = await this._getAdapterProperty('Name');
        const adapterAddr = await this._getAdapterProperty('Address');
        this.log.info(`BlueZ adapter ready: ${adapterName} (${adapterAddr}) on ${this.adapterPath}`);

        // Set adapter alias if provided (visible name on other devices)
        if (this._alias) {
            await this.setAdapterAlias(this._alias);
        }

        // Register pairing agent
        this._agent = new BluezAgent({ bus: this._bus, log: this.log });
        await this._agent.register();

        // Enumerate already-known devices
        await this._enumerateExistingDevices();
    }

    /**
     * Get the pairing agent (for external pairing request handling).
     * @returns {BluezAgent|null}
     */
    getAgent() {
        return this._agent;
    }

    /**
     * Start Bluetooth discovery with the given transport filter.
     * @param {'auto'|'le'|'bredr'} [transport='auto']
     */
    async startDiscovery(transport = 'auto') {
        if (this._destroyed) return;
        if (this._discovering) {
            this.log.debug('Discovery already running');
            return;
        }

        // Stop any leftover discovery first to get a clean state
        try {
            await this._adapter.StopDiscovery();
            await this._delay(300);
        } catch (_) { /* ignore – not running */ }

        try {
            await this._adapter.SetDiscoveryFilter({
                Transport: new dbus.Variant('s', transport),
                DuplicateData: new dbus.Variant('b', true),
            });
        } catch (e) {
            this.log.warn(`SetDiscoveryFilter failed: ${e.message}`);
        }

        try {
            await this._adapter.StartDiscovery();
            this._discovering = true;
            this.log.info(`Discovery started (transport: ${transport})`);
        } catch (e) {
            if (e.message && (e.message.includes('InProgress') || e.message.includes('already in progress'))) {
                this._discovering = true;
                this.log.debug('Discovery was already in progress');
            } else {
                throw e;
            }
        }
    }

    /**
     * Stop Bluetooth discovery.
     */
    async stopDiscovery() {
        if (!this._discovering) return;

        try {
            await this._adapter.StopDiscovery();
            this.log.info('Discovery stopped');
        } catch (e) {
            if (!e.message || !e.message.includes('NotReady')) {
                this.log.warn(`StopDiscovery error: ${e.message}`);
            }
        }
        this._discovering = false;
    }

    /**
     * Cleanly tear down – stop discovery, clean up all signal handlers.
     */
    async destroy() {
        this._destroyed = true;

        try {
            await this.stopDiscovery();
        } catch (_) { /* ignore */ }

        // Unregister pairing agent
        if (this._agent) {
            await this._agent.unregister();
            this._agent = null;
        }

        // Remove central message handler
        if (this._bus && this._messageHandler) {
            this._bus.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }

        // Stop all GATT notifications
        for (const charPath of this._notifyHandlers.keys()) {
            try {
                await this.stopNotify(charPath);
            } catch (_) { /* ignore */ }
        }
        this._notifyHandlers.clear();

        // Disconnect bus
        if (this._bus) {
            this._bus.disconnect();
            this._bus = null;
        }

        this._devices.clear();
        this._deviceProxies.clear();
        this._charProxies.clear();

        this.log.info('BluezManager destroyed');
    }

    // ─── Adapter operations ─────────────────────────────────────────

    /**
     * Set the Bluetooth adapter alias (the name visible to other devices).
     * @param {string} alias
     */
    async setAdapterAlias(alias) {
        try {
            await this._adapterProps.Set(ADAPTER_IFACE, 'Alias', new dbus.Variant('s', alias));
            this.log.info(`Bluetooth adapter alias set to "${alias}"`);
        } catch (e) {
            this.log.warn(`Failed to set adapter alias: ${e.message}`);
        }
    }

    // ─── Device operations ───────────────────────────────────────────

    /**
     * Connect to a device.
     * @param {string} devicePath – D-Bus object path
     */
    async connect(devicePath) {
        const proxy = await this._getDeviceProxy(devicePath);
        const deviceIface = proxy.getInterface(DEVICE_IFACE);
        this.log.info(`Connecting to ${devicePath}…`);
        await deviceIface.Connect();
        this.log.info(`Connected to ${devicePath}`);
    }

    /**
     * Disconnect from a device.
     * @param {string} devicePath – D-Bus object path
     */
    async disconnect(devicePath) {
        try {
            const proxy = await this._getDeviceProxy(devicePath);
            const deviceIface = proxy.getInterface(DEVICE_IFACE);
            await deviceIface.Disconnect();
            this.log.info(`Disconnected from ${devicePath}`);
        } catch (e) {
            this.log.debug(`Disconnect ${devicePath}: ${e.message}`);
        }
    }

    /**
     * Connect a specific profile on a device.
     * Useful for re-establishing HFP after RFCOMM drops.
     * @param {string} devicePath – D-Bus object path
     * @param {string} uuid – profile UUID
     */
    async connectProfile(devicePath, uuid) {
        const proxy = await this._getDeviceProxy(devicePath);
        const deviceIface = proxy.getInterface(DEVICE_IFACE);
        this.log.info(`ConnectProfile ${uuid} on ${devicePath}…`);
        await deviceIface.ConnectProfile(uuid);
        this.log.info(`ConnectProfile ${uuid} on ${devicePath} done`);
    }

    /**
     * Pair with a device.
     * @param {string} devicePath – D-Bus object path
     */
    async pair(devicePath) {
        const proxy = await this._getDeviceProxy(devicePath);
        const deviceIface = proxy.getInterface(DEVICE_IFACE);
        this.log.info(`Pairing with ${devicePath}…`);
        await deviceIface.Pair();
        this.log.info(`Paired with ${devicePath}`);
    }

    /**
     * Remove (unpair) a device via Adapter1.RemoveDevice().
     * @param {string} devicePath – D-Bus object path
     */
    async unpair(devicePath) {
        this.log.info(`Removing device ${devicePath}…`);
        await this._adapter.RemoveDevice(devicePath);
        this.log.info(`Removed device ${devicePath}`);
    }

    /**
     * Set the Trusted property on a device.
     * @param {string} devicePath
     * @param {boolean} trusted
     */
    async trust(devicePath, trusted) {
        const proxy = await this._getDeviceProxy(devicePath);
        const propsIface = proxy.getInterface(PROPERTIES_IFACE);
        await propsIface.Set(DEVICE_IFACE, 'Trusted', new dbus.Variant('b', trusted));
        this.log.info(`Set Trusted=${trusted} on ${devicePath}`);
    }

    /**
     * Set the Blocked property on a device.
     * @param {string} devicePath
     * @param {boolean} blocked
     */
    async block(devicePath, blocked) {
        const proxy = await this._getDeviceProxy(devicePath);
        const propsIface = proxy.getInterface(PROPERTIES_IFACE);
        await propsIface.Set(DEVICE_IFACE, 'Blocked', new dbus.Variant('b', blocked));
        this.log.info(`Set Blocked=${blocked} on ${devicePath}`);
    }

    // ─── GATT operations ────────────────────────────────────────────

    /**
     * Wait for ServicesResolved on a device and then enumerate all
     * GATT services and characteristics.
     *
     * @param {string} devicePath
     * @returns {Promise<Array<{uuid: string, path: string, primary: boolean,
     *           characteristics: Array<{uuid: string, path: string, flags: string[]}>}>>}
     */
    async discoverServices(devicePath) {
        await this._waitForServicesResolved(devicePath, 30000);

        const objects = await this._objectManager.GetManagedObjects();
        const services = [];

        for (const [objPath, ifaces] of Object.entries(objects)) {
            if (!objPath.startsWith(devicePath + '/')) continue;

            if (ifaces[GATT_SERVICE_IFACE]) {
                const svcProps = this._unwrapVariants(ifaces[GATT_SERVICE_IFACE]);
                const svc = {
                    uuid: svcProps.UUID || '',
                    path: objPath,
                    primary: svcProps.Primary ?? true,
                    characteristics: [],
                };

                for (const [charPath, charIfaces] of Object.entries(objects)) {
                    if (!charPath.startsWith(objPath + '/')) continue;
                    if (!charIfaces[GATT_CHAR_IFACE]) continue;

                    const charProps = this._unwrapVariants(charIfaces[GATT_CHAR_IFACE]);
                    svc.characteristics.push({
                        uuid: charProps.UUID || '',
                        path: charPath,
                        flags: charProps.Flags || [],
                    });
                }

                services.push(svc);
            }
        }

        this.log.debug(`${devicePath}: discovered ${services.length} service(s)`);
        return services;
    }

    /**
     * Read a GATT characteristic value.
     * @param {string} charPath – D-Bus object path of the characteristic
     * @returns {Promise<Buffer>}
     */
    async readCharacteristic(charPath) {
        const proxy = await this._getCharProxy(charPath);
        const charIface = proxy.getInterface(GATT_CHAR_IFACE);
        const value = await charIface.ReadValue({});
        return Buffer.from(value);
    }

    /**
     * Write a value to a GATT characteristic.
     * @param {string} charPath
     * @param {Buffer} value
     * @param {object} [options]
     */
    async writeCharacteristic(charPath, value, options = {}) {
        const proxy = await this._getCharProxy(charPath);
        const charIface = proxy.getInterface(GATT_CHAR_IFACE);

        const dbusOpts = {};
        if (options.type) {
            dbusOpts.type = new dbus.Variant('s', options.type);
        }

        await charIface.WriteValue([...value], dbusOpts);
    }

    /**
     * Subscribe to notifications on a GATT characteristic.
     *
     * Note: uses low-level D-Bus message handling (same as device signals).
     * The handler receives Buffers via our central _onDbusMessage dispatcher
     * which picks up PropertiesChanged on GattCharacteristic1 paths.
     *
     * @param {string} charPath
     * @param {function(Buffer):void} handler
     */
    async startNotify(charPath, handler) {
        const proxy = await this._getCharProxy(charPath);
        const charIface = proxy.getInterface(GATT_CHAR_IFACE);

        this._notifyHandlers.set(charPath, handler);
        await charIface.StartNotify();
        this.log.debug(`Started notifications on ${charPath}`);
    }

    /**
     * Unsubscribe from notifications on a GATT characteristic.
     * @param {string} charPath
     */
    async stopNotify(charPath) {
        try {
            const proxy = await this._getCharProxy(charPath);
            const charIface = proxy.getInterface(GATT_CHAR_IFACE);
            await charIface.StopNotify();
        } catch (e) {
            this.log.debug(`StopNotify ${charPath}: ${e.message}`);
        }
        this._notifyHandlers.delete(charPath);
    }

    // ─── Helpers (public) ────────────────────────────────────────────

    /**
     * Get cached device info by MAC.
     * @param {string} mac
     * @returns {object|undefined}
     */
    getDevice(mac) {
        return this._devices.get(this._normaliseMac(mac));
    }

    /**
     * Get all known devices.
     * @returns {Map<string, object>}
     */
    getDevices() {
        return this._devices;
    }

    /**
     * Convert MAC to BlueZ D-Bus device path.
     * @param {string} mac
     * @returns {string}
     */
    macToDevicePath(mac) {
        const clean = mac.replace(/[:-]/g, '_').toUpperCase();
        return `${this.adapterPath}/dev_${clean}`;
    }

    /**
     * Extract MAC from a BlueZ D-Bus device path.
     * @param {string} path
     * @returns {string}
     */
    devicePathToMac(path) {
        const match = path.match(/dev_([0-9A-Fa-f]{2}_[0-9A-Fa-f]{2}_[0-9A-Fa-f]{2}_[0-9A-Fa-f]{2}_[0-9A-Fa-f]{2}_[0-9A-Fa-f]{2})/);
        if (!match) return '';
        return match[1].replace(/_/g, ':').toUpperCase();
    }

    // ─── Private: low-level D-Bus signal handling ────────────────────

    /**
     * Add a D-Bus match rule via org.freedesktop.DBus.AddMatch.
     * @param {string} rule
     * @private
     */
    async _addMatchRule(rule) {
        await this._bus.call(new Message({
            type: dbus.MessageType.METHOD_CALL,
            destination: 'org.freedesktop.DBus',
            path: '/org/freedesktop/DBus',
            interface: 'org.freedesktop.DBus',
            member: 'AddMatch',
            signature: 's',
            body: [rule],
        }));
    }

    /**
     * Central D-Bus message handler.  Dispatches:
     *   – InterfacesAdded/Removed  → device discovery / removal
     *   – PropertiesChanged on Device1 → RSSI, ManufacturerData, etc.
     *   – PropertiesChanged on GattCharacteristic1 → GATT notifications
     *   – PropertiesChanged on Battery1 → battery level
     *
     * @param {object} msg – raw dbus-next Message
     * @private
     */
    _onDbusMessage(msg) {
        if (this._destroyed || !msg || !msg.interface) return;

        try {
            // ── InterfacesAdded ──
            if (msg.interface === OBJECT_MANAGER_IFACE && msg.member === 'InterfacesAdded' && msg.body) {
                const [path, interfaces] = msg.body;
                this._onInterfacesAdded(path, interfaces);
                return;
            }

            // ── InterfacesRemoved ──
            if (msg.interface === OBJECT_MANAGER_IFACE && msg.member === 'InterfacesRemoved' && msg.body) {
                const [path, interfaces] = msg.body;
                this._onInterfacesRemoved(path, interfaces);
                return;
            }

            // ── PropertiesChanged ──
            if (msg.interface === PROPERTIES_IFACE && msg.member === 'PropertiesChanged' && msg.body && msg.path) {
                const [ifaceName, changed, invalidated] = msg.body;
                this._onPropertiesChanged(msg.path, ifaceName, changed, invalidated);
                return;
            }
        } catch (e) {
            this.log.debug(`D-Bus message handler error: ${e.message}`);
        }
    }

    /**
     * Handle InterfacesAdded signal.
     * @param {string} path
     * @param {object} interfaces
     * @private
     */
    _onInterfacesAdded(path, interfaces) {
        // ── MediaPlayer1 added (AVRCP) ──
        if (interfaces[MEDIA_PLAYER_IFACE] && path.startsWith(this.adapterPath)) {
            this.emit('mediaPlayerAdded', path, interfaces);
        }

        if (!interfaces[DEVICE_IFACE]) return;
        if (!path.startsWith(this.adapterPath)) return;

        const props = this._unwrapVariants(interfaces[DEVICE_IFACE]);
        const mac = props.Address ? props.Address.toUpperCase() : this.devicePathToMac(path);
        if (!mac) return;

        const deviceInfo = this._buildDeviceInfo(path, props);

        // Check for Battery1 interface on the same path
        if (interfaces[BATTERY_IFACE]) {
            const batProps = this._unwrapVariants(interfaces[BATTERY_IFACE]);
            deviceInfo.battery = batProps.Percentage ?? null;
        }

        this._devices.set(mac, deviceInfo);

        this.log.debug(`Device found: ${mac} (${deviceInfo.name || 'unnamed'}) [${deviceInfo.type}]`);
        this.emit('deviceFound', mac, deviceInfo);
    }

    /**
     * Handle InterfacesRemoved signal.
     * @param {string} path
     * @param {string[]} interfaces
     * @private
     */
    _onInterfacesRemoved(path, interfaces) {
        // ── MediaPlayer1 removed (AVRCP) ──
        if (interfaces.includes(MEDIA_PLAYER_IFACE)) {
            this.emit('mediaPlayerRemoved', path, interfaces);
        }

        if (!interfaces.includes(DEVICE_IFACE)) return;

        const mac = this.devicePathToMac(path);
        if (!mac) return;

        this._devices.delete(mac);
        this._deviceProxies.delete(path);

        this.log.debug(`Device removed: ${mac}`);
        this.emit('deviceRemoved', mac);
    }

    /**
     * Handle PropertiesChanged signal (central dispatcher).
     * @param {string} path   – D-Bus object path
     * @param {string} iface  – which interface changed
     * @param {object} changed – dict of changed properties (Variant values)
     * @param {string[]} _invalidated
     * @private
     */
    _onPropertiesChanged(path, iface, changed, _invalidated) {
        // ── Device property changes ──
        if (iface === DEVICE_IFACE && path.startsWith(this.adapterPath + '/dev_')) {
            this._onDevicePropertiesChanged(path, changed);
            return;
        }

        // ── Battery changes ──
        if (iface === BATTERY_IFACE && path.startsWith(this.adapterPath + '/dev_')) {
            this._onBatteryChanged(path, changed);
            return;
        }

        // ── MediaPlayer1 changes (AVRCP) ──
        if (iface === MEDIA_PLAYER_IFACE && path.startsWith(this.adapterPath)) {
            const unwrapped = this._unwrapVariants(changed);
            this.emit('mediaPlayerChanged', path, unwrapped);
            return;
        }

        // ── GATT characteristic notifications ──
        if (iface === GATT_CHAR_IFACE && changed) {
            const unwrapped = this._unwrapVariants(changed);
            if ('Value' in unwrapped) {
                const buf = Buffer.from(unwrapped.Value || []);
                const handler = this._notifyHandlers.get(path);
                if (handler) {
                    try { handler(buf); } catch (_) { /* ignore */ }
                }
                this.emit('characteristicChanged', path, buf);
            }
            return;
        }
    }

    /**
     * Handle Device1 PropertiesChanged.
     * @param {string} path
     * @param {object} changed – raw Variant dict
     * @private
     */
    _onDevicePropertiesChanged(path, changed) {
        const mac = this.devicePathToMac(path);
        if (!mac) return;

        let device = this._devices.get(mac);

        // If we don't know this device yet (e.g. came via PropertiesChanged
        // before InterfacesAdded for cached devices), create a stub
        if (!device) {
            device = this._buildDeviceInfo(path, {});
            device.address = mac;
            this._devices.set(mac, device);
        }

        const unwrapped = this._unwrapVariants(changed);
        const updates = {};

        if ('RSSI' in unwrapped) {
            device.rssi = unwrapped.RSSI;
            updates.rssi = unwrapped.RSSI;
        }
        if ('Connected' in unwrapped) {
            device.connected = unwrapped.Connected;
            updates.connected = unwrapped.Connected;
        }
        if ('Paired' in unwrapped) {
            device.paired = unwrapped.Paired;
            updates.paired = unwrapped.Paired;
        }
        if ('Bonded' in unwrapped) {
            device.bonded = unwrapped.Bonded;
            updates.bonded = unwrapped.Bonded;
        }
        if ('Trusted' in unwrapped) {
            device.trusted = unwrapped.Trusted;
            updates.trusted = unwrapped.Trusted;
        }
        if ('Blocked' in unwrapped) {
            device.blocked = unwrapped.Blocked;
            updates.blocked = unwrapped.Blocked;
        }
        if ('Name' in unwrapped) {
            device.name = unwrapped.Name;
            updates.name = unwrapped.Name;
        }
        if ('Alias' in unwrapped) {
            device.alias = unwrapped.Alias;
            updates.alias = unwrapped.Alias;
        }
        if ('TxPower' in unwrapped) {
            device.txPower = unwrapped.TxPower;
            updates.txPower = unwrapped.TxPower;
        }
        if ('ServicesResolved' in unwrapped) {
            device.servicesResolved = unwrapped.ServicesResolved;
            updates.servicesResolved = unwrapped.ServicesResolved;
        }

        // ManufacturerData: dict{uint16, array(byte)}
        if ('ManufacturerData' in unwrapped) {
            device.manufacturerData = this._parseManufacturerData(unwrapped.ManufacturerData);
            updates.manufacturerData = device.manufacturerData;
        }

        // ServiceData: dict{string, array(byte)}
        if ('ServiceData' in unwrapped) {
            device.serviceData = this._parseServiceData(unwrapped.ServiceData);
            updates.serviceData = device.serviceData;
        }

        if (Object.keys(updates).length > 0) {
            this.emit('deviceChanged', mac, updates);
        }
    }

    /**
     * Handle Battery1 PropertiesChanged.
     * @param {string} path
     * @param {object} changed
     * @private
     */
    _onBatteryChanged(path, changed) {
        const mac = this.devicePathToMac(path);
        if (!mac) return;

        const device = this._devices.get(mac);
        if (!device) return;

        const unwrapped = this._unwrapVariants(changed);
        if ('Percentage' in unwrapped) {
            device.battery = unwrapped.Percentage;
            this.emit('deviceChanged', mac, { battery: unwrapped.Percentage });
        }
    }

    // ─── Private: enumeration ────────────────────────────────────────

    /**
     * Enumerate already-known BlueZ devices on startup.
     * @private
     */
    async _enumerateExistingDevices() {
        try {
            const objects = await this._objectManager.GetManagedObjects();

            for (const [path, ifaces] of Object.entries(objects)) {
                if (!ifaces[DEVICE_IFACE]) continue;
                if (!path.startsWith(this.adapterPath)) continue;

                const props = this._unwrapVariants(ifaces[DEVICE_IFACE]);
                const mac = props.Address ? props.Address.toUpperCase() : this.devicePathToMac(path);
                if (!mac) continue;

                const deviceInfo = this._buildDeviceInfo(path, props);

                if (ifaces[BATTERY_IFACE]) {
                    const batProps = this._unwrapVariants(ifaces[BATTERY_IFACE]);
                    deviceInfo.battery = batProps.Percentage ?? null;
                }

                this._devices.set(mac, deviceInfo);

                this.log.debug(`Existing device: ${mac} (${deviceInfo.name || 'unnamed'}) [${deviceInfo.type}]`);
                this.emit('deviceFound', mac, deviceInfo);
            }

            this.log.info(`Enumerated ${this._devices.size} existing device(s)`);
        } catch (e) {
            this.log.warn(`Failed to enumerate existing devices: ${e.message}`);
        }
    }

    // ─── Private: property helpers ───────────────────────────────────

    /**
     * Get a single adapter property.
     * @param {string} prop
     * @returns {Promise<*>}
     * @private
     */
    async _getAdapterProperty(prop) {
        const variant = await this._adapterProps.Get(ADAPTER_IFACE, prop);
        return variant.value;
    }

    /**
     * Get or create a D-Bus ProxyObject for a device path.
     * @param {string} path
     * @returns {Promise<import('dbus-next').ProxyObject>}
     * @private
     */
    async _getDeviceProxy(path) {
        let proxy = this._deviceProxies.get(path);
        if (!proxy) {
            proxy = await this._bus.getProxyObject(BLUEZ_SERVICE, path);
            this._deviceProxies.set(path, proxy);
        }
        return proxy;
    }

    /**
     * Get or create a D-Bus ProxyObject for a characteristic path.
     * @param {string} path
     * @returns {Promise<import('dbus-next').ProxyObject>}
     * @private
     */
    async _getCharProxy(path) {
        let proxy = this._charProxies.get(path);
        if (!proxy) {
            proxy = await this._bus.getProxyObject(BLUEZ_SERVICE, path);
            this._charProxies.set(path, proxy);
        }
        return proxy;
    }

    /**
     * Wait for a device's ServicesResolved property to become true.
     *
     * Uses the central message handler: checks existing device cache for
     * servicesResolved updates rather than per-proxy listeners.
     *
     * @param {string} devicePath
     * @param {number} timeoutMs
     * @returns {Promise<void>}
     * @private
     */
    async _waitForServicesResolved(devicePath, timeoutMs) {
        // Check current value via D-Bus
        try {
            const proxy = await this._getDeviceProxy(devicePath);
            const propsIface = proxy.getInterface(PROPERTIES_IFACE);
            const val = await propsIface.Get(DEVICE_IFACE, 'ServicesResolved');
            if (val.value === true) return;
        } catch (_) { /* continue waiting */ }

        const mac = this.devicePathToMac(devicePath);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.removeListener('deviceChanged', onChange);
                reject(new Error(`ServicesResolved timeout for ${devicePath}`));
            }, timeoutMs);

            const onChange = (changedMac, updates) => {
                if (changedMac === mac && updates.servicesResolved === true) {
                    clearTimeout(timer);
                    this.removeListener('deviceChanged', onChange);
                    resolve();
                }
            };

            this.on('deviceChanged', onChange);
        });
    }

    // ─── Private: data conversion ────────────────────────────────────

    /**
     * Build a normalized device info object from BlueZ Device1 properties.
     * @param {string} path
     * @param {object} props – unwrapped Device1 properties
     * @returns {object}
     * @private
     */
    _buildDeviceInfo(path, props) {
        const addressType = props.AddressType || 'unknown';
        const btClass = props.Class ?? null;

        return {
            path,
            address: props.Address || '',
            name: props.Name || '',
            alias: props.Alias || '',
            rssi: props.RSSI ?? null,
            txPower: props.TxPower ?? null,
            paired: props.Paired ?? false,
            bonded: props.Bonded ?? false,
            trusted: props.Trusted ?? false,
            blocked: props.Blocked ?? false,
            connected: props.Connected ?? false,
            addressType,
            class: btClass,
            icon: props.Icon || '',
            battery: null,
            servicesResolved: props.ServicesResolved ?? false,
            type: this._detectDeviceType(addressType, btClass),
            manufacturerData: this._parseManufacturerData(props.ManufacturerData),
            serviceData: this._parseServiceData(props.ServiceData),
            uuids: Array.isArray(props.UUIDs) ? props.UUIDs : [],
        };
    }

    /**
     * Detect device type from AddressType and Class.
     * @param {string} addressType
     * @param {number|null} btClass
     * @returns {'classic'|'le'|'dual'}
     * @private
     */
    _detectDeviceType(addressType, btClass) {
        const hasBle = addressType === 'public' || addressType === 'random';
        const hasClassic = typeof btClass === 'number' && btClass > 0;

        if (hasBle && hasClassic) return 'dual';
        if (hasClassic) return 'classic';
        return 'le';
    }

    /**
     * Parse BlueZ ManufacturerData into Noble-compatible Buffer.
     *
     * @param {object|null} mfData – { companyId: [byte, ...], ... }
     * @returns {Buffer|null}
     * @private
     */
    _parseManufacturerData(mfData) {
        if (!mfData || typeof mfData !== 'object') return null;

        const entries = Object.entries(mfData);
        if (entries.length === 0) return null;

        const [companyIdStr, payload] = entries[0];
        const companyId = Number(companyIdStr);
        const payloadBytes = this._unwrapValue(payload);

        // D-Bus may return Buffer, Uint8Array, or plain Array
        let payloadBuf;
        if (Buffer.isBuffer(payloadBytes)) {
            payloadBuf = payloadBytes;
        } else if (Array.isArray(payloadBytes)) {
            payloadBuf = Buffer.from(payloadBytes);
        } else if (ArrayBuffer.isView(payloadBytes)) {
            payloadBuf = Buffer.from(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.byteLength);
        } else {
            payloadBuf = Buffer.alloc(0);
        }

        const buf = Buffer.alloc(2 + payloadBuf.length);
        buf.writeUInt16LE(companyId, 0);
        payloadBuf.copy(buf, 2);
        return buf;
    }

    /**
     * Parse BlueZ ServiceData into array of { uuid, data: Buffer }.
     *
     * @param {object|null} svcData – { "uuid": [byte, ...], ... }
     * @returns {Array<{uuid: string, data: Buffer}>}
     * @private
     */
    _parseServiceData(svcData) {
        if (!svcData || typeof svcData !== 'object') return [];

        const result = [];
        for (const [uuid, payload] of Object.entries(svcData)) {
            const payloadBytes = this._unwrapValue(payload);
            // D-Bus may return Buffer, Uint8Array, or plain Array
            const data = Buffer.isBuffer(payloadBytes) ? payloadBytes
                : Array.isArray(payloadBytes) ? Buffer.from(payloadBytes)
                : ArrayBuffer.isView(payloadBytes) ? Buffer.from(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.byteLength)
                : Buffer.alloc(0);
            const normalizedUuid = uuid.toLowerCase().replace(/-/g, '');
            const shortUuid = normalizedUuid.length === 32
                ? normalizedUuid.slice(4, 8)
                : normalizedUuid;
            result.push({
                uuid: shortUuid,
                data,
            });
        }
        return result;
    }

    /**
     * Recursively unwrap D-Bus Variant objects.
     * @param {*} val
     * @returns {*}
     * @private
     */
    _unwrapValue(val) {
        if (val === null || val === undefined) return val;
        if (val && typeof val === 'object' && 'value' in val && 'signature' in val) {
            return this._unwrapValue(val.value);
        }
        // Recurse into nested dicts (e.g. Track inside MediaPlayer1)
        if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Buffer)) {
            return this._unwrapVariants(val);
        }
        return val;
    }

    /**
     * Unwrap all Variant values in a dict.
     * @param {object} dict
     * @returns {object}
     * @private
     */
    _unwrapVariants(dict) {
        if (!dict || typeof dict !== 'object') return {};
        const result = {};
        for (const [key, val] of Object.entries(dict)) {
            result[key] = this._unwrapValue(val);
        }
        return result;
    }

    /**
     * Normalise a MAC address to upper-case colon-separated form.
     * @param {string} mac
     * @returns {string}
     * @private
     */
    _normaliseMac(mac) {
        return mac.replace(/[-]/g, ':').toUpperCase();
    }

    /**
     * @param {number} ms
     * @returns {Promise<void>}
     * @private
     */
    _delay(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }
}

module.exports = BluezManager;

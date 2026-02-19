'use strict';

const { DeviceManagement } = require('@iobroker/dm-utils');

/**
 * BluetoothDeviceManagement – dm-utils bridge for the ioBroker.bluetooth adapter.
 *
 * Exposes discovered/adopted Bluetooth devices to the ioBroker Device Manager
 * admin tab, providing per-device actions (connect, disconnect, pair, unpair,
 * remove) and per-instance actions (scan, allow new devices).
 *
 * This class does NOT replace the existing DeviceManager (lib/deviceManager.js)
 * which manages the ioBroker object tree. It sits on top of it.
 */
class BluetoothDeviceManagement extends DeviceManagement {

    /**
     * @param {import('@iobroker/adapter-core').AdapterInstance} adapter
     */
    constructor(adapter) {
        super(adapter);
        this._adapter = adapter;
    }

    // ─────────────────────────────────────────────────────────────────
    //  Instance info
    // ─────────────────────────────────────────────────────────────────

    getInstanceInfo() {
        return {
            apiVersion: 'v1',
            actions: [
                {
                    id: 'scan',
                    icon: 'fas fa-radar',
                    title: 'Toggle discovery',
                    description: 'Start or stop Bluetooth discovery',
                    handler: () => this.handleInstanceAction('scan'),
                },
                {
                    id: 'allowNewDevices',
                    icon: 'fas fa-plus-circle',
                    title: 'Allow new devices',
                    description: 'Toggle whether new devices are automatically adopted',
                    handler: () => this.handleInstanceAction('allowNewDevices'),
                },
            ],
        };
    }

    // ─────────────────────────────────────────────────────────────────
    //  List devices
    // ─────────────────────────────────────────────────────────────────

    async listDevices() {
        const devices = [];
        const adapter = this._adapter;

        // Gather all known devices from discovery map + adopted set
        const discovery = adapter._discovery || new Map();
        const adopted = adapter._adopted || new Set();
        const seenMacs = new Set();

        // Helper to build a DeviceInfo entry
        const buildDevice = (mac, entry) => {
            const devId = mac.replace(/[:-]/g, '-').toUpperCase();
            if (seenMacs.has(devId)) return null;
            seenMacs.add(devId);

            const name = (entry && entry.name) || devId;
            const isConnected = !!(entry && entry.connected);
            const isPaired = !!(entry && entry.paired);

            const actions = [];
            const self = this;
            if (!isConnected) {
                actions.push({ id: 'connect', icon: 'fas fa-plug', description: 'Connect', handler: (id, ctx) => self.handleDeviceAction(id, 'connect', ctx) });
            } else {
                actions.push({ id: 'disconnect', icon: 'fas fa-unlink', description: 'Disconnect', handler: (id, ctx) => self.handleDeviceAction(id, 'disconnect', ctx) });
            }
            if (!isPaired) {
                actions.push({ id: 'pair', icon: 'fas fa-link', description: 'Pair', handler: (id, ctx) => self.handleDeviceAction(id, 'pair', ctx) });
            } else {
                actions.push({ id: 'unpair', icon: 'fas fa-chain-broken', description: 'Unpair', handler: (id, ctx) => self.handleDeviceAction(id, 'unpair', ctx) });
            }
            actions.push({ id: 'remove', icon: 'fas fa-trash', description: 'Remove device', handler: (id, ctx) => self.handleDeviceAction(id, 'remove', ctx) });

            return {
                id: devId,
                name: name,
                status: isConnected ? 'connected' : 'disconnected',
                hasDetails: true,
                actions,
            };
        };

        // 1. All adopted devices
        for (const mac of adopted) {
            const colonMac = mac.replace(/-/g, ':');
            const entry = discovery.get(colonMac) || discovery.get(mac);
            // Also check BluezManager for connection status
            let enriched = entry ? { ...entry } : { mac, name: '' };
            if (adapter.bluez) {
                const device = adapter.bluez.getDevice(colonMac);
                if (device) {
                    enriched.connected = device.connected;
                    enriched.paired = device.paired;
                    if (!enriched.name && device.name) enriched.name = device.name;
                }
            }
            const dev = buildDevice(mac, enriched);
            if (dev) devices.push(dev);
        }

        // 2. Non-adopted but discovered (non-transient, for visibility)
        for (const [, entry] of discovery) {
            if (entry.transient) continue;
            const dev = buildDevice(entry.mac, entry);
            if (dev) devices.push(dev);
        }

        return devices;
    }

    // ─────────────────────────────────────────────────────────────────
    //  Instance actions
    // ─────────────────────────────────────────────────────────────────

    async handleInstanceAction(actionId, context) {
        const adapter = this._adapter;

        switch (actionId) {
            case 'scan': {
                if (!adapter.bluez) {
                    await context.showMessage('BlueZ not initialized');
                    return { refresh: false };
                }
                try {
                    // Toggle: try to stop, if that fails start
                    const transport = (adapter._cfg && adapter._cfg.transport) || 'auto';
                    await adapter.bluez.startDiscovery(transport);
                    await context.showMessage('Discovery started');
                } catch (e) {
                    try {
                        await adapter.bluez.stopDiscovery();
                        await context.showMessage('Discovery stopped');
                    } catch (e2) {
                        await context.showMessage(`Discovery toggle failed: ${e2.message}`);
                    }
                }
                return { refresh: 'instance' };
            }
            case 'allowNewDevices': {
                await context.showMessage('Feature not yet implemented – use the adapter config to manage the allowlist.');
                return { refresh: false };
            }
            default:
                return { refresh: false };
        }
    }

    // ─────────────────────────────────────────────────────────────────
    //  Device actions
    // ─────────────────────────────────────────────────────────────────

    async handleDeviceAction(deviceId, actionId, context) {
        const adapter = this._adapter;
        const mac = deviceId.replace(/-/g, ':');

        switch (actionId) {
            case 'connect': {
                if (!adapter.bluez) {
                    await context.showMessage('BlueZ not initialized');
                    return { refresh: false };
                }
                try {
                    const devicePath = adapter.bluez.macToDevicePath(mac);
                    await adapter.bluez.connect(devicePath);
                    adapter.log.info(`DM: Connected to ${mac}`);
                } catch (e) {
                    await context.showMessage(`Connect failed: ${e.message}`);
                }
                return { refresh: 'device' };
            }
            case 'disconnect': {
                if (!adapter.bluez) return { refresh: false };
                try {
                    const devicePath = adapter.bluez.macToDevicePath(mac);
                    await adapter.bluez.disconnect(devicePath);
                    adapter.log.info(`DM: Disconnected ${mac}`);
                } catch (e) {
                    await context.showMessage(`Disconnect failed: ${e.message}`);
                }
                return { refresh: 'device' };
            }
            case 'pair': {
                if (!adapter.bluez) return { refresh: false };
                try {
                    const devicePath = adapter.bluez.macToDevicePath(mac);
                    await adapter.bluez.pair(devicePath);
                    adapter.log.info(`DM: Pairing ${mac}`);
                } catch (e) {
                    await context.showMessage(`Pair failed: ${e.message}`);
                }
                return { refresh: 'device' };
            }
            case 'unpair': {
                if (!adapter.bluez) return { refresh: false };
                try {
                    const devicePath = adapter.bluez.macToDevicePath(mac);
                    await adapter.bluez.unpair(devicePath);
                    adapter.log.info(`DM: Unpaired ${mac}`);
                } catch (e) {
                    await context.showMessage(`Unpair failed: ${e.message}`);
                }
                return { refresh: 'device' };
            }
            case 'remove': {
                const confirm = await context.showConfirmation(
                    `Remove device ${deviceId} from adopted list and delete its objects?`
                );
                if (!confirm) return { refresh: false };

                try {
                    await adapter._removeAdoptedDevice(deviceId);
                    adapter.log.info(`DM: Removed device ${deviceId}`);
                } catch (e) {
                    await context.showMessage(`Remove failed: ${e.message}`);
                }
                return { refresh: 'instance' };
            }
            default:
                adapter.log.warn(`DM: Unknown device action: ${actionId}`);
                return { refresh: false };
        }
    }

    // ─────────────────────────────────────────────────────────────────
    //  Device details
    // ─────────────────────────────────────────────────────────────────

    async getDeviceDetails(id) {
        const adapter = this._adapter;
        const mac = id.replace(/-/g, ':');
        const discovery = adapter._discovery || new Map();
        const entry = discovery.get(mac.toUpperCase()) || discovery.get(id);

        // Get live device info from BluezManager
        let device = null;
        if (adapter.bluez) {
            device = adapter.bluez.getDevice(mac);
        }

        const data = {};
        const items = {};

        // Device Info section
        items._header_info = {
            type: 'staticText',
            text: '**Device Information**',
            sm: 12,
        };
        items.name = {
            type: 'text',
            label: 'Name',
            sm: 6,
            disabled: true,
        };
        data.name = (device && device.name) || (entry && entry.name) || id;

        items.mac = {
            type: 'text',
            label: 'MAC Address',
            sm: 6,
            disabled: true,
        };
        data.mac = mac;

        items.type = {
            type: 'text',
            label: 'Type',
            sm: 4,
            disabled: true,
        };
        data.type = (device && device.type) || (entry && entry.type) || 'unknown';

        items.source = {
            type: 'text',
            label: 'Source',
            sm: 4,
            disabled: true,
        };
        data.source = (entry && entry.source) || 'local';

        items.paired = {
            type: 'checkbox',
            label: 'Paired',
            sm: 4,
            disabled: true,
        };
        data.paired = !!(device && device.paired) || !!(entry && entry.paired);

        // Signal section
        items._header_signal = {
            type: 'staticText',
            text: '**Signal**',
            newLine: true,
            sm: 12,
        };
        items.rssi = {
            type: 'number',
            label: 'RSSI (dBm)',
            sm: 4,
            disabled: true,
        };
        data.rssi = (device && device.rssi) || (entry && entry.rssi) || null;

        items.lastSeen = {
            type: 'text',
            label: 'Last Seen',
            sm: 8,
            disabled: true,
        };
        data.lastSeen = entry && entry.lastSeen
            ? new Date(entry.lastSeen).toISOString()
            : 'unknown';

        // Connection status
        items._header_connection = {
            type: 'staticText',
            text: '**Connection**',
            newLine: true,
            sm: 12,
        };
        items.connected = {
            type: 'checkbox',
            label: 'Connected',
            sm: 4,
            disabled: true,
        };
        data.connected = !!(device && device.connected);

        items.trusted = {
            type: 'checkbox',
            label: 'Trusted',
            sm: 4,
            disabled: true,
        };
        data.trusted = !!(device && device.trusted);

        items.blocked = {
            type: 'checkbox',
            label: 'Blocked',
            sm: 4,
            disabled: true,
        };
        data.blocked = !!(device && device.blocked);

        // Service / Manufacturer data
        if (device && device.manufacturerData) {
            items._header_adv = {
                type: 'staticText',
                text: '**Advertisement Data**',
                newLine: true,
                sm: 12,
            };
            items.manufacturerData = {
                type: 'text',
                label: 'Manufacturer Data',
                sm: 12,
                disabled: true,
            };
            data.manufacturerData = JSON.stringify(device.manufacturerData);
        }

        return {
            id,
            schema: {
                type: 'panel',
                items,
            },
            data,
        };
    }
}

module.exports = BluetoothDeviceManagement;

'use strict';

const dbus = require('dbus-next');
const { Interface: DbusInterface } = dbus.interface;

const AGENT_IFACE = 'org.bluez.Agent1';
const AGENT_MANAGER_IFACE = 'org.bluez.AgentManager1';
const AGENT_PATH = '/org/iobroker/bluetooth/agent';

/**
 * BluezAgent – implements org.bluez.Agent1 on D-Bus to handle pairing
 * requests (PIN, passkey, confirmation) for both Classic BT and BLE.
 *
 * Pairing flow:
 *   1. BlueZ calls RequestConfirmation(device, passkey) or similar
 *   2. Agent emits 'pairingRequest' with details + resolve/reject callbacks
 *   3. Adapter writes passkey to ioBroker state, user confirms via state
 *   4. On confirm → resolve(), on reject/timeout → reject()
 *
 * If no listener handles the event within the timeout, auto-reject.
 *
 * @emits pairingRequest ({ device, mac, method, passkey, resolve, reject })
 */
class BluezAgent {

    /**
     * @param {object} opts
     * @param {import('dbus-next').MessageBus} opts.bus – system bus
     * @param {object} opts.log – ioBroker logger
     * @param {number} [opts.timeout=30000] – pairing confirmation timeout (ms)
     */
    constructor(opts) {
        this.bus = opts.bus;
        this.log = opts.log;
        this.timeout = opts.timeout ?? 30000;

        /** @type {Function|null} bound message handler */
        this._msgHandler = null;
        /** @type {boolean} */
        this._registered = false;

        /** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
        this._pending = new Map();

        /** @type {Function|null} external listener for pairing requests */
        this._onPairingRequest = null;
    }

    /**
     * Set the callback for pairing requests.
     * @param {Function} handler – (request) => void
     */
    onPairingRequest(handler) {
        this._onPairingRequest = handler;
    }

    /**
     * Register the agent with BlueZ.
     * Exports our Agent1 interface on D-Bus and registers via AgentManager1.
     */
    async register() {
        // Export our agent object on the bus
        this._exportAgent();

        // Register with BlueZ AgentManager
        const agentManagerProxy = await this.bus.getProxyObject('org.bluez', '/org/bluez');
        const agentManager = agentManagerProxy.getInterface(AGENT_MANAGER_IFACE);

        try {
            await agentManager.RegisterAgent(AGENT_PATH, 'KeyboardDisplay');
            this.log.info('BlueZ agent registered (capability: KeyboardDisplay)');
        } catch (e) {
            if (e.message && e.message.includes('AlreadyExists')) {
                this.log.debug('Agent already registered, re-registering…');
                try { await agentManager.UnregisterAgent(AGENT_PATH); } catch (_) { /* ignore */ }
                await agentManager.RegisterAgent(AGENT_PATH, 'KeyboardDisplay');
                this.log.info('BlueZ agent re-registered');
            } else {
                throw e;
            }
        }

        // Make us the default agent
        try {
            await agentManager.RequestDefaultAgent(AGENT_PATH);
            this.log.debug('Set as default agent');
        } catch (e) {
            this.log.warn(`RequestDefaultAgent failed: ${e.message}`);
        }

        this._registered = true;
    }

    /**
     * Unregister the agent from BlueZ.
     */
    async unregister() {
        if (!this._registered) return;

        // Reject all pending requests
        for (const [key, pending] of this._pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Agent unregistered'));
            this._pending.delete(key);
        }

        try {
            const agentManagerProxy = await this.bus.getProxyObject('org.bluez', '/org/bluez');
            const agentManager = agentManagerProxy.getInterface(AGENT_MANAGER_IFACE);
            await agentManager.UnregisterAgent(AGENT_PATH);
            this.log.info('BlueZ agent unregistered');
        } catch (e) {
            this.log.debug(`Agent unregister: ${e.message}`);
        }

        try {
            this.bus.unexport(AGENT_PATH);
        } catch (_) { /* ignore */ }

        this._registered = false;
    }

    /**
     * Confirm a pending pairing request (called by adapter when user confirms).
     * @param {string} mac
     */
    confirmPairing(mac) {
        const key = this._normalise(mac);
        const pending = this._pending.get(key);
        if (pending) {
            clearTimeout(pending.timer);
            pending.resolve();
            this._pending.delete(key);
            this.log.info(`Pairing confirmed for ${mac}`);
        } else {
            this.log.warn(`No pending pairing request for ${mac}`);
        }
    }

    /**
     * Reject a pending pairing request.
     * @param {string} mac
     */
    rejectPairing(mac) {
        const key = this._normalise(mac);
        const pending = this._pending.get(key);
        if (pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Pairing rejected by user'));
            this._pending.delete(key);
            this.log.info(`Pairing rejected for ${mac}`);
        }
    }

    // ─── Private: D-Bus agent implementation ─────────────────────────

    /**
     * Export our Agent1 object on the D-Bus so BlueZ can call us.
     * Uses dbus-next's Interface export mechanism.
     * @private
     */
    _exportAgent() {
        const self = this;

        // Create Agent1 interface class dynamically
        class Agent1 extends DbusInterface {
            Release() {
                self.log.info('Agent released by BlueZ');
            }

            RequestPinCode(device) {
                self.log.info(`RequestPinCode for ${device}`);
                self._emitPairingRequest(device, 'pin', null);
                return '0000';
            }

            DisplayPinCode(device, pincode) {
                self.log.info(`DisplayPinCode for ${device}: ${pincode}`);
                self._emitPairingRequest(device, 'displayPin', pincode);
            }

            RequestPasskey(device) {
                self.log.info(`RequestPasskey for ${device}`);
                self._emitPairingRequest(device, 'passkey', null);
                return 0;
            }

            DisplayPasskey(device, passkey, entered) {
                self.log.info(`DisplayPasskey for ${device}: ${String(passkey).padStart(6, '0')} (entered: ${entered})`);
                self._emitPairingRequest(device, 'displayPasskey', String(passkey).padStart(6, '0'));
            }

            RequestConfirmation(device, passkey) {
                return self._handleRequestConfirmation(device, passkey);
            }

            RequestAuthorization(device) {
                self.log.info(`RequestAuthorization for ${device} – auto-accepting`);
                self._emitPairingRequest(device, 'authorization', null);
            }

            AuthorizeService(device, uuid) {
                self.log.info(`AuthorizeService for ${device}, UUID: ${uuid} – auto-accepting`);
            }

            Cancel() {
                self.log.info('Pairing cancelled by BlueZ');
            }
        }

        // Decorate methods with D-Bus signatures
        Agent1.configureMembers({
            methods: {
                Release:              { inSignature: '',    outSignature: '' },
                RequestPinCode:       { inSignature: 'o',   outSignature: 's' },
                DisplayPinCode:       { inSignature: 'os',  outSignature: '' },
                RequestPasskey:       { inSignature: 'o',   outSignature: 'u' },
                DisplayPasskey:       { inSignature: 'ouq', outSignature: '' },
                RequestConfirmation:  { inSignature: 'ou',  outSignature: '' },
                RequestAuthorization: { inSignature: 'o',   outSignature: '' },
                AuthorizeService:     { inSignature: 'os',  outSignature: '' },
                Cancel:               { inSignature: '',    outSignature: '' },
            },
        });

        this._agentIface = new Agent1(AGENT_IFACE);
        this.bus.export(AGENT_PATH, this._agentIface);
    }

    /**
     * Handle RequestConfirmation – the main SSP pairing method.
     * Returns a Promise that resolves on user confirm or rejects on timeout/reject.
     *
     * @param {string} devicePath
     * @param {number} passkey
     * @returns {Promise<void>}
     * @private
     */
    _handleRequestConfirmation(devicePath, passkey) {
        const mac = this._devicePathToMac(devicePath);
        const passkeyStr = String(passkey).padStart(6, '0');

        this.log.info(`RequestConfirmation for ${mac}: passkey ${passkeyStr} – waiting for user confirmation`);

        const key = this._normalise(mac);

        return new Promise((resolve, reject) => {
            const pending = { resolve, reject };

            // Timeout → auto-reject
            pending.timer = setTimeout(() => {
                this._pending.delete(key);
                reject(new dbus.DBusError('org.bluez.Error.Rejected', 'Pairing confirmation timeout'));
                this.log.warn(`Pairing confirmation timeout for ${mac}`);
            }, this.timeout);

            this._pending.set(key, pending);

            // Emit pairing request to adapter
            this._emitPairingRequest(devicePath, 'confirmation', passkeyStr);
        });
    }

    /**
     * Emit a pairing request event to the adapter.
     * @param {string} devicePath
     * @param {string} method – 'confirmation'|'pin'|'passkey'|'displayPin'|'displayPasskey'|'authorization'
     * @param {string|null} passkey
     * @private
     */
    _emitPairingRequest(devicePath, method, passkey) {
        const mac = this._devicePathToMac(devicePath);

        if (this._onPairingRequest) {
            this._onPairingRequest({
                device: devicePath,
                mac,
                method,
                passkey,
            });
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────────

    /**
     * Extract MAC from BlueZ device path.
     * @param {string} path
     * @returns {string}
     * @private
     */
    _devicePathToMac(path) {
        const match = path.match(/dev_([0-9A-Fa-f_]{17})/);
        if (!match) return path;
        return match[1].replace(/_/g, ':').toUpperCase();
    }

    /**
     * Normalise MAC to upper-case colon form.
     * @param {string} mac
     * @returns {string}
     * @private
     */
    _normalise(mac) {
        return mac.replace(/[-]/g, ':').toUpperCase();
    }
}

module.exports = BluezAgent;

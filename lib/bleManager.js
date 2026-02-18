'use strict';

const { execSync } = require('child_process');
const EventEmitter = require('events');

/**
 * BLE Manager – wraps @stoprocent/noble for scanning, connecting and
 * performing GATT operations (read / write / subscribe).
 *
 * Emits:
 *   'deviceFound'   (peripheral)          – during a scan window
 *   'stateChange'   (state)               – noble adapter state
 */
class BleManager extends EventEmitter {

    /**
     * @param {object} opts
     * @param {object} opts.log           – ioBroker-style logger (debug/info/warn/error)
     * @param {number} [opts.hciDevice=0] – /dev/hciN index
     */
    constructor(opts) {
        super();
        this.log = opts.log;
        this.hciDevice = opts.hciDevice ?? 0;
        this.noble = null;
        this._scanning = false;
        this._destroyed = false;

        /** @type {Map<string, import('@stoprocent/noble').Peripheral>} mac → peripheral */
        this.peripherals = new Map();
    }

    // ── Lifecycle ────────────────────────────────────────────────────

    /**
     * Initialise noble (sets HCI device via env before require).
     * Returns a promise that resolves once the adapter is powered on
     * (or rejects after a timeout).
     *
     * Includes HCI auto-power-on: if the adapter doesn't reach "poweredOn"
     * within 5 s, attempts `hciconfig hciN up` and waits another 10 s.
     */
    async init() {
        // noble reads NOBLE_HCI_DEVICE_ID at require-time
        process.env.NOBLE_HCI_DEVICE_ID = String(this.hciDevice);

        // Lazy-require so env var is already set
        this.noble = require('@stoprocent/noble');

        // Phase 1: Wait up to 5 s for poweredOn
        const powered = await this._waitForPoweredOn(5_000);

        if (powered) {
            return;
        }

        // Phase 2: Auto-power-on via hciconfig
        this.log.info(`Bluetooth adapter hci${this.hciDevice} not powered on after 5 s – attempting auto-power-on via hciconfig …`);

        try {
            execSync(`hciconfig hci${this.hciDevice} up`, { timeout: 5_000, stdio: 'pipe' });
            this.log.info(`hciconfig hci${this.hciDevice} up executed successfully`);
        } catch (err) {
            this.log.warn(`hciconfig hci${this.hciDevice} up failed: ${err.message} (may need root/cap_net_admin)`);
        }

        // Phase 3: Wait another 10 s for poweredOn after hciconfig up
        const poweredAfterReset = await this._waitForPoweredOn(10_000);

        if (!poweredAfterReset) {
            throw new Error(`Bluetooth adapter hci${this.hciDevice} did not reach "poweredOn" within 15 s (including auto-power-on attempt)`);
        }

        this.log.info('Bluetooth adapter powered on after auto-power-on');
    }

    /**
     * Wait for Noble to report "poweredOn" state.
     * @param {number} timeoutMs – maximum time to wait
     * @returns {Promise<boolean>} – true if poweredOn, false if timed out
     * @private
     */
    _waitForPoweredOn(timeoutMs) {
        return new Promise((resolve) => {
            if (this.noble.state === 'poweredOn') {
                return resolve(true);
            }

            const timeout = setTimeout(() => {
                this.noble.removeListener('stateChange', onState);
                resolve(false);
            }, timeoutMs);

            const onState = (state) => {
                this.log.debug(`Noble adapter state: ${state}`);
                this.emit('stateChange', state);
                if (state === 'poweredOn') {
                    clearTimeout(timeout);
                    this.noble.removeListener('stateChange', onState);
                    resolve(true);
                }
            };

            this.noble.on('stateChange', onState);
        });
    }

    /** Cleanly tear down – stop scanning & disconnect all. */
    async destroy() {
        this._destroyed = true;
        await this.stopScan();

        const disconnects = [];
        for (const [mac, peripheral] of this.peripherals) {
            if (peripheral.state === 'connected') {
                this.log.info(`Disconnecting ${mac} (shutdown)`);
                disconnects.push(
                    this._disconnectPeripheral(peripheral).catch(() => {})
                );
            }
        }
        await Promise.all(disconnects);
        this.peripherals.clear();

        if (this.noble) {
            this.noble.removeAllListeners();
            try { this.noble.reset(); } catch (_) { /* ignore */ }
        }
    }

    // ── Scanning ─────────────────────────────────────────────────────

    /**
     * Run a single scan window.
     * @param {number} durationMs – how long to scan (ms)
     * @param {object} [opts] – scan options
     * @param {string} [opts.scanMode='active'] – 'active' or 'passive'
     * @returns {Promise<Map<string,object>>}  mac → { peripheral, name, rssi, serviceUuids, manufacturerData, serviceData, txPowerLevel }
     */
    async scan(durationMs, opts = {}) {
        if (this._destroyed) return new Map();
        if (this._scanning) {
            this.log.debug('Scan already running – skipping');
            return new Map();
        }

        /** @type {Map<string,object>} */
        const found = new Map();

        const onDiscover = (peripheral) => {
            const mac = this._normaliseMac(peripheral.id || peripheral.address);
            if (!mac) return;

            this.peripherals.set(mac, peripheral);

            const adv = peripheral.advertisement || {};

            const entry = {
                peripheral,
                name: adv.localName || '',
                rssi: peripheral.rssi,
                serviceUuids: adv.serviceUuids || [],
                // Advertisement data (new)
                manufacturerData: adv.manufacturerData || null,
                serviceData: adv.serviceData || [],
                txPowerLevel: typeof adv.txPowerLevel === 'number' ? adv.txPowerLevel : null,
            };
            found.set(mac, entry);
            this.emit('deviceFound', mac, entry);
        };

        this.noble.on('discover', onDiscover);

        try {
            this._scanning = true;
            this.log.debug(`Starting BLE scan for ${durationMs} ms …`);

            // allowDuplicates = true for active mode (default), false for passive
            const allowDuplicates = (opts.scanMode || 'active') !== 'passive';
            await this._startScanning(allowDuplicates);

            await this._delay(durationMs);

            await this._stopScanning();
            this.log.debug(`Scan finished – ${found.size} device(s) found`);
        } finally {
            this._scanning = false;
            this.noble.removeListener('discover', onDiscover);
        }
        return found;
    }

    async stopScan() {
        if (this._scanning) {
            try { await this._stopScanning(); } catch (_) { /* ok */ }
            this._scanning = false;
        }
    }

    // ── Connect / Disconnect ─────────────────────────────────────────

    /**
     * Connect to a peripheral by MAC.  The caller must have run at least one
     * scan so that `this.peripherals` contains the device.
     * @param {string} mac – normalised MAC (AA-BB-CC-DD-EE-FF or lowercase hex)
     * @returns {Promise<import('@stoprocent/noble').Peripheral>}
     */
    async connect(mac) {
        const peripheral = this.peripherals.get(mac);
        if (!peripheral) throw new Error(`Unknown peripheral ${mac}`);

        if (peripheral.state === 'connected') {
            this.log.debug(`${mac} already connected`);
            return peripheral;
        }

        this.log.info(`Connecting to ${mac} …`);
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Connect timeout for ${mac}`)), 20_000);
            peripheral.connect((err) => {
                clearTimeout(timer);
                if (err) return reject(err);
                resolve();
            });
        });
        this.log.info(`Connected to ${mac}`);
        return peripheral;
    }

    /**
     * Disconnect a peripheral.
     * @param {string} mac
     */
    async disconnect(mac) {
        const peripheral = this.peripherals.get(mac);
        if (!peripheral) return;
        await this._disconnectPeripheral(peripheral);
        this.log.info(`Disconnected from ${mac}`);
    }

    /**
     * Register a handler that fires when the remote end disconnects.
     * @param {string} mac
     * @param {function} handler
     */
    onDisconnect(mac, handler) {
        const peripheral = this.peripherals.get(mac);
        if (peripheral) {
            peripheral.once('disconnect', handler);
        }
    }

    // ── GATT Discovery ───────────────────────────────────────────────

    /**
     * Discover all services & characteristics for a connected peripheral.
     * @param {string} mac
     * @returns {Promise<Array<{service: object, characteristics: object[]}>>}
     */
    async discoverAll(mac) {
        const peripheral = this.peripherals.get(mac);
        if (!peripheral || peripheral.state !== 'connected') {
            throw new Error(`${mac} not connected`);
        }

        this.log.debug(`Discovering services for ${mac} …`);

        const results = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Discovery timeout for ${mac}`)), 30_000);
            peripheral.discoverAllServicesAndCharacteristics((err, services, _chars) => {
                clearTimeout(timer);
                if (err) return reject(err);

                const out = (services || []).map((svc) => ({
                    service: svc,
                    uuid: svc.uuid,
                    characteristics: (svc.characteristics || []).map((ch) => ({
                        characteristic: ch,
                        uuid: ch.uuid,
                        properties: ch.properties || [],
                    })),
                }));
                resolve(out);
            });
        });

        this.log.debug(`${mac}: found ${results.length} service(s)`);
        return results;
    }

    // ── Read / Write / Notify ────────────────────────────────────────

    /**
     * Read a characteristic value.
     * @param {object} characteristic – noble Characteristic object
     * @returns {Promise<Buffer>}
     */
    async read(characteristic) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Read timeout')), 10_000);
            characteristic.read((err, data) => {
                clearTimeout(timer);
                if (err) return reject(err);
                resolve(data);
            });
        });
    }

    /**
     * Write to a characteristic.
     * @param {object} characteristic – noble Characteristic object
     * @param {Buffer} buffer
     * @param {boolean} [withoutResponse=false]
     * @returns {Promise<void>}
     */
    async write(characteristic, buffer, withoutResponse = false) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Write timeout')), 10_000);
            characteristic.write(buffer, withoutResponse, (err) => {
                clearTimeout(timer);
                if (err) return reject(err);
                resolve();
            });
        });
    }

    /**
     * Subscribe to notifications / indications on a characteristic.
     * @param {object} characteristic – noble Characteristic object
     * @param {function(Buffer):void} handler
     * @returns {Promise<void>}
     */
    async subscribe(characteristic, handler) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Subscribe timeout')), 10_000);

            characteristic.on('data', handler);

            characteristic.subscribe((err) => {
                clearTimeout(timer);
                if (err) {
                    characteristic.removeListener('data', handler);
                    return reject(err);
                }
                resolve();
            });
        });
    }

    /**
     * Unsubscribe from notifications on a characteristic.
     * @param {object} characteristic
     */
    async unsubscribe(characteristic) {
        return new Promise((resolve) => {
            characteristic.unsubscribe(() => resolve());
            characteristic.removeAllListeners('data');
        });
    }

    // ── Helpers (private) ────────────────────────────────────────────

    /**
     * Normalise a MAC / peripheral id to upper-case dashed form:
     *   "aabbccddeeff" → "AA-BB-CC-DD-EE-FF"
     */
    _normaliseMac(raw) {
        if (!raw) return null;
        const clean = raw.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
        if (clean.length !== 12) return raw.toUpperCase().replace(/:/g, '-');
        return clean.match(/.{2}/g).join('-');
    }

    /**
     * Promisified noble.startScanning wrapper.
     * @param {boolean} [allowDuplicates=true] – whether to report duplicates
     */
    _startScanning(allowDuplicates = true) {
        return new Promise((resolve, reject) => {
            this.noble.startScanning([], allowDuplicates, (err) => {
                if (err) return reject(err);
                resolve();
            });
        });
    }

    /** Promisified noble.stopScanningAsync wrapper */
    _stopScanning() {
        return new Promise((resolve) => {
            this.noble.stopScanning(() => resolve());
        });
    }

    /** @private */
    _disconnectPeripheral(peripheral) {
        return new Promise((resolve) => {
            if (peripheral.state !== 'connected') return resolve();
            peripheral.disconnect(() => resolve());
        });
    }

    _delay(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }
}

module.exports = BleManager;

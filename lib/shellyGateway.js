'use strict';

const mqtt = require('mqtt');
const EventEmitter = require('events');
const { parseAdvertisement } = require('./advertisementParser');
const { findBTHomeData, parseBTHome } = require('./bthomeParser');

/**
 * ShellyGateway – receives BLE scan results from Shelly Gen2+ devices via MQTT.
 *
 * Shellys with BLE gateway scripts publish scan results to MQTT.
 * This module subscribes to those topics, parses the results, and emits
 * normalized events compatible with the DeviceManager.
 *
 * Events:
 *   'deviceFound' – { mac, name, rssi, source, serviceData[], manufacturerData, txPower, bthome }
 *   'shellyOnline' – { id, name }
 *   'shellyOffline' – { id }
 *   'error' – Error
 *
 * @extends EventEmitter
 */
class ShellyGateway extends EventEmitter {

    /**
     * @param {object} opts
     * @param {object} opts.config – adapter config (shellyGateway section)
     * @param {object} opts.log – adapter log interface
     */
    constructor(opts) {
        super();
        this.config = opts.config || {};
        this.log = opts.log;

        /** @type {import('mqtt').MqttClient|null} */
        this.client = null;

        /**
         * Known Shelly gateways – tracks last seen time and device count.
         * @type {Map<string, {name: string, lastSeen: Date, deviceCount: number}>}
         */
        this.shellys = new Map();

        /**
         * Track last advertisement per MAC to throttle updates.
         * @type {Map<string, number>}
         */
        this._lastUpdate = new Map();

        /** Minimum interval between updates for the same MAC (ms) */
        this._throttleMs = 1000;

        this._destroyed = false;
    }

    /**
     * Connect to the MQTT broker and start listening for Shelly BLE scans.
     */
    async start() {
        const host = this.config.mqttHost || 'localhost';
        const port = this.config.mqttPort || 1883;
        const topic = this.config.mqttTopic || 'shelly/+/events/rpc';
        const username = this.config.mqttUser || undefined;
        const password = this.config.mqttPassword || undefined;
        const clientId = `iobroker-bluetooth-${Date.now()}`;

        const url = `mqtt://${host}:${port}`;
        this.log.info(`ShellyGateway: connecting to ${url}, topic: ${topic}`);

        return new Promise((resolve, reject) => {
            this.client = mqtt.connect(url, {
                clientId,
                username,
                password,
                clean: true,
                reconnectPeriod: 5000,
                connectTimeout: 10000,
            });

            this.client.on('connect', () => {
                this.log.info('ShellyGateway: MQTT connected');
                this.client.subscribe(topic, (err) => {
                    if (err) {
                        this.log.error(`ShellyGateway: subscribe failed: ${err.message}`);
                        reject(err);
                    } else {
                        this.log.info(`ShellyGateway: subscribed to ${topic}`);
                        resolve();
                    }
                });
            });

            this.client.on('message', (topic, message) => {
                this._handleMessage(topic, message);
            });

            this.client.on('error', (err) => {
                this.log.error(`ShellyGateway: MQTT error: ${err.message}`);
                this.emit('error', err);
            });

            this.client.on('reconnect', () => {
                this.log.debug('ShellyGateway: MQTT reconnecting...');
            });

            this.client.on('close', () => {
                if (!this._destroyed) {
                    this.log.debug('ShellyGateway: MQTT connection closed');
                }
            });

            // Timeout for initial connection
            setTimeout(() => {
                if (!this.client.connected) {
                    reject(new Error(`ShellyGateway: connection timeout to ${url}`));
                }
            }, 15000);
        });
    }

    /**
     * Stop the MQTT client and clean up.
     */
    async stop() {
        this._destroyed = true;
        if (this.client) {
            await new Promise((resolve) => {
                this.client.end(false, {}, resolve);
            });
            this.client = null;
        }
        this.shellys.clear();
        this._lastUpdate.clear();
        this.log.info('ShellyGateway: stopped');
    }

    /**
     * Get list of known Shelly gateways.
     * @returns {Array<{id: string, name: string, lastSeen: string, deviceCount: number}>}
     */
    getShellys() {
        const result = [];
        for (const [id, info] of this.shellys) {
            result.push({
                id,
                name: info.name,
                lastSeen: info.lastSeen.toISOString(),
                deviceCount: info.deviceCount,
            });
        }
        return result;
    }

    // ── Private ──────────────────────────────────────────────────────

    /**
     * Handle an incoming MQTT message from a Shelly.
     *
     * Expected formats:
     * 1. NotifyStatus with ble.scan_result (Shelly BLE observer script)
     * 2. Direct BLE scan events
     *
     * @param {string} topic
     * @param {Buffer} message
     */
    _handleMessage(topic, message) {
        try {
            const payload = JSON.parse(message.toString());
            const shellyId = this._extractShellyId(topic, payload);

            // Update Shelly tracking
            if (shellyId) {
                const existing = this.shellys.get(shellyId) || {
                    name: shellyId,
                    lastSeen: new Date(),
                    deviceCount: 0,
                };
                existing.lastSeen = new Date();
                this.shellys.set(shellyId, existing);
            }

            // Handle different message formats
            if (payload.method === 'NotifyStatus' && payload.params?.ble?.scan_result) {
                // Shelly BLE observer script format
                this._processScanResults(payload.params.ble.scan_result, shellyId);
            } else if (payload.method === 'NotifyEvent' && payload.params?.events) {
                // Shelly event format – look for BLE scan events
                for (const event of payload.params.events) {
                    if (event.event === 'ble.scan_result' && event.data) {
                        this._processScanResults(
                            Array.isArray(event.data) ? event.data : [event.data],
                            shellyId
                        );
                    }
                }
            }
        } catch (err) {
            this.log.debug(`ShellyGateway: failed to parse message on ${topic}: ${err.message}`);
        }
    }

    /**
     * Extract Shelly device ID from MQTT topic or payload.
     * @param {string} topic – e.g. "shelly/shellyplus1-aabbcc/events/rpc"
     * @param {object} payload
     * @returns {string|null}
     */
    _extractShellyId(topic, payload) {
        // From payload src field
        if (payload.src) return payload.src;

        // From topic: shelly/<id>/events/rpc
        const parts = topic.split('/');
        if (parts.length >= 2) return parts[1];

        return null;
    }

    /**
     * Process an array of BLE scan results from a Shelly.
     *
     * @param {Array<{addr: string, rssi: number, advData: string, scanRsp?: string}>} results
     * @param {string|null} shellyId
     */
    _processScanResults(results, shellyId) {
        if (!Array.isArray(results)) return;

        let deviceCount = 0;

        for (const entry of results) {
            if (!entry.addr) continue;

            const mac = entry.addr.toUpperCase();
            const now = Date.now();

            // Throttle: skip if we updated this MAC very recently
            const lastUpdate = this._lastUpdate.get(mac) || 0;
            if (now - lastUpdate < this._throttleMs) continue;
            this._lastUpdate.set(mac, now);

            // Decode advertisement data
            const advRaw = entry.advData ? Buffer.from(entry.advData, 'base64') : Buffer.alloc(0);
            const scanRspRaw = entry.scanRsp ? Buffer.from(entry.scanRsp, 'base64') : null;

            // Parse AD structures
            const adv = parseAdvertisement(advRaw);

            // Also parse scan response if available and merge
            if (scanRspRaw) {
                const scanRsp = parseAdvertisement(scanRspRaw);
                if (scanRsp.localName && !adv.localName) adv.localName = scanRsp.localName;
                if (scanRsp.txPower !== null && adv.txPower === null) adv.txPower = scanRsp.txPower;
                adv.serviceData.push(...scanRsp.serviceData);
                adv.serviceUuids.push(...scanRsp.serviceUuids);
                if (scanRsp.manufacturerData && !adv.manufacturerData) {
                    adv.manufacturerData = scanRsp.manufacturerData;
                }
            }

            // Check for BTHome data
            const bthomeRaw = findBTHomeData(adv.serviceData);
            const bthome = bthomeRaw ? parseBTHome(bthomeRaw) : null;

            const event = {
                mac,
                name: adv.localName || null,
                rssi: entry.rssi ?? null,
                source: shellyId || 'shelly-unknown',
                serviceData: adv.serviceData,
                manufacturerData: adv.manufacturerData,
                txPower: adv.txPower,
                bthome,
            };

            this.emit('deviceFound', event);
            deviceCount++;
        }

        // Update device count for this Shelly
        if (shellyId && this.shellys.has(shellyId)) {
            this.shellys.get(shellyId).deviceCount = deviceCount;
        }
    }
}

module.exports = ShellyGateway;

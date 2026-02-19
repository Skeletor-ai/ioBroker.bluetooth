'use strict';

/**
 * Test script: simulate Shelly MQTT BLE scan messages.
 *
 * Usage: node test-shelly-mqtt.js [mqtt-host]
 *
 * Publishes fake BLE scan results to the MQTT broker as if a Shelly device
 * was reporting them. Useful for testing the ShellyGateway module without
 * actual Shelly hardware.
 */

const mqtt = require('mqtt');

const host = process.argv[2] || 'localhost';
const client = mqtt.connect(`mqtt://${host}:1883`);

// BTHome v2 test payload: temperature 22.50°C, humidity 55.20%
// Device info byte: 0x40 (version=2, no encryption)
// Temp: objectId=0x02, sint16 LE, value=2250 (0x08CA) → 22.50°C
// Humidity: objectId=0x03, uint16 LE, value=5520 (0x1590) → 55.20%
const bthomePayload = Buffer.from([0x40, 0x02, 0xCA, 0x08, 0x03, 0x90, 0x15]);

// Build raw BLE advertisement with BTHome service data (UUID 0xFCD2)
// AD structure: [length] [type] [data...]
// Service Data 16-bit: type=0x16, UUID=0xFCD2 (LE: D2 FC), then payload
const serviceDataAd = Buffer.concat([
    Buffer.from([
        bthomePayload.length + 3,  // length (type + uuid + payload)
        0x16,                       // AD type: Service Data - 16 bit UUID
        0xD2, 0xFC,                 // UUID 0xFCD2 in LE
    ]),
    bthomePayload,
]);

// Add a Complete Local Name AD structure
const name = 'BTHome Sensor';
const nameAd = Buffer.from([
    name.length + 1,  // length
    0x09,             // AD type: Complete Local Name
    ...Buffer.from(name, 'utf8'),
]);

// Combine all AD structures
const advData = Buffer.concat([nameAd, serviceDataAd]);

// Shelly NotifyStatus message with BLE scan result
const shellyMessage = {
    src: 'shellyplus1-test123',
    dst: 'user_1',
    method: 'NotifyStatus',
    params: {
        ts: Date.now() / 1000,
        ble: {
            scan_result: [
                {
                    addr: 'AA:BB:CC:DD:EE:01',
                    rssi: -55,
                    advData: advData.toString('base64'),
                },
                {
                    addr: 'AA:BB:CC:DD:EE:02',
                    rssi: -72,
                    advData: advData.toString('base64'),
                },
            ],
        },
    },
};

client.on('connect', () => {
    console.log('Connected to MQTT broker');

    const topic = 'shelly/shellyplus1-test123/events/rpc';

    // Send one message immediately
    const payload = JSON.stringify(shellyMessage);
    client.publish(topic, payload);
    console.log(`Published to ${topic}:`);
    console.log(`  advData (base64): ${advData.toString('base64')}`);
    console.log(`  advData (hex):    ${advData.toString('hex')}`);
    console.log(`  BTHome payload:   ${bthomePayload.toString('hex')}`);
    console.log('  Expected: temperature=22.50°C, humidity=55.20%');

    // Send again every 5 seconds
    const interval = setInterval(() => {
        shellyMessage.params.ts = Date.now() / 1000;
        // Vary RSSI slightly
        shellyMessage.params.ble.scan_result[0].rssi = -55 + Math.floor(Math.random() * 10) - 5;
        client.publish(topic, JSON.stringify(shellyMessage));
        console.log(`Published update (RSSI: ${shellyMessage.params.ble.scan_result[0].rssi})`);
    }, 5000);

    // Stop after 30 seconds
    setTimeout(() => {
        clearInterval(interval);
        client.end();
        console.log('Done');
    }, 30000);
});

client.on('error', (err) => {
    console.error('MQTT error:', err.message);
    process.exit(1);
});

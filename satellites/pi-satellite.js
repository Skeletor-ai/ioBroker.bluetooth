#!/usr/bin/env node
'use strict';

/**
 * ioBroker.bluetooth Pi Satellite
 *
 * Standalone BLE scanner that connects to the ioBroker.bluetooth adapter
 * via TCP and sends JSONL discover events.
 *
 * Usage: node pi-satellite.js --host 192.168.1.100 --port 8734 --name wohnzimmer-pi --hci 0
 */

const net = require('net');
const os = require('os');

// Parse CLI arguments
const args = {};
for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith('--')) {
        const key = arg.slice(2);
        args[key] = process.argv[++i] || '';
    }
}

const HOST = args.host || '127.0.0.1';
const PORT = parseInt(args.port) || 8734;
const NAME = args.name || os.hostname();
const HCI = parseInt(args.hci) || 0;
const RECONNECT_DELAY = 5000;
const VERSION = '1.0.0';

let noble;
let socket = null;
let reconnectTimer = null;
let scanning = false;

/**
 * Initialize noble BLE library.
 */
function initNoble() {
    // Set HCI device before requiring noble
    process.env.NOBLE_HCI_DEVICE_ID = String(HCI);
    try {
        noble = require('@stoprocent/noble');
    } catch (e) {
        console.error('Failed to load @stoprocent/noble. Install it: npm install @stoprocent/noble');
        process.exit(1);
    }
}

/**
 * Send JSONL message to server.
 */
function send(obj) {
    if (socket && !socket.destroyed) {
        try {
            socket.write(JSON.stringify(obj) + '\n');
        } catch (e) {
            console.error('Send error:', e.message);
        }
    }
}

/**
 * Start BLE scanning.
 */
function startScan() {
    if (scanning) return;
    noble.on('discover', onDiscover);
    noble.startScanning([], true, (err) => {
        if (err) {
            console.error('Scan start error:', err.message);
            return;
        }
        scanning = true;
        send({ type: 'status', scanning: true });
        console.log('BLE scanning started');
    });
}

/**
 * Stop BLE scanning.
 */
function stopScan() {
    if (!scanning) return;
    noble.stopScanning();
    noble.removeListener('discover', onDiscover);
    scanning = false;
    send({ type: 'status', scanning: false });
    console.log('BLE scanning stopped');
}

/**
 * Handle discovered BLE peripheral.
 */
function onDiscover(peripheral) {
    const msg = {
        type: 'discover',
        address: peripheral.address?.toUpperCase() || '',
        addressType: peripheral.addressType || 'unknown',
        rssi: peripheral.rssi ?? -100,
        name: peripheral.advertisement?.localName || '',
    };

    // Service data
    const sd = peripheral.advertisement?.serviceData;
    if (sd && sd.length > 0) {
        msg.serviceData = sd.map(entry => ({
            uuid: entry.uuid,
            data: entry.data ? entry.data.toString('base64') : '',
        }));
    }

    // Manufacturer data
    const md = peripheral.advertisement?.manufacturerData;
    if (md && md.length > 0) {
        msg.manufacturerData = md.toString('base64');
    }

    send(msg);
}

/**
 * Connect to the adapter TCP server.
 */
function connect() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    console.log(`Connecting to ${HOST}:${PORT}...`);
    socket = net.createConnection({ host: HOST, port: PORT }, () => {
        console.log(`Connected to ${HOST}:${PORT}`);
        send({ type: 'hello', name: NAME, platform: os.platform(), version: VERSION });
    });

    socket.setEncoding('utf8');
    let lineBuffer = '';

    socket.on('data', (chunk) => {
        lineBuffer += chunk;
        let idx;
        while ((idx = lineBuffer.indexOf('\n')) !== -1) {
            const line = lineBuffer.slice(0, idx).trim();
            lineBuffer = lineBuffer.slice(idx + 1);
            if (line) {
                try {
                    handleServerMessage(JSON.parse(line));
                } catch (e) {
                    console.error('Parse error:', e.message);
                }
            }
        }
    });

    socket.on('close', () => {
        console.log('Disconnected from server');
        stopScan();
        scheduleReconnect();
    });

    socket.on('error', (err) => {
        console.error('Socket error:', err.message);
    });
}

/**
 * Handle message from adapter.
 */
function handleServerMessage(msg) {
    switch (msg.type) {
        case 'config':
            console.log('Received config:', JSON.stringify(msg));
            break;
        case 'command':
            if (msg.action === 'startScan') startScan();
            else if (msg.action === 'stopScan') stopScan();
            break;
        case 'ping':
            send({ type: 'pong' });
            break;
    }
}

/**
 * Schedule reconnect after disconnect.
 */
function scheduleReconnect() {
    if (reconnectTimer) return;
    console.log(`Reconnecting in ${RECONNECT_DELAY / 1000}s...`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, RECONNECT_DELAY);
}

// ── Main ─────────────────────────────────────────────────────────
console.log(`ioBroker.bluetooth Pi Satellite v${VERSION}`);
console.log(`Name: ${NAME}, HCI: hci${HCI}, Server: ${HOST}:${PORT}`);

initNoble();

noble.on('stateChange', (state) => {
    console.log(`Bluetooth state: ${state}`);
    if (state === 'poweredOn') {
        connect();
    }
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down...');
    stopScan();
    if (socket) socket.destroy();
    process.exit(0);
});
process.on('SIGTERM', () => {
    stopScan();
    if (socket) socket.destroy();
    process.exit(0);
});

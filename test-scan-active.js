'use strict';

// Direct noble test with active scanning
process.env.NOBLE_HCI_DEVICE_ID = '0';
const noble = require('@stoprocent/noble');

console.log('Waiting for poweredOn...');

noble.on('stateChange', (state) => {
    console.log(`State: ${state}`);
    if (state === 'poweredOn') {
        console.log('Starting ACTIVE scan for 30s...\n');
        // false = active scan (sends SCAN_REQ to get SCAN_RSP with names)
        noble.startScanning([], false, (err) => {
            if (err) console.error('Scan error:', err);
        });

        setTimeout(() => {
            noble.stopScanning(() => {
                console.log(`\n=== Done: ${Object.keys(devices).length} device(s) ===`);
                for (const [mac, d] of Object.entries(devices)) {
                    console.log(`  ${mac}  ${d.name || '(no name)'}  RSSI: ${d.rssi}  Services: [${d.services.join(', ')}]`);
                }
                process.exit(0);
            });
        }, 30000);
    }
});

const devices = {};
noble.on('discover', (peripheral) => {
    const mac = (peripheral.address || peripheral.id || '').toUpperCase().replace(/:/g, '-');
    const name = peripheral.advertisement?.localName || '';
    const rssi = peripheral.rssi;
    const svcs = peripheral.advertisement?.serviceUuids || [];
    
    if (!devices[mac]) {
        devices[mac] = { name, rssi, services: svcs };
        console.log(`[NEW] ${mac}  ${name || '(no name)'}  RSSI: ${rssi}`);
    } else {
        // Update name if we got one now
        if (name && !devices[mac].name) {
            devices[mac].name = name;
            console.log(`[UPD] ${mac}  name: ${name}`);
        }
        devices[mac].rssi = rssi;
    }
});

'use strict';

const BleManager = require('./lib/bleManager');

const log = {
    debug: (...a) => console.log('[DEBUG]', ...a),
    info:  (...a) => console.log('[INFO]', ...a),
    warn:  (...a) => console.warn('[WARN]', ...a),
    error: (...a) => console.error('[ERROR]', ...a),
};

(async () => {
    const mgr = new BleManager({ log, hciDevice: 0 });

    console.log('Initialising Noble (waiting for poweredOn)…');
    await mgr.init();
    console.log('Adapter ready. Starting 20s BLE scan…\n');

    const found = await mgr.scan(20_000);

    console.log(`\n=== Scan complete: ${found.size} device(s) ===\n`);
    for (const [mac, info] of found) {
        console.log(`  ${mac}  ${info.name || '(no name)'}  RSSI: ${info.rssi}  Services: [${info.serviceUuids.join(', ')}]`);
    }

    await mgr.destroy();
    console.log('\nDone.');
    process.exit(0);
})().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});

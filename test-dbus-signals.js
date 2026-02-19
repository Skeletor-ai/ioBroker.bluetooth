'use strict';
const dbus = require('@deltachat/dbus-next');
const Message = dbus.Message;

async function main() {
    const bus = dbus.systemBus();
    console.log('Connected to system bus');

    // Add match rules BEFORE getting proxies
    const addMatch = (rule) => bus.call(new Message({
        type: dbus.MessageType.METHOD_CALL,
        destination: 'org.freedesktop.DBus',
        path: '/org/freedesktop/DBus',
        interface: 'org.freedesktop.DBus',
        member: 'AddMatch',
        signature: 's',
        body: [rule],
    }));

    await addMatch("type='signal',sender='org.bluez',interface='org.freedesktop.DBus.ObjectManager'");
    await addMatch("type='signal',sender='org.bluez',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged',arg0='org.bluez.Device1'");
    console.log('Match rules added');

    let deviceCount = 0;

    // Low-level message handler
    bus.on('message', (msg) => {
        if (!msg || !msg.interface) return;

        // InterfacesAdded
        if (msg.interface === 'org.freedesktop.DBus.ObjectManager' &&
            msg.member === 'InterfacesAdded' && msg.body) {
            const [path, interfaces] = msg.body;
            const ifaceNames = Object.keys(interfaces);
            if (interfaces['org.bluez.Device1']) {
                deviceCount++;
                const dev = interfaces['org.bluez.Device1'];
                const addr = dev.Address?.value || '?';
                const name = dev.Name?.value || dev.Alias?.value || '(no name)';
                const rssi = dev.RSSI?.value || '?';
                const serviceData = dev.ServiceData?.value;
                const mfgData = dev.ManufacturerData?.value;
                console.log(`[NEW #${deviceCount}] ${addr} "${name}" rssi=${rssi}`);
                if (serviceData) {
                    for (const [uuid, data] of Object.entries(serviceData)) {
                        const buf = Buffer.from(data.value || data || []);
                        console.log(`  ServiceData[${uuid}]: ${buf.toString('hex')}`);
                        if (uuid.startsWith('0000fcd2')) {
                            console.log(`  *** BTHome v2 data detected! ***`);
                        }
                    }
                }
                if (mfgData) {
                    for (const [id, data] of Object.entries(mfgData)) {
                        const buf = Buffer.from(data.value || data || []);
                        console.log(`  ManufacturerData[0x${Number(id).toString(16)}]: ${buf.toString('hex')}`);
                    }
                }
            }
        }

        // PropertiesChanged
        if (msg.interface === 'org.freedesktop.DBus.Properties' &&
            msg.member === 'PropertiesChanged' &&
            msg.path?.startsWith('/org/bluez/hci0/dev_') &&
            msg.body?.[0] === 'org.bluez.Device1') {
            const changed = msg.body[1];
            const keys = Object.keys(changed);
            const interesting = keys.filter(k => k !== 'RSSI');
            if (interesting.length > 0) {
                const mac = msg.path.split('/').pop().replace(/^dev_/, '').replace(/_/g, ':');
                console.log(`[CHG] ${mac}: ${interesting.join(', ')}`);
                if (changed.ServiceData) {
                    const sd = changed.ServiceData.value || changed.ServiceData;
                    for (const [uuid, data] of Object.entries(sd)) {
                        const buf = Buffer.from(data.value || data || []);
                        console.log(`  ServiceData[${uuid}]: ${buf.toString('hex')}`);
                        if (uuid.startsWith('0000fcd2')) {
                            console.log(`  *** BTHome v2 update! ***`);
                        }
                    }
                }
                if (changed.ManufacturerData) {
                    const md = changed.ManufacturerData.value || changed.ManufacturerData;
                    for (const [id, data] of Object.entries(md)) {
                        const buf = Buffer.from(data.value || data || []);
                        console.log(`  ManufacturerData[0x${Number(id).toString(16)}]: ${buf.toString('hex')}`);
                    }
                }
            }
        }
    });

    // Get adapter and manage discovery
    const adapter = await bus.getProxyObject('org.bluez', '/org/bluez/hci0');
    const adapterIface = adapter.getInterface('org.bluez.Adapter1');

    // Stop any existing discovery
    try { await adapterIface.StopDiscovery(); } catch(e) { /* ok */ }
    await new Promise(r => setTimeout(r, 500));

    // Set filter for BLE
    try {
        await adapterIface.SetDiscoveryFilter({
            Transport: new dbus.Variant('s', 'le'),
            DuplicateData: new dbus.Variant('b', true),
        });
        console.log('Discovery filter set (le + duplicates)');
    } catch(e) {
        console.log('SetDiscoveryFilter error:', e.message);
    }

    await adapterIface.StartDiscovery();
    console.log('Discovery started — waiting 20s...\n');

    await new Promise(r => setTimeout(r, 20000));

    try { await adapterIface.StopDiscovery(); } catch(e) { /* ok */ }
    console.log(`\n=== Done. Found ${deviceCount} new devices ===`);

    // Final check: GetManagedObjects 
    const root = await bus.getProxyObject('org.bluez', '/');
    const om = root.getInterface('org.freedesktop.DBus.ObjectManager');
    const objects = await om.GetManagedObjects();
    const devPaths = Object.keys(objects).filter(p => objects[p]['org.bluez.Device1']);
    console.log(`GetManagedObjects now has ${devPaths.length} devices`);
    for (const p of devPaths.slice(0, 5)) {
        const d = objects[p]['org.bluez.Device1'];
        console.log(`  ${d.Address?.value || '?'} "${d.Name?.value || d.Alias?.value || '?'}" rssi=${d.RSSI?.value || '?'}`);
    }
    if (devPaths.length > 5) console.log(`  ... and ${devPaths.length - 5} more`);

    bus.disconnect();
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

'use strict';

/**
 * DeviceManager – creates and maintains the ioBroker object tree for each
 * discovered Bluetooth device (Classic + BLE), and wires up GATT handlers.
 *
 * Object structure per device:
 *
 *   bluetooth.0.<MAC>/
 *     info/
 *       name              (string)
 *       rssi              (number)
 *       connected         (indicator)
 *       lastSeen          (string – ISO date)
 *       manufacturer      (string – resolved name)
 *       manufacturerData  (string – hex)
 *       txPowerLevel      (number – dBm)
 *       serviceData       (string – JSON)
 *       paired            (boolean)
 *       trusted           (boolean, writable)
 *       blocked           (boolean, writable)
 *       type              (string – "classic", "le", "dual")
 *       icon              (string – BlueZ icon)
 *       class             (number – BT Class of Device)
 *       battery           (number – %)
 *     actions/
 *       connect           (button)
 *       disconnect        (button)
 *       pair              (button)
 *       unpair            (button)
 *     media/
 *       status            (string – playing/paused/stopped)
 *       title             (string)
 *       artist            (string)
 *       album             (string)
 *       duration          (number – ms)
 *       position          (number – ms)
 *       trackNumber       (number)
 *       totalTracks       (number)
 *       genre             (string)
 *       shuffle           (string – off/alltracks/group, writable)
 *       repeat            (string – off/singletrack/alltracks/group, writable)
 *       play              (button)
 *       pause             (button)
 *       stop              (button)
 *       next              (button)
 *       previous          (button)
 *       forward           (button)
 *       rewind            (button)
 *     notifications/
 *       connected         (boolean – MAP session active)
 *       unreadCount       (number)
 *       lastSender        (string)
 *       lastSenderAddress (string)
 *       lastSubject       (string)
 *       lastTimestamp     (string – ISO-8601)
 *       lastType          (string – sms/mms/email)
 *       lastRead          (boolean)
 *       messages          (string – JSON array of recent messages)
 *       refresh           (button – trigger inbox refresh)
 *     bthome/
 *       temperature       (number – °C)
 *       humidity          (number – %)
 *       …                 (dynamic, based on BTHome data)
 *     services/
 *       <serviceUUID>/
 *         <charUUID>      (state – read/write depending on properties)
 *         <charUUID>.read (button – trigger on-demand read)
 */
class DeviceManager {

    /**
     * @param {object} opts
     * @param {import('@iobroker/adapter-core').AdapterInstance} opts.adapter
     * @param {import('./bluezManager')} opts.bluezManager
     */
    constructor(opts) {
        this.adapter = opts.adapter;
        this.bluez = opts.bluezManager;

        /**
         * Runtime bookkeeping per device.
         * @type {Map<string, DeviceContext>}
         */
        this.devices = new Map();

        /**
         * Track which BTHome object IDs have been created for each MAC.
         * @type {Map<string, Set<string>>}
         */
        this._bthomeCreated = new Map();
    }

    // ── Public API ───────────────────────────────────────────────────

    /**
     * Ensure the base object tree exists for a device.
     * Called when a device is first discovered or on property updates.
     * This is idempotent and can be called repeatedly.
     *
     * @param {string} mac   – normalised MAC (AA-BB-CC-DD-EE-FF or AA:BB:CC:DD:EE:FF)
     * @param {object} info  – device properties from BluezManager
     */
    async ensureDeviceObjects(mac, info) {
        const id = this._macToId(mac);

        // Device folder
        await this._ensureObject(`${id}`, {
            type: 'device',
            common: { name: info.name || info.alias || mac },
            native: { mac },
        });

        // ── info channel ─────────────────────────────────────────────
        await this._ensureObject(`${id}.info`, {
            type: 'channel',
            common: { name: 'Device information' },
            native: {},
        });

        await this._ensureState(`${id}.info.name`, {
            name: 'Device name',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
        }, info.name || info.alias || '');

        await this._ensureState(`${id}.info.rssi`, {
            name: 'Signal strength (RSSI)',
            type: 'number',
            role: 'value.rssi',
            unit: 'dBm',
            read: true,
            write: false,
        }, info.rssi ?? null);

        await this._ensureState(`${id}.info.connected`, {
            name: 'Connected',
            type: 'boolean',
            role: 'indicator.connected',
            read: true,
            write: false,
        }, info.connected ?? false);

        await this._ensureState(`${id}.info.lastSeen`, {
            name: 'Last seen',
            type: 'string',
            role: 'date',
            read: true,
            write: false,
        }, new Date().toISOString());

        // ── Advertisement data states ────────────────────────────────

        await this._ensureState(`${id}.info.manufacturer`, {
            name: 'Manufacturer',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
        }, '');

        await this._ensureState(`${id}.info.manufacturerData`, {
            name: 'Manufacturer data (hex)',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
        }, '');

        await this._ensureState(`${id}.info.txPowerLevel`, {
            name: 'TX Power Level',
            type: 'number',
            role: 'value',
            unit: 'dBm',
            read: true,
            write: false,
        }, info.txPower ?? null);

        await this._ensureState(`${id}.info.serviceData`, {
            name: 'Service data (JSON)',
            type: 'string',
            role: 'json',
            read: true,
            write: false,
        }, '[]');

        // ── Classic + BLE properties ─────────────────────────────────

        await this._ensureState(`${id}.info.paired`, {
            name: 'Paired',
            type: 'boolean',
            role: 'indicator',
            read: true,
            write: false,
        }, info.paired ?? false);

        await this._ensureState(`${id}.info.trusted`, {
            name: 'Trusted',
            type: 'boolean',
            role: 'switch',
            read: true,
            write: true,
        }, info.trusted ?? false);

        await this._ensureState(`${id}.info.blocked`, {
            name: 'Blocked',
            type: 'boolean',
            role: 'switch',
            read: true,
            write: true,
        }, info.blocked ?? false);

        await this._ensureState(`${id}.info.type`, {
            name: 'Device type',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
            states: { classic: 'Classic', le: 'BLE', dual: 'Dual' },
        }, info.type || 'le');

        await this._ensureState(`${id}.info.icon`, {
            name: 'BlueZ icon',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
        }, info.icon || '');

        await this._ensureState(`${id}.info.class`, {
            name: 'Bluetooth Class of Device',
            type: 'number',
            role: 'value',
            read: true,
            write: false,
        }, info.class ?? null);

        await this._ensureState(`${id}.info.battery`, {
            name: 'Battery level',
            type: 'number',
            role: 'value.battery',
            unit: '%',
            min: 0,
            max: 100,
            read: true,
            write: false,
        }, info.battery ?? null);

        // ── actions channel ──────────────────────────────────────────
        await this._ensureObject(`${id}.actions`, {
            type: 'channel',
            common: { name: 'Device actions' },
            native: {},
        });

        await this._ensureState(`${id}.actions.connect`, {
            name: 'Connect',
            type: 'boolean',
            role: 'button',
            read: false,
            write: true,
            def: false,
        }, false);

        await this._ensureState(`${id}.actions.disconnect`, {
            name: 'Disconnect',
            type: 'boolean',
            role: 'button',
            read: false,
            write: true,
            def: false,
        }, false);

        await this._ensureState(`${id}.actions.pair`, {
            name: 'Pair',
            type: 'boolean',
            role: 'button',
            read: false,
            write: true,
            def: false,
        }, false);

        await this._ensureState(`${id}.actions.unpair`, {
            name: 'Unpair',
            type: 'boolean',
            role: 'button',
            read: false,
            write: true,
            def: false,
        }, false);

        // Store native metadata for actions
        await this.adapter.extendObjectAsync(`${id}.actions.connect`, { native: { mac, action: 'connect' } });
        await this.adapter.extendObjectAsync(`${id}.actions.disconnect`, { native: { mac, action: 'disconnect' } });
        await this.adapter.extendObjectAsync(`${id}.actions.pair`, { native: { mac, action: 'pair' } });
        await this.adapter.extendObjectAsync(`${id}.actions.unpair`, { native: { mac, action: 'unpair' } });

        // services channel is created lazily in buildCharacteristicTree()
        // only when GATT services are actually discovered
    }

    // ─────────────────────────────────────────────────────────────
    //  AVRCP media objects
    // ─────────────────────────────────────────────────────────────

    /**
     * Ensure the media channel and all AVRCP states exist for a device.
     * Called when a MediaPlayer1 interface is detected.
     *
     * @param {string} mac – normalised MAC (AA-BB-CC-DD-EE-FF or AA:BB:CC:DD:EE:FF)
     */
    async ensureMediaObjects(mac) {
        const id = this._macToId(mac);

        // ── media channel ────────────────────────────────────────
        await this._ensureObject(`${id}.media`, {
            type: 'channel',
            common: { name: 'Media control (AVRCP)' },
            native: {},
        });

        // ── Track info (read-only) ───────────────────────────────
        await this._ensureState(`${id}.media.status`, {
            name: 'Playback status',
            type: 'string',
            role: 'media.state',
            read: true,
            write: false,
            states: { playing: 'playing', paused: 'paused', stopped: 'stopped',
                'forward-seek': 'forward-seek', 'reverse-seek': 'reverse-seek', error: 'error' },
        }, 'stopped');

        await this._ensureState(`${id}.media.title`, {
            name: 'Track title',
            type: 'string',
            role: 'media.title',
            read: true,
            write: false,
        }, '');

        await this._ensureState(`${id}.media.artist`, {
            name: 'Artist',
            type: 'string',
            role: 'media.artist',
            read: true,
            write: false,
        }, '');

        await this._ensureState(`${id}.media.album`, {
            name: 'Album',
            type: 'string',
            role: 'media.album',
            read: true,
            write: false,
        }, '');

        await this._ensureState(`${id}.media.duration`, {
            name: 'Track duration',
            type: 'number',
            role: 'media.duration',
            unit: 'ms',
            read: true,
            write: false,
        }, 0);

        await this._ensureState(`${id}.media.position`, {
            name: 'Playback position',
            type: 'number',
            role: 'media.elapsed',
            unit: 'ms',
            read: true,
            write: false,
        }, 0);

        await this._ensureState(`${id}.media.trackNumber`, {
            name: 'Track number',
            type: 'number',
            role: 'media.track',
            read: true,
            write: false,
        }, 0);

        await this._ensureState(`${id}.media.totalTracks`, {
            name: 'Total tracks',
            type: 'number',
            role: 'value',
            read: true,
            write: false,
        }, 0);

        await this._ensureState(`${id}.media.genre`, {
            name: 'Genre',
            type: 'string',
            role: 'media.genre',
            read: true,
            write: false,
        }, '');

        // ── Playback settings (read+write) ───────────────────────
        await this._ensureState(`${id}.media.shuffle`, {
            name: 'Shuffle mode',
            type: 'string',
            role: 'media.mode.shuffle',
            read: true,
            write: true,
            states: { off: 'Off', alltracks: 'All tracks', group: 'Group' },
        }, 'off');

        await this._ensureState(`${id}.media.repeat`, {
            name: 'Repeat mode',
            type: 'string',
            role: 'media.mode.repeat',
            read: true,
            write: true,
            states: { off: 'Off', singletrack: 'Single track', alltracks: 'All tracks', group: 'Group' },
        }, 'off');

        // ── Transport controls (buttons) ─────────────────────────
        const buttons = [
            { id: 'play',     name: 'Play' },
            { id: 'pause',    name: 'Pause' },
            { id: 'stop',     name: 'Stop' },
            { id: 'next',     name: 'Next track' },
            { id: 'previous', name: 'Previous track' },
            { id: 'forward',  name: 'Fast forward' },
            { id: 'rewind',   name: 'Rewind' },
        ];

        for (const btn of buttons) {
            await this._ensureState(`${id}.media.${btn.id}`, {
                name: btn.name,
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
                def: false,
            }, false);
        }
    }

    /**
     * Update media states from AVRCP player properties.
     *
     * @param {string} mac
     * @param {object} props – unwrapped MediaPlayer1 properties
     */
    async updateMediaStates(mac, props) {
        const id = this._macToId(mac);

        if ('Status' in props) {
            await this.adapter.setStateAsync(`${id}.media.status`, { val: props.Status, ack: true });
        }
        if ('Position' in props) {
            await this.adapter.setStateAsync(`${id}.media.position`, { val: props.Position, ack: true });
        }
        if ('Shuffle' in props) {
            await this.adapter.setStateAsync(`${id}.media.shuffle`, { val: props.Shuffle, ack: true });
        }
        if ('Repeat' in props) {
            await this.adapter.setStateAsync(`${id}.media.repeat`, { val: props.Repeat, ack: true });
        }

        // Track is a dict with Title, Artist, Album, Genre, NumberOfTracks, TrackNumber, Duration
        if ('Track' in props && typeof props.Track === 'object') {
            const t = props.Track;
            if ('Title' in t) {
                const title = t.Title === 'Not Provided' ? '' : t.Title;
                await this.adapter.setStateAsync(`${id}.media.title`, { val: title, ack: true });
            }
            if ('Artist' in t) {
                const artist = t.Artist === 'Not Provided' ? '' : t.Artist;
                await this.adapter.setStateAsync(`${id}.media.artist`, { val: artist, ack: true });
            }
            if ('Album' in t) {
                const album = t.Album === 'Not Provided' ? '' : t.Album;
                await this.adapter.setStateAsync(`${id}.media.album`, { val: album, ack: true });
            }
            if ('Genre' in t) {
                const genre = t.Genre === 'Not Provided' ? '' : t.Genre;
                await this.adapter.setStateAsync(`${id}.media.genre`, { val: genre, ack: true });
            }
            if ('Duration' in t) {
                await this.adapter.setStateAsync(`${id}.media.duration`, { val: t.Duration ?? 0, ack: true });
            }
            if ('TrackNumber' in t) {
                await this.adapter.setStateAsync(`${id}.media.trackNumber`, { val: t.TrackNumber ?? 0, ack: true });
            }
            if ('NumberOfTracks' in t) {
                await this.adapter.setStateAsync(`${id}.media.totalTracks`, { val: t.NumberOfTracks ?? 0, ack: true });
            }
        }
    }

    // ─────────────────────────────────────────────────────────────
    //  MAP notification objects
    // ─────────────────────────────────────────────────────────────

    /**
     * Ensure the notifications channel and all MAP states exist for a device.
     * Called when a MAP session is established.
     *
     * @param {string} mac – normalised MAC
     */
    async ensureNotificationObjects(mac) {
        const id = this._macToId(mac);

        await this._ensureObject(`${id}.notifications`, {
            type: 'channel',
            common: { name: 'Notifications (MAP)' },
            native: {},
        });

        await this._ensureState(`${id}.notifications.connected`, {
            name: 'MAP session active',
            type: 'boolean',
            role: 'indicator.reachable',
            read: true,
            write: false,
        }, false);

        await this._ensureState(`${id}.notifications.unreadCount`, {
            name: 'Unread messages',
            type: 'number',
            role: 'value',
            read: true,
            write: false,
        }, 0);

        await this._ensureState(`${id}.notifications.lastSender`, {
            name: 'Last message sender',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
        }, '');

        await this._ensureState(`${id}.notifications.lastSenderAddress`, {
            name: 'Last message sender address',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
        }, '');

        await this._ensureState(`${id}.notifications.lastSubject`, {
            name: 'Last message subject / preview',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
        }, '');

        await this._ensureState(`${id}.notifications.lastTimestamp`, {
            name: 'Last message timestamp',
            type: 'string',
            role: 'date',
            read: true,
            write: false,
        }, '');

        await this._ensureState(`${id}.notifications.lastType`, {
            name: 'Last message type',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
            states: { sms: 'SMS', mms: 'MMS', email: 'E-Mail' },
        }, '');

        await this._ensureState(`${id}.notifications.lastRead`, {
            name: 'Last message read status',
            type: 'boolean',
            role: 'indicator',
            read: true,
            write: false,
        }, false);

        await this._ensureState(`${id}.notifications.messages`, {
            name: 'Recent messages (JSON)',
            type: 'string',
            role: 'json',
            read: true,
            write: false,
        }, '[]');

        await this._ensureState(`${id}.notifications.refresh`, {
            name: 'Refresh inbox',
            type: 'boolean',
            role: 'button',
            read: false,
            write: true,
            def: false,
        }, false);
    }

    /**
     * Update notification states from a MAP messages update.
     *
     * @param {string} mac
     * @param {object[]} messages – sorted message list (newest first)
     * @param {number} unreadCount
     */
    async updateNotificationStates(mac, messages, unreadCount) {
        const id = this._macToId(mac);

        await this.adapter.setStateAsync(`${id}.notifications.unreadCount`, { val: unreadCount, ack: true });
        await this.adapter.setStateAsync(`${id}.notifications.messages`, {
            val: JSON.stringify(messages), ack: true,
        });

        // Update "last message" fields from newest entry
        if (messages.length > 0) {
            const last = messages[0];
            await this.adapter.setStateAsync(`${id}.notifications.lastSender`, { val: last.sender || '', ack: true });
            await this.adapter.setStateAsync(`${id}.notifications.lastSenderAddress`, { val: last.senderAddress || '', ack: true });
            await this.adapter.setStateAsync(`${id}.notifications.lastSubject`, { val: last.subject || '', ack: true });
            await this.adapter.setStateAsync(`${id}.notifications.lastTimestamp`, { val: last.timestamp || '', ack: true });
            await this.adapter.setStateAsync(`${id}.notifications.lastType`, { val: last.type || '', ack: true });
            await this.adapter.setStateAsync(`${id}.notifications.lastRead`, { val: last.read ?? false, ack: true });
        }
    }

    /**
     * Update dynamic device states from a deviceChanged event.
     *
     * @param {string} mac
     * @param {object} changed – partial properties that changed
     */
    async updateDeviceStates(mac, changed) {
        const id = this._macToId(mac);

        if ('rssi' in changed && changed.rssi !== null) {
            await this.adapter.setStateAsync(`${id}.info.rssi`, { val: changed.rssi, ack: true });
        }
        if ('connected' in changed) {
            await this.adapter.setStateAsync(`${id}.info.connected`, { val: changed.connected, ack: true });
        }
        if ('name' in changed) {
            await this.adapter.setStateAsync(`${id}.info.name`, { val: changed.name, ack: true });
        }
        if ('paired' in changed) {
            await this.adapter.setStateAsync(`${id}.info.paired`, { val: changed.paired, ack: true });
        }
        if ('trusted' in changed) {
            await this.adapter.setStateAsync(`${id}.info.trusted`, { val: changed.trusted, ack: true });
        }
        if ('blocked' in changed) {
            await this.adapter.setStateAsync(`${id}.info.blocked`, { val: changed.blocked, ack: true });
        }
        if ('battery' in changed && changed.battery !== null) {
            await this.adapter.setStateAsync(`${id}.info.battery`, { val: changed.battery, ack: true });
        }
        if ('txPower' in changed && changed.txPower !== null) {
            await this.adapter.setStateAsync(`${id}.info.txPowerLevel`, { val: changed.txPower, ack: true });
        }

        // Always update lastSeen on any change
        await this.adapter.setStateAsync(`${id}.info.lastSeen`, { val: new Date().toISOString(), ack: true });
    }

    /**
     * Ensure the BTHome object tree exists and update values for BTHome v2 data.
     *
     * Creates a `bthome` channel under the device with states for each parsed
     * BTHome measurement. Handles duplicate object names (e.g. two temperature
     * sensors) by appending a numeric suffix.
     *
     * @param {string} mac – normalised MAC (AA-BB-CC-DD-EE-FF)
     * @param {Array<{objectId: number, name: string, value: number, unit: string, role: string}>} parsedValues
     */
    async ensureBTHomeObjects(mac, parsedValues) {
        if (!parsedValues || parsedValues.length === 0) return;

        const devId = this._macToId(mac);
        const channelId = `${devId}.bthome`;

        // Ensure bthome channel exists
        await this._ensureObject(channelId, {
            type: 'channel',
            common: { name: 'BTHome v2 data' },
            native: {},
        });

        // Track created state names per device to avoid duplicates
        if (!this._bthomeCreated.has(mac)) {
            this._bthomeCreated.set(mac, new Set());
        }
        const created = this._bthomeCreated.get(mac);

        // Count name occurrences to handle duplicates (e.g. two temperature objects)
        const nameCounts = new Map();

        for (const entry of parsedValues) {
            // Skip packet_id – it's metadata, not a measurement
            if (entry.name === 'packet_id') continue;

            // Deduplicate names: first occurrence = name, second = name_2, etc.
            const count = (nameCounts.get(entry.name) || 0) + 1;
            nameCounts.set(entry.name, count);
            const stateName = count > 1 ? `${entry.name}_${count}` : entry.name;

            const stateId = `${channelId}.${stateName}`;

            // Determine ioBroker type from value/role
            const isBool = ['switch', 'sensor.door', 'sensor.motion', 'sensor.window', 'indicator.lowbat'].includes(entry.role);
            const stateType = isBool ? 'boolean' : 'number';
            const stateValue = isBool ? !!entry.value : entry.value;

            // Create the state if not yet created
            if (!created.has(stateName)) {
                await this._ensureState(stateId, {
                    name: this._bthomeDisplayName(entry.name),
                    type: stateType,
                    role: entry.role,
                    unit: entry.unit || '',
                    read: true,
                    write: false,
                }, stateValue);

                // Store native metadata
                await this.adapter.extendObjectAsync(stateId, {
                    native: { bthome: true, objectId: entry.objectId },
                });

                created.add(stateName);
            }

            // Always update the value
            await this.adapter.setStateAsync(stateId, { val: stateValue, ack: true });
        }
    }

    /**
     * After a successful GATT discovery via BlueZ, create states for every
     * characteristic and optionally subscribe to notifications.
     *
     * @param {string} mac
     * @param {Array<{uuid: string, path: string, primary: boolean,
     *         characteristics: Array<{uuid: string, path: string, flags: string[]}>}>} servicesInfo
     */
    async buildCharacteristicTree(mac, servicesInfo) {
        const devId = this._macToId(mac);
        let ctx = this.devices.get(mac);
        if (!ctx) {
            ctx = { charPaths: new Map(), pollTimer: null, subscriptions: [] };
            this.devices.set(mac, ctx);
        }

        if (!servicesInfo || servicesInfo.length === 0) return;

        // Create services channel only when we have actual data
        await this._ensureObject(`${devId}.services`, {
            type: 'channel',
            common: { name: 'GATT Services' },
            native: {},
        });

        for (const svc of servicesInfo) {
            const svcUuid = svc.uuid.toLowerCase().replace(/-/g, '');
            // Use short UUID if it's a standard 128-bit UUID
            const svcShort = svcUuid.length === 32
                ? svcUuid.slice(4, 8)
                : svcUuid;
            const svcId = `${devId}.services.${svcShort}`;

            await this._ensureObject(svcId, {
                type: 'channel',
                common: { name: `Service ${svcShort}` },
                native: { uuid: svc.uuid, path: svc.path },
            });

            for (const ch of svc.characteristics) {
                const flags = ch.flags || [];
                const canRead = flags.includes('read');
                const canWrite = flags.includes('write') || flags.includes('write-without-response');
                const canNotify = flags.includes('notify') || flags.includes('indicate');
                const withoutResponse = flags.includes('write-without-response') && !flags.includes('write');

                const charUuid = ch.uuid.toLowerCase().replace(/-/g, '');
                const charShort = charUuid.length === 32
                    ? charUuid.slice(4, 8)
                    : charUuid;
                const charStateId = `${svcId}.${charShort}`;

                // Determine role
                let role = 'state';
                if (canRead && canWrite) role = 'level';
                else if (canWrite) role = 'level';
                else if (canRead) role = 'value';

                await this._ensureState(charStateId, {
                    name: `Characteristic ${charShort}`,
                    type: 'string',
                    role,
                    read: canRead,
                    write: canWrite,
                }, '');

                // Store native metadata so onStateChange knows what to do
                await this.adapter.extendObjectAsync(
                    charStateId,
                    { native: { uuid: ch.uuid, serviceUuid: svc.uuid, mac, properties: flags, withoutResponse, charPath: ch.path } }
                );

                // Keep a runtime reference to the D-Bus characteristic path
                ctx.charPaths.set(charStateId, ch.path);

                // On-demand read button
                if (canRead) {
                    const readBtnId = `${charStateId}.read`;
                    await this._ensureState(readBtnId, {
                        name: `Read ${charShort}`,
                        type: 'boolean',
                        role: 'button',
                        read: false,
                        write: true,
                        def: false,
                    }, false);
                    ctx.charPaths.set(readBtnId, ch.path);
                }

                // Initial read
                if (canRead) {
                    try {
                        const data = await this.bluez.readCharacteristic(ch.path);
                        await this._setCharacteristicValue(charStateId, data);
                    } catch (e) {
                        this.adapter.log.warn(`${mac} initial read of ${charShort} failed: ${e.message}`);
                    }
                }

                // Subscribe to notifications
                if (canNotify) {
                    try {
                        await this.bluez.startNotify(ch.path, async (data) => {
                            await this._setCharacteristicValue(charStateId, data);
                        });
                        ctx.subscriptions.push(ch.path);
                        this.adapter.log.debug(`${mac}: subscribed to ${charShort}`);
                    } catch (e) {
                        this.adapter.log.warn(`${mac} subscribe ${charShort} failed: ${e.message}`);
                    }
                }
            }
        }
    }

    /**
     * Write a value to a characteristic identified by its ioBroker state id.
     *
     * @param {string} stateId  – e.g. AA-BB-CC-DD-EE-FF.services.180f.2a19
     * @param {any} value       – the ioBroker state value
     * @param {object} native   – native section of the state object
     */
    async writeCharacteristic(stateId, value, native) {
        const charPath = native.charPath;
        if (!charPath) throw new Error(`No charPath in native for ${stateId}`);

        const buffer = this._valueToBuffer(value);
        const withoutResponse = !!native.withoutResponse;

        const options = withoutResponse ? { type: 'command' } : {};

        this.adapter.log.debug(`Writing ${buffer.toString('hex')} to ${native.uuid} (withoutResponse=${withoutResponse})`);
        await this.bluez.writeCharacteristic(charPath, buffer, options);
    }

    /**
     * Trigger an on-demand read for a ".read" button press.
     * @param {string} buttonStateId – e.g. ….2a19.read
     */
    async readOnDemand(buttonStateId) {
        // The corresponding value state is the button id minus ".read"
        const charStateId = buttonStateId.replace(/\.read$/, '');
        const mac = this._idToMac(charStateId);
        const ctx = this.devices.get(mac);
        if (!ctx) return;

        const charPath = ctx.charPaths.get(buttonStateId) || ctx.charPaths.get(charStateId);
        if (!charPath) return;

        const data = await this.bluez.readCharacteristic(charPath);
        await this._setCharacteristicValue(charStateId, data);
    }

    /**
     * Start a polling timer for a device.
     * @param {string} mac
     * @param {number} intervalMs
     */
    startPolling(mac, intervalMs) {
        const ctx = this.devices.get(mac);
        if (!ctx) return;
        this.stopPolling(mac);

        ctx.pollTimer = setInterval(async () => {
            for (const [stateId, charPath] of ctx.charPaths) {
                // Only poll actual value states (not .read buttons)
                if (stateId.endsWith('.read')) continue;

                try {
                    const obj = await this.adapter.getObjectAsync(stateId);
                    const props = obj?.native?.properties || [];
                    if (!props.includes('read')) continue;

                    const data = await this.bluez.readCharacteristic(charPath);
                    await this._setCharacteristicValue(stateId, data);
                } catch (e) {
                    this.adapter.log.debug(`Poll read ${stateId} failed: ${e.message}`);
                }
            }
        }, intervalMs);
    }

    stopPolling(mac) {
        const ctx = this.devices.get(mac);
        if (!ctx || !ctx.pollTimer) return;
        clearInterval(ctx.pollTimer);
        ctx.pollTimer = null;
    }

    /**
     * Mark device as disconnected and clean up subscriptions.
     */
    async setDisconnected(mac) {
        const devId = this._macToId(mac);
        await this.adapter.setStateAsync(`${devId}.info.connected`, false, true);

        const ctx = this.devices.get(mac);
        if (!ctx) return;

        this.stopPolling(mac);

        for (const charPath of ctx.subscriptions) {
            try {
                await this.bluez.stopNotify(charPath);
            } catch (_) { /* ignore */ }
        }
        ctx.subscriptions = [];
    }

    /**
     * Tear down everything.
     */
    async destroy() {
        for (const [mac] of this.devices) {
            await this.setDisconnected(mac);
        }
        this.devices.clear();
        this._bthomeCreated.clear();
    }

    // ── Private helpers ──────────────────────────────────────────────

    /** Convert MAC to ioBroker-safe object id segment */
    _macToId(mac) {
        return mac.replace(/:/g, '-').toUpperCase();
    }

    /** Extract MAC from a full state id */
    _idToMac(stateId) {
        const parts = stateId.split('.');
        for (const p of parts) {
            if (/^[0-9A-F]{2}(-[0-9A-F]{2}){5}$/.test(p)) return p;
        }
        return parts[0];
    }

    /**
     * Generate a human-friendly display name for a BTHome measurement.
     * @param {string} name – internal BTHome name (snake_case)
     * @returns {string}
     */
    _bthomeDisplayName(name) {
        const map = {
            battery: 'Battery',
            battery_ok: 'Battery OK',
            temperature: 'Temperature',
            humidity: 'Humidity',
            illuminance: 'Illuminance',
            power: 'Power',
            power_on: 'Power On',
            opening: 'Opening',
            co2: 'CO₂',
            tvoc: 'TVOC',
            moisture: 'Moisture',
            motion: 'Motion',
            window: 'Window',
            button: 'Button',
            rotation: 'Rotation',
            packet_id: 'Packet ID',
        };
        return map[name] || name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' ');
    }

    /**
     * Convert a BLE Buffer to a human-friendly string and update the state.
     */
    async _setCharacteristicValue(stateId, buffer) {
        if (!Buffer.isBuffer(buffer)) {
            buffer = Buffer.from(buffer || []);
        }

        let val;
        if (buffer.length === 0) {
            val = '';
        } else if (buffer.length <= 4 && buffer.every((b) => b <= 0xff)) {
            val = buffer.toString('hex');
        } else if (buffer.every((b) => b >= 0x20 && b < 0x7f)) {
            val = buffer.toString('utf8');
        } else {
            val = buffer.toString('hex');
        }

        await this.adapter.setStateAsync(stateId, { val, ack: true });
    }

    /**
     * Convert a user-supplied value into a Buffer for writing.
     * Supports hex strings, JSON arrays, numbers, plain strings.
     */
    _valueToBuffer(value) {
        if (Buffer.isBuffer(value)) return value;

        if (typeof value === 'number') {
            if (value >= 0 && value <= 0xff) {
                const buf = Buffer.alloc(1);
                buf.writeUInt8(value);
                return buf;
            }
            if (value >= 0 && value <= 0xffff) {
                const buf = Buffer.alloc(2);
                buf.writeUInt16LE(value);
                return buf;
            }
            const buf = Buffer.alloc(4);
            buf.writeInt32LE(value);
            return buf;
        }

        if (typeof value === 'string') {
            if (/^([0-9a-fA-F]{2})+$/.test(value)) {
                return Buffer.from(value, 'hex');
            }
            try {
                const arr = JSON.parse(value);
                if (Array.isArray(arr) && arr.every((v) => typeof v === 'number')) {
                    return Buffer.from(arr);
                }
            } catch (_) { /* not JSON */ }
            return Buffer.from(value, 'utf8');
        }

        return Buffer.alloc(0);
    }

    // ── Object helpers ───────────────────────────────────────────────

    async _ensureObject(id, obj) {
        await this.adapter.setObjectNotExistsAsync(id, obj);
    }

    async _ensureState(id, common, initialValue) {
        await this.adapter.setObjectNotExistsAsync(id, {
            type: 'state',
            common,
            native: {},
        });

        if (initialValue !== undefined) {
            const existing = await this.adapter.getStateAsync(id);
            if (!existing || existing.val === null) {
                await this.adapter.setStateAsync(id, { val: initialValue, ack: true });
            }
        }
    }
}

module.exports = DeviceManager;

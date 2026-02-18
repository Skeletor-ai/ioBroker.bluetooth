'use strict';

/**
 * bthomeParser.js – BTHome v2 protocol parser for BLE service data.
 *
 * BTHome v2 is used by Shelly BLE devices, Xiaomi sensors, and other
 * compatible devices. Service UUID: 0xFCD2.
 *
 * Frame format:
 *   Byte 0:  Device Info byte
 *            - Bit 0:   Encryption flag (1 = encrypted)
 *            - Bit 1-4: Reserved
 *            - Bit 5-7: BTHome version (2 = v2)
 *   Byte 1+: Repeated TLV objects:
 *            - 1 byte Object ID
 *            - N bytes Value (length depends on Object ID)
 *
 * @see https://bthome.io/format/
 */

/** BTHome service UUID */
const BTHOME_SERVICE_UUID = 'fcd2';

/**
 * Object ID definitions.
 * Each entry: { name, type, length, factor, unit, role }
 *
 * type: 'uint8' | 'uint16' | 'uint24' | 'sint16' | 'bool'
 * factor: multiply raw value by this to get the final value
 *
 * @type {Map<number, {name: string, type: string, length: number, factor: number, unit: string, role: string}>}
 */
const OBJECT_IDS = new Map([
    [0x00, { name: 'packet_id',    type: 'uint8',  length: 1, factor: 1,    unit: '',     role: 'value' }],
    [0x01, { name: 'battery',      type: 'uint8',  length: 1, factor: 1,    unit: '%',    role: 'value.battery' }],
    [0x02, { name: 'temperature',  type: 'sint16', length: 2, factor: 0.01, unit: '°C',   role: 'value.temperature' }],
    [0x03, { name: 'humidity',     type: 'uint16', length: 2, factor: 0.01, unit: '%',    role: 'value.humidity' }],
    [0x05, { name: 'illuminance',  type: 'uint24', length: 3, factor: 0.01, unit: 'lux',  role: 'value.illuminance' }],
    [0x0A, { name: 'power',        type: 'uint8',  length: 1, factor: 1,    unit: '',     role: 'switch' }],
    [0x0B, { name: 'opening',      type: 'uint8',  length: 1, factor: 1,    unit: '',     role: 'sensor.door' }],
    [0x0C, { name: 'co2',          type: 'uint16', length: 2, factor: 1,    unit: 'ppm',  role: 'value.co2' }],
    [0x0D, { name: 'tvoc',         type: 'uint16', length: 2, factor: 1,    unit: 'µg/m³', role: 'value.tvoc' }],
    [0x0E, { name: 'moisture',     type: 'uint16', length: 2, factor: 0.01, unit: '%',    role: 'value.humidity' }],
    [0x10, { name: 'power_on',     type: 'uint8',  length: 1, factor: 1,    unit: '',     role: 'switch' }],
    [0x12, { name: 'co2',          type: 'uint16', length: 2, factor: 1,    unit: 'ppm',  role: 'value.co2' }],
    [0x14, { name: 'moisture',     type: 'uint8',  length: 1, factor: 1,    unit: '%',    role: 'value.humidity' }],
    [0x15, { name: 'battery_ok',   type: 'uint8',  length: 1, factor: 1,    unit: '',     role: 'indicator.lowbat' }],
    [0x21, { name: 'motion',       type: 'uint8',  length: 1, factor: 1,    unit: '',     role: 'sensor.motion' }],
    [0x2D, { name: 'window',       type: 'uint8',  length: 1, factor: 1,    unit: '',     role: 'sensor.window' }],
    [0x2E, { name: 'humidity',     type: 'uint8',  length: 1, factor: 1,    unit: '%',    role: 'value.humidity' }],
    [0x3A, { name: 'button',       type: 'uint8',  length: 1, factor: 1,    unit: '',     role: 'value' }],
    [0x3F, { name: 'rotation',     type: 'sint16', length: 2, factor: 0.1,  unit: '°',    role: 'value' }],
    [0x45, { name: 'temperature',  type: 'sint16', length: 2, factor: 0.1,  unit: '°C',   role: 'value.temperature' }],
]);

/**
 * Read a value from a buffer at the given offset based on the type descriptor.
 *
 * @param {Buffer} buf
 * @param {number} offset
 * @param {string} type – 'uint8', 'uint16', 'uint24', 'sint16', 'bool'
 * @param {number} factor
 * @returns {number}
 */
function readValue(buf, offset, type, factor) {
    let raw;

    switch (type) {
        case 'uint8':
        case 'bool':
            raw = buf.readUInt8(offset);
            break;
        case 'uint16':
            raw = buf.readUInt16LE(offset);
            break;
        case 'sint16':
            raw = buf.readInt16LE(offset);
            break;
        case 'uint24':
            raw = buf.readUInt8(offset) | (buf.readUInt8(offset + 1) << 8) | (buf.readUInt8(offset + 2) << 16);
            break;
        default:
            raw = buf.readUInt8(offset);
            break;
    }

    if (factor !== 1) {
        // Round to avoid floating point artifacts
        return Math.round(raw * factor * 1000) / 1000;
    }
    return raw;
}

/**
 * Parse a BTHome v2 service data payload.
 *
 * @param {Buffer} data – raw service data buffer (starts with device info byte)
 * @returns {{
 *   version: number,
 *   encrypted: boolean,
 *   values: Array<{objectId: number, name: string, value: number, unit: string, role: string}>
 * }|null}
 */
function parseBTHome(data) {
    if (!Buffer.isBuffer(data) || data.length < 2) {
        return null;
    }

    // Byte 0: Device Info
    const deviceInfo = data.readUInt8(0);
    const encrypted = !!(deviceInfo & 0x01);
    const version = (deviceInfo >> 5) & 0x07;

    if (version !== 2) {
        // Only BTHome v2 is supported
        return null;
    }

    if (encrypted) {
        // Encrypted payloads are not supported (yet)
        return null;
    }

    const values = [];
    let offset = 1;

    while (offset < data.length) {
        const objectId = data.readUInt8(offset);
        offset += 1;

        const def = OBJECT_IDS.get(objectId);
        if (!def) {
            // Unknown object ID – we don't know the length, so we must stop
            break;
        }

        if (offset + def.length > data.length) {
            // Not enough data remaining
            break;
        }

        const value = readValue(data, offset, def.type, def.factor);
        offset += def.length;

        values.push({
            objectId,
            name: def.name,
            value,
            unit: def.unit,
            role: def.role,
        });
    }

    return { version, encrypted, values };
}

/**
 * Check if a service data entry is BTHome v2.
 *
 * @param {Array<{uuid: string, data: Buffer}>} serviceDataArray
 * @returns {Buffer|null} – the raw data buffer if found, null otherwise
 */
function findBTHomeData(serviceDataArray) {
    if (!Array.isArray(serviceDataArray)) return null;

    for (const entry of serviceDataArray) {
        if (entry.uuid && entry.uuid.toLowerCase() === BTHOME_SERVICE_UUID) {
            return Buffer.isBuffer(entry.data) ? entry.data : null;
        }
    }
    return null;
}

module.exports = {
    parseBTHome,
    findBTHomeData,
    BTHOME_SERVICE_UUID,
    OBJECT_IDS,
};

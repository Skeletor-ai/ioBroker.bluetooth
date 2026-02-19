'use strict';

/**
 * advertisementParser.js – Parse raw BLE advertisement data (GAP AD structures).
 *
 * BLE advertisements consist of repeated AD structures:
 *   [length] [type] [data...]
 *
 * Common AD types:
 *   0x01 - Flags
 *   0x02 - Incomplete 16-bit UUIDs
 *   0x03 - Complete 16-bit UUIDs
 *   0x06 - Incomplete 128-bit UUIDs
 *   0x07 - Complete 128-bit UUIDs
 *   0x08 - Shortened Local Name
 *   0x09 - Complete Local Name
 *   0x0A - TX Power Level
 *   0x16 - Service Data (16-bit UUID)
 *   0x20 - Service Data (32-bit UUID)
 *   0x21 - Service Data (128-bit UUID)
 *   0xFF - Manufacturer Specific Data
 *
 * @see Bluetooth Core Spec Vol 3, Part C, Section 11
 * @see https://www.bluetooth.com/specifications/assigned-numbers/generic-access-profile/
 */

/** AD Type constants */
const AD_TYPE = {
    FLAGS:              0x01,
    INCOMPLETE_16:      0x02,
    COMPLETE_16:        0x03,
    INCOMPLETE_32:      0x04,
    COMPLETE_32:        0x05,
    INCOMPLETE_128:     0x06,
    COMPLETE_128:       0x07,
    SHORT_NAME:         0x08,
    COMPLETE_NAME:      0x09,
    TX_POWER:           0x0A,
    SERVICE_DATA_16:    0x16,
    SERVICE_DATA_32:    0x20,
    SERVICE_DATA_128:   0x21,
    MANUFACTURER_DATA:  0xFF,
};

/**
 * Parse raw BLE advertisement bytes into structured data.
 *
 * @param {Buffer} raw – raw advertisement data
 * @returns {{
 *   flags: number|null,
 *   localName: string|null,
 *   txPower: number|null,
 *   serviceUuids: string[],
 *   serviceData: Array<{uuid: string, data: Buffer}>,
 *   manufacturerData: {companyId: number, data: Buffer}|null,
 *   raw: Buffer
 * }}
 */
function parseAdvertisement(raw) {
    const result = {
        flags: null,
        localName: null,
        txPower: null,
        serviceUuids: [],
        serviceData: [],
        manufacturerData: null,
        raw,
    };

    if (!Buffer.isBuffer(raw) || raw.length === 0) {
        return result;
    }

    let offset = 0;

    while (offset < raw.length) {
        const length = raw.readUInt8(offset);
        offset += 1;

        if (length === 0 || offset + length > raw.length) {
            break;
        }

        const type = raw.readUInt8(offset);
        const data = raw.slice(offset + 1, offset + length);

        switch (type) {
            case AD_TYPE.FLAGS:
                if (data.length >= 1) {
                    result.flags = data.readUInt8(0);
                }
                break;

            case AD_TYPE.SHORT_NAME:
            case AD_TYPE.COMPLETE_NAME:
                result.localName = data.toString('utf8');
                break;

            case AD_TYPE.TX_POWER:
                if (data.length >= 1) {
                    result.txPower = data.readInt8(0);
                }
                break;

            case AD_TYPE.INCOMPLETE_16:
            case AD_TYPE.COMPLETE_16:
                for (let i = 0; i + 1 < data.length; i += 2) {
                    const uuid = data.readUInt16LE(i).toString(16).padStart(4, '0');
                    result.serviceUuids.push(uuid);
                }
                break;

            case AD_TYPE.INCOMPLETE_128:
            case AD_TYPE.COMPLETE_128:
                for (let i = 0; i + 15 < data.length; i += 16) {
                    // 128-bit UUID is little-endian
                    const bytes = [];
                    for (let j = 15; j >= 0; j--) {
                        bytes.push(data.readUInt8(i + j).toString(16).padStart(2, '0'));
                    }
                    result.serviceUuids.push(bytes.join(''));
                }
                break;

            case AD_TYPE.SERVICE_DATA_16:
                if (data.length >= 2) {
                    const uuid = data.readUInt16LE(0).toString(16).padStart(4, '0');
                    result.serviceData.push({
                        uuid,
                        data: data.slice(2),
                    });
                }
                break;

            case AD_TYPE.SERVICE_DATA_32:
                if (data.length >= 4) {
                    const uuid = data.readUInt32LE(0).toString(16).padStart(8, '0');
                    result.serviceData.push({
                        uuid,
                        data: data.slice(4),
                    });
                }
                break;

            case AD_TYPE.SERVICE_DATA_128:
                if (data.length >= 16) {
                    const bytes = [];
                    for (let j = 15; j >= 0; j--) {
                        bytes.push(data.readUInt8(j).toString(16).padStart(2, '0'));
                    }
                    result.serviceData.push({
                        uuid: bytes.join(''),
                        data: data.slice(16),
                    });
                }
                break;

            case AD_TYPE.MANUFACTURER_DATA:
                if (data.length >= 2) {
                    result.manufacturerData = {
                        companyId: data.readUInt16LE(0),
                        data: data.slice(2),
                    };
                }
                break;
        }

        offset += length;
    }

    return result;
}

module.exports = {
    parseAdvertisement,
    AD_TYPE,
};

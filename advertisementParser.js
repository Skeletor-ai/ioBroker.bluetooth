'use strict';

/**
 * advertisementParser.js – Parse BLE advertisement data from Noble peripherals.
 *
 * Extracts and structures:
 *   - manufacturerData (Buffer → company ID + hex payload)
 *   - serviceData (Array of {uuid, data})
 *   - txPowerLevel (Number)
 */

const { lookupCompany, lookupService } = require('./bluetoothNumbers');

/**
 * Parse manufacturer data from a BLE advertisement.
 *
 * @param {Buffer|null} manufacturerData – raw manufacturer data buffer
 * @returns {{ companyId: number|null, companyName: string|null, data: string, raw: string }|null}
 */
function parseManufacturerData(manufacturerData) {
    if (!Buffer.isBuffer(manufacturerData) || manufacturerData.length === 0) {
        return null;
    }

    const raw = manufacturerData.toString('hex');

    if (manufacturerData.length < 2) {
        return { companyId: null, companyName: null, data: raw, raw };
    }

    // Company ID is the first 2 bytes in Little-Endian
    const companyId = manufacturerData.readUInt16LE(0);
    const companyName = lookupCompany(companyId);
    const payload = manufacturerData.length > 2 ? manufacturerData.subarray(2).toString('hex') : '';

    return { companyId, companyName, data: payload, raw };
}

/**
 * Parse service data array from a BLE advertisement.
 *
 * @param {Array<{uuid: string, data: Buffer}>|null} serviceData – noble service data array
 * @returns {Array<{uuid: string, data: string}>}
 */
function parseServiceData(serviceData) {
    if (!Array.isArray(serviceData) || serviceData.length === 0) {
        return [];
    }

    return serviceData.map((entry) => ({
        uuid: entry.uuid || '',
        data: Buffer.isBuffer(entry.data) ? entry.data.toString('hex') : '',
        serviceName: lookupService(entry.uuid) || null,
    }));
}

/**
 * Parse all advertisement data from a Noble peripheral.
 *
 * @param {object} advertisement – peripheral.advertisement object
 * @returns {{
 *   manufacturerData: { companyId: number|null, companyName: string|null, data: string, raw: string }|null,
 *   serviceData: Array<{uuid: string, data: string}>,
 *   txPowerLevel: number|null
 * }}
 */
function parseAdvertisement(advertisement) {
    if (!advertisement) {
        return { manufacturerData: null, serviceData: [], txPowerLevel: null };
    }

    return {
        manufacturerData: parseManufacturerData(advertisement.manufacturerData || null),
        serviceData: parseServiceData(advertisement.serviceData || []),
        txPowerLevel: typeof advertisement.txPowerLevel === 'number' ? advertisement.txPowerLevel : null,
    };
}

module.exports = {
    parseAdvertisement,
    parseManufacturerData,
    parseServiceData,
};

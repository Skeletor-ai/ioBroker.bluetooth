'use strict';

/**
 * bluetoothNumbers.js – Lookup tables for Bluetooth Assigned Numbers.
 *
 * Uses the Nordic Semiconductor bluetooth-numbers-database:
 * https://github.com/NordicSemiconductor/bluetooth-numbers-database
 *
 * Provides:
 *   - Company ID → name  (manufacturer identification)
 *   - Service UUID → name (GATT service names)
 */

const path = require('path');
const fs = require('fs');

/** @type {Map<number, string>} Company ID → name */
let companyIds = null;

/** @type {Map<string, string>} Lowercase UUID → name */
let serviceUuids = null;

/**
 * Lazily load and cache the company IDs map.
 * @returns {Map<number, string>}
 */
function getCompanyIds() {
    if (companyIds) return companyIds;

    companyIds = new Map();
    try {
        const raw = fs.readFileSync(path.join(__dirname, 'data', 'company_ids.json'), 'utf8');
        const entries = JSON.parse(raw);
        for (const entry of entries) {
            if (typeof entry.code === 'number' && typeof entry.name === 'string') {
                companyIds.set(entry.code, entry.name);
            }
        }
    } catch (e) {
        // Fallback: empty map — companyName will be null
    }
    return companyIds;
}

/**
 * Lazily load and cache the service UUIDs map.
 * @returns {Map<string, string>}
 */
function getServiceUuids() {
    if (serviceUuids) return serviceUuids;

    serviceUuids = new Map();
    try {
        const raw = fs.readFileSync(path.join(__dirname, 'data', 'service_uuids.json'), 'utf8');
        const entries = JSON.parse(raw);
        for (const entry of entries) {
            if (typeof entry.uuid === 'string' && typeof entry.name === 'string') {
                serviceUuids.set(entry.uuid.toLowerCase(), entry.name);
            }
        }
    } catch (e) {
        // Fallback: empty map
    }
    return serviceUuids;
}

/**
 * Look up a company name by Bluetooth SIG Company Identifier.
 * @param {number} code – uint16 company ID
 * @returns {string|null}
 */
function lookupCompany(code) {
    return getCompanyIds().get(code) || null;
}

/**
 * Look up a GATT service name by UUID (short or full 128-bit).
 * @param {string} uuid – e.g. "180f" or "0000180f-0000-1000-8000-00805f9b34fb"
 * @returns {string|null}
 */
function lookupService(uuid) {
    if (!uuid) return null;
    const lower = uuid.toLowerCase();

    // Try direct match first (short UUID like "180f")
    const direct = getServiceUuids().get(lower);
    if (direct) return direct;

    // Try extracting short UUID from full 128-bit Bluetooth Base UUID
    // Format: 0000XXXX-0000-1000-8000-00805f9b34fb
    const normalized = lower.replace(/-/g, '');
    if (normalized.length === 32) {
        const short = normalized.slice(4, 8);
        const tail = normalized.slice(8);
        if (tail === '00001000800000805f9b34fb') {
            return getServiceUuids().get(short) || null;
        }
        // Also try full 128-bit match
        return getServiceUuids().get(lower) || null;
    }

    return null;
}

module.exports = {
    lookupCompany,
    lookupService,
    getCompanyIds,
    getServiceUuids,
};

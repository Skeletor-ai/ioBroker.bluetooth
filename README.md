# ioBroker.bluetooth

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

General-purpose **Bluetooth Low Energy (BLE)** adapter for [ioBroker](https://www.iobroker.net/).

Scan for nearby BLE peripherals, automatically discover their GATT services and characteristics, and **read, write and subscribe** to them – all from within ioBroker.

---

## Features

| Feature | Description |
|---|---|
| **BLE Scanning** | Periodic scan for nearby devices with configurable interval and duration |
| **GATT Discovery** | Automatic discovery of all services and characteristics after connecting |
| **Read** | Initial read on connect, configurable polling, on-demand read via button state |
| **Write** | Write values through ioBroker states (write / writeWithoutResponse) |
| **Notifications** | Real-time updates via BLE notify/indicate subscriptions |
| **Reconnect** | Automatic reconnect with exponential backoff |
| **Admin UI** | Full JSONConfig-based configuration (no React/HTML needed) |

## Object Tree

After connecting to a device the adapter creates:

```
bluetooth.0.
  AA-BB-CC-DD-EE-FF/         ← device (MAC with dashes)
    info/
      name                    ← advertised local name
      rssi                    ← signal strength (dBm)
      connected               ← connection indicator
      lastSeen                ← ISO timestamp
    services/
      <serviceUUID>/
        <characteristicUUID>  ← value state (read/write depending on properties)
        <characteristicUUID>.read  ← button – trigger on-demand read
```

## Prerequisites

### 1. Linux with BlueZ

This adapter uses [`@stoprocent/noble`](https://github.com/stoprocent/noble) which requires **Linux** and **BlueZ ≥ 5.x**.

```bash
# Debian / Ubuntu
sudo apt-get install bluetooth bluez libbluetooth-dev libudev-dev

# Fedora
sudo dnf install bluez bluez-libs-devel systemd-devel
```

### 2. Grant Node.js raw BLE access (no root)

noble needs `CAP_NET_RAW` and `CAP_NET_ADMIN`:

```bash
# Find the node binary used by ioBroker
which node          # e.g. /usr/bin/node

# Set capabilities
sudo setcap 'cap_net_raw,cap_net_admin+eip' $(which node)
```

> **Note:** This must be re-applied after every Node.js update.

### 3. Verify Bluetooth

```bash
hciconfig
# Should show an "UP RUNNING" hci0 device

sudo hcitool lescan
# Should list nearby BLE devices
```

## Installation

### From GitHub (development)

```bash
cd /opt/iobroker
iobroker url https://github.com/clawdbot/ioBroker.bluetooth/archive/refs/heads/main.tar.gz
```

### Manual (local)

```bash
cd /opt/iobroker
npm install /path/to/ioBroker.bluetooth
iobroker add bluetooth
```

## Configuration

Open the adapter configuration in the ioBroker Admin UI:

### Scan Settings

| Option | Default | Description |
|---|---|---|
| Scan interval | 60 s | How often to scan for BLE devices |
| Scan duration | 10 s | How long each scan window lasts |
| HCI device | 0 | Bluetooth adapter index (`0` = `/dev/hci0`) |

### Devices (Allowlist)

Add devices by MAC address. If the list is **empty**, the adapter connects to *all* discovered devices.

Each entry supports:
- **MAC Address** – e.g. `AA:BB:CC:DD:EE:FF`
- **Name** – optional label
- **Poll interval** – read-polling interval in seconds (0 = off, use notifications only)

### Reconnect

| Option | Default | Description |
|---|---|---|
| Enable reconnect | ✅ | Automatically reconnect after unexpected disconnect |
| Base delay | 5 s | Initial delay before first reconnect attempt |
| Max delay | 300 s | Upper bound for exponential backoff |

## Writing Values

Set the characteristic state's value to one of these formats:

| Format | Example | Description |
|---|---|---|
| **Hex string** | `0a1b2c` | Bytes written directly |
| **JSON array** | `[10, 27, 44]` | Array of byte values |
| **Number** | `42` | Auto-sized UInt8 / UInt16LE / Int32LE |
| **String** | `hello` | UTF-8 encoded |

## Troubleshooting

### "Bluetooth adapter did not reach poweredOn"

- Check `hciconfig` — is the adapter UP?
- Make sure no other process has exclusive access (e.g. `bluetoothd` with `--experimental`)
- Try `sudo hciconfig hci0 up`

### "Connect timeout"

- Device may be out of range or not advertising
- Some devices only advertise for a few seconds after power-on
- Increase scan duration

### noble build errors during `npm install`

- Ensure build tools are installed: `sudo apt-get install build-essential`
- Ensure Bluetooth dev headers: `sudo apt-get install libbluetooth-dev`

## Development

```bash
git clone https://github.com/clawdbot/ioBroker.bluetooth.git
cd ioBroker.bluetooth
npm install

# Syntax check
node -c main.js
node -c lib/bleManager.js
node -c lib/deviceManager.js
```

## Changelog

### 0.4.0 (2026-02-19)
* Added BLE satellite receiver support (Pi + ESP32)
* Integrated @iobroker/dm-utils for Device Manager
* Added @iobroker/eslint-config
* Added i18n translations for all required languages

### 0.3.0
* BTHome v2 protocol support
* Advertisement data parsing

### 0.2.0
* Device allowlist and discovery management
* Auto-reconnect with exponential backoff

### 0.1.0
* Initial release
* BlueZ D-Bus integration
* Classic + BLE support

## License

[MIT](LICENSE)

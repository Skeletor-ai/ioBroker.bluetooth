# BLE Satellite Receivers

Extend your Bluetooth coverage by placing remote BLE scanners (satellites) throughout your home. Each satellite scans for BLE advertisements and forwards them to the main ioBroker.bluetooth adapter via TCP.

## Architecture

```
┌─────────────┐     TCP/JSONL      ┌──────────────────────┐
│ Pi Satellite ├───────────────────►│                      │
│ (wohnzimmer) │     Port 8734     │  ioBroker.bluetooth  │
└─────────────┘                    │     (main adapter)    │
                                   │                      │
┌─────────────┐     TCP/JSONL      │  ┌────────────────┐  │
│ESP32 Satellite├─────────────────►│  │SatelliteManager│  │
│  (keller)    │                   │  └────────────────┘  │
└─────────────┘                    │                      │
                                   │  ┌────────────────┐  │
                                   │  │  BlueZ/D-Bus   │  │ ← local BLE
                                   │  └────────────────┘  │
                                   └──────────────────────┘
```

Satellites connect **to** the adapter (outbound from satellite). The adapter runs a TCP server on port 8734 (configurable).

## Setup

### 1. Enable Satellites in ioBroker

1. Open adapter config → **Satellites** tab
2. Check **Enable satellite receivers**
3. Set port (default: 8734)
4. Optionally add allowed IPs (empty = accept all)
5. Save & restart adapter

### 2. Raspberry Pi Satellite

```bash
# On the Pi:
cd /path/to/ioBroker.bluetooth/satellites/
npm install

# Run:
node pi-satellite.js --host <IOBROKER_IP> --port 8734 --name wohnzimmer-pi --hci 0

# As systemd service:
sudo tee /etc/systemd/system/ble-satellite.service << 'EOF'
[Unit]
Description=ioBroker BLE Satellite
After=network-online.target bluetooth.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/ble-satellite/pi-satellite.js --host 192.168.1.100 --port 8734 --name wohnzimmer-pi
Restart=always
RestartSec=10
User=root

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now ble-satellite
```

**Requirements:** Node.js 18+, Bluetooth adapter, root or `cap_net_admin` capability.

### 3. ESP32 Satellite

1. Install [PlatformIO](https://platformio.org/)
2. Edit `satellites/esp32/src/main.cpp`:
   - Set `WIFI_SSID`, `WIFI_PASS`
   - Set `SERVER_HOST` to your ioBroker IP
   - Set `SATELLITE_NAME` to a unique name
3. Build & flash:

```bash
cd satellites/esp32/
pio run -t upload
pio device monitor  # watch logs
```

## Protocol Reference (JSONL over TCP)

One JSON object per line, terminated by `\n`.

### Satellite → Adapter

| Type | Description |
|------|-------------|
| `hello` | Register satellite: `{"type":"hello","name":"...","platform":"linux","version":"1.0.0"}` |
| `discover` | BLE advertisement: `{"type":"discover","address":"AA:BB:CC:DD:EE:FF","addressType":"public","rssi":-67,"name":"Sensor","serviceData":[{"uuid":"181a","data":"base64"}],"manufacturerData":"base64"}` |
| `status` | Scan status: `{"type":"status","scanning":true}` |
| `pong` | Keepalive response: `{"type":"pong"}` |

### Adapter → Satellite

| Type | Description |
|------|-------------|
| `config` | Scan configuration: `{"type":"config","scanDuration":0,"scanInterval":0,"services":[]}` |
| `command` | Control: `{"type":"command","action":"startScan"}` or `stopScan` |
| `ping` | Keepalive: `{"type":"ping"}` (every 30s, timeout 90s) |

### Data Encoding

- **serviceData[].data** — Base64-encoded raw bytes
- **manufacturerData** — Base64-encoded raw bytes
- **address** — uppercase colon-separated: `AA:BB:CC:DD:EE:FF`

## ioBroker States

Each connected satellite creates states under `bluetooth.0.satellites.<name>`:

| State | Type | Description |
|-------|------|-------------|
| `connected` | boolean | Satellite is connected |
| `lastSeen` | number | Timestamp of last received data |
| `platform` | string | OS/platform of satellite |

Devices discovered by satellites have `native.source = "satellite:<name>"` in their ioBroker objects.

## Writing a Custom Satellite

Any device that can open a TCP socket and send JSONL can be a satellite. Minimal flow:

1. Connect TCP to adapter host:port
2. Send `hello` message
3. Send `discover` messages for each BLE advertisement
4. Respond to `ping` with `pong`
5. Reconnect on disconnect

Example in Python:

```python
import socket, json, time

sock = socket.create_connection(("192.168.1.100", 8734))
sock.sendall(json.dumps({"type":"hello","name":"my-sat","platform":"python","version":"1.0.0"}).encode() + b"\n")

# Send discoveries...
# Handle pings...
```

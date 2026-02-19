/**
 * ioBroker.bluetooth ESP32 Satellite
 *
 * BLE scanner that sends JSONL discover events to the adapter via TCP.
 * Keep it simple — under 300 lines.
 */

#include <Arduino.h>
#include <WiFi.h>
#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEScan.h>
#include <BLEAdvertisedDevice.h>
#include "mbedtls/base64.h"

// ── Configuration ────────────────────────────────────────────────
#define WIFI_SSID       "YOUR_SSID"
#define WIFI_PASS       "YOUR_PASSWORD"
#define SERVER_HOST     "192.168.1.100"
#define SERVER_PORT     8734
#define SATELLITE_NAME  "esp32-satellite"
#define SCAN_TIME_SEC   5        // BLE scan window
#define RECONNECT_MS    5000

// ── Globals ──────────────────────────────────────────────────────
WiFiClient tcp;
BLEScan* bleScan = nullptr;
bool connected = false;
unsigned long lastPing = 0;
String lineBuffer;

// ── Base64 encode helper ─────────────────────────────────────────
String toBase64(const uint8_t* data, size_t len) {
    if (!data || len == 0) return "";
    size_t outLen = 0;
    mbedtls_base64_encode(NULL, 0, &outLen, data, len);
    if (outLen == 0) return "";
    uint8_t* buf = (uint8_t*)malloc(outLen + 1);
    if (!buf) return "";
    mbedtls_base64_encode(buf, outLen + 1, &outLen, data, len);
    buf[outLen] = 0;
    String result((char*)buf);
    free(buf);
    return result;
}

// ── Send JSONL line ──────────────────────────────────────────────
void sendLine(const String& json) {
    if (tcp.connected()) {
        tcp.println(json);
    }
}

// ── Escape JSON string ──────────────────────────────────────────
String jsonEscape(const String& s) {
    String out;
    out.reserve(s.length() + 4);
    for (unsigned int i = 0; i < s.length(); i++) {
        char c = s[i];
        if (c == '"') out += "\\\"";
        else if (c == '\\') out += "\\\\";
        else if (c < 0x20) out += ' ';
        else out += c;
    }
    return out;
}

// ── BLE scan callback ────────────────────────────────────────────
class SatelliteCallbacks : public BLEAdvertisedDeviceCallbacks {
    void onResult(BLEAdvertisedDevice dev) override {
        if (!tcp.connected()) return;

        String addr = dev.getAddress().toString().c_str();
        addr.toUpperCase();
        // Replace colons for consistency
        for (int i = 0; i < (int)addr.length(); i++) {
            if (addr[i] == ':') addr[i] = ':'; // keep colons
        }

        String json = "{\"type\":\"discover\",\"address\":\"" + addr + "\"";
        json += ",\"addressType\":\"" + String(dev.getAddressType() == BLE_ADDR_PUBLIC ? "public" : "random") + "\"";
        json += ",\"rssi\":" + String(dev.getRSSI());

        if (dev.haveName()) {
            json += ",\"name\":\"" + jsonEscape(dev.getName().c_str()) + "\"";
        }

        // Service data
        int sdCount = dev.getServiceDataCount();
        if (sdCount > 0) {
            json += ",\"serviceData\":[";
            for (int i = 0; i < sdCount; i++) {
                if (i > 0) json += ",";
                BLEUUID uuid = dev.getServiceDataUUID(i);
                std::string sdVal = dev.getServiceData(i);
                json += "{\"uuid\":\"" + String(uuid.toString().c_str()) + "\"";
                json += ",\"data\":\"" + toBase64((const uint8_t*)sdVal.data(), sdVal.length()) + "\"}";
            }
            json += "]";
        }

        // Manufacturer data
        if (dev.haveManufacturerData()) {
            std::string md = dev.getManufacturerData();
            json += ",\"manufacturerData\":\"" + toBase64((const uint8_t*)md.data(), md.length()) + "\"";
        }

        json += "}";
        sendLine(json);
    }
};

// ── Handle server messages ───────────────────────────────────────
void handleServerLine(const String& line) {
    // Minimal JSON parsing — just check type field
    if (line.indexOf("\"ping\"") >= 0) {
        sendLine("{\"type\":\"pong\"}");
    } else if (line.indexOf("\"startScan\"") >= 0) {
        Serial.println("Server: startScan");
    } else if (line.indexOf("\"stopScan\"") >= 0) {
        Serial.println("Server: stopScan");
    } else if (line.indexOf("\"config\"") >= 0) {
        Serial.println("Server: config received");
    }
}

// ── Read server data ─────────────────────────────────────────────
void readServer() {
    while (tcp.available()) {
        char c = tcp.read();
        if (c == '\n') {
            lineBuffer.trim();
            if (lineBuffer.length() > 0) {
                handleServerLine(lineBuffer);
            }
            lineBuffer = "";
        } else {
            lineBuffer += c;
            // Prevent buffer overflow
            if (lineBuffer.length() > 1024) lineBuffer = "";
        }
    }
}

// ── Connect to server ────────────────────────────────────────────
bool connectToServer() {
    Serial.printf("Connecting to %s:%d...\n", SERVER_HOST, SERVER_PORT);
    if (!tcp.connect(SERVER_HOST, SERVER_PORT)) {
        Serial.println("Connection failed");
        return false;
    }
    Serial.println("Connected!");

    // Send hello
    String hello = "{\"type\":\"hello\",\"name\":\"" + String(SATELLITE_NAME) +
                   "\",\"platform\":\"esp32\",\"version\":\"1.0.0\"}";
    sendLine(hello);
    connected = true;
    return true;
}

// ── WiFi connect ─────────────────────────────────────────────────
void connectWiFi() {
    Serial.printf("Connecting to WiFi '%s'...\n", WIFI_SSID);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    Serial.printf("\nWiFi connected! IP: %s\n", WiFi.localIP().toString().c_str());
}

// ── Setup ────────────────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    Serial.println("\nioBroker.bluetooth ESP32 Satellite v1.0.0");

    connectWiFi();

    // Init BLE
    BLEDevice::init("");
    bleScan = BLEDevice::getScan();
    bleScan->setAdvertisedDeviceCallbacks(new SatelliteCallbacks(), true);
    bleScan->setActiveScan(true);
    bleScan->setInterval(100);
    bleScan->setWindow(99);

    connectToServer();
}

// ── Loop ─────────────────────────────────────────────────────────
void loop() {
    // Check WiFi
    if (WiFi.status() != WL_CONNECTED) {
        connectWiFi();
    }

    // Check TCP connection
    if (!tcp.connected()) {
        if (connected) {
            Serial.println("Disconnected from server");
            connected = false;
        }
        delay(RECONNECT_MS);
        connectToServer();
        return;
    }

    // Read server messages
    readServer();

    // Run BLE scan
    Serial.println("Starting BLE scan...");
    bleScan->start(SCAN_TIME_SEC, false);
    sendLine("{\"type\":\"status\",\"scanning\":true}");
    bleScan->clearResults();

    // Small delay between scans
    delay(100);
}

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <ESP32Servo.h>
#include <Wire.h>

#define DEVICE_NAME  "ESP32-ESC-BLE"
#define SERVICE_UUID "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHAR_UUID    "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define ADXL_CHAR_UUID "b4a3db2d-8f6c-4c9d-a31e-6aeead4dbf21"

Servo esc;

const int escPin = 6;
const int rgbLedPin = RGB_BUILTIN;
const unsigned long HEARTBEAT_LED_MS = 20;
const unsigned long WRITE_TIMEOUT_MS = 1500;
const unsigned long ADXL_SAMPLE_MS = 200;
const int RAMP_DOWN_STEP_US = 5;
const int adxlAddress = 0x53;
const int adxlSdaPin = 5;
const int adxlSclPin = 4;

volatile int desiredPulse = 1000;
volatile int currentPulse = 1000;
volatile unsigned long lastWriteMillis = 0;
volatile unsigned long heartbeatLedUntilMillis = 0;
volatile bool motorArmed = false;
volatile bool rampingDown = false;
volatile bool bleConnected = false;
volatile unsigned long lastAdxlSampleMillis = 0;
volatile bool adxlAvailable = false;
unsigned long nextAdxlRetryMillis = 0;
float accelerationX = 0.0f;
float accelerationY = 0.0f;
float accelerationZ = 0.0f;
BLECharacteristic* adxlCharacteristic = nullptr;

void setLedColor(uint8_t red, uint8_t green, uint8_t blue) {
  rgbLedWrite(rgbLedPin, red, green, blue);
}

void updateStatusLed() {
  unsigned long now = millis();

  if (heartbeatLedUntilMillis != 0 && now < heartbeatLedUntilMillis) {
    setLedColor(0, 0, 255);
  } else {
    heartbeatLedUntilMillis = 0;

    if (!bleConnected) {
      setLedColor(255, 255, 255);
    } else if (motorArmed) {
      setLedColor(255, 0, 0);
    } else {
      setLedColor(0, 255, 0);
    }
  }
}

void beginThrottleRampDown() {
  desiredPulse = 1000;
  motorArmed = false;
  rampingDown = true;
}

bool adxlWriteRegister(uint8_t address, uint8_t value) {
  Wire.beginTransmission(adxlAddress);
  Wire.write(address);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

bool adxlReadRegisters(uint8_t address, uint8_t* buffer, size_t length) {
  Wire.beginTransmission(adxlAddress);
  Wire.write(address);
  if (Wire.endTransmission(false) != 0) {
    return false;
  }

  if (Wire.requestFrom(adxlAddress, length) != length) {
    return false;
  }

  for (size_t i = 0; i < length; i++) {
    buffer[i] = Wire.read();
  }
  return true;
}

bool initializeAdxl345() {
  uint8_t deviceId = 0;
  if (!adxlReadRegisters(0x00, &deviceId, 1) || deviceId != 0xE5) {
    return false;
  }

  if (!adxlWriteRegister(0x2D, 0x08) ||
      !adxlWriteRegister(0x31, 0x08) ||
      !adxlWriteRegister(0x2C, 0x09)) {
    return false;
  }
  return true;
}

void sampleAdxl345() {
  uint8_t rawData[6];
  if (!adxlReadRegisters(0x32, rawData, sizeof(rawData))) {
    adxlAvailable = false;
  } else {
    int16_t rawX = (int16_t)((rawData[1] << 8) | rawData[0]);
    int16_t rawY = (int16_t)((rawData[3] << 8) | rawData[2]);
    int16_t rawZ = (int16_t)((rawData[5] << 8) | rawData[4]);

    accelerationX = rawX * 0.00390625f;
    accelerationY = rawY * 0.00390625f;
    accelerationZ = rawZ * 0.00390625f;
    adxlAvailable = true;
  }

  if (adxlCharacteristic != nullptr) {
    char telemetry[80];
    snprintf(
      telemetry,
      sizeof(telemetry),
      "status=%s,x=%.2f,y=%.2f,z=%.2f",
      adxlAvailable ? "connected" : "unavailable",
      accelerationX,
      accelerationY,
      accelerationZ
    );
    adxlCharacteristic->setValue((uint8_t*)telemetry, strlen(telemetry));
    adxlCharacteristic->notify();
  }
}

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) override {
    bleConnected = true;
    Serial.println("Laptop connected");
  }

  void onDisconnect(BLEServer* pServer) override {
    bleConnected = false;
    beginThrottleRampDown();
    Serial.println("Disconnected - ramping throttle down to 1000us");
    BLEDevice::startAdvertising();
  }
};

class ThrottleCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pCharacteristic) override {
    String rxValue = String(pCharacteristic->getValue().c_str());
    rxValue.trim();

    if (rxValue.length() == 0) {
      Serial.println("Empty throttle command");
      return;
    }

    bool numeric = true;
    for (size_t i = 0; i < rxValue.length(); i++) {
      if (!isDigit(rxValue.charAt(i))) {
        numeric = false;
        break;
      }
    }

    if (!numeric) {
      Serial.println("Invalid throttle command");
      return;
    }

    int val = rxValue.toInt();

    if (val != 999 && (val < 1000 || val > 2000)) {
      Serial.println("Invalid pulse or disarm command");
      return;
    }

    lastWriteMillis = millis();
    if (val == 999) {
      desiredPulse = 1000;
      beginThrottleRampDown();
    } else {
      desiredPulse = val;
      motorArmed = true;
      rampingDown = false;
    }
    unsigned long now = millis();
    if (now >= heartbeatLedUntilMillis) {
      heartbeatLedUntilMillis = now + HEARTBEAT_LED_MS;
    }

    String response = String(val);
    pCharacteristic->setValue(response.c_str());
  }
};

void setup() {
  Serial.begin(115200);
  Wire.begin(adxlSdaPin, adxlSclPin);
  Wire.setClock(100000);
  adxlAvailable = initializeAdxl345();
  if (adxlAvailable) {
    Serial.println("ADXL345 ready");
  } else {
    Serial.println("ADXL345 not detected");
  }
  setLedColor(255, 255, 255);
  updateStatusLed();

  esc.setPeriodHertz(50);
  esc.attach(escPin, 1000, 2000);

  // ESC startup/arming position.
  esc.writeMicroseconds(1000);
  Serial.println("Arming ESC...");
  delay(3000);
  Serial.println("ESC armed at 1000us");

  BLEDevice::init(DEVICE_NAME);
  BLEServer* pServer = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  BLEService* pService = pServer->createService(SERVICE_UUID);

  BLECharacteristic* pCharacteristic =
    pService->createCharacteristic(
      CHAR_UUID,
      BLECharacteristic::PROPERTY_READ |
      BLECharacteristic::PROPERTY_WRITE |
      BLECharacteristic::PROPERTY_WRITE_NR
    );

  pCharacteristic->setCallbacks(new ThrottleCallbacks());
  pCharacteristic->setValue("1000");

  adxlCharacteristic =
    pService->createCharacteristic(
      ADXL_CHAR_UUID,
      BLECharacteristic::PROPERTY_READ |
      BLECharacteristic::PROPERTY_NOTIFY
    );
  adxlCharacteristic->setValue(
    adxlAvailable
      ? "status=connected,x=0.00,y=0.00,z=0.00"
      : "status=unavailable,x=0.00,y=0.00,z=0.00"
  );
  pService->start();

  BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);
  pAdvertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();

  Serial.println("BLE ready - waiting for connection");
}

void loop() {
  unsigned long now = millis();
  updateStatusLed();

  if (now - lastAdxlSampleMillis >= ADXL_SAMPLE_MS) {
    lastAdxlSampleMillis = now;
    if (adxlAvailable) {
      sampleAdxl345();
    } else if (now >= nextAdxlRetryMillis) {
      adxlAvailable = false;
      adxlAvailable = initializeAdxl345();
      nextAdxlRetryMillis = now + 1000;
    }
  }

  if (motorArmed &&
      now - lastWriteMillis > WRITE_TIMEOUT_MS) {
    beginThrottleRampDown();
    Serial.println("Command timeout - ramping throttle down to 1000us");
  }

  if (rampingDown && currentPulse > 1000) {
    currentPulse = max(1000, currentPulse - RAMP_DOWN_STEP_US);
    esc.writeMicroseconds(currentPulse);
    if (currentPulse == 1000) {
      rampingDown = false;
    }
  } else if (motorArmed && desiredPulse != currentPulse) {
    currentPulse = desiredPulse;
    esc.writeMicroseconds(currentPulse);
  }

  delay(20);
}

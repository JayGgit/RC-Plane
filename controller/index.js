const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocket, WebSocketServer } = require('ws');
const noble = require('@stoprocent/noble');

const DEVICE_NAME = 'ESP32-ESC-BLE';
// noble expects lowercase UUIDs with hyphens stripped
const SERVICE_UUID = '4fafc2011fb5459e8fccc5c9c331914b';
const CHAR_UUID = 'beb5483e36e14688b7f5ea07361b26a8';
const ADXL_CHAR_UUID = 'b4a3db2d8f6c4c9da31e6aeead4dbf21';

let peripheral = null;
let throttleChar = null;
let adxlChar = null;
let connectPromise = null;
let cancelActiveScan = null;
let connectionGen = 0;
let pendingWrite = null;
let isWriting = false;
let writeLoopPromise = Promise.resolve();
let shuttingDown = false;
let isCalibrating = false;
let calibrationHeartbeat = null;
let rssiTimer = null;
let disconnectGraceTimer = null;
let isArmed = false;

function cancelPendingDisconnect() {
  if (disconnectGraceTimer) {
    clearTimeout(disconnectGraceTimer);
    disconnectGraceTimer = null;
  }
}

function withTimeout(promise, ms) {
  let id;
  const timeout = new Promise((_, reject) => {
    id = setTimeout(() => reject(new Error('operation timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(id));
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('index.html not found in this folder');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else if (req.url === '/styles.css') {
    fs.readFile(path.join(__dirname, 'styles.css'), (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('styles.css not found in this folder');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(msg) {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(msg);
      } catch (err) {
        console.error('WebSocket broadcast failed:', err.message);
      }
    }
  }
}

function stopRSSIPolling() {
  if (rssiTimer) {
    clearInterval(rssiTimer);
    rssiTimer = null;
  }
  broadcast('RSSI:UNAVAILABLE');
}

function startRSSIPolling() {
  stopRSSIPolling();

  const pollRSSI = async () => {
    if (!peripheral || peripheral.state !== 'connected') {
      stopRSSIPolling();
      return;
    }

    try {
      const rssi = await withTimeout(peripheral.updateRssiAsync(), 1500);
      if (Number.isFinite(rssi) && rssi < 0) {
        broadcast(`RSSI:${rssi}`);
      } else {
        broadcast('RSSI:UNAVAILABLE');
      }
    } catch (err) {
      broadcast('RSSI:UNAVAILABLE');
    }
  };

  pollRSSI();
  rssiTimer = setInterval(pollRSSI, 2000);
}

function queueWrite(cmd, urgent = false, reportFailure = false) {
  if (!throttleChar) return Promise.resolve();
  if (!isArmed && urgent && cmd !== '999' && cmd !== '1000') return Promise.resolve();
  if (!isArmed && !urgent) return Promise.resolve();
  if (isCalibrating && !urgent) return writeLoopPromise;
  if (!/^999$|^\d{4}$/.test(cmd)) return Promise.resolve();
  const val = Number(cmd);
  if (val !== 999 && (val < 1000 || val > 2000)) return Promise.resolve();

  // never let a regular slider tick overwrite a pending STOP
  if (pendingWrite?.urgent && !urgent) return writeLoopPromise;
  if (urgent && (cmd === '999' || cmd === '1000')) pendingWrite = null;
  pendingWrite = { cmd, urgent, reportFailure };

  if (!isWriting) {
    isWriting = true;
    writeLoopPromise = (async () => {
      try {
        while (pendingWrite && throttleChar && peripheral?.state === 'connected') {
          const { cmd: next, reportFailure } = pendingWrite;
          pendingWrite = null;
          try {
            await withTimeout(throttleChar.writeAsync(Buffer.from(next), false), 2000);
            broadcast('PACKET_SENT');
          } catch (err) {
            console.error('BLE write failed:', err.message);
            broadcast('PACKET_LOST');
            if (reportFailure) throw err;
            if (!pendingWrite?.urgent) break;
          }
        }
      } finally {
        pendingWrite = null;
        isWriting = false;
      }
    })();
  }
  return writeLoopPromise;
}

async function startESCCalibration() {
  if (isCalibrating) return;
  if (!isArmed) return;
  if (!throttleChar || peripheral?.state !== 'connected') {
    broadcast('ERROR');
    return;
  }

  isCalibrating = true;
  broadcast('CALIBRATING');

  try {
    await queueWrite('2000', true, true);
    if (calibrationHeartbeat) clearInterval(calibrationHeartbeat);
    calibrationHeartbeat = setInterval(() => {
      if (isCalibrating) queueWrite('2000', true);
    }, 250);
  } catch (err) {
    if (calibrationHeartbeat) clearInterval(calibrationHeartbeat);
    calibrationHeartbeat = null;
    console.error('ESC calibration failed:', err.message);
    await queueWrite('1000', true).catch(() => {});
    broadcast('ERROR');
    isCalibrating = false;
  }
}

async function finishESCCalibration() {
  if (!isCalibrating) return;

  broadcast('CALIBRATING_LOW');
  if (calibrationHeartbeat) clearInterval(calibrationHeartbeat);
  calibrationHeartbeat = null;
  try {
    await queueWrite('1000', true, true);
    broadcast('CALIBRATION_COMPLETE');
  } catch (err) {
    console.error('ESC calibration failed:', err.message);
    await queueWrite('1000', true).catch(() => {});
    broadcast('ERROR');
  } finally {
    isCalibrating = false;
  }
}

async function cancelESCCalibration() {
  if (calibrationHeartbeat) clearInterval(calibrationHeartbeat);
  calibrationHeartbeat = null;
  if (!isCalibrating) {
    broadcast('CALIBRATION_CANCELLED');
    return;
  }
  isCalibrating = false;
  await queueWrite('1000', true).catch(() => {});
  broadcast('CALIBRATION_CANCELLED');
}

function scanForDevice(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const cleanup = async () => {
      clearTimeout(timer);
      noble.removeListener('discover', onDiscover);
      cancelActiveScan = null;
      await noble.stopScanningAsync().catch(() => {});
    };

    const finish = async (result, err) => {
      if (settled) return;
      settled = true;
      await cleanup();
      if (err) reject(err);
      else resolve(result);
    };

    const onDiscover = (p) => {
      const name = p.advertisement?.localName;
      const uuids = (p.advertisement?.serviceUuids || []).map((u) =>
        u.replace(/-/g, '').toLowerCase()
      );
      if (name === DEVICE_NAME || uuids.includes(SERVICE_UUID)) {
        finish(p);
      }
    };

    cancelActiveScan = () => finish(null);
    timer = setTimeout(() => finish(null), timeoutMs);

    noble.on('discover', onDiscover);
    noble.startScanningAsync([], false).catch((err) => finish(null, err));
  });
}

function connectBLE() {
  if (peripheral?.state === 'connected' && throttleChar) {
    return Promise.resolve(true);
  }
  if (connectPromise) return connectPromise;

  const myGen = connectionGen;
  connectPromise = (async () => {
    let candidate = null;
    try {
      await noble.waitForPoweredOnAsync(5000);
      if (myGen !== connectionGen || wss.clients.size === 0) return false;

      console.log(`Scanning for ${DEVICE_NAME}...`);
      candidate = await scanForDevice(8000);
      if (!candidate || myGen !== connectionGen || wss.clients.size === 0) {
        if (!candidate) console.log(`Couldn't find ${DEVICE_NAME}`);
        return false;
      }

      await withTimeout(candidate.connectAsync(), 8000);

      if (myGen !== connectionGen || wss.clients.size === 0) {
        await withTimeout(candidate.disconnectAsync(), 2000).catch(() => {});
        return false;
      }

      const { characteristics } = await withTimeout(
        candidate.discoverSomeServicesAndCharacteristicsAsync(
          [SERVICE_UUID],
          [CHAR_UUID, ADXL_CHAR_UUID]
        ),
        8000
      );

      if (
        !characteristics.length ||
        candidate.state !== 'connected' ||
        myGen !== connectionGen ||
        wss.clients.size === 0
      ) {
        if (!characteristics.length) console.log('Throttle characteristic not found');
        if (candidate.state === 'connected') {
          await withTimeout(candidate.disconnectAsync(), 2000).catch(() => {});
        }
        return false;
      }

      peripheral = candidate;
      throttleChar = characteristics.find(characteristic =>
        characteristic.uuid.replace(/-/g, '').toLowerCase() === CHAR_UUID
      ) || characteristics[0];
      adxlChar = characteristics.find(characteristic =>
        characteristic.uuid.replace(/-/g, '').toLowerCase() === ADXL_CHAR_UUID
      ) || null;

      if (adxlChar) {
        adxlChar.on('data', (data) => {
          broadcast(`ADXL:${data.toString('utf8')}`);
        });
        await withTimeout(adxlChar.subscribeAsync(), 3000);
        try {
          const initialData = await withTimeout(adxlChar.readAsync(), 3000);
          broadcast(`ADXL:${initialData.toString('utf8')}`);
        } catch (err) {
          console.error('ADXL345 initial read failed:', err.message);
        }
      } else {
        console.log('ADXL345 characteristic not found');
      }
      startRSSIPolling();

      peripheral.once('disconnect', () => {
        console.log('ESP32 disconnected');
        isArmed = false;
        isCalibrating = false;
        pendingWrite = null;
        if (calibrationHeartbeat) clearInterval(calibrationHeartbeat);
        calibrationHeartbeat = null;
        throttleChar = null;
        adxlChar = null;
        peripheral = null;
        stopRSSIPolling();
        broadcast('DISCONNECTED');
      });

      console.log('Connected to ESP32!');
      return true;
    } catch (err) {
      console.error('BLE error:', err.message);
      if (candidate && candidate.state === 'connected') {
        await withTimeout(candidate.disconnectAsync(), 2000).catch(() => {});
      }
      throttleChar = null;
      adxlChar = null;
      peripheral = null;
      return false;
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
}

async function disconnectBLE() {
  connectionGen++;
  isArmed = false;
  cancelActiveScan?.();
  cancelPendingDisconnect();
  stopRSSIPolling();
  if (calibrationHeartbeat) clearInterval(calibrationHeartbeat);
  calibrationHeartbeat = null;
  isCalibrating = false;
  pendingWrite = null;

  broadcast('DISCONNECTING');

  const device = peripheral;
  await writeLoopPromise.catch(() => {});
  if (device?.state === 'connected') {
    await withTimeout(device.disconnectAsync(), 1500).catch((err) => {
      console.error('BLE disconnect failed:', err.message);
    });
  }

  throttleChar = null;
  adxlChar = null;
  peripheral = null;
  broadcast('DISCONNECTED');
}

function forceDisconnectedState() {
  stopRSSIPolling();
  throttleChar = null;
  adxlChar = null;
  peripheral = null;
}

wss.on('connection', (ws) => {
  cancelPendingDisconnect();
  const isConn = Boolean(peripheral?.state === 'connected' && throttleChar);
  ws.send(isConn ? 'CONNECTED' : 'DISCONNECTED');
  ws.send(isArmed ? 'ARMED' : 'DISARMED');

  ws.on('message', async (raw) => {
    const cmd = raw.toString().trim();
    if (cmd === 'CONNECT') {
      const ok = await connectBLE();
      broadcast(ok ? 'CONNECTED' : 'ERROR');
    } else if (cmd === 'DISCONNECT') {
      broadcast('DISCONNECTING');
      disconnectBLE();
    } else if (cmd === 'ARM') {
      if (throttleChar && peripheral?.state === 'connected') {
        isArmed = true;
        try {
          await queueWrite('1000', true, true);
          broadcast('ARMED');
        } catch (err) {
          isArmed = false;
          console.error('BLE arm write failed:', err.message);
          broadcast('ERROR');
        }
      }
    } else if (cmd === 'DISARM') {
      isArmed = false;
      isCalibrating = false;
      pendingWrite = null;
      await queueWrite('999', true, true).catch((err) => {
        console.error('BLE disarm write failed:', err.message);
      });
      broadcast('DISARMED');
    } else if (cmd === 'STOP') {
      isCalibrating = false;
      pendingWrite = null;
      await queueWrite('999', true, true).catch((err) => {
        console.error('BLE stop write failed:', err.message);
      });
      broadcast('STOPPED');
    } else if (cmd === 'CALIBRATE_HIGH') {
      await startESCCalibration();
    } else if (cmd === 'CALIBRATE_LOW') {
      await finishESCCalibration();
    } else if (cmd === 'CALIBRATE_CANCEL') {
      await cancelESCCalibration();
    } else if (/^\d{4}$/.test(cmd)) {
      if (!isArmed) return;
      const val = Number(cmd);
      if (val >= 1000 && val <= 2000) {
        queueWrite(String(val), val === 1000);
      }
    }
  });

  ws.on('close', async () => {
    if (wss.clients.size === 0) {
      cancelPendingDisconnect();
      disconnectGraceTimer = setTimeout(() => {
        disconnectGraceTimer = null;
        disconnectBLE();
      }, 3000);
    }
  });
});

process.on('SIGINT', async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await disconnectBLE();
  wss.close();
  server.close();
  process.exit(0);
});

server.listen(8000, '127.0.0.1', () => {
  console.log('Dashboard ready at http://127.0.0.1:8000');
});
// ============================================================
// app.js — Phone Sensor Diagnostics (project 0002)
//
// Structure:
//   1. helpers + state
//   2. sensor registry (one entry per probed capability)
//   3. sampling + status
//   4. device detection (UA-CH, falling back to the UA string)
//   5. expected-specs lookup (bundled offline DB + live GSMArena refresh)
//   6. tabs, sensors list, expected comparison
//   7. visualise tab: selection tree + chart cards
//   8. render loop
// ============================================================
'use strict';

// ---------- 1. helpers + state ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ST = { UNKNOWN: 'unknown', AVAILABLE: 'available', ABSENT: 'absent', TAP: 'tap', DENIED: 'denied', ERROR: 'error' };
const ST_LABEL = { unknown: 'not probed', available: 'available', absent: 'not present', tap: 'tap to enable', denied: 'denied', error: 'error' };
const ST_CLASS = { unknown: 'st-unknown', available: 'st-ok', absent: 'st-absent', tap: 'st-tap', denied: 'st-bad', error: 'st-bad' };

const CAP = 240;          // samples retained per channel
const state = {
  status: {},             // id -> { status, detail }
  data: {},               // id -> { ch: [[..]], t: [] }
  last: {},               // id -> [values]
  meta: {},               // id -> free-form readouts
  cleanup: {},            // id -> fn
  selected: new Set(),
  specs: null,
  device: {},
};

function pushSample(id, values) {
  let d = state.data[id];
  if (!d) d = state.data[id] = { ch: values.map(() => []), t: [] };
  while (d.ch.length < values.length) d.ch.push([]);
  d.t.push(performance.now());
  for (let i = 0; i < values.length; i++) d.ch[i].push(values[i]);
  if (d.t.length > CAP) {
    d.t.shift();
    for (const c of d.ch) c.shift();
  }
  state.last[id] = values;
}

function setStatus(id, status, detail = '') {
  state.status[id] = { status, detail };
  paintStatus(id);
  refreshGroupBoxes();
}

// ---------- 2. sensor registry ----------

// Generic Sensor API classes all behave the same way, so they share a factory.
function genericSensor(spec) {
  return Object.assign({
    exposure: 'web',
    channels: ['x', 'y', 'z'],
    viz: ['line3'],
    device: null,
    needsTap: false,
    async start() {
      const C = window[spec.ctor];
      if (typeof C !== 'function') {
        setStatus(spec.id, ST.ABSENT, `${spec.ctor} is not implemented in this browser`);
        return;
      }
      try {
        const sensor = new C({ frequency: spec.freq || 30 });
        let got = false;
        sensor.addEventListener('reading', () => {
          got = true;
          if (typeof sensor.illuminance === 'number') pushSample(spec.id, [sensor.illuminance]);
          else if (typeof sensor.distance === 'number') pushSample(spec.id, [sensor.distance]);
          else pushSample(spec.id, [sensor.x, sensor.y, sensor.z]);
        });
        sensor.addEventListener('error', (e) => {
          const err = e.error || {};
          setStatus(spec.id, ST.ERROR, `${err.name || 'error'}: ${err.message || ''}`);
        });
        sensor.start();
        await sleep(1100);
        if (got) setStatus(spec.id, ST.AVAILABLE, `sampling at ~${spec.freq || 30} Hz`);
        else setStatus(spec.id, ST.ABSENT, 'constructed, but produced no readings');
        state.cleanup[spec.id] = () => { try { sensor.stop(); } catch (_) {} };
      } catch (err) {
        const name = (err && err.name) || 'Error';
        setStatus(spec.id, name === 'NotAllowedError' ? ST.DENIED : ST.ABSENT,
                  `${name}: ${(err && err.message) || ''}`);
      }
    },
  }, spec);
}

// Capability probes that have no streaming data still need a status.
function flagSensor(spec) {
  return Object.assign({ exposure: 'web', channels: [], viz: ['readout'], device: null, needsTap: false }, spec);
}

const SENSORS = [
  // ---- Motion ----
  genericSensor({ id: 'accelerometer', group: 'motion', label: 'Accelerometer', ctor: 'Accelerometer', unit: 'm/s²', device: 'accelerometer', freq: 30, viz: ['line3', 'level'], channels: ['X', 'Y', 'Z'] }),
  genericSensor({ id: 'gravity', group: 'motion', label: 'Gravity', ctor: 'GravitySensor', unit: 'm/s²', freq: 30, viz: ['line3', 'level'], channels: ['X', 'Y', 'Z'] }),
  genericSensor({ id: 'linearaccel', group: 'motion', label: 'Linear acceleration', ctor: 'LinearAccelerationSensor', unit: 'm/s²', freq: 30, viz: ['line3'], channels: ['X', 'Y', 'Z'] }),
  genericSensor({ id: 'gyroscope', group: 'motion', label: 'Gyroscope', ctor: 'Gyroscope', unit: '°/s', device: 'gyroscope', freq: 30, viz: ['line3'], channels: ['X', 'Y', 'Z'] }),
  {
    id: 'devicemotion', group: 'motion', label: 'Device motion (event)', unit: 'm/s²',
    device: 'accelerometer', channels: ['X', 'Y', 'Z'], viz: ['line3'], exposure: 'web',
    async start() {
      if (!('DeviceMotionEvent' in window)) { setStatus('devicemotion', ST.ABSENT, 'DeviceMotionEvent is not implemented'); return; }
      const h = (e) => {
        const a = e.accelerationIncludingGravity || e.acceleration;
        if (a) pushSample('devicemotion', [a.x, a.y, a.z]);
      };
      window.addEventListener('devicemotion', h);
      state.cleanup.devicemotion = () => window.removeEventListener('devicemotion', h);
      await sleep(1100);
      setStatus('devicemotion', state.last.devicemotion ? ST.AVAILABLE : ST.ABSENT,
                state.last.devicemotion ? 'fed by devicemotion events' : 'no devicemotion events received');
    },
  },
  {
    id: 'orientation', group: 'motion', label: 'Orientation (α β γ)', unit: '°',
    channels: ['α', 'β', 'γ'], viz: ['line3'], exposure: 'web',
    async start() {
      if (!('DeviceOrientationEvent' in window)) { setStatus('orientation', ST.ABSENT, 'DeviceOrientationEvent is not implemented'); return; }
      const h = (e) => {
        if (e.alpha == null && e.beta == null && e.gamma == null) return;
        pushSample('orientation', [e.alpha || 0, e.beta || 0, e.gamma || 0]);
        if (e.webkitCompassHeading != null) state.meta.heading = e.webkitCompassHeading;
      };
      window.addEventListener('deviceorientation', h);
      state.cleanup.orientation = () => window.removeEventListener('deviceorientation', h);
      await sleep(1100);
      setStatus('orientation', state.last.orientation ? ST.AVAILABLE : ST.ABSENT,
                state.last.orientation ? 'fed by deviceorientation events' : 'no deviceorientation events received');
    },
  },

  // ---- Magnetic ----
  genericSensor({ id: 'magnetometer', group: 'magnetic', label: 'Magnetometer', ctor: 'Magnetometer', unit: 'µT', device: 'magnetometer', freq: 30, viz: ['line3', 'polar'], channels: ['X', 'Y', 'Z'] }),
  {
    id: 'compass', group: 'magnetic', label: 'Compass heading', unit: '°',
    device: 'magnetometer', channels: ['heading'], viz: ['polar'], exposure: 'web',
    async start() {
      const h = (e) => {
        let hd = null;
        if (e.webkitCompassHeading != null) hd = e.webkitCompassHeading;
        else if (e.alpha != null) hd = (360 - e.alpha) % 360;
        if (hd != null) pushSample('compass', [hd]);
      };
      const evt = ('ondeviceorientationabsolute' in window) ? 'deviceorientationabsolute' : 'deviceorientation';
      if (!('DeviceOrientationEvent' in window)) { setStatus('compass', ST.ABSENT, 'no orientation events available'); return; }
      window.addEventListener(evt, h);
      state.cleanup.compass = () => window.removeEventListener(evt, h);
      await sleep(1100);
      setStatus('compass', state.last.compass ? ST.AVAILABLE : ST.ABSENT,
                state.last.compass ? `from ${evt}` : 'no absolute orientation available');
    },
  },

  // ---- Light & optics ----
  genericSensor({ id: 'ambientlight', group: 'light', label: 'Ambient light sensor', ctor: 'AmbientLightSensor', unit: 'lux', device: 'ambient-light', freq: 2, viz: ['line1', 'gauge'], channels: ['lux'] }),
  {
    id: 'camera-light', group: 'light', label: 'Camera brightness', unit: '%',
    device: 'camera', channels: ['brightness'], viz: ['line1', 'gauge'], exposure: 'web', needsTap: true,
    async start() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { setStatus('camera-light', ST.ABSENT, 'getUserMedia is not available'); return; }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        const v = document.createElement('video');
        v.srcObject = stream; v.muted = true; v.playsInline = true;
        await v.play();
        const c = document.createElement('canvas'); c.width = 32; c.height = 24;
        const cx = c.getContext('2d', { willReadFrequently: true });
        const timer = setInterval(() => {
          try {
            cx.drawImage(v, 0, 0, 32, 24);
            const d = cx.getImageData(0, 0, 32, 24).data;
            let sum = 0;
            for (let i = 0; i < d.length; i += 4) sum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
            pushSample('camera-light', [(sum / (d.length / 4)) / 255 * 100]);
          } catch (_) {}
        }, 200);
        let cams = [];
        try {
          const devs = await navigator.mediaDevices.enumerateDevices();
          cams = devs.filter((d) => d.kind === 'videoinput');
        } catch (_) {}
        state.meta['camera-light'] = { cameras: cams.map((x, i) => x.label || `camera ${i + 1}`) };
        setStatus('camera-light', ST.AVAILABLE, `${cams.length || 1} camera(s); sampling brightness`);
        state.cleanup['camera-light'] = () => { clearInterval(timer); stream.getTracks().forEach((t) => t.stop()); };
      } catch (e) {
        setStatus('camera-light', (e && e.name === 'NotAllowedError') ? ST.DENIED : ST.ERROR, (e && e.name) || String(e));
      }
    },
  },

  // ---- Sound ----
  {
    id: 'microphone', group: 'sound', label: 'Microphone', unit: 'dBFS',
    device: 'microphone', channels: ['level'], viz: ['meter', 'bars', 'spectrogram'], exposure: 'web', needsTap: true,
    async start() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { setStatus('microphone', ST.ABSENT, 'getUserMedia is not available'); return; }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        const AC = window.AudioContext || window.webkitAudioContext;
        const ac = new AC();
        const src = ac.createMediaStreamSource(stream);
        const an = ac.createAnalyser();
        an.fftSize = 1024;
        an.smoothingTimeConstant = 0.75;
        src.connect(an);
        const freq = new Uint8Array(an.frequencyBinCount);
        const time = new Uint8Array(an.fftSize);
        let peak = -100;
        state.meta.microphone = { level: -100, peak: -100, spectrum: [], sampleRate: ac.sampleRate, fftSize: an.fftSize };
        const timer = setInterval(() => {
          an.getByteFrequencyData(freq);
          an.getByteTimeDomainData(time);
          let sum = 0;
          for (let i = 0; i < time.length; i++) { const x = (time[i] - 128) / 128; sum += x * x; }
          const rms = Math.sqrt(sum / time.length);
          const db = 20 * Math.log10(Math.max(rms, 1e-6));
          peak = Math.max(peak * 0.99, db);
          const m = state.meta.microphone;
          m.level = db; m.peak = peak; m.spectrum = Array.from(freq);
          pushSample('microphone', [db]);
        }, 60);
        setStatus('microphone', ST.AVAILABLE, `sampling, ${ac.sampleRate} Hz`);
        state.cleanup.microphone = () => { clearInterval(timer); stream.getTracks().forEach((t) => t.stop()); try { ac.close(); } catch (_) {} };
      } catch (e) {
        setStatus('microphone', (e && e.name === 'NotAllowedError') ? ST.DENIED : ST.ERROR, (e && e.name) || String(e));
      }
    },
  },

  // ---- Radio / RF ----
  {
    id: 'network', group: 'radio', label: 'Network link', unit: 'Mbit/s',
    device: 'wifi', channels: ['downlink'], viz: ['line1'], exposure: 'web',
    async start() {
      const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (!c) { setStatus('network', ST.ABSENT, 'NetworkInformation API is not available'); return; }
      const read = () => {
        state.meta.network = { effectiveType: c.effectiveType, downlink: c.downlink, rtt: c.rtt, saveData: c.saveData };
        if (typeof c.downlink === 'number') pushSample('network', [c.downlink]);
      };
      read();
      c.addEventListener('change', read);
      setStatus('network', ST.AVAILABLE, `${c.effectiveType || '?'} link, ${c.rtt || '?'} ms RTT`);
      state.cleanup.network = () => c.removeEventListener('change', read);
    },
  },
  {
    id: 'bluetooth', group: 'radio', label: 'Bluetooth scan', unit: 'dBm',
    device: 'bluetooth', channels: [], viz: ['hbars'], exposure: 'web', needsTap: true,
    async start() {
      if (!navigator.bluetooth) { setStatus('bluetooth', ST.ABSENT, 'Web Bluetooth is not available'); return; }
      try {
        const dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true });
        const label = dev.name || `device ${String(dev.id).slice(0, 6)}`;
        state.meta.bluetooth = { devices: [{ label, value: -70 }] };
        setStatus('bluetooth', ST.AVAILABLE, `picked ${label}`);
        if (dev.watchAdvertisements) {
          try {
            dev.addEventListener('advertisementreceived', (e) => {
              if (typeof e.rssi === 'number') state.meta.bluetooth.devices = [{ label, value: e.rssi }];
            });
            await dev.watchAdvertisements();
          } catch (_) {}
        }
      } catch (e) {
        setStatus('bluetooth', (e && e.name === 'NotFoundError') ? ST.TAP : ST.DENIED, (e && e.name) || String(e));
      }
    },
  },

  // ---- Position ----
  {
    id: 'geolocation', group: 'position', label: 'Geolocation (GNSS)', unit: 'm',
    device: 'gps', channels: ['accuracy'], viz: ['line1'], exposure: 'web', needsTap: true,
    async start() {
      if (!navigator.geolocation) { setStatus('geolocation', ST.ABSENT, 'Geolocation API is not available'); return; }
      const id = navigator.geolocation.watchPosition(
        (p) => {
          state.meta.geolocation = {
            lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy,
            altitude: p.coords.altitude, speed: p.coords.speed, heading: p.coords.heading,
          };
          if (typeof p.coords.accuracy === 'number') pushSample('geolocation', [p.coords.accuracy]);
          setStatus('geolocation', ST.AVAILABLE, `±${Math.round(p.coords.accuracy)} m`);
        },
        (e) => setStatus('geolocation', ST.DENIED, e.message || 'position error'),
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
      );
      state.cleanup.geolocation = () => navigator.geolocation.clearWatch(id);
    },
  },

  // ---- Environment ----
  genericSensor({ id: 'proximity', group: 'environment', label: 'Proximity sensor', ctor: 'ProximitySensor', unit: 'cm', device: 'proximity', freq: 2, viz: ['gauge'], channels: ['distance'] }),
  {
    id: 'barometer', group: 'environment', label: 'Barometer (pressure)', device: 'barometer',
    exposure: 'none', channels: [], viz: [],
    async start() { setStatus('barometer', ST.ABSENT, 'no web API exposes barometric pressure'); },
  },
  {
    id: 'temperature', group: 'environment', label: 'Temperature', device: 'temperature',
    exposure: 'none', channels: [], viz: [],
    async start() { setStatus('temperature', ST.ABSENT, 'no web API exposes the temperature sensor'); },
  },
  {
    id: 'humidity', group: 'environment', label: 'Humidity', device: 'humidity',
    exposure: 'none', channels: [], viz: [],
    async start() { setStatus('humidity', ST.ABSENT, 'no web API exposes the humidity sensor'); },
  },

  // ---- System ----
  {
    id: 'battery', group: 'system', label: 'Battery', unit: '%',
    device: null, channels: ['level'], viz: ['gauge', 'line1'], exposure: 'web',
    async start() {
      if (!navigator.getBattery) { setStatus('battery', ST.ABSENT, 'Battery Status API is not available'); return; }
      try {
        const b = await navigator.getBattery();
        const read = () => {
          state.meta.battery = { level: b.level * 100, charging: b.charging, chargingTime: b.chargingTime, dischargingTime: b.dischargingTime };
          pushSample('battery', [b.level * 100]);
        };
        read();
        ['levelchange', 'chargingchange'].forEach((ev) => b.addEventListener(ev, read));
        setStatus('battery', ST.AVAILABLE, `${Math.round(b.level * 100)}%${b.charging ? ', charging' : ''}`);
        state.cleanup.battery = () => ['levelchange', 'chargingchange'].forEach((ev) => b.removeEventListener(ev, read));
      } catch (e) { setStatus('battery', ST.ERROR, (e && e.name) || String(e)); }
    },
  },
  flagSensor({
    id: 'vibration', group: 'system', label: 'Vibration', device: null,
    async start() {
      setStatus('vibration', navigator.vibrate ? ST.AVAILABLE : ST.ABSENT,
                navigator.vibrate ? 'navigator.vibrate present' : 'no vibration API');
    },
  }),
  flagSensor({
    id: 'webxr', group: 'system', label: 'WebXR (AR/VR)', device: null,
    async start() {
      if (!navigator.xr) { setStatus('webxr', ST.ABSENT, 'navigator.xr is not available'); return; }
      let ar = false;
      try { ar = await navigator.xr.isSessionSupported('immersive-ar'); } catch (_) {}
      setStatus('webxr', ST.AVAILABLE, ar ? 'immersive-ar supported' : 'XR present, no immersive-ar');
    },
  }),
];

const GROUPS = [
  { id: 'motion', label: 'Motion', note: 'Accelerometer, gyroscope, and derived gravity / rotation.' },
  { id: 'magnetic', label: 'Magnetic', note: 'Magnetometer and absolute compass heading.' },
  { id: 'light', label: 'Light & optics', note: 'Ambient light sensor and camera-derived brightness.' },
  { id: 'sound', label: 'Sound', note: 'Microphone level and frequency spectrum.' },
  { id: 'radio', label: 'Radio / RF', note: 'Network link and Bluetooth.' },
  { id: 'position', label: 'Position', note: 'GNSS via the Geolocation API.' },
  { id: 'environment', label: 'Environment', note: 'Proximity, and the sensors the web platform cannot reach.' },
  { id: 'system', label: 'System', note: 'Battery and other capabilities.' },
];

// How each visualisation is chosen for each sensor.
const CARD_VIZ = {
  accelerometer: [['line3', 'X / Y / Z acceleration'], ['level', 'Tilt (bubble level)']],
  gravity: [['line3', 'Gravity vector'], ['level', 'Tilt (bubble level)']],
  linearaccel: [['line3', 'Linear acceleration']],
  gyroscope: [['line3', 'Angular rate']],
  devicemotion: [['line3', 'Acceleration incl. gravity']],
  orientation: [['line3', 'α / β / γ']],
  magnetometer: [['line3', 'Field strength'], ['polar', 'Heading from X/Y']],
  compass: [['polar', 'Compass heading']],
  ambientlight: [['line1', 'Illuminance (log scale)'], ['gauge', 'Current']],
  'camera-light': [['line1', 'Scene brightness'], ['gauge', 'Current']],
  microphone: [['meter', 'Level (dBFS)'], ['bars', 'Spectrum'], ['spectrogram', 'Spectrogram']],
  battery: [['gauge', 'Charge'], ['line1', 'History']],
  network: [['line1', 'Downlink']],
  bluetooth: [['hbars', 'RSSI by device']],
  geolocation: [['line1', 'Fix accuracy (m)']],
  proximity: [['gauge', 'Distance']],
};

// Device-sensor vocabulary (specdb.json) -> the web probe that would reveal it.
const DEVICE_TO_PROBE = {
  accelerometer: 'accelerometer', gyroscope: 'gyroscope', magnetometer: 'magnetometer',
  'ambient-light': 'ambientlight', proximity: 'proximity', barometer: 'barometer',
  temperature: 'temperature', humidity: 'humidity', gps: 'geolocation',
  wifi: 'network', cellular: 'network', bluetooth: 'bluetooth', camera: 'camera-light',
  microphone: 'microphone', fingerprint: null, nfc: null,
};

// ---------- 3. probing ----------
async function probeAll() {
  await Promise.all(SENSORS.filter((s) => !s.needsTap).map(async (s) => {
    setStatus(s.id, ST.UNKNOWN, 'probing…');
    await s.start();
  }));
  autoSelect();
  renderSensors();
  renderExpected();
}

function autoSelect() {
  for (const s of SENSORS) {
    if (state.status[s.id] && state.status[s.id].status === ST.AVAILABLE && s.viz.length) {
      state.selected.add(s.id);
    }
  }
}

// ---------- 4. device detection ----------
async function detectDevice() {
  const d = { ua: navigator.userAgent };
  d.brands = [];
  try {
    if (navigator.userAgentData) {
      d.mobile = navigator.userAgentData.mobile;
      d.platform = navigator.userAgentData.platform;
      d.brands = navigator.userAgentData.brands.map((b) => `${b.brand} ${b.version}`);
      if (navigator.userAgentData.getHighEntropyValues) {
        const hi = await navigator.userAgentData.getHighEntropyValues(
          ['model', 'platformVersion', 'architecture', 'bitness', 'fullVersionList']
        );
        d.model = hi.model || '';
        d.platformVersion = hi.platformVersion || '';
        d.architecture = hi.architecture || '';
        d.bitness = hi.bitness || '';
        d.fullVersions = (hi.fullVersionList || []).map((b) => `${b.brand} ${b.version}`);
      }
    }
  } catch (_) {}

  if (!d.model) {
    const m = d.ua.match(/Android[^;]*;\s*([^)]+?)(?:\s+Build|\))/i);
    if (m) d.model = m[1].replace(/\s*Build.*/i, '').trim();
  }
  d.make = /samsung|sm-/i.test(d.ua + ' ' + (d.model || '')) ? 'Samsung'
    : /pixel|google/i.test(d.ua) ? 'Google'
    : /xiaomi|redmi|poco/i.test(d.ua) ? 'Xiaomi'
    : /huawei|honor/i.test(d.ua) ? 'Huawei/Honor'
    : /oneplus/i.test(d.ua) ? 'OnePlus' : '';

  d.screen = `${screen.width}×${screen.height} @${window.devicePixelRatio}x`;
  d.viewport = `${window.innerWidth}×${window.innerHeight}`;
  d.colourDepth = screen.colorDepth;
  d.cores = navigator.hardwareConcurrency;
  d.memory = navigator.deviceMemory;
  d.touch = navigator.maxTouchPoints;
  d.languages = (navigator.languages || []).join(', ');
  d.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  d.standalone = window.matchMedia('(display-mode: standalone)').matches;
  d.online = navigator.onLine;
  state.device = d;
  return d;
}

function deviceKey(d) {
  const s = `${d.model || ''} ${d.ua}`.toLowerCase();
  const aliases = [];
  if (d.model) aliases.push(d.model.toLowerCase().replace(/\s+/g, ' ').trim());
  const m = s.match(/\b(sm-[a-z0-9]+)\b/);
  if (m) aliases.push(m[1]);
  const g = s.match(/\b(galaxy\s+[a-z]\d+\s*\d*\s*(?:5g|ultra|plus)?)\b/);
  if (g) aliases.push(g[1].replace(/\s+/g, ' ').trim());
  return aliases;
}

// ---------- 5. expected specs ----------
async function loadSpecs() {
  if (state.specs) return state.specs;
  const r = await fetch('./specdb.json', { cache: 'no-cache' });
  state.specs = await r.json();
  return state.specs;
}

function findDevice(specs, keys) {
  for (const [k, v] of Object.entries(specs.devices || {})) {
    const pool = [k, ...(v.aliases || [])].map((x) => String(x).toLowerCase());
    for (const key of keys) {
      if (!key) continue;
      if (pool.includes(key) || pool.some((p) => p.includes(key) || key.includes(p))) {
        return { key: k, entry: v, matched: key, exact: pool.includes(key) };
      }
    }
  }
  return null;
}

const SENSOR_WORDS = [
  ['accelerometer', /accelerometer/i], ['gyroscope', /gyro/i],
  ['magnetometer', /compass|magnetic|geomagnetic/i], ['ambient-light', /light sensor|ambient light/i],
  ['proximity', /proximity/i], ['fingerprint', /fingerprint/i],
  ['barometer', /barometer|pressure/i], ['temperature', /thermo|temperature/i],
  ['humidity', /humidity/i],
];

function parseSensorsText(txt) {
  const found = new Set();
  for (const [id, re] of SENSOR_WORDS) if (re.test(txt)) found.add(id);
  return Array.from(found);
}

function parseGsmarenaSensors(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const el = doc.querySelector('[data-spec="sensors"]');
  const title = doc.querySelector('h1') ? doc.querySelector('h1').textContent.trim() : '';
  return el ? { text: el.textContent.trim(), title } : null;
}

async function liveRefresh() {
  const out = $('#live-out');
  const d = state.device;
  const keys = deviceKey(d);
  const specs = state.specs || await loadSpecs();
  const found = findDevice(specs, keys);
  const slug = found ? found.entry.gsmarena_slug : null;

  if (!slug) {
    out.innerHTML = `<p class="muted">No GSMArena slug is known for this device, so a live lookup is not possible. Detected keys: <code>${esc(keys.join(' / ') || 'none')}</code>. Add the device to <code>specdb.json</code> with its <code>gsmarena_slug</code> to enable it.</p>`;
    return;
  }
  out.innerHTML = `<p class="muted">Fetching <code>/specs/${esc(slug)}.php</code> through the local proxy…</p>`;
  try {
    const r = await fetch(`/specs/${slug}.php`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const parsed = parseGsmarenaSensors(await r.text());
    if (!parsed) throw new Error('sensor row not found in the returned page');
    const live = parseSensorsText(parsed.text);
    const bundled = found.entry.sensors || [];
    const onlyLive = live.filter((x) => !bundled.includes(x));
    const onlyBundled = bundled.filter((x) => !live.includes(x));
    out.innerHTML = `
      <div class="kv"><span>Source</span><b>GSMArena (live, via proxy)</b></div>
      <div class="kv"><span>Page</span><b>${esc(parsed.title || slug)}</b></div>
      <div class="kv"><span>Live sensor row</span><b>${esc(parsed.text)}</b></div>
      <div class="kv"><span>Parsed</span><b>${esc(live.join(', ') || 'none')}</b></div>
      <div class="kv"><span>Bundled snapshot</span><b>${esc(bundled.join(', '))}</b></div>
      <p class="muted" style="margin-top:10px">
        ${onlyLive.length ? `On the live page but not bundled: <b>${esc(onlyLive.join(', '))}</b>. ` : ''}
        ${onlyBundled.length ? `Bundled but not on the live page: <b>${esc(onlyBundled.join(', '))}</b>. ` : ''}
        ${(!onlyLive.length && !onlyBundled.length) ? 'Live data matches the bundled snapshot.' : ''}
      </p>`;
  } catch (e) {
    out.innerHTML = `<p class="bad">Live lookup failed: ${esc((e && e.message) || e)}</p>
      <p class="muted">This is expected when offline. The bundled database is still in use above.</p>`;
  }
}

// ---------- 6. UI ----------
function tab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('on', p.id === 'panel-' + name));
  if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
}

function renderDevice() {
  const d = state.device;
  const rows = [
    ['Make (inferred)', d.make || '—'],
    ['Model', d.model || 'not exposed'],
    ['Platform', `${d.platform || '—'} ${d.platformVersion || ''}`.trim()],
    ['Architecture', [d.architecture, d.bitness ? d.bitness + '-bit' : ''].filter(Boolean).join(' ') || '—'],
    ['Browser brands', (d.fullVersions && d.fullVersions.length ? d.fullVersions : d.brands).join(', ') || '—'],
    ['Mobile', d.mobile === undefined ? '—' : String(d.mobile)],
    ['Screen', d.screen],
    ['Colour depth', d.colourDepth + ' bit'],
    ['Logical cores', d.cores ?? '—'],
    ['Device memory', d.memory ? d.memory + ' GB (approx)' : 'not exposed'],
    ['Touch points', d.touch],
    ['Languages', d.languages || '—'],
    ['Timezone', d.timezone || '—'],
    ['Display mode', d.standalone ? 'standalone (installed)' : 'browser tab'],
    ['Network', d.online ? 'online' : 'offline'],
  ];
  $('#device-table').innerHTML = rows.map(([k, v]) =>
    `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');

  const extra = [];
  if (d.ua) extra.push(`<div class="kv"><span>User agent</span><b class="wrap">${esc(d.ua)}</b></div>`);
  $('#device-ua').innerHTML = extra.join('');
}

function paintStatus(id) {
  const el = document.querySelector(`[data-status="${id}"]`);
  if (!el) return;
  const st = state.status[id] || { status: ST.UNKNOWN, detail: '' };
  el.className = 'pill ' + (ST_CLASS[st.status] || 'st-unknown');
  el.textContent = ST_LABEL[st.status] || st.status;
  el.title = st.detail || '';
}

function renderSensors() {
  const host = $('#sensors-list');
  host.innerHTML = GROUPS.map((g) => {
    const items = SENSORS.filter((s) => s.group === g.id);
    return `
      <section class="card group">
        <header><h3>${esc(g.label)}</h3><p class="muted">${esc(g.note)}</p></header>
        <div class="rows">
          ${items.map((s) => {
            const st = state.status[s.id] || { status: ST.UNKNOWN, detail: '' };
            const enable = (s.needsTap && st.status !== ST.AVAILABLE)
              ? `<button class="mini" data-enable="${esc(s.id)}">Enable</button>` : '';
            return `
              <div class="srow">
                <div class="sname">
                  <b>${esc(s.label)}</b>
                  <span class="muted">${esc(st.detail || '')}</span>
                </div>
                <span class="pill ${ST_CLASS[st.status] || 'st-unknown'}" data-status="${esc(s.id)}">${ST_LABEL[st.status] || st.status}</span>
                ${enable}
              </div>`;
          }).join('')}
        </div>
      </section>`;
  }).join('');

  $$('[data-enable]').forEach((b) => b.addEventListener('click', async () => {
    const s = SENSORS.find((x) => x.id === b.dataset.enable);
    b.disabled = true; b.textContent = '…';
    setStatus(s.id, ST.TAP, 'requesting…');
    await s.start();
    renderSensors();
    if (state.status[s.id] && state.status[s.id].status === ST.AVAILABLE) {
      state.selected.add(s.id);
      renderTree(); renderCards();
    }
  }));
}

function renderExpected() {
  const host = $('#expected-body');
  const d = state.device;
  const specs = state.specs;
  if (!specs) { host.innerHTML = '<p class="muted">Loading…</p>'; return; }

  const keys = deviceKey(d);
  const found = findDevice(specs, keys);
  const entry = found ? found.entry : specs.baseline;
  const expected = entry.sensors || [];
  const absent = entry.absent || [];

  const cmp = expected.map((sid) => {
    const probeId = DEVICE_TO_PROBE[sid];
    const probe = probeId ? SENSORS.find((s) => s.id === probeId) : null;
    const st = probeId ? (state.status[probeId] || { status: ST.UNKNOWN }) : null;
    let verdict, cls;
    if (!probeId) { verdict = 'present on device, not exposed to web apps'; cls = 'st-absent'; }
    else if (st.status === ST.AVAILABLE) { verdict = 'detected'; cls = 'st-ok'; }
    else if (st.status === ST.TAP) { verdict = 'present — needs a tap to enable'; cls = 'st-tap'; }
    else if (st.status === ST.DENIED) { verdict = 'denied by permission'; cls = 'st-bad'; }
    else { verdict = 'not detectable from the browser'; cls = 'st-absent'; }
    return { sid, verdict, cls };
  });

  const detectedExtra = SENSORS
    .filter((s) => s.device && !expected.includes(s.device) && state.status[s.id] && state.status[s.id].status === ST.AVAILABLE)
    .map((s) => s.device);

  host.innerHTML = `
    <section class="card">
      <header>
        <h3>${esc(entry.name || 'Unknown device')}</h3>
        <p class="muted">${found
          ? `Matched the local database on <code>${esc(found.matched)}</code>${found.exact ? '' : ' (partial match)'}`
          : 'No match in the local database — showing the generic Android baseline.'}</p>
      </header>
      <div class="cmp">
        ${cmp.map((c) => `<div class="kv"><span>${esc(c.sid)}</span><b class="pill ${c.cls}">${esc(c.verdict)}</b></div>`).join('')}
      </div>
      ${absent.length ? `<p class="muted" style="margin-top:12px">Not fitted to this model: <b>${esc(absent.join(', '))}</b>.</p>` : ''}
      ${detectedExtra.length ? `<p class="muted">Detected but not in the expected list: <b>${esc(detectedExtra.join(', '))}</b>.</p>` : ''}
    </section>

    ${entry.conflicts && entry.conflicts.length ? `
    <section class="card">
      <header><h3>Sources disagree</h3></header>
      ${entry.conflicts.map((c) => `<div class="kv"><span>${esc(c.sensor)}</span><b class="wrap">${esc(c.detail)}</b></div>`).join('')}
    </section>` : ''}

    ${entry.sources ? `
    <section class="card">
      <header><h3>Where the expected data comes from</h3></header>
      ${entry.sources.map((s) => `<div class="kv"><span>${esc(s.name)}</span><b class="wrap">${esc(s.sensors)}</b></div>`).join('')}
      <p class="muted" style="margin-top:10px">Bundled offline on ${esc((specs.meta && specs.meta.updated) || '')} so the comparison still works with no network.</p>
    </section>` : ''}

    ${entry.hardware ? `
    <section class="card">
      <header><h3>Hardware</h3></header>
      ${Object.entries(entry.hardware).map(([k, v]) => `<div class="kv"><span>${esc(k.replace(/_/g, ' '))}</span><b>${esc(v)}</b></div>`).join('')}
    </section>` : ''}

    <section class="card">
      <header>
        <h3>Live lookup</h3>
        <p class="muted">Re-reads the spec page through the local proxy, so it works from the phone without CORS. Requires a network connection.</p>
      </header>
      <button id="live-btn">Refresh from GSMArena</button>
      <div id="live-out" style="margin-top:12px"></div>
    </section>`;

  const btn = $('#live-btn');
  if (btn) btn.addEventListener('click', liveRefresh);
}

// ---------- 7. visualise tab ----------
function renderTree() {
  const host = $('#tree');
  host.innerHTML = GROUPS.map((g) => {
    const items = SENSORS.filter((s) => s.group === g.id && s.viz.length);
    if (!items.length) return '';
    const avail = items.filter((s) => state.status[s.id] && state.status[s.id].status === ST.AVAILABLE);
    return `
      <div class="tgroup">
        <label class="tgl">
          <input type="checkbox" data-group="${esc(g.id)}">
          <b>${esc(g.label)}</b>
          <span class="muted">${avail.length}/${items.length} available</span>
        </label>
        <div class="titems">
          ${items.map((s) => {
            const st = state.status[s.id] || { status: ST.UNKNOWN };
            const ok = st.status === ST.AVAILABLE;
            return `<label class="titem ${ok ? '' : 'dim'}">
              <input type="checkbox" data-sensor="${esc(s.id)}" ${ok ? '' : 'disabled'}>
              <span>${esc(s.label)}</span>
              <span class="pill ${ST_CLASS[st.status] || 'st-unknown'}">${ST_LABEL[st.status] || st.status}</span>
            </label>`;
          }).join('')}
        </div>
      </div>`;
  }).join('');

  $$('#tree input[data-sensor]').forEach((cb) => {
    cb.checked = state.selected.has(cb.dataset.sensor);
    cb.addEventListener('change', () => {
      cb.checked ? state.selected.add(cb.dataset.sensor) : state.selected.delete(cb.dataset.sensor);
      refreshGroupBoxes(); renderCards();
    });
  });
  $$('#tree input[data-group]').forEach((cb) => {
    cb.addEventListener('change', () => {
      SENSORS.filter((s) => s.group === cb.dataset.group && s.viz.length).forEach((s) => {
        const st = state.status[s.id] || { status: ST.UNKNOWN };
        if (st.status !== ST.AVAILABLE) return;
        cb.checked ? state.selected.add(s.id) : state.selected.delete(s.id);
      });
      $$('#tree input[data-sensor]').forEach((c) => { c.checked = state.selected.has(c.dataset.sensor); });
      refreshGroupBoxes(); renderCards();
    });
  });
  refreshGroupBoxes();
}

function refreshGroupBoxes() {
  $$('#tree input[data-group]').forEach((cb) => {
    const items = SENSORS.filter((s) => s.group === cb.dataset.group && s.viz.length
      && state.status[s.id] && state.status[s.id].status === ST.AVAILABLE);
    if (!items.length) { cb.checked = false; cb.indeterminate = false; return; }
    const on = items.filter((s) => state.selected.has(s.id)).length;
    cb.checked = on === items.length;
    cb.indeterminate = on > 0 && on < items.length;
  });
}

// cards: id -> { spec, parts: [{ kind, canvas, label, extra }] }
const CARDS = new Map();

function renderCards() {
  const host = $('#cards');
  const chosen = SENSORS.filter((s) => state.selected.has(s.id) && s.viz.length);
  host.innerHTML = '';
  CARDS.clear();

  if (!chosen.length) {
    host.innerHTML = `<p class="muted">Nothing selected. Tick a sensor above to plot it.</p>`;
    return;
  }

  for (const s of chosen) {
    const plan = CARD_VIZ[s.id] || [['readout', s.label]];
    const card = document.createElement('section');
    card.className = 'card viz';
    card.innerHTML = `<header><h3>${esc(s.label)}</h3><p class="muted">${esc((state.status[s.id] || {}).detail || '')}</p></header>`;
    const parts = [];
    for (const [kind, label] of plan) {
      const wrap = document.createElement('div');
      wrap.className = 'vizpart';
      const h = document.createElement('div');
      h.className = 'vizlabel';
      h.textContent = label;
      wrap.appendChild(h);
      if (kind === 'readout') {
        const pre = document.createElement('div');
        pre.className = 'readout';
        pre.dataset.readout = s.id;
        wrap.appendChild(pre);
        parts.push({ kind, el: pre, label });
      } else {
        const cv = document.createElement('canvas');
        cv.className = (kind === 'spectrogram' || kind === 'polar' || kind === 'level') ? 'cv tall' : 'cv';
        wrap.appendChild(cv);
        const part = { kind, canvas: cv, label };
        if (kind === 'spectrogram') part.spec = new Viz.Spectrogram(cv);
        parts.push(part);
      }
      card.appendChild(wrap);
    }
    host.appendChild(card);
    CARDS.set(s.id, { spec: s, parts });
  }
}

function seriesFor(sensor, channels) {
  const d = state.data[sensor.id];
  const out = [];
  for (let i = 0; i < channels.length; i++) {
    out.push({
      label: (sensor.channels[i] || String.fromCharCode(88 + i)),
      colour: Viz.SERIES[i % Viz.SERIES.length],
      points: d && d.ch[i] ? d.ch[i].map((v) => ({ v })) : [],
    });
  }
  return out;
}

function logBins(freq, n) {
  const N = freq.length, out = new Array(n).fill(0);
  for (let b = 0; b < n; b++) {
    const a = Math.floor(Math.pow(N, b / n));
    const z = Math.max(a + 1, Math.floor(Math.pow(N, (b + 1) / n)));
    let m = 0;
    for (let i = a; i < z && i < N; i++) m = Math.max(m, freq[i]);
    out[b] = m;
  }
  return out;
}

function drawCards() {
  for (const [id, card] of CARDS) {
    const s = card.spec;
    for (const part of card.parts) {
      const last = state.last[id] || [];
      if (part.kind === 'readout') {
        const m = state.meta[id] || {};
        const rows = Object.entries(m).map(([k, v]) =>
          `<div class="kv"><span>${esc(k)}</span><b>${esc(typeof v === 'number' ? Viz.fmtNum(v) : v)}</b></div>`).join('');
        part.el.innerHTML = rows || `<div class="kv"><span>value</span><b>${esc(last.map((x) => Viz.fmtNum(x)).join(', ') || '—')}</b></div>`;
        continue;
      }
      if (part.kind === 'line3' || part.kind === 'line1') {
        const nch = part.kind === 'line3' ? 3 : 1;
        Viz.line(part.canvas, {
          series: seriesFor(s, s.channels.slice(0, nch)),
          unit: s.unit, yLog: id === 'ambientlight',
        });
      } else if (part.kind === 'polar') {
        let heading = null;
        if (id === 'magnetometer') {
          const d = state.data.magnetometer;
          if (d && d.ch[0] && d.ch[0].length) {
            const x = d.ch[0][d.ch[0].length - 1], y = d.ch[1][d.ch[1].length - 1];
            heading = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
          }
        } else if (last.length) heading = last[0];
        Viz.polar(part.canvas, { heading, label: s.label });
      } else if (part.kind === 'gauge') {
        let v = last[0], min = 0, max = 100;
        if (id === 'proximity') { min = 0; max = 10; }
        if (id === 'camera-light') { min = 0; max = 100; }
        Viz.gauge(part.canvas, { value: v, min, max, unit: s.unit, label: s.label, colour: '#4ade80' });
      } else if (part.kind === 'level') {
        let x = null, y = null;
        if (last.length >= 3) {
          const g = 9.81;
          x = clamp(-last[0] / g, -1, 1);
          y = clamp(last[1] / g, -1, 1);
        }
        Viz.level2d(part.canvas, { x, y });
      } else if (part.kind === 'meter') {
        const m = state.meta.microphone || {};
        Viz.meter(part.canvas, { value: (m.level + 100) / 100, peak: (m.peak + 100) / 100, label: `${Viz.fmtNum(m.level)} dBFS` });
      } else if (part.kind === 'bars') {
        const m = state.meta.microphone || {};
        const bins = m.spectrum && m.spectrum.length ? logBins(m.spectrum, 40) : [];
        const nyq = (m.sampleRate || 48000) / 2;
        Viz.bars(part.canvas, {
          values: bins, max: 255, colour: '#4cc2ff',
          labels: [{ at: 0, text: '20 Hz' }, { at: 255 * 0.5, text: `${Math.round(nyq / 4 / 1000)}k` }, { at: 255, text: `${Math.round(nyq / 1000)}k` }],
        });
      } else if (part.kind === 'spectrogram') {
        const m = state.meta.microphone || {};
        if (m.spectrum && m.spectrum.length) part.spec.push(logBins(m.spectrum, part.spec.rows));
        part.spec.draw();
      } else if (part.kind === 'hbars') {
        const m = state.meta.bluetooth || { devices: [] };
        Viz.hbars(part.canvas, { items: m.devices, min: -100, max: -40, unit: 'dBm' });
      }
    }
  }
}

// ---------- 8. init + render loop ----------
function loop() {
  drawCards();
  requestAnimationFrame(loop);
}

async function init() {
  await loadSpecs();
  await detectDevice();
  renderDevice();
  renderExpected();

  $$('.tab').forEach((t) => t.addEventListener('click', () => tab(t.dataset.tab)));
  const startTab = location.hash.slice(1);
  if (startTab && document.getElementById('panel-' + startTab)) tab(startTab);

  $('#probe-all').addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Probing…';
    await probeAll();
    e.target.disabled = false; e.target.textContent = 'Probe all sensors';
    renderTree(); renderCards();
  });

  $('#select-all').addEventListener('click', () => {
    SENSORS.forEach((s) => { if (state.status[s.id] && state.status[s.id].status === ST.AVAILABLE && s.viz.length) state.selected.add(s.id); });
    renderTree(); renderCards();
  });
  $('#select-none').addEventListener('click', () => {
    state.selected.clear(); renderTree(); renderCards();
  });

  renderSensors();
  renderTree();
  renderCards();
  loop();

  probeAll();
}

window.addEventListener('online', () => { state.device.online = true; renderDevice(); });
window.addEventListener('offline', () => { state.device.online = false; renderDevice(); });

init();

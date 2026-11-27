// Mock-level test harness for the Hermes Bot setup QR path in an .ink page.
// No glasses, camera, or network: wx.media and BarcodeDetector are stubs.
// Not part of the app package; run from the repository root:
//   node tools/scan-harness.mjs [path-to-index.ink]
import fs from 'node:fs';
import assert from 'node:assert/strict';

const file = process.argv[2] || 'hermes-bot/pages/index/index.ink';
if (!fs.existsSync(file)) throw new Error(`no such page: ${file}`);
let text = fs.readFileSync(file, 'utf8');

// The .ink page is not directly importable. Keep only <script setup>, drop
// imports, and turn `export default` into a value we can return.
const m = text.match(/<script setup>([\s\S]*?)<\/script>/);
if (!m) throw new Error('no <script setup> block');
let js = m[1]
  .replace(/^import[\s\S]*?;[ \t]*$/gm, '')
  .replace('export default {', 'const component = {');

// Shorten the 15 s timeout so the timeout tests are fast.
js = js.replace('const QR_TIMEOUT_MS = 15000;', 'const QR_TIMEOUT_MS = 40;');

// Live stubs: the component destructures these once, so each entry delegates
// to a mutable implementation the tests can replace.
let settingsFromQrImpl = () => null;
let saveSettingsImpl = () => {};
const imported = {
  askHermes: async () => '',
  plainText: (s) => s,
  speakThen: () => () => {},
  listen: () => ({ stop() {}, abort() {} }),
  conversations: () => [],
  turnsOf: () => [],
  addTurn: () => {},
  ago: () => '',
  VERSION: 'test',
  loadSettings: () => ({}),
  saveSettings: (s) => saveSettingsImpl(s),
  isConfigured: () => true,
  settingsFromQr: (...args) => settingsFromQrImpl(...args),
  newConversation: () => 'test',
};

let Detector = null;
const BarcodeDetectorProxy = function (...args) {
  return new Detector(...args);
};
const component = new Function(
  'stubs', 'wx', 'BarcodeDetector',
  `const {askHermes, plainText, speakThen, listen, conversations, turnsOf, addTurn, ago, VERSION, loadSettings, saveSettings, isConfigured, settingsFromQr, newConversation} = stubs;
   ${js}
   return component;`,
)(imported, {}, BarcodeDetectorProxy);

function instance() {
  const inst = Object.create(component);
  inst.data = { ...component.data };
  inst.setData = (patch) => Object.assign(inst.data, patch);
  inst.setState = (state, extra = {}) => {
    inst.data.state = state;
    Object.assign(inst.data, extra);
  };
  inst.paged = (extra) => extra;
  inst.startListening = () => { inst.listening = (inst.listening || 0) + 1; };
  inst.stopListening = () => {};
  inst.endSpeech = () => {};
  inst.settings = { VERSION: 1 };
  inst.scanAttempt = 0;
  inst.scanBusy = false;
  return inst;
}

let pass = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
    pass += 1;
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

function makeDetector(impl) {
  return class {
    constructor(opts) { this.opts = opts; }
    detect(blob) { return impl(blob, this.opts); }
  };
}

await test('success: captures wide, sends Blob to native detector, saves settings', async () => {
  Detector = makeDetector(async (blob, opts) => {
    assert.deepEqual(opts, { formats: ['qr_code'] });
    assert.ok(blob instanceof Blob, 'detector gets a Blob');
    assert.equal(blob.type, 'image/webp');
    assert.equal((await blob.arrayBuffer()).byteLength, 3);
    return [{ rawValue: 'setup-code' }];
  });
  settingsFromQrImpl = (raw, current) => {
    assert.equal(raw, 'setup-code');
    assert.ok(current);
    return { HERMES: 'http://x', KEY: 'k' };
  };
  const saved = [];
  saveSettingsImpl = (s) => saved.push(s);
  const inst = instance();
  let photoArgs = null;
  inst.cameraCtx = {
    async takePhoto(args) {
      photoArgs = args;
      return { mimeType: 'image/webp', data: new Uint8Array([1, 2, 3]).buffer };
    },
  };
  await inst.scanQr();
  assert.deepEqual(photoArgs, { quality: 'high', mode: 'wide', enableSystemPreview: true });
  assert.equal(inst.data.state, 'idle');
  assert.equal(saved.length, 1);
  assert.equal(inst.listening, 1);
  assert.equal(inst.scanBusy, false);
});

await test('timeout: camera never resolves -> scan error, busy cleared', async () => {
  Detector = makeDetector(async () => []);
  const inst = instance();
  inst.cameraCtx = { takePhoto: () => new Promise(() => {}) };
  await inst.scanQr();
  assert.equal(inst.data.state, 'scan');
  assert.match(inst.data.error, /timed out/i);
  assert.equal(inst.scanBusy, false);
});

await test('timeout: detector never resolves -> scan error, busy cleared', async () => {
  Detector = makeDetector(() => new Promise(() => {}));
  const inst = instance();
  inst.cameraCtx = {
    async takePhoto() { return { mimeType: 'image/webp', data: new Uint8Array([1]).buffer }; },
  };
  await inst.scanQr();
  assert.equal(inst.data.state, 'scan');
  assert.match(inst.data.error, /timed out/i);
  assert.equal(inst.scanBusy, false);
});

await test('concurrency: a second tap while busy does not take another photo', async () => {
  Detector = makeDetector(async () => []);
  let photos = 0;
  const inst = instance();
  inst.cameraCtx = {
    takePhoto: () => { photos += 1; return new Promise(() => {}); },
  };
  const first = inst.scanQr();
  await inst.scanQr();
  assert.equal(photos, 1);
  await first; // let the first attempt time out and finish
});

await test('stale attempt: result after onHide is dropped', async () => {
  Detector = makeDetector(async () => {
    throw new Error('detector should not run after hide');
  });
  let resolvePhoto;
  const inst = instance();
  inst.cameraCtx = {
    takePhoto: () => new Promise((resolve) => { resolvePhoto = resolve; }),
  };
  const pending = inst.scanQr();
  inst.onHide(); // bumps scanAttempt, clears scanBusy, returns to scan state
  resolvePhoto({ mimeType: 'image/webp', data: new Uint8Array([1]).buffer });
  await pending;
  assert.equal(inst.data.state, 'scan');
  assert.equal(inst.scanBusy, false);
});

await test('invalid photo: no mime/data -> scan error', async () => {
  Detector = makeDetector(async () => []);
  const inst = instance();
  inst.cameraCtx = { async takePhoto() { return { data: null, mimeType: '' }; } };
  await inst.scanQr();
  assert.equal(inst.data.state, 'scan');
  assert.match(inst.data.error, /invalid image/i);
});

await test('no codes -> retry message', async () => {
  Detector = makeDetector(async () => []);
  const inst = instance();
  inst.cameraCtx = {
    async takePhoto() { return { mimeType: 'image/jpeg', data: new Uint8Array([9]).buffer }; },
  };
  await inst.scanQr();
  assert.equal(inst.data.state, 'scan');
  assert.match(inst.data.error, /No QR code/i);
});

await test('wrong payload -> not a Hermes code', async () => {
  Detector = makeDetector(async () => [{ rawValue: 'other' }]);
  settingsFromQrImpl = () => null;
  const inst = instance();
  inst.cameraCtx = {
    async takePhoto() { return { mimeType: 'image/webp', data: new Uint8Array([9]).buffer }; },
  };
  await inst.scanQr();
  assert.equal(inst.data.state, 'scan');
  assert.match(inst.data.error, /not a Hermes setup code/i);
});

console.log(`\n${pass}/8 passed: ${file}`);

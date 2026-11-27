// Loads the REAL pages/index/index.ink `<script setup>` block into Node so the
// main page's own code (not a copy) can be driven by tests: voice, scanner,
// queue, cancel and the /v1/runs status wiring.
//
// What is replaced and why:
//   * `wx` and `barcode` are host modules the simulator/glasses provide, so
//     they become small stubs on globalThis.
//   * The lib imports are rewritten to absolute file: URLs, so the page file
//     itself is never edited for testing.
//   * The remaining globals (localStorage, SpeechRecognition, speechSynth-
//     esis, camera) are the same host objects the AIX runtime supplies.
//
// Nothing here changes app code; the .ink file stays the single source.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
const TMP = path.join(HERE, '.tmp');

// ---------------------------------------------------------------- page load

export async function loadPage(rel = 'pages/index/index.ink') {
  const file = path.join(ROOT, rel);
  const html = fs.readFileSync(file, 'utf8');
  const match = html.match(/<script setup>([\s\S]*?)<\/script>/);
  if (!match) throw new Error(`no <script setup> in ${rel}`);
  let code = match[1];
  code = code.replace(/^import wx from 'wx';$/m, 'const wx = globalThis.__wx;');
  code = code.replace(/^import BarcodeDetector from 'barcode';$/m, 'const BarcodeDetector = globalThis.__BarcodeDetector;');
  code = code.replace(/from '(\.{1,2}\/[^']+)'/g, (_, spec) => `from '${pathToFileURL(path.resolve(path.dirname(file), spec)).href}'`);
  fs.mkdirSync(TMP, { recursive: true });
  const out = path.join(TMP, `${process.pid}_${rel.replace(/[\\/]/g, '_').replace(/\.ink$/, '')}.mjs`);
  fs.writeFileSync(out, code);
  const mod = await import(`${pathToFileURL(out).href}?t=${Date.now()}${Math.random()}`);
  return mod.default;
}

// The page object as AIX gives it to the app: methods plus data + setData.
// setData only ever receives flat keys from this page.
export function makePage(def) {
  const page = Object.create(def);
  page.data = JSON.parse(JSON.stringify(def.data || {}));
  page.setData = (patch = {}, callback) => {
    const next = typeof patch === 'function' ? patch(page.data) : patch;
    Object.assign(page.data, next || {});
    if (callback) callback();
  };
  return page;
}

// ---------------------------------------------------------------- host stubs

export function installStorage(seed = {}) {
  const store = new Map(
    Object.entries(seed).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]),
  );
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
  return store;
}

export function readStore(store, key) {
  const raw = store.get(key);
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return raw;
  }
}

// The glasses' speech recognizer: one result, then the host ends the segment
// at a pause (which lib/listen.js handles).
export function installSpeechRecognition(transcript) {
  const instances = [];
  class FakeSpeechRecognition {
    constructor() {
      this.interimResults = false;
      this.aborted = false;
      this.started = false;
      instances.push(this);
    }

    start() {
      this.started = true;
      setTimeout(() => {
        if (this.aborted || !this.onresult) return;
        // The first segment hears the words; a fresh segment after the pause
        // is silent, which the real host reports as "no-speech" and
        // lib/listen.js treats as the end of the utterance.
        if (instances.indexOf(this) === 0) {
          this.onresult({ results: [[{ transcript }]], resultIndex: 0 });
          setTimeout(() => {
            if (!this.aborted) this.onend?.();
          }, 0);
        } else {
          this.onerror?.({ error: 'no-speech', message: 'no-speech' });
        }
      }, 0);
      return this;
    }

    stop() {
      setTimeout(() => {
        if (!this.aborted) this.onend?.();
      }, 0);
    }

    abort() {
      this.aborted = true;
    }
  }
  globalThis.SpeechRecognition = FakeSpeechRecognition;
  return instances;
}

// Enough of speechSynthesis for lib/speak.js to start and be stoppable; the
// tests stop playback themselves rather than waiting out the audio poll.
export function installSpeechSynthesis() {
  globalThis.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
    }
  };
  globalThis.SpeechAudioPlayer = class {
    constructor(task) {
      this.task = task;
      this.currentTime = 0;
      this.duration = 0;
      this.paused = false;
    }

    play() {
      this.paused = false;
    }

    stop() {}

    destroy() {}
  };
  globalThis.speechSynthesis = {
    synthesize: async () => ({ onend: null, onerror: null }),
    speak: () => {},
  };
}

// Camera + barcode for the setup-QR flow. `codes` is what the native reader
// returns (null = no QR in frame). The page captures `wx` and BarcodeDetector
// once at module load, so these are stable objects whose behaviour the tests
// can retarget between cases.
let scannerCodes = null;
let camera = null;

function defaultCamera() {
  return {
    takePhoto: async () => ({ data: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' }),
  };
}

const wxStub = {
  media: {
    createCameraContext: () => camera,
  },
  exitMiniProgram() {},
};

class BarcodeDetectorStub {
  constructor() {
    this.formats = [];
  }

  async detect() {
    return scannerCodes;
  }
}

camera = defaultCamera();
globalThis.__wx = wxStub;
globalThis.__BarcodeDetector = BarcodeDetectorStub;

export function installScanner({ codes = null, takePhoto = null } = {}) {
  scannerCodes = codes;
  camera = takePhoto ? { takePhoto } : defaultCamera();
  return camera;
}

// ---------------------------------------------------------------- gateway

// api_server._sse_frame(payload, id=seq): id line, data line, blank line.
export function sseFrame(seq, payload) {
  return `id: ${seq}\ndata: ${JSON.stringify(payload)}\n\n`;
}

// /v1/responses frames carry an SSE event name AND a type in the body.
export function responsesFrame(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function runEvent(runId, seq, name, fields = {}) {
  return { event: name, run_id: runId, timestamp: 1764000000, seq, ...fields };
}

export function sseHeaders(res, extra = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...extra,
  });
}

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(check, { timeout = 4000, label = 'condition' } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    last = check();
    if (last) return last;
    await delay(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}

export async function startGateway(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const record = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: null };
    requests.push(record);
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (raw) {
        try {
          record.body = JSON.parse(raw);
        } catch (e) {
          record.body = raw;
        }
      }
      req.on('close', () => {
        record.closed = true;
      });
      Promise.resolve(handler(req, res, record)).catch((err) => {
        try {
          res.destroy(err);
        } catch (e) {}
      });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// One configured glasses install. `v: 2` keeps loadSettings from rotating the
// conversation on every test.
export function settingsFor(base, patch = {}) {
  return {
    v: 2,
    HERMES_URL: base,
    HERMES_KEY: 'local-test-key',
    CONVERSATION: 'rokid-glasses-test',
    MODEL: 'glasses',
    SMART: false,
    SPEAK_REPLIES: false,
    KEEP_LISTENING: false,
    ...patch,
  };
}

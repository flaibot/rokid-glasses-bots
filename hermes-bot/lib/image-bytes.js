// Visual delivery helpers for the Rokid glasses spike.
//
// WHY THIS EXISTS: Hermes' streaming endpoints emit the literal text
// `MEDIA:C:\path\to\img.png` — a server-side path the glasses cannot read.
// On the *non-streaming* OpenAI chat-completions route the gateway rewrites
// that tag to `![image](data:image/png;base64,...)` before it leaves the
// server (gateway/platforms/api_server.py `_resolve_media_to_data_urls`,
// applied at gateway/platforms/api_server_openai_routes.py:801).
// This module turns that markdown into bytes and then into a drawable bitmap.
//
// Pure JS (no Node/DOM globals) so it runs unchanged on the rquickjs runtime,
// in Node tests, and in the page.

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // mirrors _MEDIA_DATA_URL_MAX_BYTES

// image/* subtypes the server is willing to inline (api_server.py:857-859).
const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};
const MIME_SET = Object.keys(MIME_EXT);

// Only markdown image syntax, which is the exact shape the server emits:
//   ![image](data:image/png;base64,iVBORw0KGgo...)
const DATA_URL_MARKDOWN = /!\[[^\]]*\]\(\s*data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=]+)\s*\)/g;
// A leftover raw tag means the server did NOT inline the image.
const RAW_MEDIA_TAG = /MEDIA:\s*([^\s`"'*<>,;)]+)/g;

export function mimeToExt(mime) {
  return MIME_EXT[mime] || null;
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_CHARS.length; i += 1) table[B64_CHARS.charCodeAt(i)] = i;
  return table;
})();

// Strict base64 -> bytes. No atob/Buffer dependency (the glasses runtime is
// rquickjs and not guaranteed to expose either). Throws on invalid input so a
// malformed payload fails loudly instead of drawing garbage.
export function base64ToBytes(input) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('empty base64 payload');
  }
  const clean = input.replace(/\s+/g, '');
  if (clean.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) throw new Error('invalid or oversized base64');
  if (clean.length % 4 !== 0) throw new Error('base64 length is not a multiple of 4');
  let pad = 0;
  if (clean.endsWith('==')) pad = 2;
  else if (clean.endsWith('=')) pad = 1;
  const core = pad ? clean.slice(0, clean.length - pad) : clean;
  if (core.includes('=')) throw new Error('base64 padding in the middle');

  const out = new Uint8Array((clean.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < core.length; i += 4) {
    const c0 = B64_LOOKUP[core.charCodeAt(i) & 127];
    const c1 = B64_LOOKUP[core.charCodeAt(i + 1) & 127];
    const c2 = i + 2 < core.length ? B64_LOOKUP[core.charCodeAt(i + 2) & 127] : 0;
    const c3 = i + 3 < core.length ? B64_LOOKUP[core.charCodeAt(i + 3) & 127] : 0;
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) throw new Error('invalid base64 character');
    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (o < out.length) out[o++] = (triple >> 16) & 0xff;
    if (o < out.length) out[o++] = (triple >> 8) & 0xff;
    if (o < out.length) out[o++] = triple & 0xff;
  }
  if (o !== out.length) throw new Error('base64 decode length mismatch');
  return out;
}

const HEX = '0123456789abcdef';
export function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) {
    s += HEX[(bytes[i] >> 4) & 0xf] + HEX[bytes[i] & 0xf];
  }
  return s;
}

export function bytesToBase64(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + B64_CHARS[(n >> 6) & 63] + B64_CHARS[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + '==';
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + B64_CHARS[(n >> 6) & 63] + '=';
  }
  return out;
}

// Magic-number sniffing: the declared MIME must agree with the actual bytes,
// so a mislabelled or truncated payload is rejected rather than drawn.
export function sniffImageType(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  return null;
}

// Pulls every inlined image out of an assistant reply.
// Returns { images, rawPaths, cleanedText, reason }.
//  images: [{ mime, ext, bytes, byteLength }]  — bytes are the real file bytes
//  rawPaths: MEDIA:<path> tags that were NOT inlined (streaming mode always
//            produces these; they are useless to the glasses and are reported,
//            never fetched)
export function extractImages(text) {
  const source = typeof text === 'string' ? text : '';
  const images = [];
  const skipped = [];
  let match;
  DATA_URL_MARKDOWN.lastIndex = 0;
  while ((match = DATA_URL_MARKDOWN.exec(source)) !== null) {
    const mime = match[1];
    const payload = match[2];
    if (!MIME_SET.includes(mime)) {
      skipped.push({ reason: `unsupported mime ${mime}` });
      continue;
    }
    let bytes;
    try {
      bytes = base64ToBytes(payload);
    } catch (e) {
      skipped.push({ reason: `bad base64: ${e.message}` });
      continue;
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      skipped.push({ reason: `oversized ${bytes.length} bytes` });
      continue;
    }
    const actual = sniffImageType(bytes);
    if (actual !== mime) {
      skipped.push({ reason: `magic mismatch: declared ${mime}, bytes look like ${actual || 'unknown'}` });
      continue;
    }
    images.push({ mime, ext: MIME_EXT[mime], bytes, byteLength: bytes.length });
  }

  const rawPaths = [];
  RAW_MEDIA_TAG.lastIndex = 0;
  let raw;
  while ((raw = RAW_MEDIA_TAG.exec(source)) !== null) {
    const path = raw[1].replace(/[.]+$/, '');
    if (path) rawPaths.push(path);
  }

  let cleanedText = source;
  DATA_URL_MARKDOWN.lastIndex = 0;
  cleanedText = cleanedText.replace(DATA_URL_MARKDOWN, ' [image] ').replace(/\s+/g, ' ').trim();

  return {
    images,
    rawPaths,
    cleanedText,
    reason: images.length === 0
      ? (skipped.length ? skipped[0].reason : rawPaths.length ? 'MEDIA path only (no inlined bytes)' : 'no image in reply')
      : '',
  };
}

// Aspect-fit placement inside the display box.
export function fitRect(srcW, srcH, boxW, boxH) {
  if (!(srcW > 0) || !(srcH > 0) || !(boxW > 0) || !(boxH > 0)) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  const scale = Math.min(boxW / srcW, boxH / srcH);
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);
  return { x: Math.round((boxW - w) / 2), y: Math.round((boxH - h) / 2), w, h };
}

// Draws bytes onto an AIUI page canvas context.
// ctx comes from wx.createCanvasContext(id) — a command queue, so call
// ctx.flush() (2-components/canvas doc) after this resolves.
export async function drawImageBytes(ctx, image, boxW, boxH) {
  if (!ctx) throw new Error('no canvas context');
  const BlobCtor = globalThis.Blob;
  if (typeof createImageBitmap !== 'function' || typeof BlobCtor !== 'function') {
    throw new Error('runtime lacks Blob/createImageBitmap');
  }
  const blob = new BlobCtor([image.bytes], { type: image.mime });
  const bitmap = await createImageBitmap(blob);
  try {
    const rect = fitRect(bitmap.width, bitmap.height, boxW, boxH);
    ctx.clearRect(0, 0, boxW, boxH);
    ctx.drawImage(bitmap, rect.x, rect.y, rect.w, rect.h);
    if (typeof ctx.flush === 'function') await ctx.flush();
    else if (typeof ctx.draw === 'function') await ctx.draw();
    else throw new Error('Canvas cannot submit drawing');
    return { width: bitmap.width, height: bitmap.height, ...rect };
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close();
  }
}

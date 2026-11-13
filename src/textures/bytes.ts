/** Binary helpers shared by the texture manager and the project container (no DOM required). */

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(out);
}

export function base64ToBytes(b64: string): Uint8Array {
  const comma = b64.startsWith('data:') ? b64.indexOf(',') : -1;
  const bin = atob(comma >= 0 ? b64.slice(comma + 1) : b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** FNV-1a (32 bit) x2 with different seeds -> 16 hex chars. Fallback when SubtleCrypto is unavailable. */
export function fnvHash(bytes: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i] as number;
    a = Math.imul(a ^ v, 0x01000193) >>> 0;
    b = Math.imul(b ^ v, 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** Content hash used to dedupe imported images (SHA-256 when available). */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;
  if (subtle) {
    try {
      const digest = await subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
      return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('');
    } catch {
      /* fall through to the JS hash */
    }
  }
  return fnvHash(bytes);
}

/** Sniff an image MIME type from magic numbers (fallback when the File has no type). */
export function sniffImageMime(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'image/webp';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return 'application/octet-stream';
}

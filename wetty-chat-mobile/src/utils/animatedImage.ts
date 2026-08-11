import { fileTypeFromBlob } from 'file-type/core';

const HEADER_SCAN_BYTES = 64 * 1024;
const GIF_FILE_NAME_RE = /\.gif(?:$|[?#])/i;

const RIFF_SIGNATURE = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // RIFF container marker.
const WEBP_SIGNATURE = new Uint8Array([0x57, 0x45, 0x42, 0x50]); // WebP RIFF form type.
const VP8X_CHUNK = new Uint8Array([0x56, 0x50, 0x38, 0x58]); // Extended WebP header.
const FTYP_BOX = new Uint8Array([0x66, 0x74, 0x79, 0x70]); // ISO base media file-type box (ftyp).
const AVIS_BRAND = new Uint8Array([0x61, 0x76, 0x69, 0x73]); // AVIF image-sequence brand (avis).

function matchesBytesAt(header: Uint8Array, offset: number, signature: Uint8Array) {
  if (offset + signature.length > header.length) return false;

  for (let index = 0; index < signature.length; index += 1) {
    if (header[offset + index] !== signature[index]) return false;
  }

  return true;
}

function findBytes(header: Uint8Array, signature: Uint8Array, end = header.length) {
  const limit = Math.min(end, header.length) - signature.length;
  for (let offset = 0; offset <= limit; offset += 1) {
    if (matchesBytesAt(header, offset, signature)) return offset;
  }

  return -1;
}

function isAnimatedWebp(header: Uint8Array) {
  return (
    matchesBytesAt(header, 0, RIFF_SIGNATURE) &&
    matchesBytesAt(header, 8, WEBP_SIGNATURE) &&
    matchesBytesAt(header, 12, VP8X_CHUNK) &&
    (header[20] & 0x02) !== 0
  );
}

function isAnimatedAvif(header: Uint8Array) {
  if (!matchesBytesAt(header, 4, FTYP_BOX)) return false;

  const boxSize = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(0);
  return findBytes(header, AVIS_BRAND, boxSize) !== -1;
}

export async function isAnimatedImageFile(file: File): Promise<boolean> {
  if (file.type.split(';', 1)[0]?.trim().toLowerCase() === 'image/gif' || GIF_FILE_NAME_RE.test(file.name)) return true;

  try {
    const detected = await fileTypeFromBlob(file);
    if (detected?.mime === 'image/apng') return true;

    const header = new Uint8Array(await file.slice(0, HEADER_SCAN_BYTES).arrayBuffer());
    return isAnimatedWebp(header) || isAnimatedAvif(header);
  } catch {
    return true;
  }
}

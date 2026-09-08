import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAnimatedImageFile } from './animated-image';
beforeEach(() => {
  vi.stubGlobal('File', NodeFile);
  vi.stubGlobal('Blob', NodeBlob);
});

const ascii = (value: string) => Array.from(value, (character) => character.charCodeAt(0));

function createFile(bytes: number[], name: string, type = '') {
  return new File([new Uint8Array(bytes)], name, { type });
}

function webpHeader(animationFlag: number) {
  return [...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8X'), 10, 0, 0, 0, animationFlag];
}

function pngChunk(type: string, data: number[] = []) {
  return [
    (data.length >>> 24) & 0xff,
    (data.length >>> 16) & 0xff,
    (data.length >>> 8) & 0xff,
    data.length & 0xff,
    ...ascii(type),
    ...data,
    0,
    0,
    0,
    0,
  ];
}

function pngHeader(...chunkTypes: string[]) {
  return [
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...pngChunk('IHDR', Array(13).fill(0)),
    ...chunkTypes.flatMap((type) => pngChunk(type)),
  ];
}

function avifHeader(...brands: string[]) {
  const boxSize = 8 + brands.length * 4;
  return [
    (boxSize >>> 24) & 0xff,
    (boxSize >>> 16) & 0xff,
    (boxSize >>> 8) & 0xff,
    boxSize & 0xff,
    ...ascii('ftyp'),
    ...brands.flatMap(ascii),
  ];
}

describe('isAnimatedImageFile', () => {
  it.each([
    ['GIFs', () => createFile([], 'loop.gif', 'image/gif')],
    ['animated WebP', () => createFile(webpHeader(0x02), 'loop.webp', 'image/webp')],
    ['APNG', () => createFile(pngHeader('acTL', 'IDAT'), 'loop.png', 'image/png')],
    ['animated AVIF', () => createFile(avifHeader('avif', 'avis'), 'loop.avif', 'image/avif')],
  ])('recognizes %s', async (_label, create) => {
    await expect(isAnimatedImageFile(create())).resolves.toBe(true);
  });

  it.each([
    ['still WebP', () => createFile(webpHeader(0), 'photo.webp', 'image/webp')],
    ['PNG', () => createFile(pngHeader('IDAT'), 'photo.png', 'image/png')],
    ['still AVIF', () => createFile(avifHeader('avif'), 'photo.avif', 'image/avif')],
    ['JPEG', () => createFile([0xff, 0xd8, 0xff], 'photo.jpg', 'image/jpeg')],
  ])('does not classify %s as animated', async (_label, create) => {
    await expect(isAnimatedImageFile(create())).resolves.toBe(false);
  });
});

afterEach(() => vi.unstubAllGlobals());

import { describe, expect, it } from 'vitest';
import { isAnimatedImageFile } from './animatedImage';

const ascii = (value: string) => Array.from(value, (character) => character.charCodeAt(0));

function createFile(bytes: number[], name: string, type = '') {
  return new File([new Uint8Array(bytes)], name, { type });
}

function webpHeader(animationFlag: number) {
  return [...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8X'), 10, 0, 0, 0, animationFlag];
}

function pngHeader(...chunkTypes: string[]) {
  return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunkTypes.flatMap(ascii)];
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
    [createFile([], 'loop.gif', 'image/gif'), 'GIFs'],
    [createFile(webpHeader(0x02), 'loop.webp', 'image/webp'), 'animated WebP'],
    [createFile(pngHeader('acTL', 'IDAT'), 'loop.png', 'image/png'), 'APNG'],
    [createFile(avifHeader('avif', 'avis'), 'loop.avif', 'image/avif'), 'animated AVIF'],
  ])('recognizes %s', async (file) => {
    await expect(isAnimatedImageFile(file)).resolves.toBe(true);
  });

  it.each([
    [createFile(webpHeader(0), 'photo.webp', 'image/webp'), 'still WebP'],
    [createFile(pngHeader('IDAT'), 'photo.png', 'image/png'), 'PNG'],
    [createFile(avifHeader('avif'), 'photo.avif', 'image/avif'), 'still AVIF'],
    [createFile([0xff, 0xd8, 0xff], 'photo.jpg', 'image/jpeg'), 'JPEG'],
  ])('does not classify %s as animated', async (file) => {
    await expect(isAnimatedImageFile(file)).resolves.toBe(false);
  });
});

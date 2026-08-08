import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DisplayableImage } from './DisplayableImage';

const { convertHeicSourceToWebpBlob } = vi.hoisted(() => ({
  convertHeicSourceToWebpBlob: vi.fn<() => Promise<Blob>>(),
}));

vi.mock('@/utils/compression', () => ({ convertHeicSourceToWebpBlob }));

describe('DisplayableImage', () => {
  let root: Root;
  let host: HTMLDivElement;
  const createObjectUrl = vi.fn(() => 'blob:converted-webp');
  const revokeObjectUrl = vi.fn();

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('URL', { ...URL, createObjectURL: createObjectUrl, revokeObjectURL: revokeObjectUrl });
    convertHeicSourceToWebpBlob.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('uses native HEIC rendering when the image loads successfully', async () => {
    await act(async () => {
      root.render(<DisplayableImage src="https://cdn.test/photo.heic" mimeType="image/heic" />);
    });

    expect(host.querySelector('img')?.src).toBe('https://cdn.test/photo.heic');
    expect(convertHeicSourceToWebpBlob).not.toHaveBeenCalled();
  });

  it('falls back to a WebP object URL after native HEIC rendering fails', async () => {
    convertHeicSourceToWebpBlob.mockResolvedValue(new Blob(['webp'], { type: 'image/webp' }));
    await act(async () => {
      root.render(<DisplayableImage src="https://cdn.test/photo.heic" mimeType="image/heic" />);
    });

    await act(async () => {
      host.querySelector('img')?.dispatchEvent(new Event('error'));
      await Promise.resolve();
    });

    expect(convertHeicSourceToWebpBlob).toHaveBeenCalledWith('https://cdn.test/photo.heic');
    expect(host.querySelector('img')?.src).toBe('blob:converted-webp');

    act(() => root.unmount());
    root = createRoot(host);
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:converted-webp');
  });
});

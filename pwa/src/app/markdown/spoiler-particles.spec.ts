import { vi } from 'vitest';
import { SpoilerParticles } from './spoiler-particles';

describe('SpoilerParticles', () => {
  let visible: (entries: { isIntersecting: boolean }[]) => void;
  let resized: () => void;
  let frames: Map<number, FrameRequestCallback>;
  let effect: SpoilerParticles;
  let host: HTMLElement;
  let element: HTMLElement;
  let canvas: HTMLCanvasElement;
  const disconnect = vi.fn();
  const ctx = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
  };

  beforeEach(() => {
    frames = new Map();
    let id = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (key: number) => frames.delete(key));
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: typeof visible) {
          visible = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: typeof resized) {
          resized = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.stubGlobal('devicePixelRatio', 2);
    host = document.createElement('div');
    element = document.createElement('span');
    canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 0, parseFloat(canvas.style.width), parseFloat(canvas.style.height)),
    );
    element.style.lineHeight = '24px';
    const content = document.createElement('span');
    vi.spyOn(content, 'getClientRects').mockReturnValue([new DOMRect(30, 10, 80, 18)] as unknown as DOMRectList);
    element.append(content, canvas);
    host.append(element);
    document.body.append(host);
    vi.spyOn(element, 'getClientRects').mockReturnValue([
      new DOMRect(30, 10, 80, 18),
      new DOMRect(10, 34, 100, 18),
    ] as unknown as DOMRectList);
    effect = new SpoilerParticles(element, canvas, host);
  });

  afterEach(() => {
    effect.destroy();
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function tick(time: number) {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(time));
  }

  it('uses a union clip across lines and bridges only their overlapping horizontal region', () => {
    visible([{ isIntersecting: true }]);
    tick(100);
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(84);
    expect(ctx.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
    expect(ctx.rect).toHaveBeenCalledWith(20, 17.5, 80, 7);
    expect(ctx.clip).toHaveBeenCalledTimes(1);
    expect(ctx.arc).toHaveBeenCalled();
  });

  it('pauses off-screen, resumes after resizing, and releases pending work on destroy', () => {
    visible([{ isIntersecting: true }]);
    tick(100);
    expect(frames.size).toBe(1);
    visible([{ isIntersecting: false }]);
    expect(frames.size).toBe(0);
    resized();
    expect(frames.size).toBe(0);
    visible([{ isIntersecting: true }]);
    expect(frames.size).toBe(1);
    effect.destroy();
    expect(frames.size).toBe(0);
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it('stops while the document is hidden and resumes when visible', () => {
    visible([{ isIntersecting: true }]);
    tick(100);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(frames.size).toBe(0);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(frames.size).toBe(1);
  });

  it('reveals immediately without measuring again, stops drawing, and can be hidden again', () => {
    visible([{ isIntersecting: true }]);
    tick(100);
    const measured = vi.mocked(element.getClientRects).mock.calls.length;
    effect.reveal();
    expect(element.classList.contains('revealed')).toBe(true);
    expect(frames.size).toBe(0);
    expect(element.getClientRects).toHaveBeenCalledTimes(measured);
    effect.hide();
    expect(element.classList.contains('revealed')).toBe(false);
    expect(frames.size).toBe(1);
    tick(200);
    expect(element.getClientRects).toHaveBeenCalledTimes(measured);
    expect(ctx.clip).toHaveBeenCalledTimes(1);
  });

  it('reuses the clipping region while drawing successive frames', () => {
    visible([{ isIntersecting: true }]);
    tick(100);
    tick(150);
    tick(200);
    expect(ctx.clearRect).toHaveBeenCalledTimes(3);
    expect(ctx.clip).toHaveBeenCalledTimes(1);
    expect(ctx.setTransform).toHaveBeenCalledTimes(1);
    resized();
    tick(250);
    expect(ctx.clip).toHaveBeenCalledTimes(2);
  });
});

import { vi } from 'vitest';
import { encodeId } from '../api/snowflake-id';
import { ReactionVisibility } from './reaction-visibility';

describe('ReactionVisibility', () => {
  let root: HTMLElement;
  let region: HTMLElement;
  let visibility: ReactionVisibility;
  let notify: (target: Element, ratio: number) => void;
  const seen = vi.fn();
  const id = encodeId('101');

  beforeEach(() => {
    vi.useFakeTimers();
    seen.mockClear();
    root = document.createElement('div');
    region = document.createElement('div');
    root.append(region);
    document.body.append(root);
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 200));
    vi.spyOn(region, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 60, 180, 30));
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
          expect(options).toEqual({ root, threshold: 0 });
          notify = (target, ratio) =>
            callback(
              [{ target, isIntersecting: ratio > 0, intersectionRatio: ratio } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver,
            );
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    visibility = new ReactionVisibility(root, seen);
    visibility.watch(new Map([[region, id]]));
  });

  afterEach(() => {
    visibility.disconnect();
    root.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('requires 500ms of visibility and does not restart on unrelated renders', () => {
    notify(region, 1);
    vi.advanceTimersByTime(300);
    visibility.watch(new Map([[region, id]]));
    notify(region, 1);
    vi.advanceTimersByTime(199);
    expect(seen).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(seen).toHaveBeenCalledExactlyOnceWith(id);
    notify(region, 1);
    vi.advanceTimersByTime(500);
    expect(seen).toHaveBeenCalledOnce();
  });

  it.each([
    { name: 'partially visible', top: 190, height: 30 },
    { name: 'taller than the viewport', top: -100, height: 600 },
  ])('counts a reaction region that is $name', ({ top, height }) => {
    vi.mocked(region.getBoundingClientRect).mockReturnValue(new DOMRect(20, top, 180, height));
    notify(region, 0.5);
    vi.advanceTimersByTime(499);
    expect(seen).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(seen).toHaveBeenCalledExactlyOnceWith(id);
  });

  it('does not accumulate time across quick scrolls', () => {
    notify(region, 0.5);
    vi.advanceTimersByTime(300);
    notify(region, 0);
    notify(region, 0.5);
    vi.advanceTimersByTime(300);
    expect(seen).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(seen).toHaveBeenCalledExactlyOnceWith(id);
  });

  it('requires a fresh dwell after suspending and resuming the page', () => {
    notify(region, 1);
    vi.advanceTimersByTime(400);
    visibility.watch(new Map());
    notify(region, 1);
    vi.advanceTimersByTime(1000);
    expect(seen).not.toHaveBeenCalled();
    visibility.watch(new Map([[region, id]]));
    notify(region, 1);
    vi.advanceTimersByTime(499);
    expect(seen).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(seen).toHaveBeenCalledExactlyOnceWith(id);
  });

  it('starts over for a new reaction on the same message', () => {
    notify(region, 1);
    vi.advanceTimersByTime(400);
    visibility.forget(id);
    visibility.watch(new Map([[region, id]]));
    notify(region, 1);
    vi.advanceTimersByTime(100);
    expect(seen).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(seen).toHaveBeenCalledExactlyOnceWith(id);
  });

  it.each([
    { edge: 'top', left: 20, top: -30 },
    { edge: 'bottom', left: 20, top: 200 },
    { edge: 'left', left: -180, top: 60 },
    { edge: 'right', left: 300, top: 60 },
  ])('rechecks the $edge edge when scrolling precedes the next observer callback', ({ left, top }) => {
    notify(region, 1);
    vi.mocked(region.getBoundingClientRect).mockReturnValue(new DOMRect(left, top, 180, 30));
    vi.advanceTimersByTime(500);
    expect(seen).not.toHaveBeenCalled();
  });

  it('cancels a replaced region and timers on destruction', () => {
    notify(region, 1);
    const replacement = document.createElement('div');
    root.append(replacement);
    visibility.watch(new Map([[replacement, id]]));
    vi.advanceTimersByTime(500);
    expect(seen).not.toHaveBeenCalled();
    vi.spyOn(replacement, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 60, 180, 30));
    notify(replacement, 1);
    visibility.disconnect();
    vi.advanceTimersByTime(500);
    expect(seen).not.toHaveBeenCalled();
  });
});

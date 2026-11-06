import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { MediaLoaded } from './media-loaded';
import { VideoPreview } from './video-preview';

@Component({
  imports: [MediaLoaded, VideoPreview],
  template: `<video appMediaLoaded [appVideoPreview]="!sticker" [autoplay]="sticker" preload="metadata"></video>`,
})
class PreviewHost {
  sticker = false;
}

describe('VideoPreview', () => {
  let intersect: (visible: boolean) => void;
  const observe = vi.fn();
  const disconnect = vi.fn();

  beforeEach(() => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersect = (visible) =>
            callback(
              [{ isIntersecting: visible } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver,
            );
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  function render(sticker = false) {
    const fixture = TestBed.createComponent(PreviewHost);
    fixture.componentInstance.sticker = sticker;
    fixture.detectChanges();
    const video: HTMLVideoElement = fixture.nativeElement.querySelector('video');
    const readyState = vi.spyOn(video, 'readyState', 'get').mockReturnValue(HTMLMediaElement.HAVE_NOTHING);
    vi.spyOn(video, 'duration', 'get').mockReturnValue(10);
    const play = vi.spyOn(video, 'play');
    return { fixture, video, readyState, play };
  }

  it.each([true, false])(
    'requests a frame only after visibility and metadata (metadata first: %s)',
    (metadataFirst) => {
      const { fixture, video, readyState, play } = render();
      if (!metadataFirst) {
        intersect(true);
        expect(video.preload).toBe('auto');
      }
      readyState.mockReturnValue(HTMLMediaElement.HAVE_METADATA);
      video.dispatchEvent(new Event('loadedmetadata'));
      fixture.detectChanges();
      expect(video.classList.contains('loaded')).toBe(false);
      if (metadataFirst) {
        expect(video.preload).toBe('metadata');
        expect(video.currentTime).toBe(0);
        intersect(true);
      }
      expect(video.currentTime).toBe(0.1);
      expect(play).not.toHaveBeenCalled();

      readyState.mockReturnValue(HTMLMediaElement.HAVE_CURRENT_DATA);
      video.dispatchEvent(new Event('seeked'));
      fixture.detectChanges();
      expect(video.classList.contains('loaded')).toBe(true);
      expect(video.preload).toBe('metadata');
      const seek = vi.spyOn(video, 'currentTime', 'set');
      intersect(false);
      intersect(true);
      expect(seek).not.toHaveBeenCalled();
      expect(video.preload).toBe('metadata');
      fixture.destroy();
      expect(disconnect).toHaveBeenCalled();
    },
  );

  it('seeks inside a very short clip', () => {
    const { video, readyState } = render();
    readyState.mockReturnValue(HTMLMediaElement.HAVE_METADATA);
    vi.spyOn(video, 'duration', 'get').mockReturnValue(0.04);
    intersect(true);
    expect(video.currentTime).toBe(0.02);
  });

  it('prepares a replacement source in the same element', () => {
    const { fixture, video, readyState } = render();
    readyState.mockReturnValue(HTMLMediaElement.HAVE_METADATA);
    intersect(true);
    readyState.mockReturnValue(HTMLMediaElement.HAVE_CURRENT_DATA);
    video.dispatchEvent(new Event('loadeddata'));
    video.dispatchEvent(new Event('seeked'));
    fixture.detectChanges();
    expect(video.classList.contains('loaded')).toBe(true);

    video.dispatchEvent(new Event('emptied'));
    readyState.mockReturnValue(HTMLMediaElement.HAVE_METADATA);
    video.currentTime = 0;
    video.dispatchEvent(new Event('loadedmetadata'));
    fixture.detectChanges();
    expect(video.classList.contains('loaded')).toBe(false);
    expect(video.currentTime).toBe(0.1);
  });

  it('reduces preloading offscreen and on failure without starting playback', () => {
    const { video, play } = render();
    intersect(true);
    expect(video.preload).toBe('auto');
    intersect(false);
    expect(video.preload).toBe('metadata');
    intersect(true);
    video.dispatchEvent(new Event('error'));
    expect(video.preload).toBe('metadata');
    expect(play).not.toHaveBeenCalled();
  });

  it('leaves autoplay stickers alone and waits for their frame', () => {
    const { fixture, video } = render(true);
    expect(observe).not.toHaveBeenCalled();
    video.dispatchEvent(new Event('loadedmetadata'));
    fixture.detectChanges();
    expect(video.classList.contains('loaded')).toBe(false);
    expect(video.currentTime).toBe(0);
    expect(video.autoplay).toBe(true);
    video.dispatchEvent(new Event('loadeddata'));
    fixture.detectChanges();
    expect(video.classList.contains('loaded')).toBe(true);
  });
});

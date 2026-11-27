import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { MediaLoaded } from './media-loaded';
import { VideoPreview } from './video-preview';

@Component({
  imports: [MediaLoaded, VideoPreview],
  template: `<video appMediaLoaded appVideoPreview preload="metadata"></video>`,
})
class PreviewHost {}

describe('VideoPreview', () => {
  let intersect: (visible: boolean) => void;
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
        observe() {}
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

  function render() {
    const fixture = TestBed.createComponent(PreviewHost);
    fixture.detectChanges();
    const video: HTMLVideoElement = fixture.nativeElement.querySelector('video');
    const readyState = vi.spyOn(video, 'readyState', 'get').mockReturnValue(HTMLMediaElement.HAVE_NOTHING);
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
      expect(video.currentTime).toBe(0.000001);
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
    expect(video.currentTime).toBe(0.000001);
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
});

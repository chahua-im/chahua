import { afterNextRender, DestroyRef, Directive, ElementRef, inject } from '@angular/core';

/** Fetch a still frame for visible, non-playing videos without starting playback. */
@Directive({
  selector: 'video[appVideoPreview]',
  host: {
    '(loadedmetadata)': 'preview()',
    '(emptied)': 'reset()',
    '(seeked)': 'settle()',
    '(error)': 'settle()',
  },
})
export class VideoPreview {
  private readonly video = inject<ElementRef<HTMLVideoElement>>(ElementRef).nativeElement;
  private visible = false;
  private requested = false;

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const observer = new IntersectionObserver(([entry]) => {
        this.visible = entry.isIntersecting;
        if (this.visible) this.preview();
        else this.settle();
      });
      observer.observe(this.video);
      destroyRef.onDestroy(() => {
        observer.disconnect();
        this.settle();
      });
    });
  }

  protected preview() {
    if (!this.visible || this.requested) return;
    this.video.preload = 'auto';
    if (this.video.readyState < HTMLMediaElement.HAVE_METADATA) return;
    this.requested = true;
    // Seeking clears the initial poster state and asks the browser to decode a frame.
    // One microsecond requests the first frame, including on browsers that skip a seek to zero.
    this.video.currentTime = 0.000001;
  }

  protected reset() {
    this.requested = false;
  }

  protected settle() {
    this.video.preload = 'metadata';
  }
}

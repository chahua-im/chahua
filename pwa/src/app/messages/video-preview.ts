import { afterNextRender, DestroyRef, Directive, ElementRef, inject, input } from '@angular/core';

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
  readonly appVideoPreview = input(true);
  private readonly video = inject<ElementRef<HTMLVideoElement>>(ElementRef).nativeElement;
  private visible = false;
  private requested = false;

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      if (!this.appVideoPreview()) return;
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
    // Keep the target inside even a clip shorter than 0.1 seconds.
    this.video.currentTime = this.video.duration > 0 ? Math.min(0.1, this.video.duration / 2) : 0.1;
  }

  protected reset() {
    this.requested = false;
  }

  protected settle() {
    if (this.appVideoPreview()) this.video.preload = 'metadata';
  }
}

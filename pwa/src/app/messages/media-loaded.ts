import { Directive, ElementRef, inject, signal } from '@angular/core';

/**
 * Marks an image or video once its data is available, so the placeholder behind it can go away.
 * Videos settle on metadata because `preload="metadata"` never decodes a first frame on its own.
 * Failures settle too; the surrounding component already renders its own failure state.
 */
@Directive({
  selector: 'img[appMediaLoaded], video[appMediaLoaded]',
  host: {
    '[class.loaded]': 'settled()',
    '(load)': 'settled.set(true)',
    '(loadedmetadata)': 'settled.set(true)',
    '(loadeddata)': 'settled.set(true)',
    '(error)': 'settled.set(true)',
  },
})
export class MediaLoaded {
  private readonly element = inject<ElementRef<HTMLImageElement | HTMLVideoElement>>(ElementRef).nativeElement;
  /** Cached media is ready as soon as it mounts, which avoids a placeholder flash when scrolling back. */
  protected readonly settled = signal(
    this.element instanceof HTMLImageElement
      ? this.element.complete && this.element.naturalWidth > 0
      : this.element.readyState >= 1,
  );
}

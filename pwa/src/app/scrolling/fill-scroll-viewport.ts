import { afterRenderEffect, DestroyRef, ElementRef, inject, type Signal } from '@angular/core';

/** Ionic emits ionInfinite on scroll; a short first page needs filling before scrolling is possible. */
export function fillScrollViewport(
  loading: Signal<boolean>,
  error: Signal<boolean>,
  cursor: Signal<unknown>,
  more: () => Promise<void>,
) {
  const host = inject<ElementRef<HTMLElement>>(ElementRef);
  const destroy = inject(DestroyRef);
  afterRenderEffect((onCleanup) => {
    if (loading() || error() || cursor() == null) return;
    const content = host.nativeElement.closest('ion-content') ?? host.nativeElement.querySelector('ion-content');
    if (!content) return;
    let current = true;
    onCleanup(() => {
      current = false;
    });
    void content.getScrollElement().then((scroll) => {
      // Ionic's iOS overscroll pseudo-element adds 1px even when the content fits.
      if (current && !destroy.destroyed && scroll.clientHeight > 0 && scroll.scrollHeight <= scroll.clientHeight + 1)
        void more();
    });
  });
}

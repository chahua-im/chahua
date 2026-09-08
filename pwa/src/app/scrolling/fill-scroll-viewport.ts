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
    const content = host.nativeElement.closest('ion-content');
    if (!content) return;
    let current = true;
    onCleanup(() => {
      current = false;
    });
    void content.getScrollElement().then((scroll) => {
      if (current && !destroy.destroyed && scroll.clientHeight > 0 && scroll.scrollHeight <= scroll.clientHeight)
        void more();
    });
  });
}

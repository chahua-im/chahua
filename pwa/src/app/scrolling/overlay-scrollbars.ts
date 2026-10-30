import { OverlayScrollbars } from 'overlayscrollbars';

/** Use the existing viewport so scrolling APIs and Angular-owned children stay in place. */
export function attachScrollbars(viewport: HTMLElement, slot = viewport) {
  return OverlayScrollbars(
    {
      target: viewport,
      elements: { viewport },
      scrollbars: { slot },
      cancel: { nativeScrollbarsOverlaid: true },
    },
    { scrollbars: { autoHide: 'leave' } },
  );
}

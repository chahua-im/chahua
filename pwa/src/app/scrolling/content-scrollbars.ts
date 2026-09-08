import { afterNextRender, DestroyRef, Directive, ElementRef, inject } from '@angular/core';
import { IonContent } from '@ionic/angular';
import { OverlayScrollbars } from 'overlayscrollbars';

@Directive({ selector: 'ion-content[appScrollbars]' })
export class ContentScrollbars {
  private readonly content = inject(IonContent);
  private readonly host = inject<ElementRef<HTMLIonContentElement>>(ElementRef).nativeElement;
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    afterNextRender(() => void this.initialize());
  }

  private async initialize() {
    const viewport = await this.content.getScrollElement();
    if (this.destroyRef.destroyed) return;

    // Keep Ionic's scroll element in its shadow root; only the bars use the fixed slot.
    const instance = OverlayScrollbars(
      {
        target: viewport,
        elements: { viewport },
        scrollbars: { slot: this.host },
        cancel: { nativeScrollbarsOverlaid: true },
      },
      { scrollbars: { autoHide: 'leave' } },
    );
    if (!OverlayScrollbars.valid(instance)) return;

    this.host.classList.add('custom-scrollbars');
    const { scrollbarHorizontal, scrollbarVertical } = instance.elements();
    scrollbarHorizontal.scrollbar.slot = 'fixed';
    scrollbarVertical.scrollbar.slot = 'fixed';

    let frame = 0;
    const update = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        instance.update(true);
      });
    };
    // The library cannot observe slotted content through Ionic's shadow root.
    // Observe the content blocks, so message/image height changes update the bars.
    const sizes = new ResizeObserver(update);
    const observeContent = () => {
      sizes.disconnect();
      for (const child of this.host.children) {
        if (child.getAttribute('slot') !== 'fixed') sizes.observe(child);
      }
      update();
    };
    const children = new MutationObserver(observeContent);
    children.observe(this.host, { childList: true });
    observeContent();

    this.destroyRef.onDestroy(() => {
      children.disconnect();
      sizes.disconnect();
      cancelAnimationFrame(frame);
      instance.destroy();
      this.host.classList.remove('custom-scrollbars');
    });
  }
}

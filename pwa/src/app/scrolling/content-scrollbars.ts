import { afterRenderEffect, booleanAttribute, Directive, ElementRef, inject, input } from '@angular/core';
import { IonContent, IonTextarea } from '@ionic/angular';
import { OverlayScrollbars } from 'overlayscrollbars';
import { attachScrollbars } from './overlay-scrollbars';

@Directive({ selector: '[appScrollbars]' })
export class ContentScrollbars {
  readonly enabled = input(true, { alias: 'appScrollbars', transform: booleanAttribute });
  private readonly content = inject(IonContent, { optional: true, self: true });
  private readonly textarea = inject(IonTextarea, { optional: true, self: true });
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  constructor() {
    afterRenderEffect((onCleanup) => {
      if (!this.enabled()) return;
      let disposed = false;
      let cleanup: (() => void) | undefined;
      onCleanup(() => {
        disposed = true;
        cleanup?.();
      });
      void (async () => {
        const viewport = this.content
          ? await this.content.getScrollElement()
          : this.textarea
            ? await this.textarea.getInputElement()
            : this.host;
        if (!disposed) cleanup = this.initialize(viewport);
      })();
    });
  }

  private initialize(viewport: HTMLElement) {
    // Ionic hides unslotted children of ion-textarea on render. Its positioned input wrapper
    // keeps the bars beside the native textarea and aligned with the editable area.
    const slot = this.textarea ? viewport.parentElement! : this.host;
    const instance = attachScrollbars(viewport, slot);
    if (!OverlayScrollbars.valid(instance)) return;

    this.host.classList.add('custom-scrollbars');
    const { scrollbarHorizontal, scrollbarVertical } = instance.elements();
    if (this.content) {
      // Keep Ionic's scroll element in its shadow root; only the bars use the fixed slot.
      scrollbarHorizontal.scrollbar.slot = 'fixed';
      scrollbarVertical.scrollbar.slot = 'fixed';
    }
    if (!this.content) {
      const update = () => instance.update(true);
      viewport.addEventListener('input', update);
      return () => {
        viewport.removeEventListener('input', update);
        instance.destroy();
        this.host.classList.remove('custom-scrollbars');
      };
    }

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

    return () => {
      children.disconnect();
      sizes.disconnect();
      cancelAnimationFrame(frame);
      instance.destroy();
      this.host.classList.remove('custom-scrollbars');
    };
  }
}

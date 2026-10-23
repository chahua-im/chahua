import { afterNextRender, DestroyRef, Directive, inject, signal } from '@angular/core';
import { isPlatform } from '@ionic/angular';

/** Keep the conversation header visible when the browser pans to the composer. */
@Directive({
  selector: 'ion-header[appConversationViewportHeader]',
  host: { '[style.translate]': "offset() ? '0 ' + offset() + 'px' : null" },
})
export class ConversationViewportHeader {
  protected readonly offset = signal(0);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    afterNextRender(() => {
      const viewport = window.visualViewport;
      if (!viewport || (!isPlatform('ios') && !isPlatform('android'))) return;

      // Ionic's fixed page stays in the layout viewport. Move only its header;
      // the browser still owns keyboard avoidance and native message scrolling.
      const update = () => this.offset.set(viewport.scale === 1 ? Math.max(0, viewport.offsetTop) : 0);
      update();
      viewport.addEventListener('resize', update);
      viewport.addEventListener('scroll', update);
      this.destroyRef.onDestroy(() => {
        viewport.removeEventListener('resize', update);
        viewport.removeEventListener('scroll', update);
      });
    });
  }
}

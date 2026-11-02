import { afterRenderEffect, Component, ElementRef, input, output, signal, viewChild } from '@angular/core';
import { createAnimation, IonIcon, IonSpinner, isPlatform } from '@ionic/angular';
import { TranslocoPipe } from '@jsverse/transloco';
import { chevronBackOutline } from 'ionicons/icons';
import { EmojiPicker } from '../emoji-picker/emoji-picker';

export interface EmojiPanelAnchor {
  x: number;
  y: number;
}

export function emojiPanelAnchor(event: MouseEvent): EmojiPanelAnchor {
  const button = (event.currentTarget as HTMLElement).getBoundingClientRect();
  return event.detail
    ? { x: event.clientX, y: event.clientY }
    : { x: button.x + button.width / 2, y: button.y + button.height / 2 };
}

export function emojiPanelAnimation(element: HTMLElement, entering: boolean) {
  const from = entering ? '0' : '1';
  const to = entering ? '1' : '0';
  return createAnimation()
    .duration(100)
    .easing('cubic-bezier(0.16, 1, 0.3, 1)')
    .addAnimation([
      createAnimation().addElement(element.shadowRoot!.querySelector('ion-backdrop')!).fromTo('opacity', from, to),
      createAnimation()
        .addElement(element.shadowRoot!.querySelector('.modal-wrapper')!)
        .beforeStyles({ transform: 'none' })
        .fromTo('opacity', from, to),
    ]);
}

@Component({
  selector: 'app-emoji-panel',
  templateUrl: './emoji-panel.html',
  styleUrl: './emoji-panel.scss',
  imports: [EmojiPicker, IonIcon, IonSpinner, TranslocoPipe],
  host: { '(click)': 'dismissBackdrop($event)' },
})
export class EmojiPanel {
  readonly title = input.required<string>();
  readonly anchor = input<EmojiPanelAnchor>();
  readonly active = input(true);
  readonly chosen = output<string>();
  readonly back = output<void>();
  readonly dismissed = output<void>();
  protected readonly backIcon = chevronBackOutline;
  protected readonly contentReady = signal(false);
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');

  constructor() {
    afterRenderEffect((onCleanup) => {
      if (!this.active() || this.contentReady()) return;
      // Give the shell a paint opportunity before constructing the grid, including
      // when the deferred module is already cached and resolves synchronously.
      let frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => this.contentReady.set(true));
      });
      onCleanup(() => cancelAnimationFrame(frame));
    });
    afterRenderEffect((onCleanup) => {
      const panel = this.panel()?.nativeElement;
      const anchor = this.anchor();
      if (!this.active() || !panel || !anchor || isPlatform('ios') || isPlatform('android')) return;
      const surface = panel.parentElement!;
      const place = () => {
        const bounds = surface.getBoundingClientRect();
        const style = getComputedStyle(surface);
        const left = parseFloat(style.paddingLeft) + 12;
        const top = parseFloat(style.paddingTop) + 12;
        const right = bounds.width - parseFloat(style.paddingRight) - 12;
        const bottom = bounds.height - parseFloat(style.paddingBottom) - 12;
        panel.style.left = `${Math.max(left, Math.min(anchor.x - bounds.left, right - panel.offsetWidth))}px`;
        panel.style.top = `${Math.max(top, Math.min(anchor.y - bounds.top + 8, bottom - panel.offsetHeight))}px`;
        panel.style.transform = 'none';
      };
      const observer = new ResizeObserver(place);
      observer.observe(surface);
      observer.observe(panel);
      place();
      onCleanup(() => observer.disconnect());
    });
  }

  protected dismissBackdrop(event: MouseEvent) {
    if (event.target === event.currentTarget) this.dismissed.emit();
  }
}

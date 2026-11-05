import { DestroyRef, Directive, ElementRef, inject, input, output } from '@angular/core';

@Directive({
  selector: '[avatarMention]',
  host: {
    '(contextmenu)': 'contextMenu($event)',
    '[style.-webkit-touch-callout]': "avatarMention() ? 'none' : null",
    '[style.user-select]': "avatarMention() ? 'none' : null",
    '(pointerdown)': 'start($event)',
    '(pointermove)': 'move($event)',
    '(pointerup)': 'cancel()',
    '(pointercancel)': 'cancel()',
    '(pointerleave)': 'cancel()',
    '(dragstart)': 'cancel()',
  },
})
export class AvatarMention {
  readonly avatarMention = input(false);
  readonly mentionRequested = output<void>();
  private press?: { x: number; y: number; timer: ReturnType<typeof setTimeout> };
  private handled = false;

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const suppressClick = (event: MouseEvent) => {
      if (!this.handled) return;
      this.handled = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    host.addEventListener('click', suppressClick, true);
    inject(DestroyRef).onDestroy(() => {
      this.cancel();
      host.removeEventListener('click', suppressClick, true);
    });
  }

  protected contextMenu(event: Event) {
    if (!this.avatarMention()) return;
    event.preventDefault();
    event.stopPropagation();
    this.cancel();
    if (!this.handled) this.mentionRequested.emit();
    this.handled = true;
  }

  protected start(event: PointerEvent) {
    this.cancel();
    this.handled = false;
    if (!this.avatarMention() || !event.isPrimary || event.button !== 0) return;
    // Keep the timeline's swipe-to-reply gesture off the avatar.
    event.stopPropagation();
    if (event.pointerType !== 'touch') return;
    this.press = {
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(() => {
        this.press = undefined;
        if (!this.avatarMention()) return;
        this.handled = true;
        this.mentionRequested.emit();
      }, 350),
    };
  }

  protected move(event: PointerEvent) {
    if (this.press && (Math.abs(event.clientX - this.press.x) > 10 || Math.abs(event.clientY - this.press.y) > 10))
      this.cancel();
  }

  protected cancel() {
    clearTimeout(this.press?.timer);
    this.press = undefined;
  }
}

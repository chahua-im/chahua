import { DOCUMENT } from '@angular/common';
import { DestroyRef, ElementRef, ErrorHandler, inject, Service } from '@angular/core';

export enum EscapePriority {
  Navigation,
  Conversation,
  Search,
  Sidebar,
  Suggestion,
}

type EscapeHandler = () => boolean | Promise<boolean>;
type EscapeEntry = { element: HTMLElement; priority: EscapePriority; handle: EscapeHandler; pending: boolean };
type Overlay = HTMLIonModalElement | HTMLIonPopoverElement | HTMLIonAlertElement | HTMLIonActionSheetElement;
const overlays = 'ion-modal, ion-popover, ion-alert, ion-action-sheet, ion-loading';

/** One key press is owned by the topmost surface, independent of input focus. */
@Service()
export class EscapeNavigation {
  private readonly document = inject(DOCUMENT);
  private readonly errors = inject(ErrorHandler);
  private readonly entries = new Set<EscapeEntry>();

  constructor() {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopImmediatePropagation();
      // Keep the browser's IME/fullscreen handling, but never let it also leave the app's current layer.
      if (event.isComposing || event.keyCode === 229 || this.document.fullscreenElement) return;
      event.preventDefault();
      if (!event.repeat) void this.handle().catch((error) => this.errors.handleError(error));
    };
    this.document.addEventListener('keydown', keydown, true);
    inject(DestroyRef).onDestroy(() => this.document.removeEventListener('keydown', keydown, true));
  }

  register(element: HTMLElement, handle: EscapeHandler, priority: EscapePriority) {
    const entry = { element, handle, priority, pending: false };
    this.entries.add(entry);
    return () => this.entries.delete(entry);
  }

  private async handle() {
    const overlay = Array.from(this.document.querySelectorAll<Overlay>(overlays))
      .filter((element) => element.overlayIndex > 0 && !element.classList.contains('overlay-hidden'))
      .at(-1);
    const popover = Array.from(this.document.querySelectorAll<HTMLElement>('[popover="auto"]:popover-open'))
      .filter((element) => !overlay || overlay.matches('ion-modal.panel-sidebar') || overlay.contains(element))
      .at(-1);
    if (popover) {
      popover.hidePopover();
      return;
    }
    const entries = [...this.entries]
      .filter(
        ({ element }) =>
          element.isConnected &&
          !element.closest('[hidden], .ion-page-hidden, .ion-hide, .overlay-hidden') &&
          (overlay ? overlay.contains(element) : !element.closest(overlays)),
      )
      .sort((a, b) => b.priority - a.priority);
    for (const entry of entries) {
      if (entry.pending) return;
      entry.pending = true;
      try {
        if (await entry.handle()) return;
      } finally {
        entry.pending = false;
      }
    }
    if (overlay?.backdropDismiss) {
      await overlay.dismiss(undefined, overlay.tagName === 'ION-MODAL' ? 'escape' : 'backdrop');
    }
  }
}

export function registerEscape(handle: EscapeHandler, priority = EscapePriority.Conversation) {
  const remove = inject(EscapeNavigation).register(
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement,
    handle,
    priority,
  );
  inject(DestroyRef).onDestroy(remove);
}

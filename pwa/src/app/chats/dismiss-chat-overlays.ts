import type { ModalController } from '@ionic/angular';

/** A navigation from a nested profile or invitation returns to the conversation itself. */
export async function dismissChatOverlays(modals: ModalController) {
  let top = await modals.getTop();
  while (top && !top.classList?.contains('route-panel')) {
    if (!(await modals.dismiss(undefined, 'navigate'))) break;
    top = await modals.getTop();
  }
}

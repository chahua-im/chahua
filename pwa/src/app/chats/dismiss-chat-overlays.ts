import type { ModalController } from '@ionic/angular';

/** A navigation from a nested profile or invitation returns to the conversation itself. */
export async function dismissChatOverlays(modals: ModalController) {
  while (await modals.getTop()) await modals.dismiss(undefined, 'navigate');
}

import { HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { RedirectCommand, Router, type CanActivateFn } from '@angular/router';
import { ToastController } from '@ionic/angular';
import { TranslocoService } from '@jsverse/transloco';
import { catchError, defer, map } from 'rxjs';
import { ChatsService } from '../../../generated/endpoints/chats/chats.service';
import { decodeId, encodeId } from '../../api/snowflake-id';

/** Resolve before leaving the current page so an unavailable message only needs a toast. */
export const openMessageLink: CanActivateFn = (route) => {
  const router = inject(Router);
  const chats = inject(ChatsService);
  const toasts = inject(ToastController);
  const i18n = inject(TranslocoService);
  const navigationId = router.currentNavigation()!.id;

  return defer(() => {
    const encoded = route.paramMap.get('encoded')!;
    const bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    if (bytes.length !== 16) throw new Error('Invalid message link');
    const view = new DataView(bytes.buffer);
    const chatId = encodeId(view.getBigUint64(0).toString());
    const messageId = encodeId(view.getBigUint64(8).toString());
    return chats
      .getMessage(chatId, messageId)
      .pipe(
        map(
          (message) =>
            new RedirectCommand(
              router.createUrlTree(
                [
                  '/chats/chat',
                  decodeId(chatId),
                  ...(message.replyRootId ? ['thread', decodeId(message.replyRootId)] : []),
                ],
                { fragment: `msg=${decodeId(messageId)}` },
              ),
            ),
        ),
      );
  }).pipe(
    catchError(async (error: unknown) => {
      const toast = await toasts.create({
        message: i18n.translate(
          error instanceof HttpErrorResponse && error.status === 404
            ? 'chats.link.messageUnavailable'
            : 'chats.link.failed',
        ),
        duration: 3000,
      });
      // Toast creation can finish after another navigation has superseded this one.
      if (router.currentNavigation()?.id !== navigationId) {
        toast.remove();
        return false;
      }
      await toast.present();
      return router.navigated ? false : new RedirectCommand(router.createUrlTree(['/chats']), { replaceUrl: true });
    }),
  );
};

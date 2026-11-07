import { RpcError, RpcErrorCode } from '../../api/rpc-error';
import { inject } from '@angular/core';
import { RedirectCommand, Router, type CanActivateFn } from '@angular/router';
import { ToastController } from '@ionic/angular';
import { TranslocoService } from '@jsverse/transloco';
import { catchError, defer, filter, map, of, switchMap, take } from 'rxjs';
import { RpcApi } from '../../../generated/rpc-api';
import { decodeId, encodeId } from '../../api/snowflake-id';
import { SessionStore } from '../../session/session-store';

/** Resolve before leaving the current page so an unavailable message only needs a toast. */
export const openMessageLink: CanActivateFn = (route) => {
  const router = inject(Router);
  const chats = inject(RpcApi);
  const toasts = inject(ToastController);
  const i18n = inject(TranslocoService);
  const session = inject(SessionStore);
  const navigationId = router.currentNavigation()!.id;

  return defer(() => {
    const encoded = route.paramMap.get('encoded')!;
    const bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    if (bytes.length !== 16) throw new Error('Invalid message link');
    const view = new DataView(bytes.buffer);
    const chatId = encodeId(view.getBigUint64(0).toString());
    const messageId = encodeId(view.getBigUint64(8).toString());
    // The app owns login errors and retries; keep the link pending until login succeeds.
    // Check the live signal because user$ may still replay the previous account's value.
    return (
      session.user()
        ? of(session.user())
        : session.user$.pipe(
            filter(() => !!session.user()),
            take(1),
          )
    ).pipe(
      switchMap(() => chats.messages.get({ chatId, messageId })),
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
      let messageKey = 'chats.link.failed';
      if (error instanceof RpcError) {
        switch (error.code) {
          case RpcErrorCode.Forbidden:
            messageKey = 'chats.link.notMember';
            break;
          case RpcErrorCode.NotFound:
          case RpcErrorCode.Gone:
            messageKey = 'chats.link.messageUnavailable';
            break;
        }
      }
      const toast = await toasts.create({
        message: i18n.translate(messageKey),
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

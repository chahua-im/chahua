import { Location } from '@angular/common';
import type { ViewerMedia } from '../../messages/media-viewer/media-viewer';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { IonButton, IonContent, IonSpinner, ModalController, type ModalOptions } from '@ionic/angular';
import { firstValueFrom } from 'rxjs';
import { ChatsService } from '../../../generated/endpoints/chats/chats.service';
import { UsersService } from '../../../generated/endpoints/users/users.service';
import { decodeId, encodeId } from '../../api/snowflake-id';
import { StickerPicker } from '../../messages/sticker-picker/sticker-picker';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { StartChat, StartChatKind } from '../start-chat/start-chat';
import { ChatDetails } from '../chat-details/chat-details';
function decodePermalink(encoded: string) {
  const bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  if (bytes.length !== 16) throw new Error('无效消息链接');
  const view = new DataView(bytes.buffer);
  return { chatId: encodeId(view.getBigUint64(0).toString()), messageId: encodeId(view.getBigUint64(8).toString()) };
}
@Component({
  selector: 'app-chat-link',
  imports: [ContentScrollbars, IonContent, IonSpinner, IonButton],
  host: { class: 'ion-page' },
  template: `<ion-content appScrollbars>
    @if (failed()) {
      <p class="ion-padding">
        链接无法打开。<ion-button fill="clear" (click)="open()">重试</ion-button
        ><ion-button fill="clear" (click)="home()">返回消息</ion-button>
      </p>
    } @else {
      <div class="loading-status"><ion-spinner /></div>
    }
  </ion-content>`,
})
export class ChatLink {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly modals = inject(ModalController);
  private readonly users = inject(UsersService);
  private readonly location = inject(Location);
  private readonly chats = inject(ChatsService);
  private readonly hasPreviousPage = this.router.currentNavigation()?.previousNavigation != null;
  private modal?: HTMLIonModalElement;
  private version = 0;
  protected readonly failed = signal(false);
  constructor() {
    inject(DestroyRef).onDestroy(() => this.ionViewWillLeave());
  }
  ionViewDidEnter() {
    if (this.isCurrentRoute()) void this.open();
  }
  ionViewWillLeave() {
    this.version++;
    void this.modal?.dismiss(undefined, 'navigate');
    this.modal = undefined;
  }
  protected home() {
    return this.router.navigate(['/chats'], { replaceUrl: true });
  }
  private isCurrentRoute() {
    return this.router.url.split(/[?#]/)[0] === '/' + this.route.snapshot.url.join('/');
  }
  protected async open() {
    const version = ++this.version;
    this.failed.set(false);
    const route = this.route.snapshot;
    try {
      const encoded = route.paramMap.get('encoded');
      if (encoded) {
        const { chatId, messageId } = decodePermalink(encoded);
        const message = await firstValueFrom(this.chats.getMessage(chatId, messageId));
        if (version !== this.version || !this.isCurrentRoute()) return;
        await this.router.navigate(
          ['/chats/chat', decodeId(chatId), ...(message.replyRootId ? ['thread', decodeId(message.replyRootId)] : [])],
          { replaceUrl: true, fragment: `msg=${decodeId(messageId)}` },
        );
        return;
      }
      let options: ModalOptions;
      const uid = Number(route.paramMap.get('uid') ?? route.queryParamMap.get('uid'));
      if (uid) {
        const response = await firstValueFrom(this.users.getUserSearch({ q: String(uid), limit: 20 }));
        const user = response.members.find((user) => user.uid === uid);
        if (!user) throw new Error('用户不存在');
        options = { component: ChatDetails, componentProps: { user } };
      } else if (route.data['component']) {
        const id = route.paramMap.get('id');
        const threadId = route.paramMap.get('threadId');
        const messageId = route.paramMap.get('messageId');
        const threadRoot =
          id && threadId ? await firstValueFrom(this.chats.getMessage(encodeId(id), encodeId(threadId))) : undefined;
        const media = route.data['media']
          ? (this.location.getState() as { media?: ViewerMedia[]; initial?: number })
          : undefined;
        if (route.data['media'] && !media?.media?.length) throw new Error('媒体已失效');
        options = {
          component: route.data['component'],
          ...(media ? { cssClass: 'media-viewer-overlay', animated: false } : {}),
          componentProps: {
            ...route.data['props'],
            ...(media ? { media: media.media, initial: media.initial } : {}),
            ...(threadRoot ? { threadRoot } : {}),
            ...(messageId ? { messageId: encodeId(messageId) } : {}),
            ...(id ? { chatId: encodeId(id) } : {}),
            ...(threadId ? { threadId: encodeId(threadId) } : {}),
          },
        };
      } else if (route.paramMap.get('packId') || route.paramMap.get('stickerId')) {
        options = {
          component: StickerPicker,
          componentProps: {
            selectable: false,
            ...(route.paramMap.get('packId') ? { packId: encodeId(route.paramMap.get('packId')!) } : {}),
            ...(route.paramMap.get('stickerId') ? { stickerId: encodeId(route.paramMap.get('stickerId')!) } : {}),
          },
        };
      } else {
        options = {
          component: StartChat,
          componentProps: {
            kind: route.data['kind'] ?? StartChatKind.Join,
            code: route.paramMap.get('code') ?? '',
          },
        };
      }
      if (version !== this.version || !this.isCurrentRoute()) return;
      const modal = await this.modals.create(options);
      if (version !== this.version || !this.isCurrentRoute()) {
        modal.remove();
        return;
      }
      this.modal = modal;
      await modal.present();
      if (version !== this.version || !this.isCurrentRoute()) {
        await modal.dismiss(undefined, 'navigate');
        return;
      }
      const result = await modal.onDidDismiss();
      if (result.role !== 'navigate' && version === this.version) {
        if (this.hasPreviousPage) this.location.back();
        else await this.home();
      }
    } catch {
      if (version === this.version) this.failed.set(true);
    }
  }
}

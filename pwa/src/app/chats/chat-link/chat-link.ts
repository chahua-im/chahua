import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { IonButton, IonContent, IonSpinner, ModalController } from '@ionic/angular';
import { firstValueFrom } from 'rxjs';
import { ChatsService } from '../../../generated/endpoints/chats/chats.service';
import { UsersService } from '../../../generated/endpoints/users/users.service';
import { decodeId, encodeId } from '../../api/snowflake-id';
import { StickerPicker } from '../../messages/sticker-picker/sticker-picker';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { StartChat, StartChatKind } from '../start-chat/start-chat';
import { UserProfile } from '../user-profile/user-profile';
export function decodePermalink(encoded: string) {
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
  private readonly chats = inject(ChatsService);
  protected readonly failed = signal(false);
  ionViewDidEnter() {
    void this.open();
  }
  protected home() {
    return this.router.navigate(['/chats'], { replaceUrl: true });
  }
  protected async open() {
    this.failed.set(false);
    const route = this.route.snapshot;
    try {
      const encoded = route.paramMap.get('encoded');
      if (encoded) {
        const { chatId, messageId } = decodePermalink(encoded);
        const message = await firstValueFrom(this.chats.getMessage(chatId, messageId));
        await this.router.navigate(
          ['/chats/chat', decodeId(chatId), ...(message.replyRootId ? ['thread', decodeId(message.replyRootId)] : [])],
          { replaceUrl: true, queryParams: { message: decodeId(messageId) } },
        );
        return;
      }
      let modal: HTMLIonModalElement;
      const uid = Number(route.queryParamMap.get('uid'));
      if (uid) {
        const response = await firstValueFrom(this.users.getUserSearch({ q: String(uid), limit: 20 }));
        const user = response.members.find((user) => user.uid === uid);
        if (!user) throw new Error('用户不存在');
        modal = await this.modals.create({ component: UserProfile, componentProps: { user } });
      } else if (route.paramMap.get('packId')) {
        modal = await this.modals.create({
          component: StickerPicker,
          componentProps: { selectable: false, packId: encodeId(route.paramMap.get('packId')!) },
        });
      } else {
        modal = await this.modals.create({
          component: StartChat,
          componentProps: {
            kind: route.data['create'] ? StartChatKind.Create : StartChatKind.Join,
            code: route.paramMap.get('code') ?? '',
          },
        });
      }
      await modal.present();
      const result = await modal.onDidDismiss();
      if (
        result.role !== 'navigate' &&
        this.router.url ===
          this.router.serializeUrl(
            this.router.createUrlTree([], { relativeTo: this.route, queryParamsHandling: 'preserve' }),
          )
      )
        await this.home();
    } catch {
      this.failed.set(true);
    }
  }
}

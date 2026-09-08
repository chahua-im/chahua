import { dismissChatOverlays } from '../dismiss-chat-overlays';
import { Component, effect, inject, input, signal, untracked, computed } from '@angular/core';
import { form, FormField } from '@angular/forms/signals';
import { Router } from '@angular/router';
import {
  IonHeader,
  IonToolbar,
  IonTitle,
  IonButtons,
  IonButton,
  IonContent,
  IonItem,
  IonList,
  IonLabel,
  IonSpinner,
  IonSearchbar,
  ModalController,
} from '@ionic/angular';
import { firstValueFrom } from 'rxjs';
import { GroupsService } from '../../../generated/endpoints/groups/groups.service';
import { InvitesService } from '../../../generated/endpoints/invites/invites.service';
import { type InvitePreviewResponse } from '../../../generated/models';
import { decodeId } from '../../api/snowflake-id';
import { DirectorySearch } from '../directory-search/directory-search';
import { ChatListStore } from '../chat-list-store';
export enum StartChatKind {
  Create,
  Join,
  Friend,
}
export function inviteCode(value: string) {
  try {
    const url = new URL(value);
    return url.searchParams.get('invite') || url.pathname.split('/').filter(Boolean).at(-1) || '';
  } catch {
    return value.trim();
  }
}
@Component({
  selector: 'app-start-chat',
  templateUrl: './start-chat.html',
  imports: [
    FormField,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonContent,
    IonItem,
    IonList,
    IonLabel,
    IonSpinner,
    IonSearchbar,
    DirectorySearch,
  ],
  host: { class: 'ion-page' },
})
export class StartChat {
  readonly kind = input(StartChatKind.Create);
  readonly code = input('');
  protected readonly Kind = StartChatKind;
  protected readonly modals = inject(ModalController);
  private readonly groups = inject(GroupsService);
  private readonly invites = inject(InvitesService);
  private readonly router = inject(Router);
  private readonly lists = inject(ChatListStore);
  protected readonly values = signal({ name: '', code: '' });
  protected readonly fields = form(this.values);
  protected readonly query = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal(false);
  protected readonly preview = signal<InvitePreviewResponse | undefined>(undefined);
  constructor() {
    effect(() => {
      const code = this.code();
      if (code) {
        this.values.update((v) => ({ ...v, code }));
        untracked(() => void this.lookup());
      }
    });
  }
  protected async lookup() {
    this.busy.set(true);
    this.error.set(false);
    this.preview.set(undefined);
    try {
      this.preview.set(
        await firstValueFrom(this.invites.getInviteByCode({ inviteCode: inviteCode(this.values().code) })),
      );
    } catch {
      this.error.set(true);
    } finally {
      this.busy.set(false);
    }
  }
  protected readonly previewValid = computed(
    () => !!this.preview() && this.preview()!.invite.code === inviteCode(this.values().code),
  );
  protected async submit() {
    if (this.busy() || (this.kind() === StartChatKind.Join && !this.previewValid())) return;
    this.busy.set(true);
    this.error.set(false);
    try {
      const chat =
        this.kind() === StartChatKind.Create
          ? await firstValueFrom(this.groups.postGroup({ name: this.values().name.trim() }))
          : this.preview()?.alreadyMember
            ? this.preview()!.chat
            : (await firstValueFrom(this.invites.postRedeemInvite({ code: inviteCode(this.values().code) }))).chat;
      this.lists.refreshChats();
      await dismissChatOverlays(this.modals);
      await this.router.navigate(['/chats/chat', decodeId(chat.id)]);
    } catch {
      this.error.set(true);
    } finally {
      this.busy.set(false);
    }
  }
}

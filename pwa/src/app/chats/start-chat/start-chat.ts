import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { form, FormField } from '@angular/forms/signals';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonSearchbar,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { TranslocoPipe } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { GroupsService } from '../../../generated/endpoints/groups/groups.service';
import { InvitesService } from '../../../generated/endpoints/invites/invites.service';
import { type InvitePreviewResponse, type SnowflakeID } from '../../../generated/models';
import { ConversationNavigation } from '../../conversations/conversation-navigation';
import { PanelNavigation } from '../../navigation/panel-navigation';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { SessionStore } from '../../session/session-store';
import { ChatAvatar } from '../chat-avatar/chat-avatar';
import { ChatListStore } from '../chat-list-store';
import { ChatStore } from '../chat-store';
import { DirectorySearch } from '../directory-search/directory-search';
import { inviteCode, inviteStatus, InviteStatus } from '../invite';
export enum StartChatKind {
  Create,
  Join,
  Friend,
}

enum StartChatAction {
  Lookup,
  Submit,
}
@Component({
  selector: 'app-start-chat',
  templateUrl: './start-chat.html',
  imports: [
    ChatAvatar,
    ContentScrollbars,
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
    TranslocoPipe,
  ],
  host: { class: 'ion-page' },
})
export class StartChat {
  readonly kind = input(StartChatKind.Create);
  readonly code = input('');
  protected readonly Kind = StartChatKind;
  protected readonly status = inviteStatus;
  protected readonly Status = InviteStatus;
  protected readonly panels = inject(PanelNavigation);
  private readonly groups = inject(GroupsService);
  private readonly invites = inject(InvitesService);
  private readonly navigation = inject(ConversationNavigation);
  private readonly lists = inject(ChatListStore);
  private readonly store = inject(ChatStore);
  private readonly session = inject(SessionStore);
  protected readonly values = signal({ name: '', code: '' });
  protected readonly fields = form(this.values);
  protected readonly query = signal('');
  protected readonly Action = StartChatAction;
  protected readonly pending = signal<StartChatAction | undefined>(undefined);
  protected readonly busy = computed(() => this.pending() != null);
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
    this.pending.set(StartChatAction.Lookup);
    this.error.set(false);
    this.preview.set(undefined);
    try {
      this.preview.set(
        await firstValueFrom(this.invites.getInviteByCode({ inviteCode: inviteCode(this.values().code) })),
      );
    } catch {
      this.error.set(true);
    } finally {
      this.pending.set(undefined);
    }
  }
  protected readonly previewValid = computed(
    () =>
      !!this.preview() &&
      this.preview()!.invite.code === inviteCode(this.values().code) &&
      (this.preview()!.alreadyMember || inviteStatus(this.preview()!.invite) === InviteStatus.Active),
  );
  protected async submit() {
    if (this.busy() || (this.kind() === StartChatKind.Join && !this.previewValid())) return;
    const uid = this.session.user()?.uid;
    const version = this.store.snapshot();
    const alreadyMember = this.preview()?.alreadyMember;
    this.pending.set(StartChatAction.Submit);
    this.error.set(false);
    try {
      let chatId: SnowflakeID;
      if (this.kind() === StartChatKind.Create) {
        chatId = (await firstValueFrom(this.groups.postGroup({ name: this.values().name.trim() }))).id;
      } else {
        const chat = alreadyMember
          ? this.preview()!.chat
          : (await firstValueFrom(this.invites.postRedeemInvite({ code: inviteCode(this.values().code) }))).chat;
        if (uid !== this.session.user()?.uid) return;
        if (!alreadyMember) this.store.acceptJoinedChat(chat, version);
        chatId = chat.id;
      }
      if (uid !== this.session.user()?.uid) return;
      this.lists.refreshChats();
      await this.navigation.open(chatId);
    } catch {
      this.error.set(true);
    } finally {
      this.pending.set(undefined);
    }
  }
}

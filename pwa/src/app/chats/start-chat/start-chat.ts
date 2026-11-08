import { Component, computed, DestroyRef, effect, inject, input, linkedSignal, signal } from '@angular/core';
import { form, FormField } from '@angular/forms/signals';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonList,
  IonSearchbar,
  IonSkeletonText,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { TranslocoPipe } from '@jsverse/transloco';
import { people } from 'ionicons/icons';
import { firstValueFrom, of, switchMap, timer } from 'rxjs';
import { RpcApi } from '../../../generated/rpc-api';
import { RpcError, RpcErrorCode } from '../../api/rpc-error';
import { SpeakingMode, type InvitePreviewResponse, type SnowflakeID } from '../../../generated/models';
import { ConversationNavigation } from '../../conversations/conversation-navigation';
import { LocalDatePipe } from '../../i18n/local-date.pipe';
import { PanelNavigation } from '../../navigation/panel-navigation';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { SessionStore } from '../../session/session-store';
import { LoadError } from '../../ui/load-error/load-error';
import { ChatAvatar } from '../chat-avatar/chat-avatar';
import { ChatListStore } from '../chat-list-store';
import { ChatStore } from '../chat-store';
import { DirectorySearch } from '../directory-search/directory-search';
import {
  inviteCode,
  inviteExpired,
  invitePreviewIssue,
  InvitePreviewIssue,
  inviteStatus,
  InviteStatus,
} from '../invite';
import { StartChatKind } from './start-chat-kind';
import { DiscardChanges } from '../../navigation/discard-changes';
export { StartChatKind } from './start-chat-kind';

enum StartChatAction {
  Lookup,
  Submit,
}
@Component({
  selector: 'app-start-chat',
  templateUrl: './start-chat.html',
  styleUrl: './start-chat.scss',
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
    IonSpinner,
    IonSearchbar,
    IonSkeletonText,
    LoadError,
    DirectorySearch,
    TranslocoPipe,
    LocalDatePipe,
  ],
  host: { class: 'ion-page' },
})
export class StartChat {
  readonly panelPath = input<string>();
  readonly kind = input(StartChatKind.Create);
  readonly code = input('');
  protected readonly Kind = StartChatKind;
  protected readonly defaultAvatarIcon = people;
  protected readonly SpeakingMode = SpeakingMode;
  protected readonly status = inviteStatus;
  protected readonly Status = InviteStatus;
  protected readonly panels = inject(PanelNavigation);
  private readonly api = inject(RpcApi);
  private readonly navigation = inject(ConversationNavigation);
  private readonly lists = inject(ChatListStore);
  private readonly store = inject(ChatStore);
  private readonly session = inject(SessionStore);
  protected readonly values = linkedSignal(() => ({ name: '', code: this.code() }));
  protected readonly fields = form(this.values);
  private readonly resolvedCode = computed(() => inviteCode(this.values().code));
  protected readonly uid = computed(() => this.session.user()?.uid);
  private readonly lookupAttempt = signal(0);
  protected readonly query = signal('');
  protected readonly Action = StartChatAction;
  protected readonly pending = signal<StartChatAction | undefined>(undefined);
  protected readonly busy = computed(() => this.pending() != null);
  protected readonly error = signal(false);
  protected readonly previewIssue = signal<InvitePreviewIssue | undefined>(undefined);
  protected readonly preview = signal<InvitePreviewResponse | undefined>(undefined);
  private readonly discardChanges = inject(DiscardChanges);
  private readonly destroy = inject(DestroyRef);
  private leaveConfirmation?: Promise<boolean>;
  private submitted = false;
  constructor() {
    effect((onCleanup) => {
      const path = this.panelPath();
      if (path) onCleanup(this.panels.registerLeaveCheck(path, () => this.canLeave()));
    });
    effect((onCleanup) => {
      if (this.kind() !== StartChatKind.Join) return;
      const code = this.resolvedCode();
      const uid = this.uid();
      this.lookupAttempt();
      this.error.set(false);
      this.previewIssue.set(undefined);
      this.preview.set(undefined);
      this.pending.set(undefined);
      if (!code || uid == null) return;

      this.pending.set(StartChatAction.Lookup);
      const delay = this.code() ? of(0) : timer(300);
      const subscription = delay.pipe(switchMap(() => this.api.invites.getByCode({ inviteCode: code }))).subscribe({
        next: (preview) => {
          this.preview.set(preview);
          this.pending.set(undefined);
        },
        error: (error: unknown) => {
          const issue = invitePreviewIssue(error);
          this.previewIssue.set(issue);
          this.error.set(issue == null);
          this.pending.set(undefined);
        },
      });
      onCleanup(() => subscription.unsubscribe());
    });
  }
  private canLeave() {
    if (this.submitted) return true;
    if (this.pending() === StartChatAction.Submit) return false;
    this.leaveConfirmation ??= this.discardForm().finally(() => {
      this.leaveConfirmation = undefined;
    });
    return this.leaveConfirmation;
  }
  private async discardForm() {
    const values = this.values();
    if ((values.name || values.code !== this.code()) && !(await this.discardChanges.confirm())) return false;
    if (this.destroy.destroyed || this.values() !== values) return false;
    this.values.set({ name: '', code: this.code() });
    return true;
  }
  protected retryLookup() {
    this.lookupAttempt.update((attempt) => attempt + 1);
  }
  protected readonly previewValid = computed(
    () =>
      !!this.preview() &&
      this.preview()!.invite.code === inviteCode(this.values().code) &&
      !inviteExpired(this.preview()!.invite) &&
      (this.preview()!.alreadyMember || this.preview()!.canJoin),
  );
  protected async submit() {
    if (this.busy() || (this.kind() === StartChatKind.Join && !this.previewValid())) return;
    const uid = this.session.user()?.uid;
    const code = this.resolvedCode();
    const version = this.store.snapshot();
    const alreadyMember = this.preview()?.alreadyMember;
    this.pending.set(StartChatAction.Submit);
    this.error.set(false);
    try {
      let chatId: SnowflakeID;
      if (this.kind() === StartChatKind.Create) {
        chatId = (await firstValueFrom(this.api.groups.create({ name: this.values().name.trim() }))).id;
      } else {
        const chat = alreadyMember
          ? this.preview()!.chat
          : (await firstValueFrom(this.api.invites.redeem({ code }))).chat;
        if (uid !== this.session.user()?.uid) return;
        if (!alreadyMember) this.store.acceptJoinedChat(chat, version);
        chatId = chat.id;
      }
      if (uid !== this.session.user()?.uid) return;
      this.lists.refreshChats();
      this.submitted = true;
      await this.navigation.open(chatId);
    } catch (error) {
      if (uid !== this.session.user()?.uid || code !== this.resolvedCode()) return;
      if (
        this.kind() === StartChatKind.Join &&
        error instanceof RpcError &&
        (error.code === RpcErrorCode.Forbidden || error.code === RpcErrorCode.Conflict)
      ) {
        try {
          const preview = await firstValueFrom(this.api.invites.getByCode({ inviteCode: code }));
          if (uid !== this.session.user()?.uid || code !== this.resolvedCode()) return;
          this.preview.set(preview);
          return;
        } catch (refreshError) {
          if (uid !== this.session.user()?.uid || code !== this.resolvedCode()) return;
          error = refreshError;
        }
      }
      const issue = this.kind() === StartChatKind.Join ? invitePreviewIssue(error) : undefined;
      if (issue) {
        this.previewIssue.set(issue);
        this.preview.set(undefined);
      }
      this.error.set(issue == null);
    } finally {
      if (uid === this.session.user()?.uid && code === this.resolvedCode()) this.pending.set(undefined);
    }
  }
}

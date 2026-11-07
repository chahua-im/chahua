import { Component, computed, DestroyRef, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ToastController } from '@ionic/angular';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { GroupKind, ServerWsMessageType } from '../../../generated/models';
import { Connection } from '../../api/connection';
import { ChatStore } from '../../chats/chat-store';
import { SpeakingAction } from '../../chats/speaking';
import { ChatPicker, ChatPickerScope, type ChooseChat } from '../../chats/chat-picker/chat-picker';
import { ConversationNavigation, type ForwardDraftLocation } from '../../conversations/conversation-navigation';
import {
  canForward,
  forwardSourceMessage,
  ForwardSelectionError,
  MAX_FORWARD_MESSAGES,
  type ForwardSource,
  type ForwardSourcesLoader,
  type ForwardSourcesResult,
} from '../forwarding';

@Component({
  selector: 'app-forward-picker',
  imports: [ChatPicker, TranslocoPipe],
  template: `
    <app-chat-picker
      [scope]="Scope.ChatsAndThreads"
      [title]="(moveFrom() ? 'messages.forward.changeTarget' : 'messages.forward.to') | transloco"
      [(open)]="open"
      [choose]="select"
      [submitted]="submitted()"
      [invalid]="invalid()"
      [failure]="failure() ? (failure()! | transloco: { max: maxForwardMessages }) : undefined"
      (closing)="dismissing()"
      (closed)="closed.emit()"
    />
  `,
})
export class ForwardPicker {
  readonly messages = input<readonly ForwardSource[]>([]);
  readonly moveFrom = input<ForwardDraftLocation>();
  readonly load = input<ForwardSourcesLoader>();
  readonly closed = output<void>();
  protected readonly Scope = ChatPickerScope;
  private readonly metadata = inject(ChatStore);
  private readonly navigation = inject(ConversationNavigation);
  private readonly destroyRef = inject(DestroyRef);
  private readonly toasts = inject(ToastController);
  private readonly i18n = inject(TranslocoService);
  protected readonly maxForwardMessages = MAX_FORWARD_MESSAGES;
  protected readonly failure = signal<ForwardSelectionError | undefined>(undefined);
  protected readonly invalid = computed(
    () => this.failure() === ForwardSelectionError.Stale || this.failure() === ForwardSelectionError.Unavailable,
  );
  protected readonly submitted = signal(false);
  protected readonly open = signal(true);
  private feedback?: HTMLIonToastElement;
  constructor() {
    this.destroyRef.onDestroy(() => void this.feedback?.dismiss());
    inject(Connection)
      .changes$.pipe(takeUntilDestroyed())
      .subscribe((event) => {
        const sources = this.messages();
        if (event.payload.chatId !== sources[0]?.chatId) return;
        const removed =
          event.type === ServerWsMessageType.messageDeleted
            ? [event.payload.id]
            : event.type === ServerWsMessageType.messagesBulkDeleted
              ? event.payload.messageIds
              : [];
        if (
          sources.some((source) => {
            const id = forwardSourceMessage(source)?.id;
            return id != null && removed.includes(id);
          })
        )
          this.failure.set(ForwardSelectionError.Stale);
      });
  }
  protected dismissing() {
    this.open.set(false);
    void this.feedback?.dismiss();
  }
  protected readonly select: ChooseChat = async (target, available) => {
    if (this.submitted() || this.invalid() || !this.open()) return false;
    void this.feedback?.dismiss();
    this.feedback = undefined;
    this.failure.set(undefined);
    try {
      if (target.kind !== GroupKind.dm) await this.metadata.ensureDetails(target.chatId);
    } catch {
      await this.report(ForwardSelectionError.NavigationFailed);
      return false;
    }
    if (this.destroyRef.destroyed || !this.open()) return false;
    if (
      !this.metadata.canSpeak(target.chatId, target.threadId ? SpeakingAction.ThreadReply : SpeakingAction.ChatMessage)
    ) {
      await this.report(ForwardSelectionError.Restricted);
      return false;
    }
    const result = await this.resolveSources();
    if (this.destroyRef.destroyed || !this.open() || this.submitted() || this.invalid()) return false;
    if (!available()) {
      await this.report(ForwardSelectionError.NavigationFailed);
      return false;
    }
    if ('error' in result) {
      await this.report(result.error);
      return false;
    }
    const selection = result.sources;
    if (!this.forwardable(selection)) {
      if (this.load()) await this.report(ForwardSelectionError.TopicUnavailable);
      else this.failure.set(ForwardSelectionError.Unavailable);
      return false;
    }
    this.submitted.set(true);
    try {
      const opened = await this.navigation.prepareForward(target.chatId, target.threadId, selection, this.moveFrom());
      if (opened) return true;
    } catch {
      /* Keep the selection available after navigation fails. */
    }
    this.submitted.set(false);
    await this.report(ForwardSelectionError.NavigationFailed);
    return false;
  };
  private async resolveSources(): Promise<ForwardSourcesResult> {
    const load = this.load();
    if (!load) return { sources: this.messages() };
    try {
      return await load();
    } catch {
      return { error: ForwardSelectionError.LoadFailed };
    }
  }
  private async report(error: ForwardSelectionError) {
    if (this.destroyRef.destroyed || !this.open()) return;
    const toast = await this.toasts.create({
      message: this.i18n.translate(error, { max: MAX_FORWARD_MESSAGES }),
      duration: 3000,
    });
    if (!this.destroyRef.destroyed && this.open()) {
      this.feedback = toast;
      await toast.present();
    } else toast.remove();
  }
  /** Every source needs a server ID and must be allowed in a forward request. */
  private forwardable(selection: readonly ForwardSource[]): boolean {
    const messages = selection.map(forwardSourceMessage);
    return (
      !!messages.length &&
      messages.length <= MAX_FORWARD_MESSAGES &&
      messages.every((message) => !!message && canForward(message))
    );
  }
}

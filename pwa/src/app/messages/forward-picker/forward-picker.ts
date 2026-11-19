import { Component, computed, DestroyRef, inject, input, output, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ToastController } from '@ionic/angular';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom, Subject, takeUntil } from 'rxjs';
import { ServerWsMessageType, type MessageResponse } from '../../../generated/models';
import { RpcApi } from '../../../generated/rpc-api';
import { Connection } from '../../api/connection';
import { RpcError, RpcErrorCode } from '../../api/rpc-error';
import { ChatStore } from '../../chats/chat-store';
import {
  ChatPicker,
  ChatPickerScope,
  type ChatPickerTarget,
  type ChooseChat,
} from '../../chats/chat-picker/chat-picker';
import { ForwardPanel } from '../forward-panel/forward-panel';
import {
  canForward,
  canForwardTo,
  loadForwardTarget,
  forwardSourceMessage,
  ForwardSelectionError,
  MAX_FORWARD_MESSAGES,
  type ForwardSource,
  type ForwardTopic,
} from '../forwarding';

@Component({
  selector: 'app-forward-picker',
  imports: [ChatPicker, TranslocoPipe, ForwardPanel],
  template: `
    <app-chat-picker
      #picker
      [scope]="Scope.ChatsAndThreads"
      [title]="title() ?? ('messages.forward.to' | transloco)"
      [reselectionTitle]="'messages.forward.changeTo' | transloco"
      [(open)]="open"
      [choose]="select"
      [disableTarget]="disableTarget"
      [selectionContent]="confirmation"
      [selectionHeight]="panel()?.contentHeight()"
      [submitted]="panel()?.sending() === true"
      [invalid]="invalid()"
      [failure]="pickerFailure() ? (pickerFailure()! | transloco: { max: maxForwardMessages }) : undefined"
      (closing)="dismissing()"
      (closed)="closed.emit()"
    />
    <ng-template #confirmation>
      @if (selection(); as selected) {
        <app-forward-panel
          [(open)]="open"
          [visible]="picker.showingSelection()"
          [initialTarget]="selected.target"
          [sources]="selected.sources"
          [(sourceFailure)]="failure"
          (back)="picker.showList()"
          (changeTarget)="picker.showList(true)"
          (sent)="sent.emit()"
        />
      }
    </ng-template>
  `,
})
export class ForwardPicker {
  readonly title = input<string>();
  readonly messages = input<readonly ForwardSource[]>([]);
  readonly topic = input<ForwardTopic>();
  readonly closed = output<void>();
  readonly sent = output<void>();
  protected readonly Scope = ChatPickerScope;
  private readonly api = inject(RpcApi);
  private readonly metadata = inject(ChatStore);
  protected readonly selection = signal<{ target: ChatPickerTarget; sources: readonly MessageResponse[] } | undefined>(
    undefined,
  );
  protected readonly panel = viewChild(ForwardPanel);
  private readonly destroyRef = inject(DestroyRef);
  private readonly toasts = inject(ToastController);
  private readonly i18n = inject(TranslocoService);
  protected readonly maxForwardMessages = MAX_FORWARD_MESSAGES;
  protected readonly failure = signal<ForwardSelectionError | undefined>(undefined);
  protected readonly pickerFailure = computed(() => {
    const panel = this.panel();
    return this.failure() ?? panel?.targetFailure();
  });
  protected readonly invalid = computed(() => !!this.failure());
  protected readonly open = signal(true);
  protected readonly disableTarget = (target: ChatPickerTarget) =>
    this.metadata.groupChatWriteRestricted(target.chatId, target.kind);
  private readonly dismissing$ = new Subject<void>();
  private readonly recalledWhileChoosing = new Set<MessageResponse['id']>();
  private feedback?: HTMLIonToastElement;
  constructor() {
    this.destroyRef.onDestroy(() => this.dismissing());
    inject(Connection)
      .changes$.pipe(takeUntilDestroyed())
      .subscribe((event) => {
        const sources = this.selection()?.sources ?? this.messages();
        if (event.payload.chatId !== (this.topic()?.chatId ?? sources[0]?.chatId)) return;
        const removed =
          event.type === ServerWsMessageType.messageDeleted
            ? [event.payload.id]
            : event.type === ServerWsMessageType.messagesBulkDeleted
              ? event.payload.messageIds
              : [];
        if (this.topic() && !this.selection()) for (const id of removed) this.recalledWhileChoosing.add(id);
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
    this.dismissing$.next();
    void this.feedback?.dismiss();
  }
  protected readonly select: ChooseChat = async (target, available) => {
    if (this.invalid() || !this.open() || this.disableTarget(target)) return false;
    const panel = this.panel();
    if (panel) return panel.choose(target, available);
    void this.feedback?.dismiss();
    this.feedback = undefined;
    this.failure.set(undefined);
    try {
      await loadForwardTarget(this.metadata, target);
    } catch {
      await this.report(ForwardSelectionError.NavigationFailed);
      return false;
    }
    if (this.destroyRef.destroyed || !this.open()) return false;
    if (!canForwardTo(this.metadata, target)) {
      await this.report(ForwardSelectionError.Restricted);
      return false;
    }
    if (this.invalid()) return false;
    if (!available()) {
      await this.report(ForwardSelectionError.NavigationFailed);
      return false;
    }
    const topic = this.topic();
    let sources: (MessageResponse | undefined)[];
    if (topic) {
      try {
        const page = await firstValueFrom(
          this.api.threads
            .listForwardSources({ chatId: topic.chatId, threadRootId: topic.threadId })
            .pipe(takeUntil(this.dismissing$)),
        );
        sources = page.messages;
      } catch (error) {
        let failure = ForwardSelectionError.TopicLoadFailed;
        if (error instanceof RpcError) {
          if (error.code === RpcErrorCode.PayloadTooLarge) failure = ForwardSelectionError.TooMany;
          if ([RpcErrorCode.Forbidden, RpcErrorCode.NotFound, RpcErrorCode.Gone].includes(error.code))
            failure = ForwardSelectionError.TopicUnavailable;
        }
        await this.report(failure);
        return false;
      }
      if (!available() || !this.open() || this.destroyRef.destroyed || this.invalid()) return false;
      if (sources.some((message) => message && this.recalledWhileChoosing.has(message.id))) {
        await this.report(ForwardSelectionError.Stale);
        return false;
      }
    } else {
      sources = this.messages().map(forwardSourceMessage);
    }
    if (
      !sources.length ||
      sources.length > MAX_FORWARD_MESSAGES ||
      !sources.every((message): message is MessageResponse => !!message && canForward(message, sources.length))
    ) {
      this.failure.set(ForwardSelectionError.Unavailable);
      return false;
    }
    this.selection.set({ target, sources });
    return true;
  };
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
}

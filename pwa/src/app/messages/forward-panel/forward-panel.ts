import {
  afterRenderEffect,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  input,
  linkedSignal,
  model,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { IonButton, IonIcon, IonSpinner, AlertController, ToastController } from '@ionic/angular';
import { chatbubbleEllipsesOutline, chevronBackOutline, closeOutline } from 'ionicons/icons';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { GroupKind, MessageType, type MentionInfo, type MessageResponse } from '../../../generated/models';
import { RpcApi } from '../../../generated/rpc-api';
import type { MessagesSendForwardParams } from '../../../generated/rpc-models';
import { Connection } from '../../api/connection';
import { RpcError, RpcErrorCode, RpcTransportError } from '../../api/rpc-error';
import { ChatStore } from '../../chats/chat-store';
import { ChatAvatar } from '../../chats/chat-avatar/chat-avatar';
import type { ChatPickerTarget, ChooseChat } from '../../chats/chat-picker/chat-picker';
import { SessionStore } from '../../session/session-store';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { LoadError } from '../../ui/load-error/load-error';
import { Message } from '../message/message';
import { MessageComposer } from '../message-composer/message-composer';
import { MessageOutbox } from '../message-outbox';
import { MessagePreview } from '../message-preview/message-preview';
import { ForwardPlaceholder } from '../forward-placeholder';
import {
  ForwardSelectionError,
  MAX_FORWARD_MESSAGES,
  canForwardTo,
  loadForwardTarget,
  forwardRelationship,
} from '../forwarding';
import { ForwardTargetIcon } from '../forward-target-icon';
import { ForwardDetails } from './forward-details';
import { buildForwardPreview, placeholderReasons } from './forward-preview';

interface ForwardSubmission {
  target: MessagesSendForwardParams;
  comment: string;
  mentions: MentionInfo[];
}

type PlaceholderConfirmation = 'confirmPendingAudio' | 'confirmNested' | 'confirmBoth';

function placeholderConfirmation(
  required: Record<string, ForwardPlaceholder>,
  confirmed?: Record<string, ForwardPlaceholder>,
): PlaceholderConfirmation | undefined {
  const reasons = Object.entries(required)
    .filter(([id, reason]) => confirmed?.[id] !== reason)
    .map(([, reason]) => reason);
  const audio = reasons.includes(ForwardPlaceholder.PendingAudio);
  const nested = reasons.includes(ForwardPlaceholder.NestedForward);
  if (audio) return nested ? 'confirmBoth' : 'confirmPendingAudio';
  if (nested) return 'confirmNested';
  return;
}

function forwardFailure(error: unknown): string {
  if (error instanceof RpcTransportError) {
    if (error.kind === 'timeout' || error.kind === 'disconnected') return 'messages.forward.networkError';
    if (error.kind === 'overloaded') return 'messages.forward.busy';
    return 'messages.forward.serviceUnavailable';
  }
  if (error instanceof RpcError) {
    if (error.code === RpcErrorCode.Overloaded) return 'messages.forward.busy';
    if ([RpcErrorCode.Internal, RpcErrorCode.DispatcherInternal, RpcErrorCode.Unavailable].includes(error.code))
      return 'messages.forward.serviceUnavailable';
  }
  return 'messages.forward.sendFailed';
}

@Component({
  selector: 'app-forward-panel',
  imports: [
    IonButton,
    IonIcon,
    IonSpinner,
    TranslocoPipe,
    ChatAvatar,
    ContentScrollbars,
    LoadError,
    Message,
    MessageComposer,
    MessagePreview,
    ForwardDetails,
    ForwardTargetIcon,
  ],
  templateUrl: './forward-panel.html',
  styleUrl: './forward-panel.scss',
})
export class ForwardPanel {
  readonly initialTarget = input.required<ChatPickerTarget>();
  readonly sources = input.required<readonly MessageResponse[]>();
  readonly sourceFailure = model<ForwardSelectionError>();
  protected readonly maxMessages = MAX_FORWARD_MESSAGES;
  private readonly sourceChatId = computed(() => this.sources()[0].chatId);
  protected readonly sourceCount = computed(() => this.sources().length);
  readonly open = model(true);
  readonly visible = input(true);
  readonly sending = signal(false);
  readonly contentHeight = signal<number | undefined>(undefined);
  readonly targetFailure = signal<ForwardSelectionError | undefined>(undefined);
  readonly back = output<void>();
  readonly changeTarget = output<void>();
  readonly sent = output<void>();
  private readonly composer = viewChild(MessageComposer);
  private readonly dialog = viewChild<ElementRef<HTMLElement>>('dialog');
  private readonly preview = viewChild<ElementRef<HTMLElement>>('preview');
  private readonly api = inject(RpcApi);
  private readonly connection = inject(Connection);
  private readonly outbox = inject(MessageOutbox);
  protected readonly metadata = inject(ChatStore);
  private readonly session = inject(SessionStore);
  private readonly i18n = inject(TranslocoService);
  private readonly alerts = inject(AlertController);
  private readonly toasts = inject(ToastController);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly GroupKind = GroupKind;
  protected readonly backIcon = chevronBackOutline;
  protected readonly closeIcon = closeOutline;
  protected readonly recentMessagesIcon = chatbubbleEllipsesOutline;
  protected readonly sourceName = computed(() => {
    const chat = this.metadata.get(this.sourceChatId());
    return chat?.peer?.username ?? chat?.name;
  });
  protected readonly target = linkedSignal(() => this.initialTarget());
  private readonly targetRelationship = computed(() => forwardRelationship(this.metadata, this.target()));
  protected readonly comment = signal('');
  private readonly confirmedPlaceholders = signal<Record<string, ForwardPlaceholder> | undefined>(undefined);
  private readonly placeholders = linkedSignal(() => placeholderReasons(this.sources()));
  protected readonly placeholderPending = computed(() =>
    placeholderConfirmation(this.placeholders(), this.confirmedPlaceholders()),
  );
  private readonly canPreview = computed(
    () => !!this.session.user() && !this.placeholderPending() && !this.unavailable(),
  );
  protected readonly forwardPreview = computed(() =>
    this.canPreview() ? buildForwardPreview(this.sources(), this.placeholders()) : undefined,
  );
  protected readonly previewMessage = computed(() => {
    const preview = this.forwardPreview();
    const user = this.session.user();
    if (!preview || !user) return undefined;
    return {
      ...preview.message,
      sender: {
        uid: user.uid,
        name: user.username,
        gender: user.gender,
        avatarUrl: user.avatarUrl,
        userGroup: user.userGroup,
      },
    };
  });
  private readonly confirmationOpening = signal(false);
  protected readonly unavailable = computed(() => !!this.sourceFailure());
  protected readonly sendFailed = signal<string | undefined>(undefined);
  protected readonly submission = signal<ForwardSubmission | undefined>(undefined);
  protected readonly targetChangeDisabled = computed(() => this.unavailable() || this.sending() || !!this.submission());
  protected readonly recentOpen = signal(false);
  protected readonly recordsOpen = signal(false);
  private readonly targetRejected = signal(false);
  protected readonly restricted = computed(() => this.targetRejected() || !canForwardTo(this.metadata, this.target()));
  protected readonly composerDisabled = computed(
    () => this.sending() || !this.forwardPreview() || this.unavailable() || this.restricted() || !!this.submission(),
  );
  private readonly canConfirmPlaceholder = computed(() => this.open() && this.visible() && !this.unavailable());
  private confirmation?: HTMLIonAlertElement;
  private readonly owner = this.session.user()?.uid;
  constructor() {
    afterRenderEffect({
      read: () => {
        if (
          !this.visible() ||
          !this.open() ||
          !this.forwardPreview() ||
          this.unavailable() ||
          this.contentHeight() != null
        )
          return;
        const dialog = this.dialog()?.nativeElement;
        const preview = this.preview()?.nativeElement;
        if (!dialog || !preview) return;

        // Measure the rows without the auto margin that keeps the composer at the bottom.
        const rows = [...dialog.querySelectorAll(':scope > header, :scope > section, :scope > footer')];
        const { paddingTop, paddingBottom, rowGap } = getComputedStyle(dialog);
        const height = rows.reduce((sum, row) => sum + row.getBoundingClientRect().height, 0);
        const spacing = parseFloat(paddingTop) + parseFloat(paddingBottom) + parseFloat(rowGap) * (rows.length - 1);
        const previewOverflow = Math.max(0, preview.scrollHeight - preview.clientHeight);
        this.contentHeight.set(Math.ceil(height + spacing + previewOverflow));
      },
    });
    this.connection.messages$.pipe(takeUntilDestroyed()).subscribe((message) => {
      const submission = this.submission();
      if (
        submission &&
        message.clientGeneratedId === submission.target.clientGeneratedId &&
        message.sender.uid === this.owner &&
        message.chatId === submission.target.chatId &&
        (message.replyRootId ?? null) === (submission.target.threadId ?? null)
      )
        this.confirmSend(submission);
    });
    effect(() => {
      if (!this.canConfirmPlaceholder()) {
        void this.confirmation?.dismiss(undefined, 'suspended');
      } else if (!this.confirmationOpening()) {
        const pending = this.placeholderPending();
        if (pending) untracked(() => void this.confirmPlaceholder(pending));
      }
    });
    effect(() => {
      if (this.session.user()?.uid !== this.owner) {
        this.sending.set(false);
        this.close();
      }
      if (!this.metadata.isAccessible(this.sourceChatId())) {
        this.invalidateSource();
      }
    });
    effect((onCleanup) => {
      const relationship = this.targetRelationship();
      if (relationship) onCleanup(relationship.activate());
    });
    this.destroyRef.onDestroy(() => {
      void this.confirmation?.dismiss();
    });
  }
  protected invalidateSource() {
    this.sourceFailure.set(ForwardSelectionError.Stale);
    this.recordsOpen.set(false);
    this.recentOpen.set(false);
  }
  private async confirmPlaceholder(confirmation: PlaceholderConfirmation) {
    const replacements = this.placeholders();
    this.confirmationOpening.set(true);
    try {
      const alert = await this.alerts.create({
        header: this.i18n.translate('messages.forward.confirmTitle'),
        message: this.i18n.translate(`messages.forward.${confirmation}`),
        buttons: [
          { text: this.i18n.translate('common.cancel'), role: 'cancel' },
          { text: this.i18n.translate('messages.forward.continue'), role: 'confirm' },
        ],
      });
      if (this.destroyRef.destroyed || !this.canConfirmPlaceholder()) {
        alert.remove();
        return;
      }
      this.confirmation = alert;
      const dismissed = alert.onDidDismiss();
      await alert.present();
      if (!this.canConfirmPlaceholder() || this.destroyRef.destroyed) void alert.dismiss(undefined, 'suspended');
      const { role } = await dismissed;
      if (role === 'suspended' || this.destroyRef.destroyed || !this.canConfirmPlaceholder()) return;
      if (role === 'confirm') this.confirmedPlaceholders.set(replacements);
      else this.close();
    } catch {
      this.close();
    } finally {
      this.confirmation = undefined;
      if (!this.destroyRef.destroyed) this.confirmationOpening.set(false);
    }
  }
  protected backToPicker() {
    this.targetFailure.set(undefined);
    this.back.emit();
  }
  protected requestTargetChange() {
    this.targetFailure.set(undefined);
    this.changeTarget.emit();
  }
  readonly choose: ChooseChat = async (target, available) => {
    if (this.targetChangeDisabled()) return false;
    this.targetFailure.set(undefined);
    try {
      await loadForwardTarget(this.metadata, target);
      if (!this.open() || this.destroyRef.destroyed || !available() || this.targetChangeDisabled()) return false;
      if (!canForwardTo(this.metadata, target)) {
        this.targetFailure.set(ForwardSelectionError.Restricted);
        return false;
      }
      this.targetRejected.set(false);
      this.target.set(target);
      this.sendFailed.set(undefined);
      return true;
    } catch {
      if (available()) this.targetFailure.set(ForwardSelectionError.NavigationFailed);
      return false;
    }
  };
  protected async send(mentions: MentionInfo[] = this.composer()?.mentionSnapshot() ?? []) {
    if (
      this.sending() ||
      (!this.submission() && (!this.forwardPreview() || this.unavailable() || this.restricted())) ||
      !this.open()
    )
      return;
    if (this.owner == null || this.owner !== this.session.user()?.uid) return;
    const previous = this.submission();
    const target = this.target();
    const submission = previous ?? {
      target: {
        clientGeneratedId: crypto.randomUUID(),
        chatId: target.chatId,
        threadId: target.threadId,
        sourceChatId: this.sourceChatId(),
        messageIds: this.sources().map((source) => source.id),
        confirmedPlaceholders: this.confirmedPlaceholders(),
      },
      comment: this.comment().trim(),
      mentions,
    };
    this.submission.set(submission);
    this.sending.set(true);
    this.sendFailed.set(undefined);
    try {
      const { message } = await firstValueFrom(
        this.api.messages.sendForward(submission.target).pipe(takeUntilDestroyed(this.destroyRef)),
      );
      if (!this.isCurrentSend() || this.submission() !== submission) return;
      if (message) this.connection.accept(message);
      this.confirmSend(submission);
    } catch (error) {
      if (!this.isCurrentSend() || this.submission() !== submission) return;
      const gone = error instanceof RpcError && error.code === RpcErrorCode.Gone;
      const data = error instanceof RpcError && error.code === RpcErrorCode.BadRequest ? error.data : undefined;
      const byId =
        data && typeof data === 'object' && 'forwardPlaceholdersById' in data
          ? data.forwardPlaceholdersById
          : undefined;
      const reasons =
        byId && typeof byId === 'object'
          ? placeholderReasons(this.sources(), byId as Record<string, unknown>)
          : undefined;
      const needsConsent = reasons && placeholderConfirmation(reasons, this.confirmedPlaceholders());
      const rejected =
        error instanceof RpcError &&
        [RpcErrorCode.NotFound, RpcErrorCode.Forbidden, RpcErrorCode.SpeakingRestricted].includes(error.code);
      const retryOriginal =
        !gone &&
        !(error instanceof RpcError && error.code === RpcErrorCode.Conflict) &&
        !needsConsent &&
        !rejected &&
        (previous ||
          (error instanceof RpcTransportError
            ? error.sent
            : !(error instanceof RpcError) ||
              [RpcErrorCode.Internal, RpcErrorCode.DispatcherInternal, RpcErrorCode.Unavailable].includes(error.code)));
      if (!retryOriginal) this.submission.set(undefined);
      if (needsConsent) this.placeholders.set(reasons);
      else if (gone) this.invalidateSource();
      else if (rejected) this.targetRejected.set(true);
      else this.sendFailed.set(forwardFailure(error));
    } finally {
      if (this.isCurrentSend()) this.sending.set(false);
    }
  }
  private isCurrentSend() {
    return !this.destroyRef.destroyed && this.open() && this.session.user()?.uid === this.owner;
  }
  private confirmSend(submission: ForwardSubmission) {
    if (!this.isCurrentSend() || this.submission() !== submission) return;
    this.submission.set(undefined);
    if (submission.comment) {
      this.outbox.enqueue(submission.target.chatId, submission.target.threadId, submission.comment, {
        messageType: MessageType.text,
        attachmentIds: [],
        markRead: false,
        ...(submission.mentions.length ? { mentions: submission.mentions } : {}),
      });
    }
    this.sent.emit();
    void this.completeSend();
  }
  private async completeSend() {
    this.sending.set(false);
    this.close();
    const toast = await this.toasts.create({ message: this.i18n.translate('messages.forward.sent'), duration: 2500 });
    await toast.present();
  }
  protected close() {
    if (!this.sending()) this.open.set(false);
  }
}

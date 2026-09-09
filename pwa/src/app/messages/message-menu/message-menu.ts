import { DOCUMENT } from '@angular/common';
import {
  afterRenderEffect,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { createAnimation, IonAlert, IonIcon, IonModal, IonSpinner, IonToast, ModalController } from '@ionic/angular';
import {
  addOutline,
  arrowUndoOutline,
  bookmarkOutline,
  chatbubblesOutline,
  copyOutline,
  linkOutline,
  peopleOutline,
  pinOutline,
  trashOutline,
} from 'ionicons/icons';
import { GroupRole, MessageType, type MessageResponse } from '../../../generated/models';
import { decodeId, type SnowflakeID } from '../../api/snowflake-id';
import { ChatStore } from '../../chats/chat-store';
import { SessionStore } from '../../session/session-store';
import { Preferences } from '../../settings/preferences';
import { EmojiPicker } from '../emoji-picker/emoji-picker';
import { MessageActions } from '../message-actions';
import { MessageNotice } from '../message-notice';
import { MessageOutbox, type OutgoingMessage } from '../message-outbox';
import { messageParts } from '../message-text/message-text';
import { Message, type MessageContent, type MessageMenuSelection } from '../message/message';
import { ReactionDetails } from '../reaction-details/reaction-details';
import { exceedsReactionLimit } from '../reaction-state';

export enum MessageAction {
  Reply,
  Thread,
  Pin,
  Copy,
  Save,
  Link,
  Recall,
  Edit,
  Reactions,
}

@Component({
  selector: 'app-message-menu',
  templateUrl: './message-menu.html',
  styleUrl: './message-menu.scss',
  imports: [Message, EmojiPicker, IonAlert, IonIcon, IonModal, IonSpinner, IonToast],
  providers: [MessageActions],
})
export class MessageMenu {
  readonly chatId = input.required<SnowflakeID>();
  readonly threadId = input<SnowflakeID>();
  readonly canReply = input(true);
  readonly reply = output<MessageResponse>();
  readonly edit = output<MessageResponse>();
  readonly editQueued = output<OutgoingMessage>();
  readonly openThread = output<SnowflakeID>();
  readonly messages = input.required<readonly MessageResponse[]>();
  protected readonly pins = computed(() => this.chatInfo.pins(this.chatId(), this.threadId()));
  private readonly chatInfo = inject(ChatStore);
  private readonly session = inject(SessionStore);
  private readonly messageActions = inject(MessageActions);
  private readonly outbox = inject(MessageOutbox);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly modal = viewChild(IonModal);
  private readonly preview = viewChild<ElementRef<HTMLElement>>('preview');
  private version = 0;
  private readonly pending = signal(false);
  readonly busy = this.pending.asReadonly();
  protected readonly selection = signal<MessageMenuSelection | undefined>(undefined);
  protected readonly queued = computed(() => {
    const id = this.selection()?.clientGeneratedId;
    return this.outbox.items().find((item) => item.clientGeneratedId === id && !item.cancelled());
  });
  protected readonly serverMessage = computed(() => {
    const selection = this.selection();
    if (!selection) return;
    return (
      this.messages().find((message) => message.id === selection.messageId) ??
      this.messages().find((message) => message.clientGeneratedId === selection.clientGeneratedId)
    );
  });
  protected readonly message = computed<MessageContent | undefined>(
    () => this.queued()?.message() ?? this.serverMessage(),
  );
  protected readonly admin = computed(() => this.chatInfo.get(this.chatId())?.myRole === GroupRole.admin);
  protected readonly pinned = computed(() => {
    const message = this.serverMessage();
    return !this.queued() && !!message && !!this.pins().get(message.id);
  });
  private readonly preferences = inject(Preferences);
  private readonly modals = inject(ModalController);
  protected readonly recent = this.preferences.recentReactions;
  protected readonly notice = signal<MessageNotice | undefined>(undefined);
  protected readonly Notice = MessageNotice;
  protected readonly confirmation = signal<
    | {
        action: MessageAction.Pin | MessageAction.Recall;
        message: MessageResponse;
        pinned: boolean;
      }
    | undefined
  >(undefined);
  protected readonly Action = MessageAction;
  protected readonly MessageType = MessageType;
  protected readonly icons = {
    peopleOutline,
    addOutline,
    arrowUndoOutline,
    bookmarkOutline,
    chatbubblesOutline,
    copyOutline,
    linkOutline,
    pinOutline,
    trashOutline,
  };
  protected readonly choosingEmoji = signal(false);
  protected readonly placed = signal(false);
  private readonly stack = viewChild<ElementRef<HTMLElement>>('stack');
  private readonly reactionBar = viewChild<ElementRef<HTMLElement>>('reactionBar');
  private readonly actions = viewChild<ElementRef<HTMLElement>>('actions');
  protected readonly canReact = computed(() => {
    const message = this.serverMessage();
    return (
      !this.queued() &&
      !!message &&
      !message.isDeleted &&
      message.messageType !== MessageType.sticker &&
      message.messageType !== MessageType.invite
    );
  });
  protected readonly canThread = computed(() => {
    const message = this.serverMessage();
    return (
      !this.queued() &&
      !!message &&
      !this.threadId() &&
      !message.isDeleted &&
      message.messageType === MessageType.text &&
      !message.threadInfo
    );
  });
  protected readonly canCopy = computed(() => {
    const message = this.message();
    return (
      !!message &&
      !message.isDeleted &&
      !!message.message?.trim() &&
      message.messageType !== MessageType.audio &&
      message.messageType !== MessageType.sticker &&
      message.messageType !== MessageType.invite
    );
  });
  protected readonly canSave = computed(() => {
    const message = this.serverMessage();
    return (
      !this.queued() &&
      !!message &&
      !message.isDeleted &&
      ![MessageType.sticker, MessageType.invite].includes(message.messageType)
    );
  });
  protected readonly canEdit = computed(() => {
    const message = this.message();
    return (
      !!message &&
      !message.isDeleted &&
      message.messageType === MessageType.text &&
      (!!this.queued() || message.sender.uid === this.session.user()?.uid)
    );
  });
  protected readonly canRecall = computed(() => {
    const message = this.serverMessage();
    return !!this.queued() || (!!message && !message.isDeleted && this.canRecallMessage(message));
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.reset());
    effect(() => {
      if (this.queued() || !this.serverMessage()) return;
      untracked(() => {
        const version = this.version;
        void Promise.all([this.chatInfo.ensureDetails(this.chatId()), this.pins().ensure()]).catch(() => {
          if (version === this.version) this.notice.set(MessageNotice.MetadataFailed);
        });
      });
    });
    afterRenderEffect((onCleanup) => {
      const stack = this.stack()?.nativeElement;
      if (!stack) return;
      const selection = this.selection()!;
      const own = selection.own;
      const bar = this.reactionBar()?.nativeElement;
      const actions = this.actions()?.nativeElement;
      const preview = this.preview()!.nativeElement;
      const row = preview.querySelector<HTMLElement>('.chat-row')!;
      const place = () => {
        if (!stack.offsetWidth) return;
        const rect = selection.element.isConnected ? selection.element.getBoundingClientRect() : selection.rect;
        const viewport = window.visualViewport;
        const style = getComputedStyle(stack.parentElement!);
        const horizontalInset = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        const verticalInset = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
        const left = (viewport?.offsetLeft ?? 0) + parseFloat(style.paddingLeft) + 12;
        const top = (viewport?.offsetTop ?? 0) + parseFloat(style.paddingTop) + 12;
        const availableWidth = (viewport?.width ?? window.innerWidth) - horizontalInset - 24;
        const availableHeight = (viewport?.height ?? window.innerHeight) - verticalInset - 24;
        const avatarSpace =
          row.querySelector<HTMLElement>('.avatar-slot')!.offsetWidth + parseFloat(getComputedStyle(row).gap);
        const previewWidth = Math.min(rect.width + avatarSpace, availableWidth);
        preview.style.width = `${previewWidth}px`;
        stack.style.width = `${Math.min(Math.max(previewWidth, 276), availableWidth)}px`;
        const barHeight = bar?.offsetHeight ?? 0;
        const actionsHeight = actions?.offsetHeight ?? 0;
        const totalHeight = preview.offsetHeight + barHeight + actionsHeight + (bar ? 16 : 8);
        const anchored = totalHeight > availableHeight;
        stack.classList.toggle('anchored', anchored);
        const clampX = (x: number, width: number) => Math.max(left, Math.min(x, left + availableWidth - width));
        const clampY = (y: number, height: number) => Math.max(top, Math.min(y, top + availableHeight - height));
        let x: number;
        let y: number;
        if (anchored) {
          // Keep the original message content in place; only the two panels follow the press.
          const width = Math.min(276, availableWidth);
          stack.style.width = `${width}px`;
          const point = selection.point ?? { x: own ? rect.right : rect.left, y: top + availableHeight / 2 };
          x = clampX(own ? point.x - width : point.x, width);
          y = clampY(point.y - (bar ? barHeight + 8 : 0), barHeight + actionsHeight + (bar ? 8 : 0));
          const contentSelector = '.reply-preview, .media-content, .message-body';
          const sourceContent = selection.element.querySelector(contentSelector);
          const previewContent = preview.querySelector(contentSelector)!;
          const contentOffset = previewContent.getBoundingClientRect().top - preview.getBoundingClientRect().top;
          const contentTop = sourceContent?.getBoundingClientRect().top ?? rect.top;
          preview.style.left = `${rect.left - (own ? 0 : avatarSpace) - x}px`;
          preview.style.top = `${contentTop - contentOffset - y}px`;
        } else {
          const width = stack.offsetWidth;
          x = clampX(own ? rect.right + avatarSpace - width : rect.left - avatarSpace, width);
          y = clampY(rect.top - (bar ? barHeight + 8 : 0), totalHeight);
          preview.style.removeProperty('left');
          preview.style.removeProperty('top');
        }
        stack.style.left = `${x}px`;
        stack.style.top = `${y}px`;
        this.placed.set(true);
      };
      const observer = new ResizeObserver(place);
      observer.observe(preview);
      observer.observe(actions!);
      if (bar) observer.observe(bar);
      window.addEventListener('resize', place);
      window.visualViewport?.addEventListener('resize', place);
      window.visualViewport?.addEventListener('scroll', place);
      place();
      onCleanup(() => {
        observer.disconnect();
        window.removeEventListener('resize', place);
        window.visualViewport?.removeEventListener('resize', place);
        window.visualViewport?.removeEventListener('scroll', place);
      });
    });
  }

  protected readonly enterAnimation = (element: HTMLElement) => this.animate(element, true);
  protected readonly leaveAnimation = (element: HTMLElement) => this.animate(element, false);

  private animate(element: HTMLElement, entering: boolean) {
    const from = entering ? '0' : '1';
    const to = entering ? '1' : '0';
    return createAnimation()
      .duration(entering ? 180 : 120)
      .easing('cubic-bezier(0.2, 0.8, 0.2, 1)')
      .addAnimation([
        createAnimation().addElement(element.shadowRoot!.querySelector('ion-backdrop')!).fromTo('opacity', from, to),
        createAnimation()
          .addElement(element.shadowRoot!.querySelector('.modal-wrapper')!)
          .beforeStyles({ transform: 'none' })
          .fromTo('opacity', from, to),
        createAnimation()
          .addElement(element.querySelectorAll('.panel'))
          .fromTo('transform', entering ? 'scale(0.96)' : 'scale(1)', entering ? 'scale(1)' : 'scale(0.96)'),
      ]);
  }

  protected emojis(defaults: readonly string[]) {
    return [...new Set([defaults[0], ...this.recent(), ...defaults])].slice(0, 5);
  }

  protected selected(emoji: string) {
    return !!this.serverMessage()?.reactions.find((reaction) => reaction.emoji === emoji)?.reactedByMe;
  }

  protected dismissBackdrop(event: MouseEvent) {
    if (event.target === event.currentTarget) void this.close();
  }

  open(selection: MessageMenuSelection) {
    if (this.busy() || this.selection()) return;
    const focused = this.document.activeElement;
    if (focused instanceof HTMLElement) focused.blur();
    this.choosingEmoji.set(false);
    this.placed.set(false);
    this.selection.set(selection);
  }

  reset() {
    this.version++;
    this.selection.set(undefined);
    this.confirmation.set(undefined);
    this.notice.set(undefined);
    this.pending.set(false);
    this.choosingEmoji.set(false);
  }

  protected async close() {
    const selection = this.selection();
    await this.modal()?.dismiss();
    if (this.selection() === selection) this.selection.set(undefined);
  }

  protected async choose(action: MessageAction) {
    const content = this.message();
    if (!content || this.busy()) return;
    const version = this.version;
    // Start clipboard writes in the click handler to retain Safari user activation.
    if (action === MessageAction.Copy) {
      if (!this.canCopy()) return;
      const text = messageParts(content.message!, content.mentions ?? [])
        .map((part) => part.text)
        .join('');
      void this.close();
      await this.perform(() => navigator.clipboard.writeText(text), MessageNotice.Copied);
      return;
    }
    const queued = this.queued();
    if (queued) {
      if (action === MessageAction.Recall) {
        void this.outbox.cancel(queued);
        await this.close();
      } else if (action === MessageAction.Edit && this.canEdit()) {
        await this.close();
        if (version === this.version && !queued.cancelled()) this.editQueued.emit(queued);
      }
      return;
    }
    const message = this.serverMessage();
    if (!message || (action === MessageAction.Pin && !this.admin())) return;
    if (action === MessageAction.Link) {
      const url = this.router.createUrlTree(
        ['/chats/chat', decodeId(this.chatId()), ...(this.threadId() ? ['thread', decodeId(this.threadId()!)] : [])],
        { queryParams: { message: decodeId(message.id) } },
      );
      const text = new URL(this.router.serializeUrl(url), this.document.baseURI).href;
      void this.close();
      await this.perform(() => navigator.clipboard.writeText(text), MessageNotice.Copied);
      return;
    }
    const pinned = this.pinned();
    await this.close();
    if (version !== this.version) return;
    switch (action) {
      case MessageAction.Reactions: {
        const modal = await this.modals.create({
          component: ReactionDetails,
          componentProps: { chatId: this.chatId(), messageId: message.id },
        });
        await modal.present();
        break;
      }
      case MessageAction.Edit:
        this.edit.emit(message);
        break;
      case MessageAction.Reply:
        if (this.canReply()) this.reply.emit(message);
        break;
      case MessageAction.Thread:
        this.openThread.emit(message.id);
        break;
      case MessageAction.Pin:
      case MessageAction.Recall:
        this.confirmation.set({ action, message, pinned });
        break;
      case MessageAction.Save:
        await this.perform(() => this.messageActions.save(message), MessageNotice.Saved);
        break;
    }
  }

  protected async confirm(event: CustomEvent<{ role?: string }>) {
    const pending = this.confirmation();
    this.confirmation.set(undefined);
    if (event.detail.role !== 'confirm' || !pending) return;
    if (pending.action === MessageAction.Recall && this.canRecallMessage(pending.message)) {
      await this.perform(() => this.messageActions.recall(pending.message), MessageNotice.Recalled);
    } else if (pending.action === MessageAction.Pin && this.admin()) {
      await this.perform(
        () => this.pins().set(pending.message, !pending.pinned),
        pending.pinned ? MessageNotice.Unpinned : MessageNotice.Pinned,
      );
    }
  }

  async reactTo(message: MessageResponse, emoji: string) {
    if (this.queued() || this.busy() || message.isDeleted) return;
    if (exceedsReactionLimit(message, emoji)) {
      this.notice.set(MessageNotice.ReactionLimit);
      return;
    }
    const version = this.version;
    void this.close();
    await this.perform(async () => {
      await this.messageActions.toggleReaction(message, emoji);
      if (version === this.version) this.preferences.rememberReaction(emoji);
    });
  }

  private canRecallMessage(message: MessageResponse) {
    return this.admin() || message.sender.uid === this.session.user()?.uid;
  }

  private async perform(operation: () => Promise<unknown>, success?: MessageNotice) {
    if (this.busy()) return;
    const version = this.version;
    this.pending.set(true);
    this.notice.set(undefined);
    try {
      await operation();
      if (version === this.version) this.notice.set(success);
    } catch {
      if (version === this.version) this.notice.set(MessageNotice.Failed);
    } finally {
      if (version === this.version) this.pending.set(false);
    }
  }
}

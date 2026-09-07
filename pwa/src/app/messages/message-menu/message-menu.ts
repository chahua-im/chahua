import { DOCUMENT } from '@angular/common';
import {
  afterRenderEffect,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { IonAlert, IonIcon, IonModal, IonSpinner, IonToast } from '@ionic/angular';
import {
  addOutline,
  arrowUndoOutline,
  bookmarkOutline,
  chatbubblesOutline,
  copyOutline,
  linkOutline,
  pinOutline,
  trashOutline,
} from 'ionicons/icons';
import { GroupRole, MessageType, type MessageResponse } from '../../../generated/models';
import { decodeId, type SnowflakeID } from '../../api/snowflake-id';
import { SessionStore } from '../../session/session-store';
import { ChatStore } from '../../chats/chat-store';
import { EmojiPicker } from '../emoji-picker/emoji-picker';
import { MessageActions } from '../message-actions';
import { MessageNotice } from '../message-notice';
import { Message, type MessageMenuSelection } from '../message/message';
import { exceedsReactionLimit } from '../reaction-state';

export enum MessageAction {
  Reply,
  Thread,
  Pin,
  Copy,
  Save,
  Link,
  Recall,
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
  readonly showAllAvatars = input(false);
  readonly reply = output<MessageResponse>();
  readonly openThread = output<SnowflakeID>();
  readonly messages = input.required<readonly MessageResponse[]>();
  protected readonly pins = computed(() => this.chatInfo.pins(this.chatId(), this.threadId()));
  private readonly chatInfo = inject(ChatStore);
  private readonly session = inject(SessionStore);
  private readonly messageActions = inject(MessageActions);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly modal = viewChild(IonModal);
  private version = 0;
  private readonly pending = signal(false);
  readonly busy = this.pending.asReadonly();
  protected readonly selection = signal<MessageMenuSelection | undefined>(undefined);
  protected readonly message = computed(() => {
    const id = this.selection()?.messageId;
    return this.messages().find((message) => message.id === id);
  });
  protected readonly admin = computed(() => this.chatInfo.get(this.chatId())?.myRole === GroupRole.admin);
  protected readonly pinned = computed(() => {
    const message = this.message();
    return !!message && !!this.pins().get(message.id);
  });
  protected readonly recent = signal<readonly string[]>([]);
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
  protected readonly position = signal({ left: 12, top: 12, width: 276, previewHeight: 300 });
  private readonly stack = viewChild<ElementRef<HTMLElement>>('stack');
  private readonly reactionBar = viewChild<ElementRef<HTMLElement>>('reactionBar');
  private readonly actions = viewChild<ElementRef<HTMLElement>>('actions');
  protected readonly canReact = computed(() => {
    const message = this.message();
    return (
      !!message &&
      !message.isDeleted &&
      message.messageType !== MessageType.sticker &&
      message.messageType !== MessageType.invite
    );
  });
  protected readonly canThread = computed(() => {
    const message = this.message();
    return (
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
    const message = this.message();
    return !!message && !message.isDeleted && ![MessageType.sticker, MessageType.invite].includes(message.messageType);
  });
  protected readonly canRecall = computed(() => {
    const message = this.message();
    return !!message && !message.isDeleted && this.canRecallMessage(message);
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.reset());
    afterRenderEffect((onCleanup) => {
      const stack = this.stack()?.nativeElement;
      if (!stack) return;
      const selection = this.selection()!;
      const own = selection.own;
      const bar = this.reactionBar()?.nativeElement;
      const actions = this.actions()?.nativeElement;
      const place = () => {
        const rect = selection.element.isConnected ? selection.element.getBoundingClientRect() : selection.rect;
        const viewport = window.visualViewport;
        const style = getComputedStyle(stack.parentElement!);
        const horizontalInset = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        const verticalInset = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
        const left = (viewport?.offsetLeft ?? 0) + parseFloat(style.paddingLeft) + 12;
        const top = (viewport?.offsetTop ?? 0) + parseFloat(style.paddingTop) + 12;
        const availableWidth = (viewport?.width ?? window.innerWidth) - horizontalInset - 24;
        const width = Math.min(Math.max(rect.width, 276), availableWidth);
        const height = (viewport?.height ?? window.innerHeight) - verticalInset - 24;
        const previewHeight = Math.max(
          0,
          height - (bar?.offsetHeight ?? 0) - (actions?.offsetHeight ?? 0) - (bar ? 16 : 8),
        );
        this.position.set({
          width,
          previewHeight,
          left: Math.max(left, Math.min(own ? rect.right - width : rect.left, left + availableWidth - width)),
          top: Math.max(top, Math.min(rect.top - (bar ? bar.offsetHeight + 8 : 0), top + height - stack.offsetHeight)),
        });
      };
      const observer = new ResizeObserver(place);
      observer.observe(stack);
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

  protected emojis(defaults: readonly string[]) {
    return [...new Set([defaults[0], ...this.recent(), ...defaults])].slice(0, 5);
  }

  protected selected(emoji: string) {
    return !!this.message()?.reactions.find((reaction) => reaction.emoji === emoji)?.reactedByMe;
  }

  protected dismissBackdrop(event: MouseEvent) {
    if (event.target === event.currentTarget) void this.close();
  }

  open(selection: MessageMenuSelection) {
    if (this.busy() || this.selection()) return;
    const focused = this.document.activeElement;
    if (focused instanceof HTMLElement) focused.blur();
    this.choosingEmoji.set(false);
    this.selection.set(selection);
    const version = this.version;
    void Promise.all([this.chatInfo.ensureDetails(this.chatId()), this.pins().ensure()]).catch(() => {
      if (version === this.version) this.notice.set(MessageNotice.MetadataFailed);
    });
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
    const message = this.message();
    if (!message || this.busy()) return;
    if (action === MessageAction.Pin && !this.admin()) return;
    const version = this.version;
    // Start clipboard writes in the click handler to retain Safari user activation.
    if (action === MessageAction.Copy || action === MessageAction.Link) {
      const url = this.router.createUrlTree(
        ['/chats/chat', decodeId(this.chatId()), ...(this.threadId() ? ['thread', decodeId(this.threadId()!)] : [])],
        { queryParams: { message: decodeId(message.id) } },
      );
      const text =
        action === MessageAction.Copy
          ? message.message!
          : new URL(this.router.serializeUrl(url), this.document.baseURI).href;
      void this.close();
      await this.perform(() => navigator.clipboard.writeText(text), MessageNotice.Copied);
      return;
    }
    const pinned = this.pinned();
    await this.close();
    if (version !== this.version) return;
    switch (action) {
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
    if (this.busy() || message.isDeleted) return;
    if (exceedsReactionLimit(message, emoji)) {
      this.notice.set(MessageNotice.ReactionLimit);
      return;
    }
    const version = this.version;
    void this.close();
    await this.perform(async () => {
      await this.messageActions.toggleReaction(message, emoji);
      if (version === this.version)
        this.recent.update((recent) => [emoji, ...recent.filter((item) => item !== emoji)].slice(0, 5));
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

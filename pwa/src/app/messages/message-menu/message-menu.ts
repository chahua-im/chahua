import { Router } from '@angular/router';
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
import { TranslocoPipe } from '@jsverse/transloco';
import { createAnimation, IonAlert, IonIcon, IonModal, IonSpinner, IonToast, isPlatform } from '@ionic/angular';
import {
  addOutline,
  arrowUndoOutline,
  arrowRedoOutline,
  checkboxOutline,
  bookmark,
  bookmarkOutline,
  chatbubblesOutline,
  chevronBackOutline,
  chevronDown,
  chevronUp,
  copyOutline,
  linkOutline,
  peopleOutline,
  createOutline,
  heart,
  heartOutline,
  pinOutline,
  trashOutline,
} from 'ionicons/icons';
import { GroupKind, GroupRole, MessageType, type MessageResponse } from '../../../generated/models';
import { copyText } from '../../api/clipboard';
import { decodeId, type SnowflakeID } from '../../api/snowflake-id';
import { ChatStore } from '../../chats/chat-store';
import { SpeakingAction } from '../../chats/speaking';
import { SessionStore } from '../../session/session-store';
import { Preferences } from '../../settings/preferences';
import { EmojiPicker } from '../emoji-picker/emoji-picker';
import { ForwardPicker } from '../forward-picker/forward-picker';
import { canForward, canSelect, type ForwardSource } from '../forwarding';
import { messageLink } from '../message-link';
import { MessageActions } from '../message-actions';
import { MessageNotice } from '../message-notice';
import { MessageOutbox, type OutgoingMessage } from '../message-outbox';
import { messageParts } from '../message-text/message-text';
import { Message, type MessageContent, type MessageMenuSelection } from '../message/message';
import { exceedsReactionLimit } from '../reaction-state';
import { SavedMessageStore } from '../saved-message-store';
import { StickerFavorites } from '../sticker-favorites';

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
  FavoriteSticker,
  Forward,
  Select,
}

const COLUMNS = 5;

export type MenuSlot =
  | { kind: 'action'; action: MessageAction; disabled: boolean; destructive: boolean }
  | { kind: 'paging'; direction: 'up' | 'down' };

/** Two rows of five; beyond ten actions the last slot pages through the remaining rows, up to eighteen. */
export function pageSlots(actions: readonly MenuSlot[], page: number): readonly MenuSlot[] {
  if (actions.length <= COLUMNS * 2) return actions;
  const rows = actions.length <= COLUMNS * 3 - 1 ? 3 : 4;
  const up = page > 0;
  const start = up ? (rows === 3 ? COLUMNS : COLUMNS * 2 - 1) : 0;
  const paging: MenuSlot = { kind: 'paging', direction: up ? 'up' : 'down' };
  const data = actions.slice(start, start + COLUMNS * 2 - 1);
  return up ? [...data.slice(0, COLUMNS - 1), paging, ...data.slice(COLUMNS - 1)] : [...data, paging];
}

@Component({
  selector: 'app-message-menu',
  templateUrl: './message-menu.html',
  styleUrl: './message-menu.scss',
  imports: [ForwardPicker, Message, EmojiPicker, IonAlert, IonIcon, IonModal, IonSpinner, IonToast, TranslocoPipe],
  providers: [MessageActions],
})
export class MessageMenu {
  readonly chatId = input.required<SnowflakeID>();
  readonly threadId = input<SnowflakeID>();
  readonly canReply = input(true);
  readonly reply = output<MessageResponse>();
  readonly edit = output<MessageResponse>();
  readonly allowSelect = input(false);
  readonly select = output<MessageResponse | OutgoingMessage>();
  protected readonly forwarding = signal<readonly ForwardSource[]>([]);
  readonly editQueued = output<OutgoingMessage>();
  readonly openThread = output<SnowflakeID>();
  readonly messages = input.required<readonly MessageResponse[]>();
  protected readonly pins = computed(() => this.chatInfo.pins(this.chatId(), this.threadId()));
  private readonly chatInfo = inject(ChatStore);
  private readonly session = inject(SessionStore);
  private readonly messageActions = inject(MessageActions);
  private readonly savedMessages = inject(SavedMessageStore);
  private readonly favoriteStickers = inject(StickerFavorites);
  private readonly outbox = inject(MessageOutbox);
  private readonly document = inject(DOCUMENT);
  private readonly modal = viewChild(IonModal);
  private readonly preview = viewChild<ElementRef<HTMLElement>>('preview');
  private version = 0;
  private readonly pending = signal(false);
  private readonly actingOn = signal<SnowflakeID | undefined>(undefined);
  readonly busy = this.pending.asReadonly();
  readonly busyMessageId = this.actingOn.asReadonly();
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
  private readonly chat = computed(() => this.chatInfo.get(this.chatId()));
  protected readonly admin = computed(() => this.chat()?.myRole === GroupRole.admin);
  protected readonly dm = computed(() => this.chat()?.kind === GroupKind.dm);
  /** A DM whose friendship ended keeps its history readable but accepts no writes. */
  private readonly readOnly = computed(() => {
    const uid = this.chat()?.peer?.uid;
    return this.dm() && !!uid && this.chatInfo.relationship(uid).value()?.canDm === false;
  });
  protected readonly pinned = computed(() => {
    const message = this.serverMessage();
    return !this.queued() && !!message && !!this.pins().get(message.id);
  });
  protected readonly saved = computed(() => {
    const message = this.serverMessage();
    return !this.queued() && !!message && this.savedMessages.isSaved(this.chatId(), message.id);
  });
  protected readonly favorited = computed(() => {
    const sticker = this.serverMessage()?.sticker;
    return !!sticker && this.favoriteStickers.isFavorite(sticker.id);
  });
  private readonly preferences = inject(Preferences);
  private readonly router = inject(Router);
  protected readonly recent = this.preferences.recentReactions;
  protected readonly pinnedReactions = this.preferences.pinnedReactions;
  protected readonly quickEmojis = computed(() =>
    [...this.pinnedReactions(), ...this.recent().filter((emoji) => !this.pinnedReactions().includes(emoji))].slice(
      0,
      5,
    ),
  );
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
  /** Recalling someone else's message names its author; recall of an own message confirms instead. */
  protected readonly recallAuthor = computed(() => {
    const sender = this.confirmation()?.message.sender;
    if (!sender || sender.uid === this.session.user()?.uid) return undefined;
    return sender.name ?? String(sender.uid);
  });
  protected readonly Action = MessageAction;
  protected readonly icons = { addOutline, chevronBackOutline, chevronDown, chevronUp };
  protected readonly actionIcons = computed<Record<MessageAction, string>>(() => ({
    [MessageAction.Forward]: arrowRedoOutline,
    [MessageAction.Select]: checkboxOutline,
    [MessageAction.Reply]: arrowUndoOutline,
    [MessageAction.Thread]: chatbubblesOutline,
    [MessageAction.Pin]: pinOutline,
    [MessageAction.Copy]: copyOutline,
    [MessageAction.Edit]: createOutline,
    [MessageAction.Save]: this.saved() ? bookmark : bookmarkOutline,
    [MessageAction.FavoriteSticker]: this.favorited() ? heart : heartOutline,
    [MessageAction.Link]: linkOutline,
    [MessageAction.Recall]: trashOutline,
    [MessageAction.Reactions]: peopleOutline,
  }));
  protected readonly choosingEmoji = signal(false);
  private readonly emojiAnchor = signal<{ x: number; y: number } | undefined>(undefined);
  private readonly emojiPanel = viewChild<ElementRef<HTMLElement>>('emojiPanel');
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
      !message.threadInfo &&
      this.chatInfo.canSpeak(this.chatId(), SpeakingAction.CreateThread)
    );
  });
  protected readonly canCopy = computed(() => {
    const message = this.message();
    return (
      !!message &&
      !message.isDeleted &&
      !!message.message?.trim() &&
      message.messageType !== MessageType.placeholder &&
      message.messageType !== MessageType.forwarded &&
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
      !message.forwardedFrom &&
      !this.queued()?.forwarding &&
      this.chatInfo.canSpeak(
        this.chatId(),
        message.replyRootId ? SpeakingAction.ThreadReply : SpeakingAction.ChatMessage,
      ) &&
      (!!this.queued() || message.sender.uid === this.session.user()?.uid)
    );
  });
  protected readonly canRecall = computed(() => {
    const message = this.serverMessage();
    return !!this.queued() || (!!message && !message.isDeleted && this.canRecallMessage(message));
  });
  /** Available actions in menu order; write actions drop out while a DM is read-only. */
  protected readonly menuActions = computed<readonly MenuSlot[]>(() => {
    const message = this.message();
    const slots: MenuSlot[] = [];
    const add = (action: MessageAction, options: { disabled?: boolean; destructive?: boolean } = {}) =>
      slots.push({
        kind: 'action',
        action,
        disabled: !!options.disabled,
        destructive: !!options.destructive,
      });
    const writable = !this.readOnly();
    if (!this.queued() && writable) add(MessageAction.Reply, { disabled: !this.canReply() });
    if (writable && this.canThread()) add(MessageAction.Thread);
    if (this.canCopy()) add(MessageAction.Copy);
    const source = this.queued() ? this.queued()!.confirmed() : this.serverMessage();
    if (source && canForward(source)) add(MessageAction.Forward);
    if (writable && this.canEdit()) add(MessageAction.Edit, { disabled: !this.queued() && !this.canReply() });
    if (this.canSave()) add(MessageAction.Save);
    else if (
      message &&
      !this.queued() &&
      !message.isDeleted &&
      message.messageType === MessageType.sticker &&
      message.sticker
    )
      add(MessageAction.FavoriteSticker, { disabled: this.favoriteStickers.loading() });
    if (this.allowSelect() && source && canSelect(source)) add(MessageAction.Select);
    if (this.canReact() && message?.reactions?.length) add(MessageAction.Reactions);
    if (message && !this.queued() && !this.dm() && message.messageType !== MessageType.invite) add(MessageAction.Link);
    // DMs let both participants manage shared pins; groups stay admin-only.
    if (
      message &&
      !this.queued() &&
      writable &&
      (this.admin() || this.dm()) &&
      message.messageType !== MessageType.sticker &&
      (this.pinned() || !message.isDeleted)
    )
      add(MessageAction.Pin, { disabled: this.pins().loading() || this.busy() });
    if (writable && this.canRecall()) add(MessageAction.Recall, { destructive: true });
    return slots;
  });
  private readonly page = signal(0);
  protected readonly slots = computed(() => pageSlots(this.menuActions(), this.page()));

  constructor() {
    inject(DestroyRef).onDestroy(() => this.reset());
    afterRenderEffect((onCleanup) => {
      const panel = this.emojiPanel()?.nativeElement;
      const anchor = this.emojiAnchor();
      if (!panel || !anchor) return;
      const surface = panel.parentElement!;
      const place = () => {
        const bounds = surface.getBoundingClientRect();
        const style = getComputedStyle(surface);
        const left = parseFloat(style.paddingLeft) + 12;
        const top = parseFloat(style.paddingTop) + 12;
        const right = bounds.width - parseFloat(style.paddingRight) - 12;
        const bottom = bounds.height - parseFloat(style.paddingBottom) - 12;
        panel.style.left = `${Math.max(left, Math.min(anchor.x - bounds.left, right - panel.offsetWidth))}px`;
        panel.style.top = `${Math.max(top, Math.min(anchor.y - bounds.top + 8, bottom - panel.offsetHeight))}px`;
        panel.style.transform = 'none';
      };
      const observer = new ResizeObserver(place);
      observer.observe(surface);
      observer.observe(panel);
      place();
      onCleanup(() => observer.disconnect());
    });
    effect(() => {
      if (this.queued() || !this.serverMessage()) return;
      untracked(() => {
        const version = this.version;
        // A missing saved-state read only costs the 收藏 label, so it stays out of the permission notice.
        void this.savedMessages.ensure(this.chatId()).catch(() => undefined);
        if (this.serverMessage()?.sticker) void this.favoriteStickers.ensure();
        void Promise.all([this.chatInfo.ensureDetails(this.chatId()), this.pins().ensure()]).catch(() => {
          if (version === this.version) this.notice.set(MessageNotice.MetadataFailed);
        });
      });
    });
    effect((onCleanup) => {
      const uid = this.chat()?.peer?.uid;
      if (this.selection() && uid) onCleanup(this.chatInfo.relationship(uid).activate());
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
      // When present, the overlay's sender row also appears for grouped messages.
      // Measure the complete author row once and widen the preview instead of eliding it.
      let nameWidth = 0;
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
        const avatarSpace = row.querySelector<HTMLElement>('.avatar-slot')!.offsetWidth;
        const baseWidth = rect.width + avatarSpace;
        if (!nameWidth) {
          const author = preview.querySelector<HTMLElement>('.sender');
          nameWidth = baseWidth;
          if (author) {
            author.style.width = 'max-content';
            const surfaceStyle = getComputedStyle(author.parentElement!);
            // Computed width keeps subpixels and ignores the preview's entrance transform.
            // Integer scroll/client widths can undercount enough to trigger an ellipsis.
            nameWidth = Math.ceil(
              avatarSpace +
                parseFloat(getComputedStyle(author).width) +
                parseFloat(surfaceStyle.paddingLeft) +
                parseFloat(surfaceStyle.paddingRight),
            );
            author.style.removeProperty('width');
          }
        }
        const previewWidth = Math.min(Math.max(baseWidth, nameWidth), availableWidth);
        preview.style.width = `${previewWidth}px`;
        stack.style.width = `${Math.min(Math.max(previewWidth, 276), availableWidth)}px`;
        const barHeight = bar?.offsetHeight ?? 0;
        const actionsHeight = actions?.offsetHeight ?? 0;
        const totalHeight = preview.offsetHeight + barHeight + actionsHeight + (bar ? 16 : 8);
        const anchored = totalHeight > availableHeight;
        stack.classList.toggle('anchored', anchored);
        const clampX = (x: number, width: number) => Math.max(left, Math.min(x, left + availableWidth - width));
        const clampY = (y: number, height: number) => Math.max(top, Math.min(y, top + availableHeight - height));
        // Adding the sender row must expand upward from the original content.
        const contentSelector = '.reply-preview, .media-content, .message-body';
        const sourceContent = selection.element.querySelector(contentSelector);
        const previewContent = preview.querySelector(contentSelector)!;
        const contentOffset = previewContent.getBoundingClientRect().top - preview.getBoundingClientRect().top;
        const previewTop = (sourceContent?.getBoundingClientRect().top ?? rect.top) - contentOffset;
        let x: number;
        let y: number;
        let fromY = 0;
        if (anchored) {
          // Keep the original message content in place; only the two panels follow the press.
          const width = Math.min(276, availableWidth);
          stack.style.width = `${width}px`;
          const point = selection.point ?? { x: own ? rect.right : rect.left, y: top + availableHeight / 2 };
          x = clampX(own ? point.x - width : point.x, width);
          y = clampY(point.y - (bar ? barHeight + 8 : 0), barHeight + actionsHeight + (bar ? 8 : 0));
          // Keep the whole preview, including the avatar column the chat may not have reserved, on screen.
          const previewLeft = clampX(
            own ? rect.right + avatarSpace - previewWidth : rect.left - avatarSpace,
            previewWidth,
          );
          preview.style.left = `${previewLeft - x}px`;
          preview.style.top = `${previewTop - y}px`;
        } else {
          const width = stack.offsetWidth;
          const originX = own ? rect.right + avatarSpace - width : rect.left - avatarSpace;
          const originY = previewTop - (bar ? barHeight + 8 : 0);
          x = originX;
          y = clampY(originY, totalHeight);
          fromY = originY - y;
          // Keep the avatar column the chat may not have reserved inside the safe area.
          const previewX = own ? x + width - previewWidth : x;
          preview.style.left = `${clampX(previewX, previewWidth) - previewX}px`;
          preview.style.removeProperty('top');
        }
        const surface = stack.parentElement!.getBoundingClientRect();
        stack.style.left = `${x - surface.left}px`;
        stack.style.top = `${y - surface.top}px`;
        // Preserve the message's horizontal position; each panel avoids the edges independently.
        const stackWidth = stack.offsetWidth;
        for (const panel of [bar, actions]) {
          if (!panel) continue;
          const panelX = own ? x + stackWidth - panel.offsetWidth : x;
          panel.style.left = `${clampX(panelX, panel.offsetWidth) - panelX}px`;
        }
        stack.style.setProperty('--menu-from', `translate(0px, ${fromY}px)`);
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
    const animation = createAnimation()
      .duration(entering ? 180 : 120)
      .easing('cubic-bezier(0.16, 1, 0.3, 1)')
      .addAnimation([
        createAnimation().addElement(element.shadowRoot!.querySelector('ion-backdrop')!).fromTo('opacity', from, to),
        createAnimation()
          .addElement(element.shadowRoot!.querySelector('.modal-wrapper')!)
          .beforeStyles({ transform: 'none' })
          .fromTo('opacity', from, to),
        createAnimation()
          .addElement(element.querySelectorAll('.panel, .preview'))
          .fromTo('transform', `scale(${entering ? 0.92 : 1})`, `scale(${entering ? 1 : 0.92})`),
      ]);
    if (entering) {
      animation.addAnimation(
        createAnimation()
          .addElement(element.querySelector('.menu-stack')!)
          .fromTo('transform', 'var(--menu-from, translate(0px, 0px))', 'translate(0px, 0px)'),
      );
    }
    return animation;
  }

  protected selected(emoji: string) {
    return !!this.serverMessage()?.reactions.find((reaction) => reaction.emoji === emoji)?.reactedByMe;
  }

  protected dismissBackdrop(event: MouseEvent) {
    if (event.target === event.currentTarget) void this.close();
  }

  protected turnPage() {
    this.page.update((page) => (page === 0 ? 1 : 0));
  }

  protected openEmojiPicker(event: MouseEvent) {
    const button = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.emojiAnchor.set(
      isPlatform('ios') || isPlatform('android')
        ? undefined
        : event.detail
          ? { x: event.clientX, y: event.clientY }
          : { x: button.x + button.width / 2, y: button.y + button.height / 2 },
    );
    this.choosingEmoji.set(true);
  }

  open(selection: MessageMenuSelection) {
    if (this.busy() || this.selection()) return;
    const focused = this.document.activeElement;
    if (focused instanceof HTMLElement) focused.blur();
    this.choosingEmoji.set(false);
    this.placed.set(false);
    this.page.set(0);
    this.selection.set(selection);
  }

  reset() {
    this.forwarding.set([]);
    this.version++;
    this.selection.set(undefined);
    this.confirmation.set(undefined);
    this.notice.set(undefined);
    this.pending.set(false);
    this.actingOn.set(undefined);
    this.choosingEmoji.set(false);
    this.page.set(0);
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
      await this.perform(() => copyText(text), MessageNotice.Copied);
      return;
    }
    const queued = this.queued();
    if (queued) {
      if (
        action === MessageAction.Select &&
        this.allowSelect() &&
        queued.confirmed() &&
        canSelect(queued.confirmed()!)
      ) {
        await this.close();
        if (version === this.version && !queued.cancelled()) this.select.emit(queued);
      } else if (action === MessageAction.Forward && queued.confirmed() && canForward(queued.confirmed()!)) {
        await this.close();
        if (version === this.version && !queued.cancelled()) this.forwarding.set([queued]);
      } else if (action === MessageAction.Recall) {
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
      const text = new URL(messageLink(this.chatId(), message.id), this.document.baseURI).href;
      void this.close();
      await this.perform(() => copyText(text), MessageNotice.Copied);
      return;
    }
    const pinned = this.pinned();
    const saved = this.saved();
    const favorited = this.favorited();
    await this.close();
    if (version !== this.version) return;
    switch (action) {
      case MessageAction.Forward:
        this.forwarding.set([message]);
        break;
      case MessageAction.Select:
        this.select.emit(message);
        break;
      case MessageAction.Reactions: {
        await this.router.navigate([
          '/chats/chat',
          decodeId(this.chatId()),
          'message',
          decodeId(message.id),
          'reactions',
        ]);
        break;
      }
      case MessageAction.Edit:
        if (
          this.chatInfo.canSpeak(
            this.chatId(),
            message.replyRootId ? SpeakingAction.ThreadReply : SpeakingAction.ChatMessage,
          )
        )
          this.edit.emit(message);
        break;
      case MessageAction.Reply:
        if (this.canReply()) this.reply.emit(message);
        break;
      case MessageAction.Thread:
        if (this.chatInfo.canSpeak(this.chatId(), SpeakingAction.CreateThread)) this.openThread.emit(message.id);
        break;
      case MessageAction.Pin:
      case MessageAction.Recall:
        this.confirmation.set({ action, message, pinned });
        break;
      case MessageAction.Save:
        await this.perform(
          async () => {
            await this.savedMessages.ensure(message.chatId);
            await (saved ? this.savedMessages.unsave(message) : this.savedMessages.save(message));
          },
          saved ? MessageNotice.Unsaved : MessageNotice.Saved,
        );
        break;
      case MessageAction.FavoriteSticker: {
        const sticker = message.sticker;
        if (sticker)
          await this.perform(
            () => this.favoriteStickers.set(sticker.id, !favorited),
            favorited ? MessageNotice.Unsaved : MessageNotice.Saved,
          );
        break;
      }
    }
  }

  protected async confirm(event: CustomEvent<{ role?: string }>) {
    const pending = this.confirmation();
    this.confirmation.set(undefined);
    if (event.detail.role !== 'confirm' || !pending) return;
    if (pending.action === MessageAction.Recall && this.canRecallMessage(pending.message)) {
      await this.perform(() => this.messageActions.recall(pending.message), MessageNotice.Recalled, pending.message.id);
    } else if (pending.action === MessageAction.Pin && this.admin()) {
      await this.perform(
        () => this.pins().set(pending.message, !pending.pinned),
        pending.pinned ? MessageNotice.Unpinned : MessageNotice.Pinned,
        pending.message.id,
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
    // The server refuses reactions in a read-only DM, so the tap only dismisses the menu.
    if (this.readOnly()) return;
    await this.perform(async () => {
      await this.messageActions.toggleReaction(message, emoji);
      if (version === this.version) this.preferences.rememberReaction(emoji);
    });
  }

  private canRecallMessage(message: MessageResponse) {
    return this.admin() || message.sender.uid === this.session.user()?.uid;
  }

  private async perform(operation: () => Promise<unknown>, success?: MessageNotice, messageId?: SnowflakeID) {
    if (this.busy()) return;
    const version = this.version;
    this.pending.set(true);
    this.actingOn.set(messageId);
    this.notice.set(undefined);
    try {
      await operation();
      if (version === this.version) this.notice.set(success);
    } catch {
      if (version === this.version) this.notice.set(MessageNotice.Failed);
    } finally {
      if (version === this.version) {
        this.pending.set(false);
        this.actingOn.set(undefined);
      }
    }
  }
}

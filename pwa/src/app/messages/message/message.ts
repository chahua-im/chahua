import { StartChat, StartChatKind } from '../../chats/start-chat/start-chat';
import { StickerPicker } from '../sticker-picker/sticker-picker';
import { MessageText } from '../message-text/message-text';
import { UserProfile } from '../../chats/user-profile/user-profile';
import { ModalController } from '@ionic/angular';
import { DatePipe } from '@angular/common';
import { Component, computed, DestroyRef, ElementRef, inject, input, output, signal } from '@angular/core';
import { IonAvatar, IonIcon, IonSpinner } from '@ionic/angular';
import { arrowUndoOutline } from 'ionicons/icons';
import { MessageType, type MessageResponse } from '../../../generated/models';
import { decodeId, type SnowflakeID } from '../../api/snowflake-id';
import { mediaOverlay } from '../media-overlay';
import { MessageAttachments, type MessageAttachmentSource } from '../message-attachments/message-attachments';
import { MessageAuthor } from '../message-author/message-author';
import { MessagePreview } from '../message-preview/message-preview';
import { MessageReactions } from '../message-reactions/message-reactions';
import { MessageThread } from '../message-thread/message-thread';
import { MessageDelivery, MessageStatus } from '../message-status';
import type { AttachmentUpload } from '../upload';
import { userColors } from '../user-colors';

export type MessageContent = MessageAttachmentSource &
  Pick<MessageResponse, 'sender' | 'message'> &
  Partial<
    Pick<
      MessageResponse,
      'id' | 'isEdited' | 'mentions' | 'isDeleted' | 'reactions' | 'replyRootId' | 'threadInfo' | 'replyToMessage'
    >
  >;

export interface MessageMenuSelection {
  messageId: SnowflakeID;
  element: HTMLElement;
  rect: DOMRect;
  first: boolean;
  last: boolean;
  own: boolean;
}

@Component({
  selector: 'app-message',
  templateUrl: './message.html',
  styleUrl: './message.scss',
  imports: [
    DatePipe,
    IonAvatar,
    IonIcon,
    IonSpinner,
    MessageAttachments,
    MessageText,
    MessageAuthor,
    MessagePreview,
    MessageReactions,
    MessageThread,
    MessageStatus,
  ],
  host: {
    '[attr.data-message-id]': 'messageId()',
    '[style.--sender-light]': 'senderColors().light',
    '[style.--sender-dark]': 'senderColors().dark',
    '[style.--reply-light]': 'replyColors().light',
    '[style.--reply-dark]': 'replyColors().dark',
  },
})
export class Message<T extends MessageContent = MessageResponse> {
  private readonly modals = inject(ModalController);
  protected async profile() {
    if (!this.canInteract()) return;
    const sender = this.message().sender;
    const modal = await this.modals.create({
      component: UserProfile,
      componentProps: { user: { ...sender, username: sender.name } },
    });
    await modal.present();
  }
  protected readonly messageId = computed(() => {
    const id = this.message().id;
    return id != null ? decodeId(id) : undefined;
  });
  readonly message = input.required<T>();
  protected readonly system = MessageType.system;
  protected readonly Type = MessageType;
  protected async invite(event: Event) {
    event.stopPropagation();
    if (!this.canInteract()) return;
    const modal = await this.modals.create({
      component: StartChat,
      componentProps: { kind: StartChatKind.Join, code: this.message().message ?? '' },
    });
    await modal.present();
  }
  protected async sticker(event: Event) {
    if (!this.isSticker() || !this.canInteract()) return;
    event.stopPropagation();
    const modal = await this.modals.create({
      component: StickerPicker,
      componentProps: { selectable: false, stickerId: this.message().sticker?.id },
    });
    await modal.present();
  }
  readonly own = input.required<boolean>();
  readonly first = input(true);
  readonly last = input(true);
  protected readonly showAvatar = computed(() => this.last() || this.showAllAvatars());
  readonly showAllAvatars = input(false);
  readonly preview = input(false);
  readonly interactive = input(true);
  protected readonly canInteract = computed(() => this.interactive() && !this.preview() && this.message().id != null);
  readonly delivery = input<MessageDelivery>();
  readonly uploads = input<readonly AttachmentUpload[]>([]);
  readonly retry = output<void>();
  protected readonly Delivery = MessageDelivery;
  protected readonly status = computed(() =>
    this.own() ? (this.delivery() ?? (this.message().id != null ? MessageDelivery.Sent : undefined)) : undefined,
  );
  readonly canReply = input(true);
  readonly canOpenThread = input(false);
  readonly reply = output<T>();
  readonly jumpingTo = input<SnowflakeID>();
  readonly jumpDisabled = input(false);
  readonly jump = output<SnowflakeID>();
  readonly openThread = output<SnowflakeID>();
  readonly menu = output<MessageMenuSelection>();
  readonly react = output<string>();
  private press?: { pointerId: number; x: number; y: number; timer: ReturnType<typeof setTimeout> };
  private longPressed = false;
  protected readonly swipe = signal(0);
  protected readonly dragging = signal(false);
  protected readonly burst = signal(false);
  private touch?: { x: number; y: number; horizontal: boolean };
  protected startSwipe(event: PointerEvent) {
    if (
      event.pointerType !== 'touch' ||
      !event.isPrimary ||
      !this.canReply() ||
      !this.canInteract() ||
      this.message().isDeleted
    )
      return;
    if ((event.target as HTMLElement).closest('audio, video')) return;
    this.longPressed = false;
    this.touch = { x: event.clientX, y: event.clientY, horizontal: false };
  }
  protected moveSwipe(event: PointerEvent) {
    this.movePress(event);
    const touch = this.touch;
    if (!touch) return;
    const dx = touch.x - event.clientX;
    const dy = Math.abs(event.clientY - touch.y);
    if (!touch.horizontal) {
      if (dy > 10 && dy >= Math.abs(dx)) {
        this.touch = undefined;
        return;
      }
      if (dx < 10 || dx <= dy) return;
      touch.horizontal = true;
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      this.cancelPress();
      this.dragging.set(true);
    }
    const offset = Math.max(0, Math.min(dx, 80));
    if (offset >= 60 && this.swipe() < 60) this.burst.set(true);
    this.swipe.set(offset);
  }
  protected endSwipe(cancelled = false) {
    this.cancelPress();
    if (this.touch?.horizontal) {
      this.longPressed = true;
      if (!cancelled && this.canInteract() && this.swipe() >= 60) this.reply.emit(this.message());
    }
    this.touch = undefined;
    this.dragging.set(false);
    this.swipe.set(0);
  }
  protected readonly name = computed(() => this.message().sender.name ?? String(this.message().sender.uid));
  protected readonly senderColors = computed(() => userColors(this.name()));
  protected readonly hasMedia = computed(() => {
    const message = this.message();
    return !message.isDeleted && (message.attachments.length > 0 || !!message.sticker);
  });
  protected readonly isSticker = computed(
    () => !this.message().isDeleted && this.message().messageType === MessageType.sticker,
  );
  protected readonly mediaOverlay = computed(() => !this.message().isDeleted && mediaOverlay(this.message()));
  protected readonly hasReactions = computed(() => !this.message().isDeleted && !!this.message().reactions?.length);
  protected readonly threadInfo = computed(() => {
    const message = this.message();
    return this.canOpenThread() && message.id != null && !message.isDeleted && !message.replyRootId
      ? message.threadInfo
      : undefined;
  });
  protected readonly quoted = computed(() => {
    const message = this.message();
    return message.isDeleted || message.replyToMessage?.isDeleted ? undefined : message.replyToMessage;
  });
  protected readonly quoteName = computed(() => {
    const sender = this.quoted()?.sender;
    return sender ? (sender.name ?? String(sender.uid)) : '';
  });
  protected readonly replyColors = computed(() => userColors(this.quoteName()));
  protected readonly replyIcon = arrowUndoOutline;

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const suppressClick = (event: MouseEvent) => {
      if (this.preview() || (this.longPressed && event.detail > 0)) {
        this.longPressed = false;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    host.addEventListener('click', suppressClick, true);
    inject(DestroyRef).onDestroy(() => {
      this.cancelPress();
      host.removeEventListener('click', suppressClick, true);
    });
  }

  protected showThread() {
    const id = this.message().id;
    if (this.canInteract() && id != null) this.openThread.emit(id);
  }

  protected showMenu(event: Event, element: HTMLElement) {
    if (!this.canInteract()) return;
    event.preventDefault();
    this.cancelPress();
    if (!this.longPressed) this.emitMenu(element);
  }

  protected startPress(event: PointerEvent, element: HTMLElement) {
    this.cancelPress();
    this.longPressed = false;
    if (!this.canInteract() || event.pointerType !== 'touch' || !event.isPrimary) return;
    this.press = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(() => {
        this.press = undefined;
        this.longPressed = true;
        this.emitMenu(element);
      }, 350),
    };
  }

  protected movePress(event: PointerEvent) {
    const press = this.press;
    if (
      press?.pointerId === event.pointerId &&
      (Math.abs(event.clientX - press.x) > 10 || Math.abs(event.clientY - press.y) > 10)
    ) {
      this.cancelPress();
    }
  }

  protected cancelPress() {
    clearTimeout(this.press?.timer);
    this.press = undefined;
  }

  private emitMenu(element: HTMLElement) {
    const message = this.message();
    if (!this.canInteract() || message.id == null || message.messageType === MessageType.system) return;
    this.menu.emit({
      messageId: message.id,
      element,
      rect: element.getBoundingClientRect(),
      first: this.first(),
      last: this.last(),
      own: this.own(),
    });
  }
}

import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, input, output, signal, viewChild } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonIcon,
  IonItem,
  IonItemOption,
  IonItemOptions,
  IonItemSliding,
  IonLabel,
  IonList,
  IonPopover,
  IonRouterLink,
  IonSpinner,
  IonText,
  isPlatform,
} from '@ionic/angular';
import { heartOutline, notificationsOffOutline } from 'ionicons/icons';
import { MessageDelivery } from '../../messages/message-delivery';
import { MessageStatus } from '../../messages/message-status/message-status';
import { ChatAvatar, type ChatAvatarData } from '../chat-avatar/chat-avatar';
import { ChatDatePipe } from '../chat-date.pipe';

export interface ChatListEntry extends ChatAvatarData {
  subtitle?: string;
  delivery?: MessageDelivery;
  read?: boolean;
  link?: string[];
  state?: Record<string, unknown>;
  sender?: string;
  time?: string;
  unreadCount?: number;
  unreadMentions?: number;
  unreadReactions?: number;
  unreadColor?: string;
  muted?: boolean;
}

export interface ChatListAction {
  label: string;
  icon: string;
  color?: string;
  run: () => void | Promise<unknown>;
}

@Component({
  selector: 'app-chat-list-item',
  templateUrl: './chat-list-item.html',
  styleUrl: './chat-list-item.scss',
  imports: [
    ChatDatePipe,
    ChatAvatar,
    MessageStatus,
    NgTemplateOutlet,
    RouterLink,
    RouterLinkActive,
    IonRouterLink,
    IonButton,
    IonButtons,
    IonIcon,
    IonBadge,
    IonItem,
    IonItemSliding,
    IonItemOptions,
    IonItemOption,
    IonLabel,
    IonList,
    IonPopover,
    IonText,
    IonSpinner,
    TranslocoPipe,
  ],
})
export class ChatListItem {
  protected readonly desktop = !isPlatform('ios') && !isPlatform('android');
  protected readonly mutedIcon = notificationsOffOutline;
  protected readonly reactionIcon = heartOutline;
  readonly entry = input.required<ChatListEntry>();
  readonly button = input(false);
  readonly online = input(false);
  readonly startActions = input<readonly ChatListAction[]>([]);
  readonly endActions = input<readonly ChatListAction[]>([]);
  readonly actionsAlwaysVisible = input(false);
  protected readonly menuEnabled = computed(
    () => this.desktop && !this.actionsAlwaysVisible() && !!(this.startActions().length || this.endActions().length),
  );
  protected readonly menuEvent = signal<MouseEvent | undefined>(undefined);
  readonly selected = output<void>();
  protected readonly pendingAction = signal<ChatListAction | undefined>(undefined);
  protected readonly error = signal(false);
  private readonly sliding = viewChild(IonItemSliding);
  private readonly menu = viewChild(IonPopover);

  protected openMenu(event: MouseEvent) {
    if (!this.menuEnabled()) return;
    event.preventDefault();
    event.stopPropagation();
    if (!this.pendingAction()) this.menuEvent.set(event);
  }

  protected async perform(action: ChatListAction, event: Event) {
    event.preventDefault();
    event.stopPropagation();
    if (this.pendingAction()) return;
    this.pendingAction.set(action);
    this.error.set(false);
    try {
      const menu = this.menu();
      if (menu) await menu.dismiss();
      await this.sliding()?.close();
      await action.run();
    } catch {
      this.error.set(true);
    } finally {
      this.pendingAction.set(undefined);
    }
  }
}

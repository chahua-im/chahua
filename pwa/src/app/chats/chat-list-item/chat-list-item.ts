import { NgTemplateOutlet } from '@angular/common';
import { Component, input, output, signal, viewChild } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
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
  IonRouterLink,
  IonSpinner,
  IonText,
} from '@ionic/angular';
import { ChatAvatar, type ChatAvatarData } from '../chat-avatar/chat-avatar';
import { ChatDatePipe } from '../chat-date.pipe';

export interface ChatListEntry extends ChatAvatarData {
  subtitle?: string;
  link?: string[];
  sender?: string;
  time?: string;
  unreadCount?: number;
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
    IonText,
    IonSpinner,
  ],
})
export class ChatListItem {
  readonly entry = input.required<ChatListEntry>();
  readonly startActions = input<readonly ChatListAction[]>([]);
  readonly endActions = input<readonly ChatListAction[]>([]);
  readonly actionsAlwaysVisible = input(false);
  readonly selected = output<void>();
  protected readonly pendingAction = signal<ChatListAction | undefined>(undefined);
  protected readonly error = signal(false);
  private readonly sliding = viewChild(IonItemSliding);

  protected async perform(action: ChatListAction, event: Event) {
    event.preventDefault();
    event.stopPropagation();
    if (this.pendingAction()) return;
    this.pendingAction.set(action);
    this.error.set(false);
    try {
      await this.sliding()?.close();
      await action.run();
    } catch {
      this.error.set(true);
    } finally {
      this.pendingAction.set(undefined);
    }
  }
}

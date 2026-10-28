import { NgComponentOutlet } from '@angular/common';
import {
  afterRenderEffect,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
  type Type,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { IonButton, IonContent, IonSpinner } from '@ionic/angular';
import { TranslocoPipe } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { ChatsService } from '../../generated/endpoints/chats/chats.service';
import { UsersService } from '../../generated/endpoints/users/users.service';
import { encodeId } from '../api/snowflake-id';
import { ChatDetails, DetailView } from '../chats/chat-details/chat-details';
import { StartChat, StartChatKind } from '../chats/start-chat/start-chat';
import { ConversationPage } from '../conversations/conversation/conversation.page';
import type { ViewerMedia } from '../messages/media-viewer/media-viewer';
import { StickerPicker } from '../messages/sticker-picker/sticker-picker';
import { panelRoutes } from '../panel-routes';
import { PanelNavigation, panelIdentity } from './panel-navigation';

@Component({
  selector: 'app-panel-page',
  host: { class: 'ion-page' },
  imports: [NgComponentOutlet, IonContent, IonSpinner, IonButton, TranslocoPipe],
  template: `
    @if (content(); as page) {
      <ng-container *ngComponentOutlet="page.component; inputs: inputs()" />
    } @else {
      <ion-content>
        @if (failed()) {
          <p class="ion-padding">{{ 'chats.link.failed' | transloco }}</p>
          <ion-button fill="clear" (click)="load()">{{ 'common.retry' | transloco }}</ion-button>
        } @else {
          <div class="loading-status"><ion-spinner /></div>
        }
        <ion-button fill="clear" (click)="panels.back()">{{ 'common.close' | transloco }}</ion-button>
      </ion-content>
    }
  `,
})
export class PanelPage {
  readonly path = input.required<string>();
  readonly active = input(true);
  readonly source = input<unknown>();
  protected readonly panels = inject(PanelNavigation);
  private readonly router = inject(Router);
  private readonly users = inject(UsersService);
  private readonly chats = inject(ChatsService);
  private readonly destroy = inject(DestroyRef);
  private readonly outlet = viewChild(NgComponentOutlet);
  protected readonly content = signal<{ component: Type<unknown>; props: Record<string, unknown> } | undefined>(
    undefined,
  );
  protected readonly failed = signal(false);
  protected readonly inputs = computed<Record<string, unknown>>(() => {
    let props = this.content()?.props ?? {};
    if (this.content()?.component === ChatDetails) props = { ...props, panelPath: panelIdentity(this.path()) };
    const source = this.source();
    if (this.content()?.component === ChatDetails && source instanceof ConversationPage) {
      const context = source.detailsContext();
      if (props['chatId'] === context.chatId && props['threadId'] === context.threadId) {
        props = { ...props, threadRoot: context.threadRoot ?? props['threadRoot'] };
      }
    }
    const view = this.router.parseUrl(this.path()).queryParams['view'];
    return view == null || this.content()?.component !== ChatDetails
      ? props
      : { ...props, view: /^\d+$/.test(view) ? Number(view) : view };
  });
  private version = 0;

  constructor() {
    effect(() => {
      this.path().split('?')[0];
      // The wrapper survives internal detail-page changes; the inputs update in place.
      if (!untracked(this.content)) untracked(() => void this.load());
    });
    let wasActive = false;
    let previousComponent: unknown;
    afterRenderEffect(() => {
      const active = this.active();
      const component = this.outlet()?.componentInstance as { panelResume?: () => void } | undefined;
      // Constructors load initially visible pages. Only an already mounted, hidden
      // page needs refreshing, including a parent first mounted from a copied chain.
      if (active && !wasActive && component && component === previousComponent)
        untracked(() => component.panelResume?.());
      wasActive = active && !!component;
      previousComponent = component;
    });
    this.destroy.onDestroy(() => this.version++);
  }

  protected async load() {
    const version = ++this.version;
    this.failed.set(false);
    const url = this.router.parseUrl(this.path());
    const segments = url.root.children['primary']?.segments.map((segment) => segment.path) ?? [];
    const params: Record<string, string> = {};
    const route = panelRoutes.find((route) => {
      const parts = route.path!.split('/');
      if (parts.length !== segments.length) return false;
      return parts.every((part, index) => part.startsWith(':') || part === segments[index]);
    });
    try {
      if (!route) throw new Error('Unknown panel');
      route.path!.split('/').forEach((part, index) => {
        if (part.startsWith(':')) params[part.slice(1)] = segments[index];
      });
      const data = route.data ?? {};
      let component = data['component'];
      const props: Record<string, unknown> = { ...data['props'] };
      const uid = Number(params['uid'] ?? url.queryParams['uid']);
      if (uid) {
        const response = await firstValueFrom(
          this.users.getUserSearch({ q: String(uid), limit: 20 }).pipe(takeUntilDestroyed(this.destroy)),
        );
        const user = response.members.find((user) => user.uid === uid);
        if (!user) throw new Error('User unavailable');
        component = ChatDetails;
        props['user'] = user;
      } else if (component) {
        for (const key of ['id', 'threadId', 'messageId', 'packId']) {
          if (params[key]) props[key === 'id' ? 'chatId' : key] = encodeId(params[key]);
        }
        if (params['id'] && params['threadId']) {
          const source = this.source();
          const context = source instanceof ConversationPage ? source.detailsContext() : undefined;
          props['threadRoot'] =
            context && context.chatId === props['chatId'] && context.threadId === props['threadId']
              ? context.threadRoot
              : undefined;
          props['threadRoot'] ??= await firstValueFrom(
            this.chats
              .getMessage(encodeId(params['id']), encodeId(params['threadId']))
              .pipe(takeUntilDestroyed(this.destroy)),
          );
        }
        if (data['media']) {
          const state = this.panels.state() as { media?: ViewerMedia[]; initial?: number };
          if (!state.media?.length) throw new Error('Media unavailable');
          props['media'] = state.media;
          props['initial'] = state.initial ?? 0;
        }
      } else if (params['packId'] || params['stickerId']) {
        component = StickerPicker;
        props['selectable'] = false;
        if (params['packId']) props['packId'] = encodeId(params['packId']);
        if (params['stickerId']) props['stickerId'] = encodeId(params['stickerId']);
      } else {
        component = StartChat;
        props['kind'] = data['kind'] ?? StartChatKind.Join;
        props['code'] = params['code'] ?? '';
      }
      if (component === ChatDetails) props['view'] ??= DetailView.Info;
      if (version === this.version && !this.destroy.destroyed) this.content.set({ component, props });
    } catch {
      if (version === this.version && !this.destroy.destroyed) this.failed.set(true);
    }
  }
}

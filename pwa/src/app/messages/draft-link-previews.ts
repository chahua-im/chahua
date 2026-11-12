import { Component, computed, DestroyRef, effect, inject, input, linkedSignal, model, untracked } from '@angular/core';
import { IonButton, IonIcon, IonModal, IonSpinner } from '@ionic/angular';
import { closeOutline, linkOutline } from 'ionicons/icons';
import { TranslocoPipe } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RpcApi } from '../../generated/rpc-api';
import {
  LinkPreviewInputStatus,
  LinkPreviewStatus,
  type LinkPreviewInput,
  type LinkPreviewResponse,
} from '../../generated/models';
import type { SnowflakeID } from '../api/snowflake-id';
import { MessageLinkPreviews } from './message-link-previews';
import { draftLinkUrls } from './draft-link-urls';

@Component({
  selector: 'app-draft-link-previews',
  imports: [IonButton, IonIcon, IonModal, IonSpinner, TranslocoPipe, MessageLinkPreviews],
  template: `
    <ion-modal
      class="draft-link-preview-modal"
      [isOpen]="open()"
      [keepContentsMounted]="true"
      [style.--preview-light]="colors()?.light"
      [style.--preview-dark]="colors()?.dark"
      (willDismiss)="open.set(false)"
    >
      <ng-template>
        <div class="dialog">
          <div class="heading">
            <div class="heading-text">
              <div class="title">
                <strong>{{ 'messages.linkDraft.title' | transloco }}</strong>
                <span class="count">{{ selected().length }}/{{ maxPreviews }}</span>
              </div>
            </div>
            <ion-button fill="clear" color="medium" (click)="open.set(false)"
              ><ion-icon slot="icon-only" [icon]="closeIcon"
            /></ion-button>
          </div>
          <div class="entries">
            @for (url of urls(); track url) {
              @let disabled = isDisabled(url);
              @let active = selected().includes(url);
              @let preview = results()[url];
              <div class="entry" [class.muted]="!active">
                <div class="content">
                  <a class="destination" [href]="url" [title]="url" target="_blank" rel="noopener noreferrer">
                    @if (preview?.status === Status.ready) {
                      <app-message-link-previews [previews]="[preview!]" [interactive]="false" />
                    } @else {
                      <div class="link-summary">
                        <span class="link-symbol">
                          @if (active && !preview) {
                            <ion-spinner name="circular" />
                          } @else {
                            <ion-icon [icon]="linkIcon" />
                          }
                        </span>
                        <div class="link-text">
                          <strong>{{ hostname(url) }}</strong>
                          <span class="url">{{ url }}</span>
                        </div>
                      </div>
                    }
                  </a>
                </div>
                <button
                  type="button"
                  class="preview-choice"
                  [class.chosen]="!disabled"
                  [class.waiting]="!disabled && !active"
                  [title]="(disabled ? 'messages.linkDraft.enable' : 'messages.linkDraft.disable') | transloco"
                  (click)="toggle(url)"
                >
                  <span class="choice-circle">
                    @if (!disabled) {
                      <svg viewBox="0 0 16 16"><path d="m3 8 3.2 3.2L13 4.5" /></svg>
                    }
                  </span>
                </button>
              </div>
            }
          </div>
        </div>
      </ng-template>
    </ion-modal>
  `,
  styles: `
    :host {
      display: contents;
    }
    ion-modal {
      --width: min(560px, calc(100vw - 32px));
      --height: auto;
      --border-radius: 16px;
      --message-accent: light-dark(
        var(--preview-light, var(--ion-color-primary)),
        var(--preview-dark, var(--ion-color-primary))
      );
      --message-accent-stripe: var(--message-accent);
      --message-accent-background: color-mix(in srgb, var(--message-accent) 10%, transparent);
      --message-accent-tile: color-mix(in srgb, var(--message-accent) 20%, transparent);
    }
    .dialog {
      display: flex;
      flex-direction: column;
      max-height: min(680px, 85dvh);
      padding: 16px;
      box-sizing: border-box;
    }
    .heading,
    .title {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .heading {
      justify-content: space-between;
      flex-shrink: 0;
      padding: 0 0 8px 4px;
    }
    .heading-text {
      min-width: 0;
    }
    .count {
      padding: 2px 6px;
      border-radius: 6px;
      background: var(--ion-background-color-step-100);
      color: var(--ion-color-medium);
      font-size: var(--app-font-caption);
      font-variant-numeric: tabular-nums;
    }
    .heading ion-button {
      flex-shrink: 0;
      margin: 0;
    }
    .entries {
      min-height: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    .entry {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 12px;
      padding: 10px 4px;
    }
    .entry + .entry {
      border-top: 1px solid var(--ion-background-color-step-100);
    }
    .content {
      min-width: 0;
    }
    .destination {
      display: block;
      color: inherit;
      text-decoration: none;
    }
    .muted .destination {
      opacity: 0.55;
    }
    .link-summary {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 48px;
      padding: 0 8px 0 11px;
    }
    .link-symbol {
      display: grid;
      place-items: center;
      flex: 0 0 36px;
      height: 36px;
      border-radius: 4px;
      background: var(--ion-background-color-step-100);
      color: var(--ion-color-medium);
    }
    .link-symbol ion-icon,
    ion-spinner {
      width: 20px;
      height: 20px;
    }
    .link-text {
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 0;
    }
    .link-text strong,
    .url {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .link-text strong {
      font-size: 14px;
      font-weight: 600;
    }
    .url {
      color: var(--ion-color-medium);
      font-size: var(--app-font-caption);
    }
    .preview-choice {
      display: grid;
      place-items: center;
      width: 40px;
      height: 40px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: var(--ion-color-medium);
      cursor: pointer;
    }
    .choice-circle {
      display: grid;
      place-items: center;
      width: 22px;
      height: 22px;
      box-sizing: border-box;
      border: 2px solid currentColor;
      border-radius: 50%;
    }
    .chosen {
      color: var(--ion-color-primary);
    }
    .waiting {
      color: var(--ion-color-medium);
    }
    .chosen .choice-circle {
      background: currentColor;
    }
    .choice-circle svg {
      width: 16px;
      height: 16px;
      fill: none;
      stroke: var(--ion-color-primary-contrast);
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .waiting svg {
      stroke: var(--ion-color-medium-contrast);
    }
    @media (hover: hover) {
      .preview-choice:hover {
        background: color-mix(in srgb, currentColor 10%, transparent);
      }
    }
    .preview-choice:active {
      background: color-mix(in srgb, currentColor 16%, transparent);
    }
  `,
})
export class DraftLinkPreviews {
  readonly chatId = input.required<SnowflakeID>();
  readonly scope = input.required<string>();
  readonly text = input('');
  readonly colors = input<{ light: string; dark: string }>();
  readonly automatic = input(false);
  readonly initial = input<readonly LinkPreviewResponse[]>([]);
  readonly choices = model<readonly LinkPreviewInput[]>([]);
  readonly open = model(false);
  protected readonly urls = computed(() => draftLinkUrls(this.text()));
  protected readonly Status = LinkPreviewStatus;
  protected readonly maxPreviews = 3;
  protected readonly closeIcon = closeOutline;
  protected readonly linkIcon = linkOutline;
  protected hostname(url: string) {
    return new URL(url).hostname;
  }
  private readonly api = inject(RpcApi);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly results = linkedSignal({
    source: this.scope,
    computation: (): Record<string, LinkPreviewResponse> =>
      Object.fromEntries(
        untracked(this.initial)
          .filter((p) => p.status === LinkPreviewStatus.ready || p.status === LinkPreviewStatus.unavailable)
          .map((p) => [p.url, p]),
      ),
  });
  private readonly pending = new Map<string, object>();
  protected readonly selected = computed(() =>
    this.urls()
      .filter((url) => !this.isDisabled(url))
      .slice(0, this.maxPreviews),
  );

  readonly firstReady = computed(() =>
    this.selected()
      .map((url) => this.results()[url])
      .find((preview) => preview?.status === LinkPreviewStatus.ready),
  );
  readonly fallbackUrl = computed(() =>
    this.firstReady()
      ? undefined
      : this.selected().find((url) => this.results()[url]?.status === LinkPreviewStatus.unavailable),
  );
  private readonly automaticUrl = computed(() => {
    for (const url of this.selected()) {
      const preview = this.results()[url];
      if (preview?.status === LinkPreviewStatus.ready) return undefined;
      if (!preview) return url;
    }
    return undefined;
  });

  constructor() {
    let previousText = '';
    let previousOpen = false;
    effect((onCleanup) => {
      const scope = this.scope();
      const urls = this.urls();
      const open = this.open();
      const selected = this.selected();
      const text = this.text();
      const automatic = this.automatic();
      const automaticUrl = automatic ? this.automaticUrl() : undefined;
      const typing = (automatic || (previousOpen && open)) && text !== previousText;
      previousText = text;
      previousOpen = open;
      untracked(() => {
        for (const url of this.pending.keys())
          if (!urls.some((candidate) => url === scope + candidate)) this.pending.delete(url);
        const retained = Object.fromEntries(Object.entries(this.results()).filter(([url]) => urls.includes(url)));
        if (Object.keys(retained).length !== Object.keys(this.results()).length) this.results.set(retained);
        if (!open && !automaticUrl) return;
        const targets = open ? selected : [automaticUrl!];
        const load = () => {
          for (const url of targets)
            if (!this.results()[url] && !this.pending.has(scope + url)) void this.load(scope, url);
        };
        if (typing) {
          const timer = setTimeout(load, 250);
          onCleanup(() => clearTimeout(timer));
        } else load();
      });
    });
  }

  snapshot(): LinkPreviewResponse[] {
    return this.urls()
      .filter((url) => this.isDisabled(url) || this.selected().includes(url))
      .map((url) =>
        this.isDisabled(url)
          ? { url, status: LinkPreviewStatus.disabled }
          : (this.results()[url] ?? {
              url,
              status: LinkPreviewStatus.pending,
              expiresAt: new Date(Date.now() + 30000).toISOString(),
            }),
      );
  }

  protected isDisabled(url: string) {
    return this.choices().some((p) => p.url === url && p.status === LinkPreviewInputStatus.disabled);
  }
  protected toggle(url: string) {
    const status = this.isDisabled(url) ? LinkPreviewInputStatus.enabled : LinkPreviewInputStatus.disabled;
    this.choices.set([...this.choices().filter((p) => p.url !== url), { url, status }]);
  }
  private async load(scope: string, url: string) {
    const request = {};
    const key = scope + url;
    this.pending.set(key, request);
    const isCurrent = () =>
      !this.destroyRef.destroyed &&
      this.scope() === scope &&
      this.pending.get(key) === request &&
      this.urls().includes(url);
    try {
      const previews = await firstValueFrom(
        this.api.messages
          .previewLinks({ chatId: this.chatId(), urls: [url] })
          .pipe(takeUntilDestroyed(this.destroyRef)),
      );
      if (isCurrent()) this.results.update((values) => ({ ...values, [url]: previews[0] }));
    } catch {
      if (isCurrent())
        this.results.update((values) => ({ ...values, [url]: { url, status: LinkPreviewStatus.unavailable } }));
    } finally {
      if (this.pending.get(key) === request) this.pending.delete(key);
    }
  }
}

import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { LinkPreviewStatus, type LinkPreviewResponse } from '../../generated/models';
import { internalHref } from './message-text/message-text';

@Component({
  selector: 'app-message-link-previews',
  template: `
    @for (preview of visible(); track preview.url) {
      @if (preview.status === status.pending) {
        <div class="card skeleton">
          <span class="thumbnail placeholder"></span>
          <span class="text"><span class="title placeholder"></span><span class="domain placeholder"></span></span>
        </div>
      } @else {
        @let host = hostname(preview.url);
        @if (interactive()) {
          <a
            class="card"
            [href]="preview.url"
            [attr.target]="internal(preview.url) ? null : '_blank'"
            [attr.rel]="internal(preview.url) ? null : 'noopener noreferrer'"
            (click)="follow(preview.url, $event)"
          >
            <ng-container [ngTemplateOutlet]="content" />
          </a>
        } @else {
          <div class="card"><ng-container [ngTemplateOutlet]="content" /></div>
        }
        <ng-template #content>
          @if (preview.image?.url && !failedImages().has(preview.image!.url)) {
            <span class="thumbnail">
              <img
                [src]="preview.image!.url"
                width="36"
                height="36"
                loading="lazy"
                decoding="async"
                (error)="imageFailed(preview.image!.url)"
              />
            </span>
          } @else {
            <span class="thumbnail letter">{{ host.charAt(0).toUpperCase() }}</span>
          }
          <span class="text"
            ><span class="title">{{ preview.title || host }}</span>
            @if (preview.description) {
              <span class="description">{{ preview.description }}</span>
            }
            <span class="domain">{{ host }}</span></span
          >
        </ng-template>
      }
    }
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    :host(:empty) {
      display: none;
    }
    .card {
      box-sizing: border-box;
      display: grid;
      grid-template-columns: var(--thumbnail-width, clamp(56px, 26%, 88px)) minmax(0, 1fr);
      align-items: center;
      gap: 8px;
      min-height: 48px;
      padding: 6px 8px;
      border-inline-start: 3px solid var(--stripe);
      border-radius: 4px;
      background: var(--background);
      color: inherit;
      text-decoration: none;
      min-width: 0;
    }
    .card + .card {
      margin-top: 4px;
    }
    :host {
      --preview-color: var(--ion-color-primary);
      --stripe: var(--preview-color);
      --background: color-mix(in srgb, var(--preview-color) 12%, transparent);
      --tile: color-mix(in srgb, var(--preview-color) 20%, transparent);
    }
    :host(:not(.standalone-card)) {
      --stripe: var(--message-accent-stripe);
      --background: var(--message-accent-background);
      --tile: var(--message-accent-tile);
    }
    .thumbnail {
      position: relative;
      min-width: 0;
      /* Two title lines, three description lines with margins, and one domain line. */
      height: var(--thumbnail-height, 106px);
      border-radius: 4px;
      overflow: hidden;
    }
    .thumbnail img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .letter {
      display: grid;
      place-items: center;
      background: var(--tile);
      font-weight: 600;
    }
    .text {
      display: flex;
      flex-direction: column;
      min-width: 0;
      justify-content: center;
      line-height: 16px;
    }
    .domain {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .title {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      overflow: hidden;
      overflow-wrap: anywhere;
      font-size: 14px;
      font-weight: 600;
    }
    :host(:not(.standalone-card)) .title {
      color: var(--message-accent);
    }
    .description {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 3;
      overflow: hidden;
      overflow-wrap: anywhere;
      margin: 2px 0;
      font-size: 13px;
      line-height: 18px;
    }
    .domain {
      font-size: 12px;
      opacity: 0.75;
    }
    .placeholder {
      display: block;
      background: var(--tile);
    }
    .text .placeholder {
      border-radius: 4px;
      height: 10px;
    }
    .skeleton .text .title {
      width: 75%;
      margin-bottom: 5px;
    }
    .skeleton .text .domain {
      width: 45%;
    }
    :host(.standalone-card) .card {
      --thumbnail-width: clamp(64px, 30%, 112px);
      --thumbnail-height: 114px;
      gap: 12px;
      min-height: 88px;
      padding: 14px 14px 36px;
      border: 1px solid var(--ion-color-light-shade);
      border-radius: 14px;
      background: var(--ion-background-color-step-50, var(--ion-background-color, var(--ion-color-light)));
      color: var(--ion-text-color, var(--ion-color-dark));
    }
    :host(.standalone-card) .title {
      line-height: 20px;
    }
  `,
  imports: [NgTemplateOutlet],
  host: { '[class.standalone-card]': 'standaloneCard()' },
})
export class MessageLinkPreviews {
  readonly previews = input.required<readonly LinkPreviewResponse[]>();
  readonly interactive = input(true);
  readonly standaloneCard = input(false);
  protected readonly status = LinkPreviewStatus;
  protected readonly failedImages = signal<ReadonlySet<string>>(new Set());
  private readonly expired = signal<ReadonlySet<string>>(new Set());
  private readonly deadlines = new Map<string, number>();
  private readonly router = inject(Router);

  private key(preview: LinkPreviewResponse): string {
    return JSON.stringify([preview.url, preview.expiresAt]);
  }

  protected readonly visible = computed(() =>
    this.previews()
      .filter(
        (preview) =>
          preview.status === LinkPreviewStatus.ready ||
          (preview.status === LinkPreviewStatus.pending &&
            Date.parse(preview.expiresAt ?? '') > Date.now() &&
            !this.expired().has(this.key(preview))),
      )
      .slice(0, 3),
  );

  constructor() {
    effect((onCleanup) => {
      const pending = this.previews().filter((preview) => preview.status === LinkPreviewStatus.pending);
      const keys = new Set(this.previews().map((preview) => this.key(preview)));
      for (const key of this.deadlines.keys()) {
        if (!keys.has(key)) this.deadlines.delete(key);
      }
      for (const preview of pending) {
        const key = this.key(preview);
        if (!this.deadlines.has(key)) {
          const delay = Math.max(0, Math.min((Date.parse(preview.expiresAt ?? '') || 0) - Date.now(), 30000));
          this.deadlines.set(key, performance.now() + delay);
        }
      }
      const previous = this.expired();
      const retained = new Set([...previous].filter((key) => keys.has(key)));
      if (retained.size !== previous.size) this.expired.set(retained);
      const next = pending
        .filter((preview) => !retained.has(this.key(preview)))
        .map((preview) => ({
          key: this.key(preview),
          delay: Math.max(0, this.deadlines.get(this.key(preview))! - performance.now()),
        }))
        .sort((a, b) => a.delay - b.delay)[0];
      if (!next) return;
      const timer = setTimeout(() => this.expired.update((expired) => new Set([...expired, next.key])), next.delay);
      onCleanup(() => clearTimeout(timer));
    });
  }

  protected hostname(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  protected internal(url: string): string | undefined {
    return internalHref(url);
  }

  protected follow(url: string, event: MouseEvent): void {
    event.stopPropagation();
    const internal = this.internal(url);
    if (!internal || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    void this.router.navigateByUrl(internal);
  }

  protected imageFailed(url: string): void {
    this.failedImages.update((failed) => new Set([...failed, url]));
  }
}

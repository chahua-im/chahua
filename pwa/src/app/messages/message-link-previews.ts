import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { LinkPreviewStatus, type LinkPreviewResponse } from '../../generated/models';
import { internalHref } from './message-text/message-text';

@Component({
  selector: 'app-message-link-previews',
  template: `
    <ng-template #skeleton>
      <div class="card skeleton">
        <span class="thumbnail placeholder"></span>
        <span class="text"><span class="title placeholder"></span><span class="domain placeholder"></span></span>
      </div>
    </ng-template>
    @if (loading()) {
      <ng-container [ngTemplateOutlet]="skeleton" />
    }
    @for (preview of visible(); track preview.url) {
      @if (preview.status === status.pending) {
        <ng-container [ngTemplateOutlet]="skeleton" />
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
      font-size: var(--app-chat-font-size, var(--app-font-body));
      line-height: var(--app-chat-line-height, var(--app-line-body));
    }
    :host(:empty) {
      display: none;
    }
    .card {
      box-sizing: border-box;
      display: flow-root;
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
      --stripe: var(--message-accent-stripe);
      --background: var(--message-accent-background);
      --tile: var(--message-accent-tile);
    }
    .thumbnail {
      position: relative;
      float: left;
      width: 36px;
      height: 36px;
      margin: 0 8px 4px 0;
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
      display: block;
    }
    .domain {
      display: block;
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
      font-weight: 600;
      color: var(--message-accent);
    }
    .description {
      display: block;
      max-height: 3lh;
      /* Clip without creating a formatting context, so lines wrap below the thumbnail. */
      overflow: clip;
      overflow-wrap: anywhere;
      margin: 2px 0;
      font-size: 0.75em;
      line-height: 1.333333;
    }
    .domain {
      font-size: 12px;
      line-height: 16px;
      text-align: left;
      opacity: 0.5;
    }
    .placeholder {
      display: block;
      background: var(--tile);
    }
    .text .placeholder {
      border-radius: 4px;
      height: 10px;
    }
    .skeleton .text {
      margin-left: 44px;
    }
    .skeleton .text .title {
      width: 75%;
      margin-bottom: 5px;
    }
    .skeleton .text .domain {
      width: 45%;
    }
  `,
  imports: [NgTemplateOutlet],
})
export class MessageLinkPreviews {
  readonly previews = input.required<readonly LinkPreviewResponse[]>();
  readonly interactive = input(true);
  readonly loading = input(false);
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

import { Component, input, model, output, signal } from '@angular/core';
import { IonIcon } from '@ionic/angular';
import { TranslocoPipe } from '@jsverse/transloco';
import { linkOutline } from 'ionicons/icons';
import type { InlineFormatKind } from './text-format';

export type ToolbarFormatKind = InlineFormatKind | 'code' | 'quote';

/** Viewport-space point the toolbar should hover above (textarea top-centre). */
export interface FormatToolbarAnchor {
  top: number;
  left: number;
}

/**
 * Floating formatting pill (bold / italic / strike / underline / code / quote /
 * link) shown next to the textarea while text is selected. Mousedowns are
 * prevented from defaulting so the textarea never loses its selection.
 */
@Component({
  selector: 'app-format-toolbar',
  imports: [IonIcon, TranslocoPipe],
  template: `
    <div
      class="toolbar"
      [style.top.px]="anchor().top"
      [style.left.px]="anchor().left"
      data-format-toolbar
      (mousedown)="$event.preventDefault()"
    >
      <button
        type="button"
        class="button"
        title="{{ 'messages.composer.format.bold' | transloco }}"
        data-format-bold
        (click)="format.emit('bold')"
      >
        <span class="bold-glyph">B</span>
      </button>
      <button
        type="button"
        class="button"
        title="{{ 'messages.composer.format.italic' | transloco }}"
        data-format-italic
        (click)="format.emit('italic')"
      >
        <span class="italic-glyph">I</span>
      </button>
      <button
        type="button"
        class="button"
        title="{{ 'messages.composer.format.strike' | transloco }}"
        data-format-strike
        (click)="format.emit('strike')"
      >
        <span class="strike-glyph">S</span>
      </button>
      <button
        type="button"
        class="button"
        title="{{ 'messages.composer.format.underline' | transloco }}"
        data-format-underline
        (click)="format.emit('underline')"
      >
        <span class="underline-glyph">U</span>
      </button>
      <button
        type="button"
        class="button"
        title="{{ 'messages.composer.format.code' | transloco }}"
        data-format-code
        (click)="format.emit('code')"
      >
        <span class="code-glyph">{{ codeGlyph }}</span>
      </button>
      <button
        type="button"
        class="button"
        title="{{ 'messages.composer.format.quote' | transloco }}"
        data-format-quote
        (click)="format.emit('quote')"
      >
        <span class="quote-glyph">&quot;</span>
      </button>
      <button
        type="button"
        class="button"
        title="{{ 'messages.composer.format.link' | transloco }}"
        [class.selected]="linkMode()"
        data-format-link
        (click)="openLinkMode()"
      >
        <ion-icon [icon]="icons.linkOutline" class="link-icon" />
      </button>

      @if (linkMode()) {
        <div class="popup" data-format-url-popup>
          <input
            #urlInput
            class="url-input"
            type="text"
            inputMode="url"
            placeholder="https://example.com"
            [value]="draftUrl()"
            (input)="draftUrl.set(urlInput.value)"
            (keydown)="urlKey($event)"
            data-format-url-input
          />
          <button type="button" class="popup-btn" (click)="apply()" data-format-url-apply>
            {{ 'common.add' | transloco }}
          </button>
          <button type="button" class="popup-cancel" (click)="linkMode.set(false)" data-format-url-cancel>
            {{ 'common.cancel' | transloco }}
          </button>
        </div>
      }
    </div>
  `,
  styles: `
    .toolbar {
      position: fixed;
      z-index: 2000;
      transform: translate(-50%, -100%);
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 4px 6px;
      background: var(--ion-item-background, var(--ion-background-color, #fff));
      border: 1px solid var(--ion-background-color-step-150, #e0e0e0);
      border-radius: 12px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.22);
    }

    .button {
      min-width: 34px;
      height: 30px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: none;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      color: var(--ion-text-color, #222);
      font-size: 15px;
      padding: 0 4px;

      &:hover,
      &.selected {
        background: var(--ion-background-color-step-100, #f0f0f0);
      }

      &:active {
        background: var(--ion-background-color-step-150, #e0e0e0);
      }
    }

    .bold-glyph {
      font-weight: 700;
    }

    .italic-glyph {
      font-style: italic;
      font-family: Georgia, 'Times New Roman', serif;
    }

    .strike-glyph {
      text-decoration: line-through;
    }

    .underline-glyph {
      text-decoration: underline;
      text-underline-offset: 2px;
    }

    .code-glyph {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      letter-spacing: -1px;
    }

    .quote-glyph {
      font-family: Georgia, 'Times New Roman', serif;
      font-size: 20px;
      font-weight: 700;
      line-height: 1;
    }

    .link-icon {
      font-size: 18px;
    }

    .popup {
      position: absolute;
      top: calc(100% + 6px);
      left: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px;
      background: var(--ion-item-background, var(--ion-background-color, #fff));
      border: 1px solid var(--ion-background-color-step-150, #e0e0e0);
      border-radius: 10px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.22);
    }

    .url-input {
      width: 180px;
      height: 30px;
      padding: 0 8px;
      border: 1px solid var(--ion-background-color-step-200, #ddd);
      border-radius: 8px;
      outline: none;
      font-size: 13px;
      background: var(--ion-background-color, #fff);
      color: var(--ion-text-color, #222);

      &:focus {
        border-color: var(--ion-color-primary, #3880ff);
      }
    }

    .popup-btn,
    .popup-cancel {
      height: 30px;
      min-width: 64px;
      padding: 0 12px;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 13px;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .popup-btn {
      background: var(--ion-color-primary, #3880ff);
      color: var(--ion-color-primary-contrast, #fff);
    }

    .popup-cancel {
      background: var(--ion-background-color-step-150, #e0e0e0);
      color: var(--ion-text-color, #222);
    }
  `,
})
export class FormatToolbar {
  readonly anchor = input.required<FormatToolbarAnchor>();
  readonly linkMode = model(false);
  readonly format = output<ToolbarFormatKind>();
  readonly submitLink = output<string>();

  protected readonly icons = { linkOutline };
  protected readonly codeGlyph = '</>';
  protected readonly draftUrl = signal('https://');

  protected openLinkMode() {
    this.draftUrl.set('https://');
    this.linkMode.set(true);
    const focusUrlInput = () => document.querySelector<HTMLInputElement>('[data-format-url-input]')?.focus();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focusUrlInput);
    else window.setTimeout(focusUrlInput, 0);
  }

  protected apply() {
    const url = this.draftUrl().trim();
    if (!url) return;
    this.submitLink.emit(url);
    this.linkMode.set(false);
  }

  protected urlKey(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.linkMode.set(false);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      this.apply();
    }
  }
}

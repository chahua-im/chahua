import { DOCUMENT } from '@angular/common';
import { Component, DestroyRef, effect, ElementRef, inject, input, output } from '@angular/core';
import type { MarkdownNode } from './nodes';

/**
 * Renders a {@link MarkdownNode} tree as DOM. Never uses HTML strings or
 * innerHTML, so raw HTML and unsafe payloads from the parser stay inert.
 * Interactive decisions (mention clickability, internal link targets) are made
 * by the caller that builds the tree; this component only wires the events.
 */
@Component({
  selector: 'app-markdown-body',
  template: '',
  styles: `
    :host {
      display: contents;
      min-width: 0;
      word-break: break-word;
      white-space: pre-wrap;

      p {
        margin: 0;
      }

      p + p {
        margin-top: 6px;
      }

      > * + * {
        margin-top: 6px;
      }

      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
        font-size: 0.92em;
        border-radius: 4px;
        padding: 0.5px 4px;
        word-break: break-all;
        background: rgba(var(--ion-text-color-rgb, 26, 26, 26), 0.08);
      }

      a {
        color: inherit;
        text-decoration: underline;
      }

      blockquote {
        margin: 4px 0;
        padding-left: 8px;
        border-left: 3px solid rgba(var(--ion-color-primary-rgb, 56, 128, 255), 0.5);
      }

      ul,
      ol {
        margin: 2px 0;
        padding-left: 22px;
      }

      li > p {
        margin: 0;
      }

      pre {
        margin: 6px 0;
        padding: 8px 10px;
        border-radius: 8px;
        overflow-x: auto;
        font-size: 0.92em;
        background: rgba(var(--ion-text-color-rgb, 26, 26, 26), 0.06);

        code {
          display: block;
          padding: 0;
          background: none;
          white-space: pre;
          word-break: normal;
        }
      }
    }

    // Sent bubbles are primary-colored, so accents come from the contrast color.
    :host-context(.sent) {
      code {
        background: rgba(var(--ion-color-primary-contrast-rgb, 255, 255, 255), 0.16);
      }

      pre {
        background: rgba(var(--ion-color-primary-contrast-rgb, 255, 255, 255), 0.12);
      }

      blockquote {
        border-left-color: rgba(var(--ion-color-primary-contrast-rgb, 255, 255, 255), 0.6);
      }
    }

    .mention {
      font-weight: 600;
      font-size: 0.9em;
      border-radius: 4px;
      padding: 1px 4px;
      margin: 0 -1px;
      white-space: nowrap;
      color: var(--ion-color-primary, #3880ff);
      background: rgba(var(--ion-color-primary-rgb, 56, 128, 255), 0.1);

      &.mention-self {
        background: rgba(var(--ion-color-primary-rgb, 56, 128, 255), 0.2);
      }
    }

    :host-context(.sent) .mention {
      color: var(--ion-color-primary-contrast, #fff);
      background: rgba(var(--ion-color-primary-contrast-rgb, 255, 255, 255), 0.18);

      &.mention-self {
        background: rgba(var(--ion-color-primary-contrast-rgb, 255, 255, 255), 0.28);
      }
    }
  `,
})
export class MarkdownBody {
  readonly nodes = input.required<readonly MarkdownNode[]>();
  readonly mention = output<number>();
  /** An anchor with an `internal` target was activated; the value is the in-app path. */
  readonly follow = output<string>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly document = inject(DOCUMENT);
  private readonly destroy = inject(DestroyRef);

  constructor() {
    effect(() => this.render(this.nodes()));
    this.destroy.onDestroy(() => this.render([]));
  }

  private render(nodes: readonly MarkdownNode[]) {
    const parent = this.host.nativeElement;
    parent.replaceChildren();
    for (const node of nodes) parent.append(this.build(node));
  }

  private build(node: MarkdownNode): Node {
    switch (node.type) {
      case 'text':
        return this.document.createTextNode(node.text);
      case 'mention': {
        const element = this.document.createElement(node.clickable ? 'button' : 'span');
        element.className = node.self ? 'mention mention-self' : 'mention';
        element.textContent = '@' + node.name;
        if (node.clickable) {
          element.addEventListener('click', (event) => {
            event.stopPropagation();
            this.mention.emit(node.uid);
          });
        }
        return element;
      }
      case 'widget':
        return this.build(node.node);
      default: {
        const element = this.document.createElement(node.tag);
        for (const [key, value] of Object.entries(node.attrs ?? {})) element.setAttribute(key, value);
        if (node.tag === 'a') {
          if (element.hasAttribute('internal')) {
            element.removeAttribute('internal');
            const target = element.getAttribute('href')!;
            element.addEventListener('click', (event) => {
              event.stopPropagation();
              event.preventDefault();
              this.follow.emit(target);
            });
          } else {
            element.addEventListener('click', (event) => event.stopPropagation());
          }
        }
        for (const child of node.children) element.append(this.build(child));
        return element;
      }
    }
  }
}

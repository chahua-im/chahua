import { afterRenderEffect, Component, DestroyRef, ElementRef, inject, input, output, Renderer2 } from '@angular/core';
import { translateSignal } from '@jsverse/transloco';
import { copyText } from '../api/clipboard';
import { attachScrollbars } from '../scrolling/overlay-scrollbars';
import { highlightCodeBlock } from './code-highlight';
import type { MarkdownNode } from './nodes';
import { SpoilerParticles } from './spoiler-particles';

/**
 * Renders a {@link MarkdownNode} tree as DOM using text nodes for user content.
 * Code blocks are then highlighted by highlight.js, which escapes their text.
 * Interactive decisions (mention clickability, internal link targets) are made
 * by the caller that builds the tree; this component only wires the events.
 */
@Component({
  selector: 'app-markdown-body',
  template: '',
  host: {
    '[class.blocks]': 'blocks()',
    '[class.summary]': 'summary()',
  },
  styleUrl: './markdown-body.scss',
})
export class MarkdownBody {
  readonly nodes = input.required<readonly MarkdownNode[]>();
  readonly blocks = input(false);
  readonly summary = input(false);
  readonly copyEnabled = input(true);
  readonly mention = output<number>();
  /** An anchor with an `internal` target was activated; the value is the in-app path. */
  readonly follow = output<string>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly renderer = inject(Renderer2);
  private readonly destroy = inject(DestroyRef);

  private readonly copyLabel = translateSignal('messages.menu.actions.copy');
  private readonly copiedLabel = translateSignal('messages.menu.notice.copied');
  private readonly failedLabel = translateSignal('messages.menu.notice.failed');
  private readonly spoilers: SpoilerParticles[] = [];
  private readonly copyResets = new Map<HTMLButtonElement, number>();

  constructor() {
    afterRenderEffect((onCleanup) => {
      this.render(this.nodes());
      const scrollbars = [...this.host.nativeElement.querySelectorAll('pre')].map((element) =>
        attachScrollbars(element),
      );
      onCleanup(() => scrollbars.forEach((instance) => instance.destroy()));
    });
    this.destroy.onDestroy(() => this.render([]));
  }

  private render(nodes: readonly MarkdownNode[]) {
    for (const timer of this.copyResets.values()) window.clearTimeout(timer);
    this.copyResets.clear();
    for (const spoiler of this.spoilers) spoiler.destroy();
    this.spoilers.length = 0;
    const parent = this.host.nativeElement;
    parent.replaceChildren();
    for (const node of nodes) parent.append(this.build(node));
  }

  private build(node: MarkdownNode): Node {
    switch (node.type) {
      case 'text':
        return this.renderer.createText(node.text);
      case 'mention': {
        const element: HTMLElement = this.renderer.createElement(node.clickable ? 'button' : 'span');
        if (node.clickable) element.setAttribute('type', 'button');
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
        const element: HTMLElement = this.renderer.createElement(node.tag);
        for (const [key, value] of Object.entries(node.attrs ?? {})) element.setAttribute(key, value);
        if (node.tag === 'a') {
          if (element.hasAttribute('internal')) {
            const target = element.getAttribute('internal')!;
            element.removeAttribute('internal');
            element.addEventListener('click', (event) => {
              event.stopPropagation();
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              this.follow.emit(target);
            });
          } else {
            element.addEventListener('click', (event) => event.stopPropagation());
          }
        }
        for (const child of node.children) element.append(this.build(child));
        if (node.tag === 'pre') {
          const code = element.querySelector('code')!;
          const language = code.className.replace(/^language-/, '');
          highlightCodeBlock(code);
          return this.buildCodeBlock(element, code.textContent ?? '', language);
        }
        if (node.attrs?.['class'] === 'spoiler') {
          const content: HTMLElement = this.renderer.createElement('span');
          content.className = 'spoiler-content';
          content.append(...element.childNodes);
          const canvas: HTMLCanvasElement = this.renderer.createElement('canvas');
          canvas.className = 'spoiler-canvas';
          element.append(content, canvas);
          const particles = new SpoilerParticles(element, canvas, this.host.nativeElement);
          this.spoilers.push(particles);
          element.addEventListener(
            'click',
            (event) => {
              if (this.summary()) return;
              if (!element.classList.contains('revealed')) {
                event.stopPropagation();
                event.preventDefault();
                particles.reveal();
              } else if (!(event.target as Element).closest('a, button')) {
                event.stopPropagation();
                particles.hide();
              }
            },
            { capture: true },
          );
        }
        return element;
      }
    }
  }

  private buildCodeBlock(pre: HTMLElement, text: string, language: string): HTMLElement {
    const block: HTMLElement = this.renderer.createElement('div');
    block.className = 'code-block';
    const header: HTMLElement = this.renderer.createElement('div');
    header.className = 'code-header';
    const label: HTMLElement = this.renderer.createElement('span');
    label.textContent = language;
    const button: HTMLButtonElement = this.renderer.createElement('button');
    button.type = 'button';
    button.className = 'code-copy';
    button.disabled = !this.copyEnabled() || this.summary();
    const copyLabel = this.copyLabel();
    const copiedLabel = this.copiedLabel();
    const failedLabel = this.failedLabel();
    button.title = copyLabel;
    const svg = this.renderer.createElement('svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = this.renderer.createElement('path', 'svg');
    const copyPath = 'M9 5H5v14h10v-4M9 3h10v12H9z';
    path.setAttribute('d', copyPath);
    svg.append(path);
    button.append(svg);
    button.addEventListener('pointerdown', (event) => event.stopPropagation());
    button.addEventListener('contextmenu', (event) => event.stopPropagation());
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      window.clearTimeout(this.copyResets.get(button));
      this.copyResets.delete(button);
      button.disabled = true;
      try {
        await copyText(text);
        if (!block.isConnected) return;
        path.setAttribute('d', 'm5 12 4 4L19 6');
        button.title = copiedLabel;
        this.copyResets.set(
          button,
          window.setTimeout(() => {
            path.setAttribute('d', copyPath);
            button.title = copyLabel;
            this.copyResets.delete(button);
          }, 3000),
        );
      } catch {
        path.setAttribute('d', 'M12 8v5m0 3v.01M12 3 2 21h20z');
        button.title = failedLabel;
      } finally {
        button.disabled = !this.copyEnabled() || this.summary();
      }
    });
    header.append(label, button);
    block.append(header, pre);
    return block;
  }
}

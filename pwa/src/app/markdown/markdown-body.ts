import { Component, DestroyRef, effect, ElementRef, inject, input, output, Renderer2 } from '@angular/core';
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
  readonly mention = output<number>();
  /** An anchor with an `internal` target was activated; the value is the in-app path. */
  readonly follow = output<string>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly renderer = inject(Renderer2);
  private readonly destroy = inject(DestroyRef);

  private readonly spoilers: SpoilerParticles[] = [];

  constructor() {
    effect(() => this.render(this.nodes()));
    this.destroy.onDestroy(() => this.render([]));
  }

  private render(nodes: readonly MarkdownNode[]) {
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
        if (node.tag === 'pre') {
          for (const code of element.querySelectorAll('code')) highlightCodeBlock(code);
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
}

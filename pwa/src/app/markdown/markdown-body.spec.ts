import { vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { MarkdownBody } from './markdown-body';
import { renderMarkdownText } from './nodes';

describe('MarkdownBody presentation', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  function render(text: string) {
    const fixture = TestBed.createComponent(MarkdownBody);
    fixture.componentRef.setInput('nodes', renderMarkdownText(text));
    fixture.detectChanges();
    return fixture;
  }

  it('applies component styles to dynamically rendered descendants', () => {
    const fixture = render('> **quote**\n\n```\ncode\n```');
    const host = fixture.nativeElement as HTMLElement;
    const scope = host
      .querySelector('blockquote')!
      .getAttributeNames()
      .find((name) => name.startsWith('_ngcontent-'));
    expect(scope).toBeDefined();
    for (const element of host.querySelectorAll('*')) expect(element.hasAttribute(scope!)).toBe(true);
  });

  it('reveals a hidden link before allowing navigation', () => {
    const fixture = render('||[secret](https://example.com/secret)||');
    const host = fixture.nativeElement as HTMLElement;
    const spoiler = host.querySelector('.spoiler')!;
    const link = host.querySelector('a')!;
    let followed = 0;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      followed++;
    });
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(spoiler.classList.contains('revealed')).toBe(true);
    expect(followed).toBe(0);
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(followed).toBe(1);
    spoiler.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(spoiler.classList.contains('revealed')).toBe(false);
  });
});

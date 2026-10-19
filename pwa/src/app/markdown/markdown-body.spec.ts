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

  it('highlights a language alias while preserving code text and escaping HTML', () => {
    const code = 'const html = "<img src=x onerror=alert(1)>";\n';
    const fixture = render('```js\n' + code + '```');
    const element = (fixture.nativeElement as HTMLElement).querySelector('pre code')!;
    expect(element.querySelector('.hljs-keyword')?.textContent).toBe('const');
    expect(element.textContent).toBe(code);
    expect(element.querySelector('img')).toBeNull();

    fixture.componentRef.setInput('nodes', renderMarkdownText('```rust\nlet value = 42;\n```'));
    fixture.detectChanges();
    const updated = (fixture.nativeElement as HTMLElement).querySelector('pre code')!;
    expect(updated.querySelector('.hljs-keyword')?.textContent).toBe('let');
    expect(updated.textContent).toBe('let value = 42;\n');
  });

  it.each(['', 'unknown-language', 'text'])('keeps %s code blocks plain', (language) => {
    const fixture = render('```' + language + '\nconst value = 42;\n```');
    const code = (fixture.nativeElement as HTMLElement).querySelector('pre code')!;
    expect(code.querySelector('span')).toBeNull();
    expect(code.textContent).toBe('const value = 42;\n');
  });

  it('keeps inline code plain', () => {
    const fixture = render('`const value = 42;`');
    expect((fixture.nativeElement as HTMLElement).querySelector('.hljs')).toBeNull();
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

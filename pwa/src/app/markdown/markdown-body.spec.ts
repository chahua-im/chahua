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
      .querySelector('p')!
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

  it('copies only the chosen block verbatim without opening the message menu', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const code = '\tconst html = "<b>raw</b>";  \n\n// **literal** @[uid:2]\n';
    const fixture = render('```js\n' + code + '```\n```\nsecond\n```');
    const host = fixture.nativeElement as HTMLElement;
    const outerClick = vi.fn();
    const outerPointer = vi.fn();
    host.addEventListener('click', outerClick);
    host.addEventListener('pointerdown', outerPointer);
    const buttons = host.querySelectorAll<HTMLButtonElement>('.code-copy');
    buttons[0].dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    buttons[0].click();
    expect(writeText).toHaveBeenCalledWith(code);
    await vi.waitFor(() => expect(buttons[0].disabled).toBe(false));
    buttons[1].click();
    expect(writeText).toHaveBeenLastCalledWith('second\n');
    expect(outerClick).not.toHaveBeenCalled();
    expect(outerPointer).not.toHaveBeenCalled();
  });

  it('allows retry after clipboard failure and confirms only a successful write', async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const fixture = render('```text\nretry\n```');
    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.code-copy')!;
    button.click();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    const failureIcon = button.querySelector('path')!.getAttribute('d');
    button.click();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(button.querySelector('path')!.getAttribute('d')).not.toBe(failureIcon);
  });

  it('does not copy from an inactive preview', () => {
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const fixture = render('```js\ncode\n```');
    fixture.componentRef.setInput('copyEnabled', false);
    fixture.detectChanges();
    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.code-copy')!;
    button.click();
    expect(writeText).not.toHaveBeenCalled();
  });
  it('keeps inline code plain', () => {
    const fixture = render('`const value = 42;`');
    expect((fixture.nativeElement as HTMLElement).querySelector('.hljs')).toBeNull();
  });

  it('breaks bare URLs more freely while preserving link labels, code and the original address', () => {
    const url = 'https://example.com/longpathname?token=abcdefghijklmnopqrstuvwxyz&view=full#details';
    const fixture = render(`看看这个链接：${url}\n[查看文档](${url})\n\`${url}\`\n\n\`\`\`\n${url}\n\`\`\``);
    const host = fixture.nativeElement as HTMLElement;
    const [raw, labeled] = host.querySelectorAll('a');
    expect(getComputedStyle(raw).wordBreak).toBe('break-all');
    expect(raw.textContent).toBe(url);
    expect(raw.getAttribute('href')).toBe(url);
    expect(getComputedStyle(labeled).wordBreak).not.toBe('break-all');
    expect(labeled.textContent).toBe('查看文档');
    expect(labeled.getAttribute('href')).toBe(url);
    expect(host.querySelectorAll('.raw-url')).toHaveLength(1);
    expect(host.querySelector('code')?.textContent).toBe(url);
    expect(host.querySelector('pre code')?.textContent).toBe(url + '\n');
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

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { MentionInfo } from '../../../generated/models';

import { MarkdownSummary } from './markdown-summary';

describe('MarkdownSummary', () => {
  let fixture: ComponentFixture<MarkdownSummary>;
  beforeEach(() => {
    fixture = TestBed.createComponent(MarkdownSummary);
  });
  function render(text: string, mentions: readonly MentionInfo[] = []) {
    fixture.componentRef.setInput('text', text);
    fixture.componentRef.setInput('mentions', mentions);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('renders inline Markdown (bold/italic/strikethrough/code) without raw syntax', () => {
    const element = render('**粗**、__斜__、~~删~~、`code`');

    expect(element.querySelector('strong')?.textContent).toBe('粗');
    expect(element.querySelector('em')?.textContent).toBe('斜');
    expect(element.querySelector('s')?.textContent).toBe('删');
    expect(element.querySelector('code')?.textContent).toBe('code');
    expect(element.textContent).not.toContain('**');
    expect(element.textContent).not.toContain('~~');
    expect(element.textContent).toBe('粗、斜、删、code');
  });

  it('flattens block Markdown into a single inline line (no block elements, no <br>)', () => {
    const element = render('# 标题\n\n- 项一\n- 项二\n\n1. 甲\n2. 乙');

    for (const tag of ['p', 'h1', 'h2', 'ul', 'ol', 'li', 'pre', 'blockquote', 'hr', 'br']) {
      expect(element.querySelector(tag)).toBeNull();
    }
    // Heading is out of the subset and stays literal; lists keep their prefixes.
    expect(element.querySelector('strong')).toBeNull();
    expect(element.textContent).toContain('# 标题');
    expect(element.textContent).toContain('项一');
    expect(element.textContent).toContain('• 项二');
    expect(element.textContent).toContain('1. 甲');
    expect(element.textContent).toContain('2. 乙');
  });

  it('renders link labels without interactive anchors', () => {
    const element = render('去 [链接](https://example.com) 看 https://auto.example/a');

    const anchors = Array.from(element.querySelectorAll('a'));
    expect(anchors).toEqual([]);
    expect(element.textContent).toBe('去 链接 看 https://auto.example/a');
    expect(element.textContent).not.toContain('[链接]');
  });

  it('renders Markdown next to a literal attachment label prefix', () => {
    const element = render('[图片] **新的设计** 已上传');

    expect(element.textContent).toContain('[图片]');
    expect(element.querySelector('strong')?.textContent).toBe('新的设计');
    expect(element.textContent).not.toContain('**');
  });

  it('resolves mention macros to display names and keeps code regions verbatim', () => {
    const element = render('叫 @[uid:2] 看 `@[uid:2]`', [{ uid: 2, username: '小花', gender: 0 }]);

    expect(element.textContent).toContain('叫 @小花 看');
    expect(element.querySelector('code')?.textContent).toBe('@[uid:2]');
  });

  it.each(['`hello\n@[uid:2]`', '> ```\n> @[uid:2]\n> ```', '- ```\n  @[uid:2]\n  ```', '```\n```oops\n@[uid:2]\n```'])(
    'preserves code mentions in previews: %s',
    (source) => {
      const element = render(source + '\n\n@[uid:2]', [{ uid: 2, username: '小花', gender: 0 }]);
      expect(element.querySelector('code')?.textContent).toContain('@[uid:2]');
      expect(element.textContent).toContain('@小花');
    },
  );

  it('keeps marker-free text on the plain path without wrapping elements', () => {
    const element = render('5 * 3 * 4 和 1.2 段落');

    expect(element.textContent).toBe('5 * 3 * 4 和 1.2 段落');
    expect(element.querySelector('strong')).toBeNull();
    expect(element.querySelector('em')).toBeNull();
  });

  it('keeps spoilers masked in single-line previews without intercepting the parent click', () => {
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
    try {
      const element = render('前文 ||**秘密** [链接](https://example.com)\n第二行|| 后文');
      const spoiler = element.querySelector<HTMLElement>('.spoiler')!;
      expect(spoiler).not.toBeNull();
      expect(spoiler.querySelector('canvas.spoiler-canvas')).not.toBeNull();
      expect(spoiler.querySelector('.spoiler-content')?.textContent).toBe('秘密 链接 第二行');
      expect(element.querySelector('br')).toBeNull();
      const openPreview = vi.fn();
      element.addEventListener('click', openPreview);
      spoiler.click();
      expect(spoiler.classList.contains('revealed')).toBe(false);
      expect(openPreview).toHaveBeenCalledTimes(1);
    } finally {
      fixture.destroy();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it.each(['a||', '__小花__', '**名字**', '`name`', '[name](https://example.com)'])(
    'keeps mention name %s literal inside the spoiler',
    (username) => {
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
      try {
        const element = render('||@[uid:2] secret|| after', [{ uid: 2, username, gender: 0 }]);
        expect(element.querySelectorAll('.spoiler')).toHaveLength(1);
        expect(element.querySelector('.spoiler-content')?.textContent).toBe('@' + username + ' secret');
        expect(element.textContent).toBe('@' + username + ' secret after');
        expect(element.querySelector('.spoiler-content')?.querySelector('em, strong, code, a')).toBeNull();
      } finally {
        fixture.destroy();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      }
    },
  );

  it('does not interpret Markdown syntax introduced by names in a plain summary', () => {
    const element = render('call @[uid:2]', [{ uid: 2, username: '__名字__', gender: 0 }]);
    expect(element.textContent).toBe('call @__名字__');
    expect(element.querySelector('em')).toBeNull();
  });

  it('renders nothing for an empty string', () => {
    const element = render('');

    expect(element.textContent).toBe('');
  });
});

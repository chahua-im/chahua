import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownSummaryText } from './MarkdownSummaryText';

const featureMocks = vi.hoisted(() => ({
  isFeatureEnabled: vi.fn<(name: string) => boolean>(),
}));

vi.mock('@/features', () => ({
  isFeatureEnabled: featureMocks.isFeatureEnabled,
}));

let container: HTMLDivElement;
let root: Root;

function render(text: string, maxLength?: number) {
  act(() => {
    root.render(<MarkdownSummaryText text={text} maxLength={maxLength} />);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  featureMocks.isFeatureEnabled.mockReturnValue(true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe('MarkdownSummaryText', () => {
  it('renders inline Markdown (bold/italic/strikethrough/code) without raw syntax', () => {
    render('**粗**、*斜*、~~删~~、`code`');

    expect(container.querySelector('strong')?.textContent).toBe('粗');
    expect(container.querySelector('em')?.textContent).toBe('斜');
    expect(container.querySelector('s')?.textContent).toBe('删');
    expect(container.querySelector('code')?.textContent).toBe('code');
    expect(container.textContent).not.toContain('**');
    expect(container.textContent).not.toContain('~~');
    expect(container.textContent).toBe('粗、斜、删、code');
  });

  it('flattens block Markdown into a single inline line (no block elements, no <br>)', () => {
    render('# 标题\n\n- 项一\n- 项二\n\n1. 甲\n2. 乙');

    for (const tag of ['p', 'h1', 'h2', 'ul', 'ol', 'li', 'pre', 'blockquote', 'hr', 'br']) {
      expect(container.querySelector(tag)).toBeNull();
    }
    // Heading is out of the subset and stays literal; lists keep their prefixes.
    expect(container.querySelector('strong')).toBeNull();
    expect(container.textContent).toContain('# 标题');
    expect(container.textContent).toContain('项一');
    expect(container.textContent).toContain('• 项二');
    expect(container.textContent).toContain('1. 甲');
    expect(container.textContent).toContain('2. 乙');
  });

  it('renders autolinks and markdown links as inline anchors', () => {
    render('去 [链接](https://example.com) 看 https://auto.example/a');

    const anchors = Array.from(container.querySelectorAll('a'));
    expect(anchors.map((a) => a.getAttribute('href'))).toEqual(['https://example.com', 'https://auto.example/a']);
    expect(container.textContent).not.toContain('[链接]');
  });

  it('renders Markdown next to a literal attachment label prefix', () => {
    render('[图片] **新的设计** 已上传');

    expect(container.textContent).toContain('[图片]');
    expect(container.querySelector('strong')?.textContent).toBe('新的设计');
    expect(container.textContent).not.toContain('**');
  });

  it('returns plain text unchanged when the feature gate is off', () => {
    featureMocks.isFeatureEnabled.mockReturnValue(false);
    render('别 **加粗** 我');

    expect(container.textContent).toBe('别 **加粗** 我');
    expect(container.querySelector('strong')).toBeNull();
  });

  it('truncates only the plain-text fallback when maxLength is given', () => {
    const longText = 'a'.repeat(60);
    render(longText, 8);

    expect(container.textContent).toMatch(/^a{7,8}…$/);
  });

  it('renders nothing for an empty string', () => {
    render('');

    expect(container.textContent).toBe('');
  });
});

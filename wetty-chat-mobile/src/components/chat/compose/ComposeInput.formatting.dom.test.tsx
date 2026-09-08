import { useRef, useState, type ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposeInput } from './ComposeInput';

vi.mock('@lingui/core/macro', () => ({
  t: (strings: TemplateStringsArray | string) => (typeof strings === 'string' ? strings : strings.join('')),
}));
vi.mock('@ionic/react', () => ({
  IonIcon: () => null,
}));
vi.mock('ionicons/icons', () => ({
  happyOutline: 'happy-outline',
  linkOutline: 'link-outline',
}));
vi.mock('./MessageComposeBar.module.scss', () => ({ default: {} }));
vi.mock('./FormatToolbar.module.scss', () => ({ default: {} }));

const featureMocks = vi.hoisted(() => ({
  isFeatureEnabled: vi.fn<(name: string) => boolean>(),
}));
vi.mock('@/features', () => ({
  isFeatureEnabled: featureMocks.isFeatureEnabled,
}));

const BODY_PORTAL_SELECTOR = '[data-format-toolbar]';

let container: HTMLDivElement;
let root: Root;

function Harness({
  initialText = '',
  mentionOpen = false,
}: {
  initialText?: string;
  mentionOpen?: boolean;
}): ReactElement {
  const [text, setText] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  return (
    <div>
      <ComposeInput
        textareaRef={textareaRef}
        text={text}
        onTextChange={setText}
        onSubmit={() => {}}
        canRequestRecentEdit={false}
        onRequestEditLastMessage={() => false}
        isUnchangedEdit={false}
        onCancelEdit={() => {}}
        onCancelReply={() => {}}
        onStickerPress={() => {}}
        isStickerActive={false}
        onMentionKeyDown={() => false}
        isMentionMenuOpen={mentionOpen}
      />
    </div>
  );
}

function renderHarness(props: { initialText?: string; mentionOpen?: boolean } = {}) {
  act(() => {
    root.render(<Harness {...props} />);
  });
}

function textarea(): HTMLTextAreaElement {
  const el = container.querySelector('textarea');
  if (!el) throw new Error('textarea not rendered');
  return el;
}

async function flushTimers() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function focusTextarea() {
  await act(async () => {
    textarea().dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  });
}

async function selectRange(start: number, end: number) {
  await act(async () => {
    const ta = textarea();
    ta.setSelectionRange(start, end);
    ta.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
}

async function openSelection(start: number, end: number) {
  await focusTextarea();
  await selectRange(start, end);
}

function typeInto(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function fireKeydown(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
}

function toolbar(): HTMLElement | null {
  return document.body.querySelector(BODY_PORTAL_SELECTOR);
}

function clickToolbarButton(selector: string) {
  const target = document.body.querySelector(selector);
  if (!target) throw new Error(`missing ${selector}`);
  act(() => {
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  featureMocks.isFeatureEnabled.mockReset();
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
  document.body.querySelectorAll(BODY_PORTAL_SELECTOR).forEach((el) => el.remove());
});

describe('ComposeInput formatting toolbar', () => {
  it('shows the floating toolbar when text is selected and hides it on collapse', async () => {
    renderHarness({ initialText: 'hello world' });
    await openSelection(0, 5);

    expect(toolbar()).not.toBeNull();

    act(() => {
      const ta = textarea();
      ta.setSelectionRange(5, 5);
      ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
    });
    await flushTimers();

    expect(toolbar()).toBeNull();
  });

  it('keeps the toolbar hidden while the mention menu is open', async () => {
    renderHarness({ initialText: 'hello @', mentionOpen: true });
    await openSelection(0, 5);

    expect(toolbar()).toBeNull();
  });

  it('hides the toolbar when the textarea loses focus', async () => {
    renderHarness({ initialText: 'hello world' });
    await openSelection(0, 5);
    expect(toolbar()).not.toBeNull();

    await act(async () => {
      textarea().dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(toolbar()).toBeNull();
  });

  it('does not show the toolbar when the feature gate is off', async () => {
    featureMocks.isFeatureEnabled.mockReturnValue(false);
    renderHarness({ initialText: 'hello world' });
    await openSelection(0, 5);

    expect(toolbar()).toBeNull();
  });
});

describe('ComposeInput formatting buttons', () => {
  it('wraps the selection in ** via the toolbar bold button', async () => {
    renderHarness({ initialText: 'hello world' });
    await openSelection(0, 5);

    clickToolbarButton('[data-format-bold]');
    await flushTimers();

    expect(textarea().value).toBe('**hello** world');
    // Cursor sits right after the closing marker, toolbar hidden.
    expect(textarea().selectionStart).toBe(9);
    expect(textarea().selectionEnd).toBe(9);
    expect(toolbar()).toBeNull();
  });

  it('wraps the selection in * / ~~ via italic and strike buttons', async () => {
    renderHarness({ initialText: 'hello world' });
    await openSelection(0, 5);

    clickToolbarButton('[data-format-italic]');
    await flushTimers();
    expect(textarea().value).toBe('*hello* world');

    // In "*hello* world", "world" spans 8..13.
    await openSelection(8, 13);
    clickToolbarButton('[data-format-strike]');
    await flushTimers();
    expect(textarea().value).toBe('*hello* ~~world~~');
  });

  it('wraps the selection in __ via the toolbar underline button', async () => {
    renderHarness({ initialText: 'hello world' });
    await openSelection(0, 5);

    clickToolbarButton('[data-format-underline]');
    await flushTimers();

    expect(textarea().value).toBe('__hello__ world');
    expect(textarea().selectionStart).toBe(9);
    expect(textarea().selectionEnd).toBe(9);
    expect(toolbar()).toBeNull();
  });

  it('fences the selection via the toolbar code button', async () => {
    renderHarness({ initialText: 'hello world' });
    await openSelection(0, 5);

    clickToolbarButton('[data-format-code]');
    await flushTimers();

    expect(textarea().value).toBe('```\nhello\n``` world');
    expect(toolbar()).toBeNull();
  });

  it('prefixes every selected line with > via the toolbar quote button', async () => {
    renderHarness({ initialText: 'first\nsecond' });
    await openSelection(0, 12);

    clickToolbarButton('[data-format-quote]');
    await flushTimers();

    expect(textarea().value).toBe('> first\n> second');
    expect(toolbar()).toBeNull();
  });

  it('applies a typed link URL to the selection', async () => {
    renderHarness({ initialText: 'see hello now' });
    await openSelection(4, 9);

    clickToolbarButton('[data-format-link]');
    await flushTimers();

    const input = document.body.querySelector('[data-format-url-input]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    typeInto(input!, 'example.com/docs');
    clickToolbarButton('[data-format-url-apply]');
    await flushTimers();

    expect(textarea().value).toBe('see [hello](https://example.com/docs) now');
  });
});

describe('ComposeInput keyboard shortcuts', () => {
  it('Ctrl+B wraps the selection like the toolbar button', async () => {
    renderHarness({ initialText: 'hello world' });
    await openSelection(0, 5);

    fireKeydown('b', { ctrlKey: true });
    await flushTimers();

    expect(textarea().value).toBe('**hello** world');
    expect(toolbar()).toBeNull();
  });

  it('Ctrl+I and Cmd+D wrap the selection', async () => {
    renderHarness({ initialText: 'one two' });
    await openSelection(0, 3);
    fireKeydown('i', { ctrlKey: true });
    await flushTimers();
    expect(textarea().value).toBe('*one* two');

    // In "*one* two", "two" spans 6..9.
    await openSelection(6, 9);
    fireKeydown('d', { metaKey: true });
    await flushTimers();
    expect(textarea().value).toBe('*one* ~~two~~');
  });

  it('Ctrl+U and Ctrl+Q wrap underline and quote the selection', async () => {
    renderHarness({ initialText: 'hello world' });
    await openSelection(0, 5);

    fireKeydown('u', { ctrlKey: true });
    await flushTimers();
    expect(textarea().value).toBe('__hello__ world');

    // In "__hello__ world", "world" spans 10..15.
    await openSelection(10, 15);
    fireKeydown('q', { ctrlKey: true });
    await flushTimers();
    expect(textarea().value).toBe('__hello__ > world');
  });

  it('collapsed selection is a no-op: no stray markers are inserted', async () => {
    renderHarness({ initialText: 'plain' });
    await focusTextarea();

    fireKeydown('b', { ctrlKey: true });
    await flushTimers();

    expect(textarea().value).toBe('plain');
    expect(toolbar()).toBeNull();
  });

  it('does not fire formatting shortcuts during IME composition', async () => {
    renderHarness({ initialText: 'plain' });
    await focusTextarea();
    // Set a selection but pretend the OS is still composing.
    await selectRange(0, 5);

    act(() => {
      textarea().dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'b',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
          isComposing: true,
        }),
      );
    });
    await flushTimers();

    expect(textarea().value).toBe('plain');
  });
});

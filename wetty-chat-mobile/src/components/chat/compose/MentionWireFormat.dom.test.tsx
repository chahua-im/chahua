import { useRef, useState, type ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMembers, type MemberResponse } from '@/api/group';
import { ComposeInput } from './ComposeInput';
import { useMentionAutocomplete } from './useMentionAutocomplete';

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
vi.mock('@/features', () => ({
  isFeatureEnabled: () => true,
}));
vi.mock('@/api/group', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/group')>();
  return { ...actual, getMembers: vi.fn() };
});

const MENTION_MEMBER = { uid: 7, username: 'devuser2' } as MemberResponse;
const BODY_PORTAL_SELECTOR = '[data-format-toolbar]';

let container: HTMLDivElement;
let root: Root;
let selectMentionRef: { current: (member: MemberResponse) => void };
let sendRef: { current: () => void };

function Harness(): ReactElement {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [sent, setSent] = useState('');
  const {
    mentionState,
    selectMention,
    toWireFormat,
    clearMentions,
    onTextChange: onMentionTextChange,
  } = useMentionAutocomplete(textareaRef, text, 1);

  selectMentionRef.current = selectMention;
  sendRef.current = () => {
    // Mirrors MessageComposeBar.handleSend: convert to wire format first,
    // then trim so mention offsets are computed against the raw text.
    const wire = toWireFormat(text).trim();
    setSent(wire);
    setText('');
    clearMentions();
  };

  return (
    <div>
      <ComposeInput
        textareaRef={textareaRef}
        text={text}
        onTextChange={(value) => {
          setText(value);
          onMentionTextChange(value);
        }}
        onSubmit={sendRef.current}
        canRequestRecentEdit={false}
        onRequestEditLastMessage={() => false}
        isUnchangedEdit={false}
        onCancelEdit={() => {}}
        onCancelReply={() => {}}
        onStickerPress={() => {}}
        isStickerActive={false}
        onMentionKeyDown={() => false}
        isMentionMenuOpen={mentionState.isOpen}
      />
      <div data-sent>{sent}</div>
    </div>
  );
}

function textarea(): HTMLTextAreaElement {
  const el = container.querySelector('textarea');
  if (!el) throw new Error('textarea not rendered');
  return el;
}

function sentText(): string {
  return container.querySelector('[data-sent]')?.textContent ?? '';
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Types text as one native input commit (value + caret), like real typing. */
async function commitText(next: string, caret: number) {
  await act(async () => {
    const ta = textarea();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, next);
    ta.setSelectionRange(caret, caret);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
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

async function flushTimers() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
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
  vi.mocked(getMembers).mockReset();
  vi.mocked(getMembers).mockResolvedValue({
    data: { members: [MENTION_MEMBER] },
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {},
  } as never);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  selectMentionRef = { current: () => {} };
  sendRef = { current: () => {} };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  act(() => {
    root.render(<Harness />);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  document.body.querySelectorAll(BODY_PORTAL_SELECTOR).forEach((el) => el.remove());
});

describe('mention autocomplete wire format', () => {
  it('sends a wire mention after the mention is wrapped in emphasis markers', async () => {
    await commitText('@devuser2', 9);
    await settle();
    await act(async () => {
      selectMentionRef.current(MENTION_MEMBER);
    });
    expect(textarea().value).toBe('@devuser2 ');

    await focusTextarea();
    await selectRange(0, 9);
    expect(toolbar()).not.toBeNull();
    clickToolbarButton('[data-format-italic]');
    await flushTimers();
    expect(textarea().value).toBe('*@devuser2* ');

    await act(async () => {
      sendRef.current();
    });
    expect(sentText()).toBe('*@[uid:7]*');
  });

  it('trims leading whitespace after converting to the wire format', async () => {
    // Mention after a leading space — offsets start at 1, not 0.
    await commitText(' @devuser2', 10);
    await settle();
    await act(async () => {
      selectMentionRef.current(MENTION_MEMBER);
    });
    expect(textarea().value).toBe(' @devuser2 ');

    await act(async () => {
      sendRef.current();
    });
    expect(sentText()).toBe('@[uid:7]');
  });
});

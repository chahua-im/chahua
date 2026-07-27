import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ReplyTo } from './types';
import { ComposeInput } from './ComposeInput';

vi.mock('@lingui/core/macro', () => ({
  t: (strings: TemplateStringsArray | string) => (typeof strings === 'string' ? strings : strings.join('')),
}));

vi.mock('@ionic/react', () => ({
  IonIcon: () => null,
}));

vi.mock('ionicons/icons', () => ({
  happyOutline: 'happy-outline',
}));

vi.mock('./MessageComposeBar.module.scss', () => ({ default: {} }));

const replyTarget: ReplyTo = {
  messageId: 'msg-1',
  username: 'alice',
  messageType: 'text',
  text: 'hello',
};

interface HarnessProps {
  replyTo?: ReplyTo;
  editing?: { messageId: string; text: string };
  isUnchangedEdit?: boolean;
  text?: string;
}

function makeProps(overrides: HarnessProps = {}) {
  return {
    textareaRef,
    text: overrides.text ?? '',
    onTextChange,
    onSubmit: vi.fn<() => void>(),
    onFocusChange,
    canRequestRecentEdit: false,
    onRequestEditLastMessage: vi.fn<() => boolean>(),
    editing: overrides.editing,
    isUnchangedEdit: overrides.isUnchangedEdit ?? false,
    onCancelEdit,
    replyTo: overrides.replyTo,
    onCancelReply,
    onStickerPress: vi.fn<() => void>(),
    isStickerActive: false,
    onMentionKeyDown: vi.fn<(event: KeyboardEvent) => boolean>(),
  };
}

const textareaRef = createRef<HTMLTextAreaElement>();
let onFocusChange: Mock<(focused: boolean) => void>;
let onCancelReply: Mock<() => void>;
let onCancelEdit: Mock<() => void>;
let onTextChange: Mock<(value: string) => void>;
let container: HTMLDivElement;
let root: Root;

function render(props: ReturnType<typeof makeProps>) {
  act(() => {
    root.render(<ComposeInput {...props} />);
  });
}

function fireEscape(target: HTMLElement, isComposing = false) {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
    // happy-dom supports isComposing in KeyboardEventInit
    isComposing,
  });
  const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
  const stopPropagationSpy = vi.spyOn(event, 'stopPropagation');
  target.dispatchEvent(event);
  return { event, preventDefaultSpy, stopPropagationSpy };
}

beforeEach(() => {
  vi.clearAllMocks();
  onFocusChange = vi.fn<(focused: boolean) => void>();
  onCancelReply = vi.fn<() => void>();
  onCancelEdit = vi.fn<() => void>();
  onTextChange = vi.fn<(value: string) => void>();
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

describe('ComposeInput Escape state machine', () => {
  it('focused + replying: first Esc cancels reply, keeps focus and text', () => {
    render(makeProps({ replyTo: replyTarget, text: 'draft text' }));
    const textarea = textareaRef.current!;
    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    const docSpy = vi.fn();
    document.addEventListener('keydown', docSpy);
    try {
      const { preventDefaultSpy, stopPropagationSpy } = fireEscape(textarea);

      expect(onCancelReply).toHaveBeenCalledTimes(1);
      // Reply cancel must fully consume the Esc (no leak to global handlers).
      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(stopPropagationSpy).toHaveBeenCalled();
      expect(docSpy).not.toHaveBeenCalled();
      // Focus is preserved: no blur, textarea still active.
      expect(onFocusChange).not.toHaveBeenCalledWith(false);
      expect(document.activeElement).toBe(textarea);
      // Text/draft is untouched.
      expect(onTextChange).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', docSpy);
    }
  });

  it('focused + not replying: Esc blurs the input and stops propagation', () => {
    render(makeProps({ text: 'draft text' }));
    const textarea = textareaRef.current!;
    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    const docSpy = vi.fn();
    document.addEventListener('keydown', docSpy);
    try {
      const { preventDefaultSpy, stopPropagationSpy } = fireEscape(textarea);

      expect(onCancelReply).not.toHaveBeenCalled();
      expect(onCancelEdit).not.toHaveBeenCalled();
      // Blur branch must also consume the Esc so the same key does not also navigate.
      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(stopPropagationSpy).toHaveBeenCalled();
      expect(docSpy).not.toHaveBeenCalled();
      // The textarea blurred.
      expect(onFocusChange).toHaveBeenCalledWith(false);
      expect(document.activeElement).not.toBe(textarea);
    } finally {
      document.removeEventListener('keydown', docSpy);
    }
  });

  it('reply -> blur -> back sequence: second Esc blurs after reply cancelled', () => {
    // 1st Esc: cancel reply (focus kept).
    render(makeProps({ replyTo: replyTarget, text: 'draft text' }));
    const textarea = textareaRef.current!;
    textarea.focus();
    fireEscape(textarea);
    expect(onCancelReply).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(textarea);
    expect(onFocusChange).not.toHaveBeenCalledWith(false);

    // Simulate the parent clearing reply state after onCancelReply, then 2nd Esc blurs.
    render(makeProps({ replyTo: undefined, text: 'draft text' }));
    // React swaps the textarea node when not keyed; re-read the ref.
    const textareaAfter = textareaRef.current!;
    textareaAfter.focus();
    expect(document.activeElement).toBe(textareaAfter);

    const docSpy = vi.fn();
    document.addEventListener('keydown', docSpy);
    try {
      fireEscape(textareaAfter);
      expect(onFocusChange).toHaveBeenCalledWith(false);
      expect(document.activeElement).not.toBe(textareaAfter);
      expect(docSpy).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', docSpy);
    }
  });

  it('IME composing: Esc is not intercepted (no reply cancel, no blur)', () => {
    render(makeProps({ replyTo: replyTarget, text: '中文' }));
    const textarea = textareaRef.current!;
    textarea.focus();

    const { event, preventDefaultSpy, stopPropagationSpy } = fireEscape(textarea, /* isComposing */ true);

    expect(onCancelReply).not.toHaveBeenCalled();
    expect(onFocusChange).not.toHaveBeenCalledWith(false);
    expect(preventDefaultSpy).not.toHaveBeenCalled();
    expect(stopPropagationSpy).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('editing + unchanged edit: Esc cancels edit (preserved behaviour), no blur', () => {
    render(
      makeProps({
        editing: { messageId: 'msg-edit', text: 'original' },
        isUnchangedEdit: true,
        text: 'original',
      }),
    );
    const textarea = textareaRef.current!;
    textarea.focus();

    const docSpy = vi.fn();
    document.addEventListener('keydown', docSpy);
    try {
      const { preventDefaultSpy, stopPropagationSpy } = fireEscape(textarea);

      expect(onCancelEdit).toHaveBeenCalledTimes(1);
      expect(onCancelReply).not.toHaveBeenCalled();
      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(stopPropagationSpy).toHaveBeenCalled();
      expect(docSpy).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', docSpy);
    }
  });

  it('only allows global back handler when input is not focused', () => {
    render(makeProps({ text: 'draft text' }));
    const textarea = textareaRef.current!;
    // Intentionally do NOT focus the textarea.
    expect(document.activeElement).not.toBe(textarea);

    const docSpy = vi.fn();
    document.addEventListener('keydown', docSpy);
    try {
      // When the input is not focused, Esc is pressed on the document (body),
      // not on the textarea, so ComposeInput never consumes it.
      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
      document.dispatchEvent(event);

      // ComposeInput did not consume the Esc; the global handler is free to run.
      expect(preventDefaultSpy).not.toHaveBeenCalled();
      expect(onCancelReply).not.toHaveBeenCalled();
      expect(onFocusChange).not.toHaveBeenCalledWith(false);
      expect(docSpy).toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', docSpy);
    }
  });
});

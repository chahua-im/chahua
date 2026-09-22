import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatBubble } from './ChatBubble';

// The gesture logic under test lives in ChatBubble's wrapper; stub the visual
// bubble so no Redux/Ionic/canvas-dependent rendering is pulled in. The stub
// still mounts the forwarded ref so getBoundingClientRect resolves.
vi.mock('./ChatBubbleBase', () => ({
  ChatBubbleBase: ({ bubbleRef }: { bubbleRef?: React.Ref<HTMLDivElement | null> }) => (
    <div ref={bubbleRef} data-testid="bubble" />
  ),
}));

function dispatchTouch(el: Element, type: string, x: number, y: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: [{ clientX: x, clientY: y }] });
  act(() => {
    el.dispatchEvent(event);
  });
  return event;
}

describe('ChatBubble long-press gesture', () => {
  let host: HTMLDivElement;
  let root: Root;
  let onLongPress: ReturnType<typeof vi.fn<(rect: DOMRect, pos?: { x: number; y: number }) => void>>;
  let onReply: ReturnType<typeof vi.fn<() => void>>;

  function renderBubble(props?: { onReply?: () => void; swipeDirection?: 'left' | 'right' }) {
    act(() => {
      root.render(
        <ChatBubble
          messageType="text"
          senderName="Alice"
          message="hello"
          isSent={false}
          onLongPress={onLongPress}
          onReply={props?.onReply ?? onReply}
          swipeDirection={props?.swipeDirection}
        />,
      );
    });
    return host.querySelector('[data-testid="bubble"]') as HTMLElement;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    onLongPress = vi.fn<(rect: DOMRect, pos?: { x: number; y: number }) => void>();
    onReply = vi.fn<() => void>();
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not fire at 349ms and fires exactly once at 350ms', () => {
    const bubble = renderBubble();
    dispatchTouch(bubble, 'touchstart', 12, 34);

    act(() => {
      vi.advanceTimersByTime(349);
    });
    expect(onLongPress).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress.mock.calls[0]?.[1]).toEqual({ x: 12, y: 34 });

    // The fired timer is released: further time never re-fires it.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    dispatchTouch(bubble, 'touchend', 12, 34);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('cancels the long-press when the finger moves more than 10px', () => {
    const bubble = renderBubble();
    dispatchTouch(bubble, 'touchstart', 0, 0);
    dispatchTouch(bubble, 'touchmove', 30, 0);

    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('cancels the long-press on touchend before the timer expires', () => {
    const bubble = renderBubble();
    dispatchTouch(bubble, 'touchstart', 0, 0);
    dispatchTouch(bubble, 'touchend', 0, 0);

    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('cancels the long-press on touchcancel', () => {
    const bubble = renderBubble();
    dispatchTouch(bubble, 'touchstart', 0, 0);
    dispatchTouch(bubble, 'touchcancel', 0, 0);

    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('cancels the pending long-press timer on unmount', () => {
    const bubble = renderBubble();
    dispatchTouch(bubble, 'touchstart', 0, 0);

    act(() => {
      root.unmount();
    });

    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('still opens the menu on mouse contextmenu and blocks the browser menu', () => {
    const bubble = renderBubble();

    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 5,
      clientY: 6,
    });
    act(() => {
      bubble.dispatchEvent(event);
    });

    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress.mock.calls[0]?.[1]).toEqual({ x: 5, y: 6 });
    expect(event.defaultPrevented).toBe(true);
  });

  it('keeps the horizontal swipe-to-reply gesture working', () => {
    const bubble = renderBubble({ onReply });
    dispatchTouch(bubble, 'touchstart', 0, 0);
    dispatchTouch(bubble, 'touchmove', -70, 0);
    dispatchTouch(bubble, 'touchend', -70, 0);

    expect(onReply).toHaveBeenCalledTimes(1);
  });
});

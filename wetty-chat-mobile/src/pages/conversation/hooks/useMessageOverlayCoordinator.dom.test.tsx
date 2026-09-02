import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMessageOverlayCoordinator, type OverlayRequest } from './useMessageOverlayCoordinator';

interface CoordinatorState {
  overlayMessage: OverlayRequest | null;
  requestOverlay: (request: OverlayRequest) => boolean;
  closeOverlay: () => void;
}

function makeRequest(id: string): OverlayRequest {
  return {
    message: { id } as unknown as OverlayRequest['message'],
    sourceRect: new DOMRect(10, 20, 100, 40),
  };
}

describe('useMessageOverlayCoordinator', () => {
  let host: HTMLDivElement;
  let root: Root;
  let state: CoordinatorState;
  let dismissKeyboard: ReturnType<typeof vi.fn<() => void>>;
  let manuallyUnmounted = false;

  function render(props?: { isKeyboardOpen?: boolean; keyboardFullyClosed?: boolean }) {
    const { isKeyboardOpen = false, keyboardFullyClosed = true } = props ?? {};
    act(() => {
      root.render(
        <TestComponent
          isKeyboardOpen={isKeyboardOpen}
          keyboardFullyClosed={keyboardFullyClosed}
          dismissKeyboard={dismissKeyboard}
          onState={(nextState) => (state = nextState)}
        />,
      );
    });
  }

  function TestComponent({
    isKeyboardOpen,
    keyboardFullyClosed,
    dismissKeyboard: dismiss,
    onState,
  }: {
    isKeyboardOpen: boolean;
    keyboardFullyClosed: boolean;
    dismissKeyboard: () => void;
    onState: (state: CoordinatorState) => void;
  }) {
    const coordinator = useMessageOverlayCoordinator({
      isKeyboardOpen,
      keyboardFullyClosed,
      dismissKeyboard: dismiss,
    });
    onState(coordinator);
    return null;
  }

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    dismissKeyboard = vi.fn<() => void>();
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    if (!manuallyUnmounted) {
      act(() => {
        root.unmount();
      });
    }
    host.remove();
    vi.restoreAllMocks();
  });

  it('shows the first request immediately when no keyboard is open', () => {
    render();

    let accepted = false;
    act(() => {
      accepted = state.requestOverlay(makeRequest('A'));
    });

    expect(accepted).toBe(true);
    expect(state.overlayMessage?.message.id).toBe('A');
    expect(dismissKeyboard).not.toHaveBeenCalled();
  });

  it('defers and dismisses the keyboard once when the keyboard is open', () => {
    render({ isKeyboardOpen: true, keyboardFullyClosed: false });

    let accepted = false;
    act(() => {
      accepted = state.requestOverlay(makeRequest('A'));
    });

    expect(accepted).toBe(true);
    expect(state.overlayMessage).toBeNull();
    expect(dismissKeyboard).toHaveBeenCalledTimes(1);
  });

  it('ignores a duplicate request while deferred and shows the pressed message after the keyboard closes', () => {
    render({ isKeyboardOpen: true, keyboardFullyClosed: false });

    act(() => {
      state.requestOverlay(makeRequest('A'));
    });
    let accepted = false;
    act(() => {
      accepted = state.requestOverlay(makeRequest('B'));
    });

    expect(accepted).toBe(false);
    expect(state.overlayMessage).toBeNull();

    render({ isKeyboardOpen: false, keyboardFullyClosed: true });

    expect(state.overlayMessage?.message.id).toBe('A');
  });

  it('keeps the pressed message when a late request arrives after the overlay is shown', () => {
    render({ isKeyboardOpen: true, keyboardFullyClosed: false });

    act(() => {
      state.requestOverlay(makeRequest('A'));
    });
    render({ isKeyboardOpen: false, keyboardFullyClosed: true });
    expect(state.overlayMessage?.message.id).toBe('A');

    let accepted = true;
    act(() => {
      accepted = state.requestOverlay(makeRequest('B'));
    });

    expect(accepted).toBe(false);
    expect(state.overlayMessage?.message.id).toBe('A');
  });

  it('does not reset the overlay when the same message requests again', () => {
    render();

    act(() => {
      state.requestOverlay(makeRequest('A'));
    });
    const shown = state.overlayMessage;

    let accepted = true;
    act(() => {
      accepted = state.requestOverlay(makeRequest('A'));
    });

    expect(accepted).toBe(false);
    expect(state.overlayMessage).toBe(shown);
  });

  it('accepts a new message after the overlay closes', () => {
    render();

    act(() => {
      state.requestOverlay(makeRequest('A'));
    });
    act(() => {
      state.closeOverlay();
    });
    expect(state.overlayMessage).toBeNull();

    let accepted = false;
    act(() => {
      accepted = state.requestOverlay(makeRequest('C'));
    });

    expect(accepted).toBe(true);
    expect(state.overlayMessage?.message.id).toBe('C');
  });

  it('keeps the transaction lock on the immediate path too', () => {
    render();

    act(() => {
      state.requestOverlay(makeRequest('A'));
    });

    let accepted = true;
    act(() => {
      accepted = state.requestOverlay(makeRequest('B'));
    });

    expect(accepted).toBe(false);
    expect(state.overlayMessage?.message.id).toBe('A');
  });

  it('does not consume the deferred request twice across repeated viewport updates', () => {
    render({ isKeyboardOpen: true, keyboardFullyClosed: false });

    act(() => {
      state.requestOverlay(makeRequest('A'));
    });
    render({ isKeyboardOpen: false, keyboardFullyClosed: true });
    const shown = state.overlayMessage;
    expect(shown?.message.id).toBe('A');

    render({ isKeyboardOpen: false, keyboardFullyClosed: false });
    render({ isKeyboardOpen: false, keyboardFullyClosed: true });

    expect(state.overlayMessage).toBe(shown);
  });

  it('does not update state or call dismiss after unmount', () => {
    render({ isKeyboardOpen: true, keyboardFullyClosed: false });

    act(() => {
      state.requestOverlay(makeRequest('A'));
    });
    expect(dismissKeyboard).toHaveBeenCalledTimes(1);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    manuallyUnmounted = true;
    act(() => {
      root.unmount();
    });

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

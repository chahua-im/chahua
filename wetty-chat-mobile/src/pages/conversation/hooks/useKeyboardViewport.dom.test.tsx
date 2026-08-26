import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useKeyboardViewport } from './useKeyboardViewport';

interface HookState {
  handleComposeFocusChange: (focused: boolean) => void;
  isKeyboardOpen: boolean;
  keyboardFullyClosed: boolean;
  pageStyle: React.CSSProperties | undefined;
}

class MockVisualViewport extends EventTarget {
  height = 800;
  offsetTop = 0;
}

function TestComponent({ isDesktop, onRender }: { isDesktop: boolean; onRender: (state: HookState) => void }) {
  const state = useKeyboardViewport(isDesktop);
  onRender(state);
  return null;
}

describe('useKeyboardViewport', () => {
  let host: HTMLDivElement;
  let root: Root;
  let viewport: MockVisualViewport;
  let state: HookState;
  let originalVisualViewport: PropertyDescriptor | undefined;
  let originalInnerHeight: PropertyDescriptor | undefined;
  let originalScrollY: PropertyDescriptor | undefined;

  function renderHook(isDesktop = false) {
    act(() => {
      root.render(<TestComponent isDesktop={isDesktop} onRender={(nextState) => (state = nextState)} />);
    });
  }

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    viewport = new MockVisualViewport();

    originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    originalScrollY = Object.getOwnPropertyDescriptor(window, 'scrollY');

    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: viewport,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      value: 0,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();

    if (originalVisualViewport) {
      Object.defineProperty(window, 'visualViewport', originalVisualViewport);
    } else {
      Reflect.deleteProperty(window, 'visualViewport');
    }
    if (originalInnerHeight) {
      Object.defineProperty(window, 'innerHeight', originalInnerHeight);
    }
    if (originalScrollY) {
      Object.defineProperty(window, 'scrollY', originalScrollY);
    } else {
      Reflect.deleteProperty(window, 'scrollY');
    }
  });

  it('opens when compose is focused and the visual viewport shrinks past the threshold', () => {
    renderHook();

    expect(state.isKeyboardOpen).toBe(false);
    expect(state.keyboardFullyClosed).toBe(true);

    act(() => {
      state.handleComposeFocusChange(true);
    });
    viewport.height = 640;
    viewport.offsetTop = 32;
    act(() => {
      viewport.dispatchEvent(new Event('resize'));
    });

    expect(state.isKeyboardOpen).toBe(true);
    expect(state.keyboardFullyClosed).toBe(false);
  });

  it('uses Safari layout scroll to keep the resized page at the visual origin', () => {
    renderHook();

    act(() => {
      state.handleComposeFocusChange(true);
    });
    viewport.height = 377;
    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      value: 337,
    });
    act(() => {
      viewport.dispatchEvent(new Event('resize'));
    });

    expect(state.pageStyle).toEqual({ height: '377px', top: '337px' });
  });

  it('keeps keyboard status open when iOS later reports a viewport scroll', () => {
    renderHook();

    act(() => {
      state.handleComposeFocusChange(true);
    });
    viewport.height = 377;
    act(() => {
      viewport.dispatchEvent(new Event('resize'));
    });
    expect(state.isKeyboardOpen).toBe(true);

    viewport.offsetTop = 337;
    act(() => {
      viewport.dispatchEvent(new Event('scroll'));
    });
    expect(state.isKeyboardOpen).toBe(true);
    expect(state.keyboardFullyClosed).toBe(false);
  });

  it('reports fully closed after blur and viewport recovery', () => {
    renderHook();

    act(() => {
      state.handleComposeFocusChange(true);
    });
    viewport.height = 620;
    act(() => {
      viewport.dispatchEvent(new Event('resize'));
    });
    expect(state.isKeyboardOpen).toBe(true);

    act(() => {
      state.handleComposeFocusChange(false);
    });
    viewport.height = 800;
    act(() => {
      viewport.dispatchEvent(new Event('scroll'));
    });

    expect(state.isKeyboardOpen).toBe(false);
    expect(state.keyboardFullyClosed).toBe(true);
  });

  it('keeps desktop mode inactive even if the viewport changes', () => {
    renderHook(true);

    act(() => {
      state.handleComposeFocusChange(true);
    });
    viewport.height = 500;
    viewport.offsetTop = 80;
    act(() => {
      viewport.dispatchEvent(new Event('resize'));
    });

    expect(state.isKeyboardOpen).toBe(false);
    expect(state.keyboardFullyClosed).toBe(false);
  });
});

import { act, type MutableRefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageResponse } from '@/api/messages';
import { ChatVirtualScroll } from './ChatVirtualScroll';
import type { ChatRow, VirtualScrollHandle } from './types';

vi.mock('@lingui/core/macro', () => ({
  t: (strings: TemplateStringsArray | string) => (typeof strings === 'string' ? strings : strings.join('')),
}));

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: unknown }) => children,
}));

vi.mock('react-redux', () => ({
  useSelector: () => '14px',
}));

const ROW_HEIGHT = 76;
const VIEWPORT_HEIGHT = 320;

let currentRowCount = 0;
let currentViewportHeight = VIEWPORT_HEIGHT;
let scrollContainer: HTMLElement | null = null;
const rowIndexes = new WeakMap<Element, number>();
const resizeObservers = new Set<MockResizeObserver>();

class MockResizeObserver {
  private readonly elements = new Set<Element>();
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObservers.add(this);
  }

  observe(element: Element) {
    this.elements.add(element);
    const row = element.querySelector<HTMLElement>('[data-row-index]');
    if (row?.dataset.rowIndex) {
      rowIndexes.set(element, Number(row.dataset.rowIndex));
    }
  }

  disconnect() {
    this.elements.clear();
    resizeObservers.delete(this);
  }

  flush() {
    const entries = Array.from(this.elements, (target) => ({
      target,
      contentRect: target.getBoundingClientRect(),
    })) as ResizeObserverEntry[];
    this.callback(entries, this as unknown as ResizeObserver);
  }
}

function flushResizeObservers() {
  for (const observer of Array.from(resizeObservers)) {
    observer.flush();
  }
}

async function flushLayout(times = 1) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      flushResizeObservers();
      await Promise.resolve();
    });
  }
}

function message(id: string): MessageResponse {
  return {
    id,
    clientGeneratedId: `client-${id}`,
    chatId: '1',
    replyRootId: null,
    message: `message ${id}`,
    messageType: 'text',
    sender: { uid: 2, name: 'User', gender: 0 },
    createdAt: new Date(Number(id)).toISOString(),
    isEdited: false,
    isDeleted: false,
    hasAttachments: false,
  };
}

function rows(count: number): ChatRow[] {
  currentRowCount = count;
  return Array.from({ length: count }, (_, index) => {
    const id = String(index + 1);
    return {
      type: 'group',
      key: `grp:${id}`,
      messages: [message(id)],
      firstMessageId: id,
      lastMessageId: id,
      isSystem: false,
      showName: true,
      useStickyAvatar: true,
    } satisfies ChatRow;
  });
}

function renderVirtualScroll(
  root: Root,
  nextRows: ChatRow[],
  scrollApiRef: MutableRefObject<VirtualScrollHandle | null>,
) {
  root.render(
    <ChatVirtualScroll
      rows={nextRows}
      renderRow={(row) =>
        row.type === 'group' ? (
          <div data-testid={row.key} data-row-index={Number(row.firstMessageId) - 1}>
            {row.messages[0].message}
          </div>
        ) : (
          <div data-testid={row.key}>{row.dateLabel}</div>
        )
      }
      initialAnchor={{ type: 'bottom', token: 1 }}
      scrollApiRef={scrollApiRef}
      loadOlder={{ hasMore: false, onLoad: vi.fn() }}
      loadNewer={{ hasMore: false, onLoad: vi.fn() }}
    />,
  );
}

describe('ChatVirtualScroll realtime appends', () => {
  let host: HTMLDivElement;
  let root: Root;
  let originalClientHeight: PropertyDescriptor | undefined;
  let originalScrollHeight: PropertyDescriptor | undefined;
  let originalOffsetTop: PropertyDescriptor | undefined;
  let originalGetBoundingClientRect: typeof HTMLElement.prototype.getBoundingClientRect;
  let originalScrollTo: typeof HTMLElement.prototype.scrollTo;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    originalOffsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');
    originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    originalScrollTo = HTMLElement.prototype.scrollTo;
    consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return currentViewportHeight;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return currentRowCount * ROW_HEIGHT;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get() {
        return (rowIndexes.get(this) ?? 0) * ROW_HEIGHT;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      const index = rowIndexes.get(this);
      if (index != null) {
        const top = index * ROW_HEIGHT - (scrollContainer?.scrollTop ?? 0);
        return {
          x: 0,
          y: top,
          top,
          left: 0,
          right: 100,
          bottom: top + ROW_HEIGHT,
          width: 100,
          height: ROW_HEIGHT,
          toJSON: () => ({}),
        };
      }
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 100,
        bottom: currentViewportHeight,
        width: 100,
        height: currentViewportHeight,
        toJSON: () => ({}),
      };
    };
    HTMLElement.prototype.scrollTo = function scrollTo(options?: ScrollToOptions | number, y?: number) {
      if (typeof options === 'number') {
        this.scrollTop = y ?? 0;
        return;
      }
      this.scrollTop = options?.top ?? 0;
    };

    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    scrollContainer = null;
    currentRowCount = 0;
    currentViewportHeight = VIEWPORT_HEIGHT;
    resizeObservers.clear();

    if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
    if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
    if (originalOffsetTop) Object.defineProperty(HTMLElement.prototype, 'offsetTop', originalOffsetTop);
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    HTMLElement.prototype.scrollTo = originalScrollTo;
    consoleDebugSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('keeps following the bottom when a websocket append arrives while a staging batch is pending', async () => {
    const scrollApiRef = { current: null } as MutableRefObject<VirtualScrollHandle | null>;

    await act(async () => {
      renderVirtualScroll(root, rows(40), scrollApiRef);
    });
    scrollContainer = host.firstElementChild as HTMLElement;
    currentViewportHeight = VIEWPORT_HEIGHT + 1;
    await flushLayout();
    currentViewportHeight = VIEWPORT_HEIGHT;
    await flushLayout(8);
    expect(host.querySelector('[data-testid="grp:40"]')).not.toBeNull();

    await act(async () => {
      scrollContainer!.scrollTop = 24 * ROW_HEIGHT;
      scrollContainer!.dispatchEvent(new Event('scroll', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      scrollApiRef.current?.scrollToBottom({ behavior: 'auto', source: 'test-pending-bottom' });
      await Promise.resolve();
    });

    await act(async () => {
      renderVirtualScroll(root, rows(41), scrollApiRef);
      await Promise.resolve();
    });

    expect(scrollContainer!.scrollTop).toBe(currentRowCount * ROW_HEIGHT - currentViewportHeight);
  });
});

import { useCallback, useEffect, useState } from 'react';

const KEYBOARD_OPEN_HEIGHT_DIFF = 120;
const KEYBOARD_CLOSED_HEIGHT_DIFF = 20;

function isStandalonePwa() {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function useKeyboardViewport(isDesktop: boolean) {
  const [composeFocused, setComposeFocused] = useState(false);
  const [baselineViewportHeight, setBaselineViewportHeight] = useState<number>(
    () => window.visualViewport?.height ?? window.innerHeight,
  );
  const [viewportHeight, setViewportHeight] = useState<number>(
    () => window.visualViewport?.height ?? window.innerHeight,
  );
  const [viewportOffsetTop, setViewportOffsetTop] = useState(() => window.visualViewport?.offsetTop ?? 0);

  useEffect(() => {
    if (isDesktop) return;

    const visualViewport = window.visualViewport;
    const getViewportHeight = () => visualViewport?.height ?? window.innerHeight;
    const updateViewportMetrics = (event: Event) => {
      const nextViewportHeight = getViewportHeight();
      const nextOffsetTop = visualViewport?.offsetTop ?? 0;
      console.debug('[keyboard:viewport]', {
        event: event.type,
        focused: composeFocused,
        baselineViewportHeight,
        viewportOffsetTop: nextOffsetTop,
        viewportHeight: nextViewportHeight,
        offsetTop: nextOffsetTop,
        scrollY: window.scrollY,
        innerHeight: window.innerHeight,
        standalone: isStandalonePwa(),
      });
      setViewportHeight(nextViewportHeight);
      setViewportOffsetTop(nextOffsetTop);
      window.requestAnimationFrame(() => {
        const pageRect = document.querySelector<HTMLElement>('.conversation-page')?.getBoundingClientRect();
        const footerRect = document.querySelector<HTMLElement>('.conversation-footer')?.getBoundingClientRect();
        console.debug('[keyboard:layout]', {
          viewportHeight: visualViewport?.height ?? window.innerHeight,
          offsetTop: visualViewport?.offsetTop ?? 0,
          scrollY: window.scrollY,
          viewportOffsetTop: visualViewport?.offsetTop ?? 0,
          pageTop: pageRect?.top,
          pageHeight: pageRect?.height,
          footerTop: footerRect?.top,
          footerBottom: footerRect?.bottom,
          standalone: isStandalonePwa(),
        });
      });
      if (!composeFocused) {
        setBaselineViewportHeight((prev) => Math.max(prev, nextViewportHeight));
      }
    };

    const target = visualViewport ?? window;
    target.addEventListener('resize', updateViewportMetrics);
    // iOS fires visualViewport scroll events when the keyboard pushes the viewport.
    if (visualViewport) {
      visualViewport.addEventListener('scroll', updateViewportMetrics);
    }

    return () => {
      target.removeEventListener('resize', updateViewportMetrics);
      if (visualViewport) {
        visualViewport.removeEventListener('scroll', updateViewportMetrics);
      }
    };
  }, [baselineViewportHeight, composeFocused, isDesktop]);

  const handleComposeFocusChange = useCallback((focused: boolean) => {
    console.debug('[keyboard:focus]', {
      focused,
      viewportHeight: window.visualViewport?.height ?? window.innerHeight,
      offsetTop: window.visualViewport?.offsetTop ?? 0,
      scrollY: window.scrollY,
      standalone: isStandalonePwa(),
    });
    setComposeFocused(focused);
  }, []);

  const isKeyboardOpen =
    !isDesktop && composeFocused && baselineViewportHeight - viewportHeight > KEYBOARD_OPEN_HEIGHT_DIFF;
  const keyboardFullyClosed =
    !isDesktop && !composeFocused && baselineViewportHeight - viewportHeight < KEYBOARD_CLOSED_HEIGHT_DIFF;
  const pageStyle = isKeyboardOpen
    ? {
        height: `${viewportHeight}px`,
        top: `${viewportOffsetTop}px`,
      }
    : undefined;

  return {
    handleComposeFocusChange,
    isKeyboardOpen,
    keyboardFullyClosed,
    pageStyle,
  };
}

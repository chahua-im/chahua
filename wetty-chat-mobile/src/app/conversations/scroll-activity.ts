/** Native scrolling includes the inertia after the finger has lifted. */
export function scrollActivity() {
  let touching = false;
  let scrolling = false;
  let pending: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const settle = () => {
    if (touching || scrolling) return;
    release?.();
    release = undefined;
    pending = undefined;
  };
  return {
    touchStart: () => {
      touching = true;
    },
    touchEnd: () => {
      touching = false;
      settle();
    },
    scrollStart: () => {
      scrolling = true;
    },
    scrollEnd: () => {
      scrolling = false;
      settle();
    },
    wait: () => {
      if (!touching && !scrolling) return Promise.resolve();
      return (pending ??= new Promise<void>((resolve) => {
        release = resolve;
      }));
    },
    reset: () => {
      touching = scrolling = false;
      settle();
    },
  };
}

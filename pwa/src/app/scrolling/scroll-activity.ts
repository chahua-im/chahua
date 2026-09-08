import { signal } from '@angular/core';

/** Native scrolling includes the inertia after the finger has lifted. */
export function scrollActivity() {
  let touching = false;
  const moving = signal(false);
  let pending: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const settle = () => {
    if (touching || moving()) return;
    release?.();
    release = undefined;
    pending = undefined;
  };
  return {
    moving: moving.asReadonly(),
    touchStart: () => {
      touching = true;
    },
    touchEnd: () => {
      touching = false;
      settle();
    },
    scrollStart: () => {
      moving.set(true);
    },
    scrollEnd: () => {
      moving.set(false);
      settle();
    },
    wait: () => {
      if (!touching && !moving()) return Promise.resolve();
      return (pending ??= new Promise<void>((resolve) => {
        release = resolve;
      }));
    },
    reset: () => {
      touching = false;
      moving.set(false);
      settle();
    },
  };
}

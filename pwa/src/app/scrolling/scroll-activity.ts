import { computed, signal } from '@angular/core';

/** Native scrolling includes the inertia after the finger has lifted. */
export function scrollActivity() {
  const touching = signal(false);
  const moving = signal(false);
  const idle = computed(() => !touching() && !moving());
  let pending: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const settle = () => {
    if (!idle()) return;
    release?.();
    release = undefined;
    pending = undefined;
  };
  return {
    idle,
    moving: moving.asReadonly(),
    touchStart: () => {
      touching.set(true);
    },
    touchEnd: () => {
      touching.set(false);
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
      if (idle()) return Promise.resolve();
      return (pending ??= new Promise<void>((resolve) => {
        release = resolve;
      }));
    },
    reset: () => {
      touching.set(false);
      moving.set(false);
      settle();
    },
  };
}

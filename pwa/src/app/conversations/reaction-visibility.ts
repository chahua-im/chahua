import type { SnowflakeID } from '../api/snowflake-id';

/** One observer per conversation, with a continuous dwell for each reaction region. */
export class ReactionVisibility {
  private readonly targets = new Map<Element, { id: SnowflakeID; timer?: ReturnType<typeof setTimeout> }>();
  private readonly observer: IntersectionObserver;

  constructor(
    private readonly root: HTMLElement,
    private readonly onSeen: (id: SnowflakeID) => void,
  ) {
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const target = this.targets.get(entry.target);
          if (!target) continue;
          if (!entry.isIntersecting) {
            clearTimeout(target.timer);
            target.timer = undefined;
          } else if (target.timer == null) {
            target.timer = setTimeout(() => {
              target.timer = undefined;
              // Layout/scroll changes can precede delivery of the next observer entry.
              const rect = entry.target.getBoundingClientRect();
              const viewport = this.root.getBoundingClientRect();
              if (
                !entry.target.isConnected ||
                rect.width <= 0 ||
                rect.height <= 0 ||
                rect.top >= viewport.bottom ||
                rect.bottom <= viewport.top ||
                rect.left >= viewport.right ||
                rect.right <= viewport.left
              )
                return;
              this.remove(entry.target);
              this.onSeen(target.id);
            }, 500);
          }
        }
      },
      { root, threshold: 0 },
    );
  }

  watch(targets: ReadonlyMap<Element, SnowflakeID>) {
    for (const [element, target] of this.targets) if (targets.get(element) !== target.id) this.remove(element);
    for (const [element, id] of targets) {
      if (this.targets.has(element)) continue;
      this.targets.set(element, { id });
      this.observer.observe(element);
    }
  }

  forget(id: SnowflakeID) {
    for (const [element, target] of this.targets) if (target.id === id) this.remove(element);
  }

  disconnect() {
    this.watch(new Map());
    this.observer.disconnect();
  }

  private remove(element: Element) {
    clearTimeout(this.targets.get(element)?.timer);
    this.targets.delete(element);
    this.observer.unobserve(element);
  }
}

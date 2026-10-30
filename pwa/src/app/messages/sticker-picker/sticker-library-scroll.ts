import { afterRenderEffect, type ElementRef, type Signal, signal, untracked } from '@angular/core';
import type { SnowflakeID } from '../../../generated/models';

const GROUP_PREFETCH_MARGIN = 300;

interface StickerLibraryView {
  grouped: Signal<boolean>;
  embedded: Signal<boolean>;
  activeId: Signal<SnowflakeID | undefined>;
  groups: Signal<readonly { id?: SnowflakeID }[]>;
  viewport: Signal<ElementRef<HTMLElement> | undefined>;
  sections: Signal<readonly ElementRef<HTMLElement>[]>;
  tabs: Signal<readonly ElementRef<HTMLElement>[]>;
  select: (id?: SnowflakeID) => void;
  approach: (id: SnowflakeID) => void;
}

/** Owns the picker viewport, proximity window and anchors across layout/content changes. */
export class StickerLibraryScroll {
  private readonly nearGroups = signal<ReadonlySet<SnowflakeID | undefined>>(new Set());
  private readonly scrollTarget = signal<{ id?: SnowflakeID } | undefined>(undefined);
  private groupOffset = 0;
  private scrollAnchor?: { tile: HTMLElement; offset: number };
  private scrollWidth = 0;
  private scrollHeight = 0;
  private restoredScrollTop?: number;

  constructor(private readonly view: StickerLibraryView) {
    let previousGrouped = this.view.grouped();
    afterRenderEffect(() => {
      const grouped = this.view.grouped();
      const elements = this.view.sections();
      const groups = this.view.groups();
      const scroll = this.view.viewport()?.nativeElement;
      const target = this.scrollTarget();
      if (!scroll) return;
      if (target || grouped || grouped !== previousGrouped || this.scrollAnchor) {
        const id = target ? target.id : untracked(this.view.activeId);
        const index = groups.findIndex((group) => group.id === id);
        const section = elements[index]?.nativeElement;
        if (section) {
          if (target) {
            this.scrollAnchor = undefined;
            scroll.scrollTop = section.offsetTop;
          } else this.restoreScrollAnchor();
          this.scrollTarget.set(undefined);
        }
      }
      previousGrouped = grouped;
    });
    afterRenderEffect((onCleanup) => {
      const scroll = this.view.viewport()?.nativeElement;
      if (!scroll || !this.view.embedded()) return;
      this.scrollWidth = scroll.clientWidth;
      this.scrollHeight = scroll.clientHeight;
      const observer = new ResizeObserver(() => {
        if (scroll.clientWidth === this.scrollWidth && scroll.clientHeight === this.scrollHeight) return;
        this.restoreScrollAnchor();
      });
      observer.observe(scroll);
      onCleanup(() => observer.disconnect());
    });
    afterRenderEffect((onCleanup) => {
      const grouped = this.view.grouped();
      const elements = this.view.sections();
      const scroll = this.view.viewport()?.nativeElement;
      if (!grouped || !scroll) return;
      const groups = untracked(this.view.groups);
      const ids = new Map(elements.map((element, i) => [element.nativeElement, groups[i].id]));
      const observer = new IntersectionObserver(
        (entries) => {
          this.nearGroups.update((previous) => {
            const next = new Set(previous);
            for (const entry of entries) {
              const id = ids.get(entry.target as HTMLElement);
              if (entry.isIntersecting) next.add(id);
              else next.delete(id);
            }
            return next;
          });
          for (const entry of entries) {
            const id = ids.get(entry.target as HTMLElement);
            if (entry.isIntersecting && id != null) this.view.approach(id);
          }
        },
        { root: scroll, rootMargin: `${GROUP_PREFETCH_MARGIN}px 0px` },
      );
      elements.forEach((element) => observer.observe(element.nativeElement));
      onCleanup(() => observer.disconnect());
    });
    afterRenderEffect(() => {
      const id = this.view.activeId();
      const tabs = this.view.tabs();
      if (!this.view.grouped()) return;
      const index = untracked(this.view.groups).findIndex((group) => group.id === id);
      const tab = tabs[index]?.nativeElement;
      const bar = tab?.parentElement;
      if (!tab || !bar) return;
      if (tab.offsetLeft < bar.scrollLeft) bar.scrollLeft = tab.offsetLeft;
      else if (tab.offsetLeft + tab.offsetWidth > bar.scrollLeft + bar.clientWidth)
        bar.scrollLeft = tab.offsetLeft + tab.offsetWidth - bar.clientWidth;
    });
  }

  onScroll() {
    const scroll = this.view.viewport()!.nativeElement;
    // A resize can clamp scrollTop before Angular updates the layout. Keep the old anchor until restoration.
    if (scroll.clientWidth !== this.scrollWidth || scroll.clientHeight !== this.scrollHeight) return;
    if (scroll.scrollTop === this.restoredScrollTop) return;
    this.restoredScrollTop = undefined;
    if (!this.view.grouped()) {
      this.groupOffset = scroll.scrollTop;
      this.captureScrollAnchor(this.view.sections()[0]?.nativeElement);
      return;
    }
    const sections = this.view.sections();
    let index = 0;
    for (let i = 1; i < sections.length; i++) {
      if (sections[i].nativeElement.offsetTop > scroll.scrollTop + 1) break;
      index = i;
    }
    const id = this.view.groups()[index]?.id;
    this.view.select(id);
    this.groupOffset = scroll.scrollTop - (sections[index]?.nativeElement.offsetTop ?? 0);
    this.captureScrollAnchor(sections[index]?.nativeElement);
  }

  private captureScrollAnchor(section?: HTMLElement) {
    this.scrollAnchor = undefined;
    if (!section || this.groupOffset <= 0) return;
    const top =
      this.view.viewport()!.nativeElement.getBoundingClientRect().top +
      (section.querySelector<HTMLElement>('.group-title')?.offsetHeight ?? 0);
    for (const tile of section.querySelectorAll<HTMLElement>('.sticker-item')) {
      const rect = tile.getBoundingClientRect();
      if (rect.bottom > top) {
        this.scrollAnchor = { tile, offset: rect.top - top };
        break;
      }
    }
  }

  private restoreScrollAnchor() {
    const scroll = this.view.viewport()!.nativeElement;
    const section =
      this.view.sections()[this.view.groups().findIndex((group) => group.id === this.view.activeId())]?.nativeElement;
    if (!section) return;
    const anchor = this.scrollAnchor;
    if (anchor && section.contains(anchor.tile)) {
      const titleHeight = section.querySelector<HTMLElement>('.group-title')?.offsetHeight ?? 0;
      scroll.scrollTop +=
        anchor.tile.getBoundingClientRect().top - scroll.getBoundingClientRect().top - titleHeight - anchor.offset;
    } else scroll.scrollTop = section.offsetTop + this.groupOffset;
    this.scrollWidth = scroll.clientWidth;
    this.scrollHeight = scroll.clientHeight;
    // Programmatic scrolling must not replace the anchor with the first tile of the newly wrapped row.
    this.restoredScrollTop = scroll.scrollTop;
  }

  renders(id?: SnowflakeID) {
    return !this.view.grouped() || id === this.view.activeId() || this.nearGroups().has(id);
  }

  jump(id?: SnowflakeID) {
    this.scrollAnchor = undefined;
    this.restoredScrollTop = undefined;
    this.groupOffset = 0;
    this.scrollTarget.set({ id });
  }
}

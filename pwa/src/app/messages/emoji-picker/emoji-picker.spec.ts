import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import {
  EmojiDataService,
  EmojiFlagCacheService,
  EmojiPickerComponent,
  EmojiRecentsService,
  EmojiSearchService,
  SkinTonePopoverComponent,
} from '@nicematic/emoji-picker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Localization } from '../../i18n/localization';
import { EmojiPicker } from './emoji-picker';

describe('EmojiPicker data integration', () => {
  const originalShowPopover = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'showPopover');
  const showPopover = vi.fn();

  beforeEach(() => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('requestIdleCallback', undefined);
    showPopover.mockClear();
    Object.defineProperty(HTMLElement.prototype, 'showPopover', { configurable: true, value: showPopover });
    TestBed.configureTestingModule({
      imports: [EmojiPicker],
      providers: [{ provide: Localization, useValue: { locale: signal('zh-CN') } }],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
    if (originalShowPopover) Object.defineProperty(HTMLElement.prototype, 'showPopover', originalShowPopover);
    else Reflect.deleteProperty(HTMLElement.prototype, 'showPopover');
  });

  it('opens without requestIdleCallback and leaves flag loading to lazy image elements', () => {
    const fixture = TestBed.createComponent(EmojiPicker);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('nicematic-cell').length).toBeGreaterThan(40);
    expect(fixture.nativeElement.querySelectorAll('nicematic-cell').length).toBeLessThan(200);
    const child = fixture.debugElement.query(By.directive(EmojiPickerComponent));
    expect(child.injector.get(EmojiDataService).allEmojis().length).toBeGreaterThan(2000);
    child.componentInstance.onSearch('🇨🇳');
    fixture.detectChanges();
    const images = [...fixture.nativeElement.querySelectorAll('nicematic-cell img')] as HTMLImageElement[];
    expect(images.length).toBeGreaterThan(0);
    expect(images.every((image) => image.getAttribute('loading') === 'lazy')).toBe(true);

    const idle = vi.fn();
    const image = vi.fn();
    vi.stubGlobal('requestIdleCallback', idle);
    vi.stubGlobal('Image', image);
    const flags = child.injector.get(EmojiFlagCacheService);
    flags.preloadFlags(['🇨🇳', '🇺🇸']);
    expect(idle).not.toHaveBeenCalled();
    expect(image).not.toHaveBeenCalled();
    expect(flags.getFlag('1f1e8-1f1f3')).toContain('1f1e8-1f1f3.png');
  });

  it('windows scrolling and broad search results, and resets scroll when the query changes', () => {
    const fixture = TestBed.createComponent(EmojiPicker);
    fixture.detectChanges();
    const picker = fixture.debugElement.query(By.directive(EmojiPickerComponent))
      .componentInstance as EmojiPickerComponent;
    const viewport = picker.grid.scrollContainerRef.nativeElement;
    const first = fixture.nativeElement.querySelector('nicematic-cell');
    viewport.scrollTop = 36;
    viewport.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('nicematic-cell')).toBe(first);
    viewport.scrollTop = 4000;
    viewport.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();
    expect(fixture.nativeElement.contains(first)).toBe(false);
    expect(fixture.nativeElement.querySelectorAll('nicematic-cell').length).toBeLessThan(200);
    picker.onSearch('人');
    fixture.detectChanges();
    expect(viewport.scrollTop).toBe(0);
    expect(picker.displayedEmojis().length).toBeGreaterThan(200);
    expect(fixture.nativeElement.querySelectorAll('nicematic-cell').length).toBeLessThan(200);
    picker.onSearch('🫱🏻‍🫲🏿');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('nicematic-cell')).toHaveLength(1);
    picker.onSearch('');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('nicematic-cell').length).toBeGreaterThan(40);
  });

  it('uses the complete data for the real grid, search, skin popover, output and persisted recents', () => {
    const fixture = TestBed.createComponent(EmojiPicker);
    const chosen = vi.fn();
    fixture.componentInstance.chosen.subscribe(chosen);
    fixture.detectChanges();
    const child = fixture.debugElement.query(By.directive(EmojiPickerComponent));
    const picker = child.componentInstance as EmojiPickerComponent;
    const data = child.injector.get(EmojiDataService);
    const search = child.injector.get(EmojiSearchService);
    expect(picker.displayedEmojis().some((emoji) => emoji.char === '🫡')).toBe(true);

    picker.onSearch('宇航员');
    fixture.detectChanges();
    expect(search.results().some((emoji) => emoji.char === '🧑‍🚀')).toBe(true);
    const astronaut = picker.grid.emojis().find((emoji) => emoji.char === '🧑‍🚀')!;
    picker.grid.onLongPress(astronaut, new DOMRect(50, 200, 36, 36));
    fixture.detectChanges();
    const popover = fixture.debugElement.query(By.directive(SkinTonePopoverComponent))
      .componentInstance as SkinTonePopoverComponent;
    const floating = fixture.nativeElement.querySelector('nicematic-skin-tone-popover > div') as HTMLElement;
    expect(floating.getAttribute('popover')).toBe('manual');
    expect(floating.style.margin).toBe('0px');
    expect(showPopover).toHaveBeenCalled();
    expect(popover.getPreview('🏽')).toBe('🧑🏽‍🚀');
    popover.onSelect('🏽');
    expect(chosen).toHaveBeenLastCalledWith('🧑🏽‍🚀');

    const saved = new EmojiRecentsService().recents().find((emoji) => emoji.char === '🧑🏽‍🚀')!;
    expect(saved.base).toBe('🧑‍🚀');
    expect(data.getEmojiWithSkinTone(saved, '')).toBe('🧑🏽‍🚀');
    picker.grid.onLongPress(saved, new DOMRect(50, 200, 36, 36));
    fixture.detectChanges();
    const recentPopover = fixture.debugElement.query(By.directive(SkinTonePopoverComponent))
      .componentInstance as SkinTonePopoverComponent;
    expect(recentPopover.getPreview('')).toBe('🧑‍🚀');
    recentPopover.onSelect('🏿');
    expect(chosen).toHaveBeenLastCalledWith('🧑🏿‍🚀');

    picker.onSearch('🫱🏻‍🫲🏿');
    fixture.detectChanges();
    picker.onEmojiSelect(picker.displayedEmojis()[0]);
    expect(chosen).toHaveBeenLastCalledWith('🫱🏻‍🫲🏿');
  });

  it('closes the floating skin selector when hidden while retaining the search and picker instance', () => {
    const fixture = TestBed.createComponent(EmojiPicker);
    fixture.detectChanges();
    const picker = fixture.debugElement.query(By.directive(EmojiPickerComponent))
      .componentInstance as EmojiPickerComponent;
    picker.onSearch('宇航员');
    fixture.detectChanges();
    const astronaut = picker.grid.emojis().find((emoji) => emoji.char === '🧑‍🚀')!;
    picker.grid.onLongPress(astronaut, new DOMRect(50, 200, 36, 36));
    fixture.detectChanges();
    expect(picker.grid.skinToneEmoji()).toBe(astronaut);
    fixture.componentRef.setInput('active', false);
    fixture.detectChanges();
    expect(picker.grid.skinToneEmoji()).toBeNull();
    fixture.componentRef.setInput('active', true);
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.directive(EmojiPickerComponent)).componentInstance).toBe(picker);
    expect(picker.searchQuery()).toBe('宇航员');
  });
});

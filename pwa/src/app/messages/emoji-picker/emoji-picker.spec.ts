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
    expect(fixture.nativeElement.querySelectorAll('nicematic-cell').length).toBeGreaterThan(2000);
    const images = [...fixture.nativeElement.querySelectorAll('nicematic-cell img')] as HTMLImageElement[];
    expect(images.length).toBeGreaterThan(0);
    expect(images.every((image) => image.getAttribute('loading') === 'lazy')).toBe(true);

    const idle = vi.fn();
    const image = vi.fn();
    vi.stubGlobal('requestIdleCallback', idle);
    vi.stubGlobal('Image', image);
    const child = fixture.debugElement.query(By.directive(EmojiPickerComponent));
    const flags = child.injector.get(EmojiFlagCacheService);
    flags.preloadFlags(['🇨🇳', '🇺🇸']);
    expect(idle).not.toHaveBeenCalled();
    expect(image).not.toHaveBeenCalled();
    expect(flags.getFlag('1f1e8-1f1f3')).toContain('1f1e8-1f1f3.png');
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
});

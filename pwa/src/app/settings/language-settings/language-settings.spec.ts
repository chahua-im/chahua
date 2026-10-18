import { TestBed } from '@angular/core/testing';
import { ModalController, provideIonicAngular } from '@ionic/angular';
import type { RadioGroupCustomEvent } from '@ionic/core';
import { vi } from 'vitest';
import { Preferences } from '../preferences';
import { LanguageSettings } from './language-settings';

describe('LanguageSettings', () => {
  const values = new Map<string, string>();
  const dismiss = vi.fn().mockResolvedValue(true);

  beforeEach(() => {
    values.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    dismiss.mockClear();
    TestBed.configureTestingModule({
      imports: [LanguageSettings],
      providers: [provideIonicAngular({ animated: false }), { provide: ModalController, useValue: { dismiss } }],
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('offers auto plus every supported language', () => {
    const fixture = TestBed.createComponent(LanguageSettings);
    fixture.detectChanges();
    const page: HTMLElement = fixture.nativeElement;
    expect(Array.from(page.querySelectorAll('ion-radio')).map((radio) => radio.value)).toEqual([
      'auto',
      'en',
      'zh-CN',
      'zh-TW',
    ]);
    expect(page.textContent).toContain('自动');
    expect(page.textContent).toContain('English');
  });

  it('persists an explicit language, applies it and dismisses', async () => {
    const fixture = TestBed.createComponent(LanguageSettings);
    await fixture.componentInstance['select']({ detail: { value: 'en' } } as RadioGroupCustomEvent);
    fixture.detectChanges();
    expect(TestBed.inject(Preferences).selectedLocale()).toBe('en');
    expect(localStorage.getItem('chahua.preferences.locale')).toBe('en');
    expect(fixture.nativeElement.querySelector('ion-title').textContent).toContain('Language');
    expect(document.documentElement.lang).toBe('en');
    expect(dismiss).toHaveBeenCalled();
  });

  it('returns to automatic detection', async () => {
    localStorage.setItem('chahua.preferences.locale', 'zh-TW');
    const fixture = TestBed.createComponent(LanguageSettings);
    await fixture.componentInstance['select']({ detail: { value: 'auto' } } as RadioGroupCustomEvent);
    expect(TestBed.inject(Preferences).selectedLocale()).toBeNull();
    expect(localStorage.getItem('chahua.preferences.locale')).toBeNull();
  });
});

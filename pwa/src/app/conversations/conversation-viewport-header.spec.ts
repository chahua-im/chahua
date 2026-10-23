import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { getPlatforms, IonHeader } from '@ionic/angular';
import { vi } from 'vitest';
import { ConversationViewportHeader } from './conversation-viewport-header';

@Component({
  imports: [IonHeader, ConversationViewportHeader],
  template: '<ion-header appConversationViewportHeader>Conversation</ion-header>',
})
class HeaderHost {}

describe('Conversation viewport header', () => {
  const platforms = getPlatforms();
  const originalPlatforms = [...platforms];
  let viewport: EventTarget & { height: number; offsetTop: number; scale: number };

  beforeEach(() => {
    platforms.splice(0, platforms.length, 'ios');
    viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
    vi.stubGlobal('visualViewport', viewport);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    platforms.splice(0, platforms.length, ...originalPlatforms);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(['ios', 'android'] as const)(
    'keeps the header visible through keyboard pan and resize on %s',
    async (platform) => {
      platforms.splice(0, platforms.length, platform);
      const fixture = TestBed.createComponent(HeaderHost);
      await fixture.whenStable();
      const header: HTMLElement = fixture.nativeElement.querySelector('ion-header');
      const bodyStyle = document.body.style.cssText;
      const scroll = vi.spyOn(window, 'scrollTo');

      // Opening, changing keyboard height, panning without a resize, then closing.
      for (const [height, offsetTop, event] of [
        [400, 300, 'resize'],
        [350, 350, 'resize'],
        [350, 200, 'scroll'],
        [800, 0, 'resize'],
      ] as const) {
        Object.assign(viewport, { height, offsetTop });
        viewport.dispatchEvent(new Event(event));
        await fixture.whenStable();
        expect(header.style.translate).toBe(offsetTop ? `0 ${offsetTop}px` : '');
        expect(document.body.style.cssText).toBe(bodyStyle);
      }
      expect(scroll).not.toHaveBeenCalled();
    },
  );

  it('initializes while the keyboard is already open and releases viewport listeners on destroy', async () => {
    viewport.offsetTop = 240;
    const remove = vi.spyOn(viewport, 'removeEventListener');
    const fixture = TestBed.createComponent(HeaderHost);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('ion-header').style.translate).toBe('0 240px');

    fixture.destroy();
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
  });

  it('does not shift desktop headers', async () => {
    platforms.splice(0, platforms.length, 'desktop');
    viewport.offsetTop = 240;
    const fixture = TestBed.createComponent(HeaderHost);
    await fixture.whenStable();
    viewport.dispatchEvent(new Event('scroll'));
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('ion-header').style.translate).toBe('');
  });
});

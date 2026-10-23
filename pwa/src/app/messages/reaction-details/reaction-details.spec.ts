import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import { testChat, testMessage, wireChat, wireMessage } from '../../api/testing';
import { ReactionDetails } from './reaction-details';
describe('ReactionDetails', () => {
  it('shows all reactors and filters locally without issuing another request', async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    TestBed.configureTestingModule({ providers: [provideChahuaBaseUrl('/_api')] });
    const fixture = TestBed.createComponent(ReactionDetails);
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.componentRef.setInput('messageId', testMessage.id);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne(`/_api/chats/${wireChat.id}/messages/${wireMessage.id}/reactions`).flush({
      reactions: [
        { emoji: '👍', reactors: Array.from({ length: 8 }, (_, uid) => ({ uid, name: `用户${uid}`, sortIndex: uid })) },
        { emoji: '❤️', reactors: [{ uid: 9, name: '朋友', sortIndex: 8 }] },
      ],
    });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('ion-item')).toHaveLength(9);
    fixture.componentInstance['emoji'].set('❤️');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('ion-item')).toHaveLength(1);
    expect(fixture.nativeElement.textContent).toContain('朋友');
    http.verify();
    fixture.destroy();
  });

  it('groups by user in chronological order and uses the earliest remaining reaction after removal', async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    TestBed.configureTestingModule({ providers: [provideChahuaBaseUrl('/_api')] });
    const fixture = TestBed.createComponent(ReactionDetails);
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.componentRef.setInput('messageId', testMessage.id);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    const url = `/_api/chats/${wireChat.id}/messages/${wireMessage.id}/reactions`;
    const reactions = [
      {
        emoji: '👍',
        reactors: [
          { uid: 1, name: 'A', sortIndex: 0 },
          { uid: 3, name: 'C', sortIndex: 4 },
          { uid: 2, name: 'B', sortIndex: 5 },
        ],
      },
      {
        emoji: '❤️',
        reactors: [
          { uid: 2, name: 'B', sortIndex: 1 },
          { uid: 1, name: 'A', sortIndex: 3 },
        ],
      },
      {
        emoji: '🎉',
        reactors: [
          { uid: 4, name: 'D', sortIndex: 2 },
          { uid: 2, name: 'B', sortIndex: 6 },
        ],
      },
    ];
    http.expectOne(url).flush({ reactions });
    await fixture.whenStable();
    fixture.detectChanges();
    // Read the DOM text directly; Ionic's slot shim hides label text in jsdom.
    const textContent = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')!.get!;
    const rows = () =>
      Array.from(fixture.nativeElement.querySelectorAll('ion-item') as NodeListOf<HTMLElement>, (item) => [
        textContent.call(item.querySelector('ion-label')).trim(),
        item.querySelector('[slot="end"]')?.textContent?.trim(),
      ]);
    const expected = [
      ['A', '👍 ❤️'],
      ['B', '❤️ 👍 🎉'],
      ['D', '🎉'],
      ['C', '👍'],
    ];
    expect(rows()).toEqual(expected);
    expect(textContent.call(fixture.nativeElement.querySelector('ion-segment-button[value=""] ion-label'))).toContain(
      '7',
    );

    fixture.componentInstance['emoji'].set('❤️');
    fixture.detectChanges();
    expect(rows()).toEqual([
      ['B', '❤️'],
      ['A', '❤️'],
    ]);
    fixture.componentInstance['emoji'].set('');
    fixture.detectChanges();
    expect(rows()).toEqual(expected);
    http.expectNone(url);

    const reload = fixture.componentInstance['load']();
    http.expectOne(url).flush({
      reactions: reactions.map((group) => ({
        ...group,
        reactors: group.reactors.filter((user) => group.emoji !== '👍' || user.uid !== 1),
      })),
    });
    await reload;
    fixture.detectChanges();
    expect(rows()).toEqual([
      ['B', '❤️ 👍 🎉'],
      ['D', '🎉'],
      ['A', '❤️'],
      ['C', '👍'],
    ]);
    http.verify();
    fixture.destroy();
  });
});

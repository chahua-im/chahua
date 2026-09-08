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
        { emoji: '👍', reactors: Array.from({ length: 8 }, (_, uid) => ({ uid, name: `用户${uid}` })) },
        { emoji: '❤️', reactors: [{ uid: 9, name: '朋友' }] },
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
});

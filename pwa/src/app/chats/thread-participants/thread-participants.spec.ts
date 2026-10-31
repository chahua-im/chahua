import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ModalController } from '@ionic/angular';
import type { User } from '../../../generated/models';
import { RpcErrorCode } from '../../api/rpc-error';
import { provideRpcTesting, RpcTestPeer } from '../../api/rpc-testing';
import { decodeId, encodeId } from '../../api/snowflake-id';
import { testChat, testMessage, wireChat } from '../../api/testing';
import { ThreadParticipants } from './thread-participants';

const first: User = { uid: 1, name: '甲', gender: 0 };
const second: User = { uid: 2, name: '乙', gender: 0 };
const third: User = { uid: 3, name: '丙', gender: 0 };

const participantParams = (chatId = wireChat.id, threadRootId = decodeId(testMessage.id), cursor?: number) => ({
  chatId,
  threadRootId,
  limit: 100,
  ...(cursor == null ? {} : { cursor }),
});

describe('ThreadParticipants', () => {
  let peer: RpcTestPeer;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRpcTesting(), provideRouter([]), { provide: ModalController, useValue: {} }],
    });
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
  });

  afterEach(() => peer.verify());

  function open() {
    const fixture = TestBed.createComponent(ThreadParticipants);
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.componentRef.setInput('rootId', testMessage.id);
    fixture.detectChanges();
    return fixture;
  }

  it('loads the authoritative roster in UID pages and removes paging at the final cursor', async () => {
    const fixture = open();
    expect(fixture.nativeElement.querySelector('.page-loading')).not.toBeNull();
    peer
      .expect('threads.listParticipants', participantParams())
      .flush({ participants: [first, second], nextCursor: 2 });
    await fixture.whenStable();
    fixture.detectChanges();

    const component = fixture.componentInstance;
    expect(component['participants']().map((user) => user.uid)).toEqual([1, 2]);
    expect(component['cursor']()).toBe(2);

    const continuation = component['load'](true);
    peer.expect('threads.listParticipants', participantParams(wireChat.id, decodeId(testMessage.id), 2)).flush({
      participants: [third],
      nextCursor: null,
    });
    await continuation;
    fixture.detectChanges();

    expect(component['participants']().map((user) => user.uid)).toEqual([1, 2, 3]);
    expect(component['cursor']()).toBeNull();
    expect(fixture.nativeElement.querySelector('ion-infinite-scroll')).toBeNull();
  });

  it('keeps rows and the continuation cursor through a retryable paging failure', async () => {
    const fixture = open();
    peer.expect('threads.listParticipants', participantParams()).flush({ participants: [first], nextCursor: 1 });
    await fixture.whenStable();
    const component = fixture.componentInstance;

    const continuation = component['load'](true);
    peer
      .expect('threads.listParticipants', participantParams(wireChat.id, decodeId(testMessage.id), 1))
      .error(RpcErrorCode.Unavailable);
    await continuation;
    expect(component['participants']()).toEqual([first]);
    expect(component['cursor']()).toBe(1);
    expect(component['error']()).toBe(true);

    component['retry']();
    peer.expect('threads.listParticipants', participantParams(wireChat.id, decodeId(testMessage.id), 1)).flush({
      participants: [second],
    });
    await fixture.whenStable();

    expect(component['participants']()).toEqual([first, second]);
    expect(component['cursor']()).toBeUndefined();
    expect(component['error']()).toBe(false);
  });

  it('cancels and ignores a roster response when the chat scope changes', async () => {
    const fixture = open();
    const previous = peer.expect('threads.listParticipants', participantParams());
    const nextChatId = encodeId('200');
    fixture.componentRef.setInput('chatId', nextChatId);
    fixture.detectChanges();

    previous.flush({ participants: [first] });
    peer.expect('threads.listParticipants', participantParams('200')).flush({ participants: [third] });
    await fixture.whenStable();

    expect(fixture.componentInstance['participants']()).toEqual([third]);
  });

  it('cancels a previous thread in the same chat and cancels reads on destruction', async () => {
    const fixture = open();
    const previous = peer.expect('threads.listParticipants', participantParams());
    fixture.componentRef.setInput('rootId', encodeId('201'));
    fixture.detectChanges();
    previous.flush({ participants: [first] });
    peer.expect('threads.listParticipants', participantParams(wireChat.id, '201')).flush({ participants: [third] });
    await fixture.whenStable();
    expect(fixture.componentInstance['participants']()).toEqual([third]);
    const refreshing = fixture.componentInstance['load']();
    const pending = peer.expect('threads.listParticipants', participantParams(wireChat.id, '201'));
    fixture.destroy();
    pending.flush({ participants: [first] });
    await refreshing;
  });

  it('preserves a known roster during refresh and retries its first page on failure', async () => {
    const fixture = open();
    peer.expect('threads.listParticipants', participantParams()).flush({ participants: [first], nextCursor: 1 });
    await fixture.whenStable();
    fixture.detectChanges();
    const row = fixture.nativeElement.querySelector('ion-item');
    const refresh = fixture.componentInstance['load']();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-item')).toBe(row);
    expect(fixture.nativeElement.querySelector('.page-loading')).toBeNull();
    peer.expect('threads.listParticipants', participantParams()).error(RpcErrorCode.Unavailable);
    await refresh;
    fixture.componentInstance['retry']();
    peer.expect('threads.listParticipants', participantParams()).flush({
      participants: [{ ...first, name: 'Updated participant' }],
      nextCursor: null,
    });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-item')).toBe(row);
    expect(row.textContent).toContain('Updated participant');
    expect(fixture.nativeElement.querySelector('ion-infinite-scroll')).toBeNull();
  });

  it('clears a retained roster and disables retry when its scope loses access', async () => {
    const fixture = open();
    peer.expect('threads.listParticipants', participantParams()).flush({ participants: [first], nextCursor: 1 });
    await fixture.whenStable();
    const component = fixture.componentInstance;

    const refresh = component['load']();
    expect(component['participants']()).toEqual([first]);
    peer.expect('threads.listParticipants', participantParams()).error(RpcErrorCode.Forbidden);
    await refresh;

    expect(component['participants']()).toEqual([]);
    expect(component['cursor']()).toBeUndefined();
    expect(component['error']()).toBe(true);
    expect(component['retryable']()).toBe(false);
  });
});

import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ModalController } from '@ionic/angular';
import type { User } from '../../../generated/models';
import { encodeId } from '../../api/snowflake-id';
import { testMessage } from '../../api/testing';
import { ChatStore } from '../chat-store';
import { ThreadParticipants } from './thread-participants';

describe('ThreadParticipants', () => {
  it('uses the known participant list and merges loaded replies without counting other topics or recalled messages', async () => {
    const known = signal<User[] | undefined>(undefined);
    TestBed.configureTestingModule({
      providers: [
        { provide: ChatStore, useValue: { thread: () => (known() ? { participants: known() } : undefined) } },
        { provide: ModalController, useValue: {} },
      ],
    });
    const fixture = TestBed.createComponent(ThreadParticipants);
    fixture.componentRef.setInput('rootId', testMessage.id);
    fixture.componentRef.setInput('root', testMessage);
    const reply = {
      ...testMessage,
      id: encodeId('200'),
      replyRootId: testMessage.id,
      sender: { uid: 2, name: '参与者', gender: 0 },
    };
    fixture.componentRef.setInput('messages', [
      reply,
      { ...reply, id: encodeId('201') },
      { ...reply, id: encodeId('202'), sender: { uid: 3, name: '已撤回', gender: 0 }, isDeleted: true },
      { ...reply, id: encodeId('203'), sender: { uid: 4, name: '另一话题', gender: 0 }, replyRootId: encodeId('199') },
    ]);
    fixture.detectChanges();
    await fixture.whenStable();
    const names = () => fixture.componentInstance['participants']().map((user) => user.name);
    expect(names()).toEqual([testMessage.sender.name, '参与者']);
    expect(fixture.componentInstance['complete']()).toBe(false);
    known.set([{ uid: 5, name: '较早的参与者', gender: 0 }, reply.sender]);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(names()).toEqual(['较早的参与者', '参与者', testMessage.sender.name]);
    expect(fixture.componentInstance['complete']()).toBe(true);
    fixture.destroy();
  });
});

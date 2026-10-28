import { TestBed } from '@angular/core/testing';
import { provideIonicAngular } from '@ionic/angular';
import { of, throwError } from 'rxjs';
import { GroupsService } from '../../../generated/endpoints/groups/groups.service';
import { InvitesService } from '../../../generated/endpoints/invites/invites.service';
import { InviteType, type InviteResponse } from '../../../generated/models';
import { encodeId } from '../../api/snowflake-id';
import { ChatStore } from '../chat-store';
import { ChatInvites } from './chat-invites';

describe('Invite settings feedback', () => {
  const invite: InviteResponse = {
    id: encodeId('3'),
    chatId: encodeId('4'),
    code: 'test-code',
    inviteType: InviteType.generic,
    createdAt: '2026-01-01T00:00:00Z',
    creatorUid: 1,
  };
  const groups = { getGroups: vi.fn() };
  const invites = { getInvites: vi.fn(), postInvite: vi.fn(), postSendInviteMessage: vi.fn() };
  beforeEach(() => {
    vi.clearAllMocks();
    groups.getGroups.mockReturnValue(of({ groups: [] }));
    invites.getInvites.mockReturnValue(of({ invites: [] }));
    invites.postInvite.mockReturnValue(of(invite));
    invites.postSendInviteMessage.mockReturnValue(of(undefined));
    TestBed.configureTestingModule({
      providers: [
        provideIonicAngular({ animated: false }),
        { provide: GroupsService, useValue: groups },
        { provide: InvitesService, useValue: invites },
        { provide: ChatStore, useValue: { ensureDetails: async () => {}, canSpeak: () => true } },
      ],
    });
  });
  async function page() {
    const fixture = TestBed.createComponent(ChatInvites);
    fixture.componentRef.setInput('chatId', invite.chatId);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }
  it('retries group loading independently from the invite list', async () => {
    groups.getGroups.mockReturnValueOnce(throwError(() => new Error('offline')));
    const fixture = await page();
    const component = fixture.componentInstance;
    expect(component['groupsError']()).toBe(true);
    expect(component['error']()).toBe(false);
    const retry: HTMLElement = Array.from(
      fixture.nativeElement.querySelectorAll('ion-button') as NodeListOf<HTMLElement>,
    ).find((button) => button.textContent?.trim() === '重试')!;
    retry.click();
    await fixture.whenStable();
    expect(component['groupsError']()).toBe(false);
    expect(groups.getGroups).toHaveBeenCalledTimes(2);
    expect(invites.getInvites).toHaveBeenCalledOnce();
  });
  it('rejects past or malformed expiration and retains valid creation input on failure', async () => {
    const component = (await page()).componentInstance;
    for (const expiry of ['invalid', '2000-01-01T12:00']) {
      component['values'].set({ expiry });
      await component['create']();
    }
    expect(invites.postInvite).not.toHaveBeenCalled();
    const expiry = '2099-01-01T12:00';
    component['values'].set({ expiry });
    invites.postInvite.mockReturnValueOnce(throwError(() => new Error('offline')));
    await component['create']();
    expect(component['values']().expiry).toBe(expiry);
    expect(component['error']()).toBe(true);
    await component['create']();
    expect(component['invites']()).toEqual([invite]);
  });
  it('shows confirmation only after a successful share', async () => {
    const component = (await page()).componentInstance;
    component['destination'].set(encodeId('10'));
    invites.postSendInviteMessage.mockReturnValueOnce(throwError(() => new Error('offline')));
    await component['share'](invite);
    expect(component['notice']()).toBeUndefined();
    await component['share'](invite);
    expect(component['notice']()).toBe('邀请已发送');
  });
});

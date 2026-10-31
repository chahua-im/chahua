import { TestBed } from '@angular/core/testing';
import { AlertController, ModalController, provideIonicAngular } from '@ionic/angular';
import { FriendAddVerificationMode as Mode } from '../../../generated/models';
import { RpcTestPeer, provideRpcTesting } from '../../api/rpc-testing';
import { PanelNavigation } from '../../navigation/panel-navigation';
import { FriendVerificationSettings } from './friend-verification-settings';

describe('Friend verification unsaved question', () => {
  let peer: RpcTestPeer;
  let confirm: ReturnType<typeof vi.fn>;
  let dismiss: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    confirm = vi.fn().mockResolvedValue({ role: 'cancel' });
    dismiss = vi.fn().mockResolvedValue(true);
    TestBed.configureTestingModule({
      providers: [
        provideIonicAngular({ animated: false }),
        provideRpcTesting(),
        { provide: ModalController, useValue: { dismiss } },
        { provide: PanelNavigation, useValue: { back: dismiss, close: dismiss, registerLeaveCheck: () => () => {} } },
        {
          provide: AlertController,
          useValue: { create: async () => ({ present: async () => {}, onDidDismiss: confirm }) },
        },
      ],
    });
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
  });
  afterEach(() => peer.verify());
  async function page() {
    const fixture = TestBed.createComponent(FriendVerificationSettings);
    peer.expect('friends.getSettings').flush({ mode: Mode.need_message });
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.componentInstance;
  }
  it('does not prompt for unchanged settings and keeps edits when discard is cancelled', async () => {
    const component = await page();
    expect(await component.canDismiss()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    component['chooseMode'](Mode.question);
    component['verification'].update((value) => ({ ...value, question: '问题' }));
    expect(await component.canDismiss()).toBe(false);
    expect(component['verification']().question).toBe('问题');
    confirm.mockResolvedValueOnce({ role: 'destructive' });
    expect(await component.canDismiss()).toBe(true);
    expect(component['dirty']()).toBe(false);
    expect(await component.canDismiss()).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2);
    peer.expectNone('friends.updateSettings');
  });
  it('keeps a failed question editable and closes only after a successful retry', async () => {
    const component = await page();
    component['chooseMode'](Mode.question);
    component['verification'].update((value) => ({ ...value, question: ' 问题 ' }));
    const failure = component['saveVerification']();
    expect(await component.canDismiss()).toBe(false);
    peer.expect('friends.updateSettings', { mode: Mode.question, question: '问题' }).error(1503);
    await failure;
    expect(component['verification']().question).toBe(' 问题 ');
    expect(component['dirty']()).toBe(true);
    expect(dismiss).not.toHaveBeenCalled();
    const success = component['saveVerification']();
    peer.expect('friends.updateSettings', { mode: Mode.question, question: '问题' }).flush({
      mode: Mode.question,
      question: '问题',
    });
    await success;
    expect(component['dirty']()).toBe(false);
    expect(dismiss).toHaveBeenCalledWith();
  });
});

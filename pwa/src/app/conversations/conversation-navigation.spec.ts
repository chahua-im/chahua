import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { ModalController } from '@ionic/angular';
import { testChat } from '../api/testing';
import { ConversationNavigation } from './conversation-navigation';

describe('Conversation navigation', () => {
  const modals = { getTop: vi.fn(), dismiss: vi.fn() };
  const router = {
    url: '',
    createUrlTree: (commands: string[]) => commands.join('/'),
    serializeUrl: (url: string) => url,
    navigate: vi.fn(),
  };
  beforeEach(() => {
    router.url = '/chats';
    router.navigate.mockReset().mockResolvedValue(true);
    modals.getTop.mockReset().mockResolvedValue(undefined);
    modals.dismiss.mockReset().mockResolvedValue(true);
    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: router },
        { provide: ModalController, useValue: modals },
      ],
    });
  });

  it('keeps the source panel when opening a conversation is rejected', async () => {
    router.navigate.mockResolvedValue(false);
    expect(await TestBed.inject(ConversationNavigation).open(testChat.id)).toBe(false);
    expect(modals.getTop).not.toHaveBeenCalled();
    expect(modals.dismiss).not.toHaveBeenCalled();
  });

  it('keeps the current overlay until routing succeeds', async () => {
    let resolve!: (opened: boolean) => void;
    router.navigate.mockImplementation(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    modals.getTop.mockResolvedValueOnce({}).mockResolvedValue(undefined);
    const pending = TestBed.inject(ConversationNavigation).open(testChat.id);
    expect(modals.getTop).not.toHaveBeenCalled();
    resolve(true);
    expect(await pending).toBe(true);
    expect(modals.dismiss).toHaveBeenCalledExactlyOnceWith(undefined, 'navigate');
  });
});

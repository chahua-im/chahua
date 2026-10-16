import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import WaveSurfer from 'wavesurfer.js';
import { encodeId } from '../../api/snowflake-id';
import { ConversationNavigation } from '../../conversations/conversation-navigation';
import { VoicePlayback, type VoiceDock } from './voice-playback';
import { VoiceBar } from './voice-bar';
import { VoicePlayer } from './voice-player';

const dock: VoiceDock = {
  messageId: encodeId('9007199254741003'),
  chatId: encodeId('9007199254740993'),
  label: '张三',
  createdAt: '2026-10-16T10:00:00Z',
};

describe('VoiceBar', () => {
  let playback: VoicePlayback;
  let navigation: ConversationNavigation;
  let fixture: ReturnType<typeof create>;
  function create() {
    return TestBed.createComponent(VoiceBar);
  }
  beforeEach(() => {
    vi.stubGlobal(
      'Audio',
      class {
        preload = 'none';
        play = vi.fn(async () => {});
        pause = vi.fn();
        addEventListener = () => {};
        removeEventListener = () => {};
        removeAttribute = () => {};
      },
    );
    vi.spyOn(WaveSurfer, 'create').mockReturnValue({
      on: () => {},
      load: () => Promise.resolve(),
      destroy: () => {},
    } as unknown as WaveSurfer);
    playback = TestBed.inject(VoicePlayback);
    playback.active.set(undefined);
    playback.rate.set(1);
    navigation = TestBed.inject(ConversationNavigation);
    fixture = create();
    fixture.detectChanges();
  });
  afterEach(() => vi.unstubAllGlobals());

  function playingPlayer() {
    const player = TestBed.createComponent(VoicePlayer);
    player.componentRef.setInput('src', '/voice.ogg');
    player.componentRef.setInput('dock', dock);
    player.detectChanges();
    player.componentInstance.toggle();
    fixture.detectChanges();
    return player;
  }

  it('is hidden while no voice is active', () => {
    expect(fixture.nativeElement.querySelector('.voice-bar')).toBeNull();
  });

  it('renders the active voice and drives playback, speed and dismissal through it', () => {
    const player = playingPlayer();
    const bar: HTMLElement = fixture.nativeElement.querySelector('.voice-bar');
    expect(bar).not.toBeNull();
    expect(bar.querySelector('.voice-name')?.textContent).toBe('张三');
    bar.querySelector<HTMLButtonElement>('.voice-speed')!.click();
    expect(playback.rate()).toBe(1.5);
    bar.querySelector<HTMLButtonElement>('.voice-button')!.click();
    expect(player.componentInstance.playing()).toBe(false);
    (bar.querySelector('ion-button') as HTMLElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.voice-bar')).toBeNull();
    expect(playback.active()).toBeUndefined();
  });

  it('opens the voice conversation from its label', () => {
    const open = vi.spyOn(navigation, 'open').mockResolvedValue(true);
    playingPlayer();
    (fixture.nativeElement.querySelector('.voice-label') as HTMLElement).click();
    expect(open).toHaveBeenCalledWith(dock.chatId, undefined, dock.messageId);
  });
});

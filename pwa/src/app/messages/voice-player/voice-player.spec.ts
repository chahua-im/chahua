import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import WaveSurfer from 'wavesurfer.js';
import { encodeId, type SnowflakeID } from '../../api/snowflake-id';
import { VoicePlayback, type VoiceDock } from './voice-playback';
import { VoicePlayer } from './voice-player';
const destroy = vi.fn(),
  load = vi.fn(() => Promise.resolve()),
  exportPeaks = vi.fn(() => [[0.5, 0.8, 0.3]]),
  handlers = new Map<string, () => void>();
const dock: VoiceDock = {
  messageId: encodeId('9007199254741003'),
  chatId: encodeId('9007199254740993'),
  label: '张三',
  createdAt: '2026-10-16T10:00:00Z',
};
let create: ReturnType<typeof vi.spyOn>;
describe('VoicePlayer', () => {
  let audios: HTMLAudioElement[];
  let playback: VoicePlayback;
  beforeEach(() => {
    audios = [];
    handlers.clear();
    create = vi.spyOn(WaveSurfer, 'create').mockReturnValue({
      on: (event: string, fn: () => void) => handlers.set(event, fn),
      load,
      exportPeaks,
      destroy,
    } as unknown as WaveSurfer);
    create.mockClear();
    load.mockClear();
    exportPeaks.mockClear();
    destroy.mockClear();
    vi.stubGlobal(
      'Audio',
      class {
        constructor(src: string) {
          const audio = document.createElement('audio');
          audio.src = src;
          audio.play = vi.fn(async () => {
            audio.dispatchEvent(new Event('playing'));
          });
          audio.pause = vi.fn(() => audio.dispatchEvent(new Event('pause')));
          audios.push(audio);
          return audio;
        }
      },
    );
    playback = TestBed.inject(VoicePlayback);
    playback.active.set(undefined);
    playback.rate.set(1);
  });
  afterEach(() => vi.unstubAllGlobals());
  function open(src = '/voice.ogg', dock?: VoiceDock) {
    const fixture = TestBed.createComponent(VoicePlayer);
    fixture.componentRef.setInput('src', src);
    if (dock) fixture.componentRef.setInput('dock', dock);
    fixture.detectChanges();
    return fixture;
  }
  it('loads the waveform on mount and starts playback from the first click', () => {
    const fixture = open();
    expect(audios).toHaveLength(1);
    expect(audios[0].preload).toBe('metadata');
    expect(create).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith('/voice.ogg');
    fixture.nativeElement.querySelector('.play').click();
    expect(audios[0].play).toHaveBeenCalledOnce();
    expect(fixture.componentInstance.playing()).toBe(true);
    fixture.destroy();
    expect(audios[0].pause).toHaveBeenCalled();
    expect(destroy).toHaveBeenCalled();
  });
  it('pauses the previous voice and retains playback if only waveform decoding fails', () => {
    const first = open('/one.ogg'),
      second = open('/two.ogg');
    first.componentInstance.toggle();
    second.componentInstance.toggle();
    expect(audios[0].pause).toHaveBeenCalled();
    handlers.get('error')!();
    expect(second.componentInstance.playing()).toBe(true);
    expect(second.componentInstance.failed()).toBe(false);
  });
  it('pauses playback and buffering while retaining the player for a covered conversation', () => {
    const fixture = open();
    fixture.componentInstance.toggle();
    audios[0].dispatchEvent(new Event('waiting'));
    expect(fixture.componentInstance.loading()).toBe(true);
    playback.pause();
    expect(fixture.componentInstance.playing()).toBe(false);
    expect(fixture.componentInstance.loading()).toBe(false);
    expect(destroy).not.toHaveBeenCalled();
  });
  it('offers original-file access and recreates a failed player on retry', () => {
    const fixture = open();
    fixture.componentInstance.toggle();
    audios[0].dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('a').getAttribute('href')).toBe('/voice.ogg');
    fixture.componentInstance.toggle();
    expect(audios).toHaveLength(2);
    expect(create).toHaveBeenCalledTimes(2);
  });
  it('docks a message voice on play, keeps it through pause and releases it on end or dismissal', () => {
    const fixture = open('/voice.ogg', dock);
    expect(playback.active()).toBeUndefined();
    expect(fixture.nativeElement.querySelector('.trailing')).toBeNull();
    fixture.componentInstance.toggle();
    expect(playback.active()).toBe(fixture.componentInstance);
    fixture.componentInstance.toggle();
    expect(playback.active()).toBe(fixture.componentInstance);
    audios[0].dispatchEvent(new Event('ended'));
    expect(playback.active()).toBeUndefined();
    fixture.componentInstance.dismiss();
    expect(audios[0].pause).toHaveBeenCalled();
    expect(playback.active()).toBeUndefined();
  });
  it('pauses and releases a docked voice that never played when its player is destroyed', () => {
    const fixture = open('/voice.ogg', dock);
    fixture.destroy();
    expect(audios[0].pause).toHaveBeenCalled();
    expect(playback.active()).toBeUndefined();
  });
  it('keeps the inline speed control for players that cannot dock', () => {
    const fixture = open('/preview.ogg');
    expect(fixture.nativeElement.querySelector('.trailing')).not.toBeNull();
    fixture.componentInstance.toggle();
    expect(playback.active()).toBeUndefined();
    fixture.destroy();
    expect(audios[0].pause).toHaveBeenCalled();
  });
  it('keeps a docked voice playing after its player is destroyed and hands it back on return', () => {
    const fixture = open('/voice.ogg', dock);
    fixture.componentInstance.toggle();
    handlers.get('decode')!();
    fixture.componentInstance.speed();
    fixture.destroy();
    // The audio element is adopted untouched, so playback continues.
    expect(audios[0].pause).not.toHaveBeenCalled();
    const orphan = playback.active()!;
    expect(orphan).not.toBe(fixture.componentInstance);
    expect(orphan.dock()).toBe(dock);
    expect(orphan.playing()).toBe(true);
    expect(playback.rate()).toBe(1.5);
    orphan.toggle();
    expect(audios[0].pause).toHaveBeenCalled();
    expect(playback.active()).toBe(orphan);
    playback.speed();
    expect(playback.rate()).toBe(2);
    // Returning to the conversation reuses the adopted element instead of a second Audio.
    const returned = open('/voice.ogg', dock);
    expect(audios).toHaveLength(1);
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ peaks: [[0.5, 0.8, 0.3]], media: audios[0] }));
    expect(playback.active()).toBe(returned.componentInstance);
    expect(playback.rate()).toBe(2);
    audios[0].dispatchEvent(new Event('ended'));
    expect(playback.active()).toBeUndefined();
  });
  it('releases an adopted voice when a different one starts or the bar closes it', () => {
    const fixture = open('/voice.ogg', dock);
    fixture.componentInstance.toggle();
    fixture.destroy();
    const orphan = playback.active()!;
    const other = open('/other.ogg');
    other.componentInstance.toggle();
    expect(audios[0].pause).toHaveBeenCalled();
    expect(playback.active()).toBeUndefined();
    orphan.dismiss();
    expect(audios[0].pause).toHaveBeenCalled();
  });
});

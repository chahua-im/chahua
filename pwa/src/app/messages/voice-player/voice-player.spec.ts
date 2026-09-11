import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import WaveSurfer from 'wavesurfer.js';
import { pauseVoicePlayback, VoicePlayer } from './voice-player';
const destroy = vi.fn(),
  handlers = new Map<string, () => void>();
let create: ReturnType<typeof vi.spyOn>;
describe('VoicePlayer', () => {
  let audios: HTMLAudioElement[];
  beforeEach(() => {
    audios = [];
    handlers.clear();
    create = vi.spyOn(WaveSurfer, 'create').mockReturnValue({
      on: (event: string, fn: () => void) => handlers.set(event, fn),
      destroy,
    } as unknown as WaveSurfer);
    create.mockClear();
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
  });
  afterEach(() => vi.unstubAllGlobals());
  function open(src = '/voice.ogg') {
    const fixture = TestBed.createComponent(VoicePlayer);
    fixture.componentRef.setInput('src', src);
    fixture.detectChanges();
    return fixture;
  }
  it('creates no media or waveform request until the first click', () => {
    const fixture = open();
    expect(audios).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
    fixture.nativeElement.querySelector('.play').click();
    expect(audios).toHaveLength(1);
    expect(audios[0].preload).toBe('none');
    expect(audios[0].play).toHaveBeenCalledOnce();
    expect(fixture.componentInstance['playing']()).toBe(true);
    fixture.destroy();
    expect(audios[0].pause).toHaveBeenCalled();
    expect(destroy).toHaveBeenCalled();
  });
  it('pauses the previous voice and retains playback if only waveform decoding fails', () => {
    const first = open('/one.ogg'),
      second = open('/two.ogg');
    first.componentInstance['toggle']();
    second.componentInstance['toggle']();
    expect(audios[0].pause).toHaveBeenCalled();
    handlers.get('error')!();
    expect(second.componentInstance['playing']()).toBe(true);
    expect(second.componentInstance['failed']()).toBe(false);
  });
  it('pauses playback and buffering while retaining the player for a covered conversation', () => {
    const fixture = open();
    fixture.componentInstance['toggle']();
    audios[0].dispatchEvent(new Event('waiting'));
    expect(fixture.componentInstance['loading']()).toBe(true);
    pauseVoicePlayback();
    expect(fixture.componentInstance['playing']()).toBe(false);
    expect(fixture.componentInstance['loading']()).toBe(false);
    expect(destroy).not.toHaveBeenCalled();
  });
  it('offers original-file access and recreates a failed player on retry', () => {
    const fixture = open();
    fixture.componentInstance['toggle']();
    audios[0].dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('a').getAttribute('href')).toBe('/voice.ogg');
    fixture.componentInstance['toggle']();
    expect(audios).toHaveLength(2);
    expect(create).toHaveBeenCalledTimes(2);
  });
});

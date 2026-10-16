import { Service, signal, type Signal, type WritableSignal } from '@angular/core';
import type { SnowflakeID } from '../../api/snowflake-id';

export interface VoiceDock {
  messageId: SnowflakeID;
  chatId: SnowflakeID;
  label: string;
  createdAt: string;
}

/** Whatever currently owns the single playing audio: a live player, or a voice adopted after its page went away. */
export interface ActiveVoice {
  readonly dock: Signal<VoiceDock | undefined>;
  readonly playing: Signal<boolean>;
  readonly loading: Signal<boolean>;
  readonly failed: Signal<boolean>;
  readonly elapsed: Signal<number>;
  readonly duration: Signal<number>;
  toggle(): void;
  dismiss(): void;
}

interface Adoption {
  src: string;
  audio: HTMLAudioElement;
  peaks: number[][] | undefined;
  duration: WritableSignal<number>;
  elapsed: WritableSignal<number>;
  playing: WritableSignal<boolean>;
  cleanup: () => void;
}

/** Single owner of message voice playback, so it survives leaving and switching conversations. */
@Service()
export class VoicePlayback {
  readonly active = signal<ActiveVoice | undefined>(undefined);
  /** Playback speed shared by every voice, like Telegram's. */
  readonly rate = signal(1);
  private adopted?: Adoption;
  private current?: HTMLAudioElement;

  /** Cycles the shared playback speed and applies it to the playing audio. */
  speed() {
    const next = this.rate() === 2 ? 1 : this.rate() + 0.5;
    this.rate.set(next);
    if (this.current) this.current.playbackRate = next;
  }

  /** Makes `audio` the one playing audio: anything else, including an adopted voice, is paused. */
  claim(audio: HTMLAudioElement) {
    if (this.adopted && this.adopted.audio !== audio) this.release();
    if (this.current !== audio) this.current?.pause();
    this.current = audio;
  }

  /** Deliberate pause for a covered conversation; switching conversations does not call this. */
  pause() {
    this.current?.pause();
  }

  isActive(voice: ActiveVoice) {
    return this.active() === voice;
  }

  activate(voice: ActiveVoice) {
    this.active.set(voice);
  }

  deactivate(voice: ActiveVoice) {
    if (this.active() === voice) this.active.set(undefined);
  }

  /**
   * Keeps a docked voice playing after its player is destroyed: the audio element and its state move
   * into the service until a player for the same message takes them back.
   */
  adopt(voice: {
    src: string;
    dock: VoiceDock;
    audio: HTMLAudioElement;
    peaks: number[][] | undefined;
    duration: number;
    elapsed: number;
    playing: boolean;
  }) {
    this.release();
    const { audio } = voice;
    const playing = signal(voice.playing);
    const loading = signal(false);
    const failed = signal(false);
    const elapsed = signal(voice.elapsed);
    const duration = signal(voice.duration);
    const on = (type: string, listener: () => void) => audio.addEventListener(type, listener);
    const off = (type: string, listener: () => void) => audio.removeEventListener(type, listener);
    const listeners: [string, () => void][] = [
      ['playing', () => (playing.set(true), loading.set(false))],
      ['pause', () => (playing.set(false), loading.set(false))],
      ['ended', () => (playing.set(false), this.release())],
      ['timeupdate', () => elapsed.set(audio.currentTime)],
      [
        'durationchange',
        () => {
          if (Number.isFinite(audio.duration)) duration.set(audio.duration);
        },
      ],
      [
        'error',
        () => {
          failed.set(true);
          loading.set(false);
          playing.set(false);
        },
      ],
    ];
    for (const [type, listener] of listeners) on(type, listener);
    this.adopted = {
      src: voice.src,
      audio,
      peaks: voice.peaks,
      duration,
      elapsed,
      playing,
      cleanup: () => {
        for (const [type, listener] of listeners) off(type, listener);
        if (this.current === audio) this.current = undefined;
      },
    };
    this.active.set({
      dock: signal(voice.dock),
      playing,
      loading,
      failed,
      elapsed,
      duration,
      toggle: () => {
        if (playing() || loading()) {
          audio.pause();
          loading.set(false);
          return;
        }
        loading.set(true);
        void audio.play().catch((error) => {
          loading.set(false);
          if (error?.name !== 'AbortError') failed.set(true);
        });
      },
      dismiss: () => {
        audio.pause();
        this.release();
      },
    });
  }

  /** Hands an adopted voice back to a freshly mounted player for the same message. */
  take(src: string) {
    if (!this.adopted || this.adopted.src !== src) return undefined;
    const { audio, peaks, duration, elapsed, playing } = this.adopted;
    const taken = {
      audio,
      peaks,
      duration: duration(),
      elapsed: elapsed(),
      playing: playing(),
    };
    this.release();
    this.current = audio;
    return taken;
  }

  private release() {
    if (!this.adopted) return;
    const { audio, cleanup } = this.adopted;
    this.adopted = undefined;
    audio.pause();
    cleanup();
    this.active.set(undefined);
  }
}

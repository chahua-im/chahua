import { Component, DestroyRef, ElementRef, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { IonIcon, IonSpinner } from '@ionic/angular';
import { pause, play, refreshOutline } from 'ionicons/icons';
import WaveSurfer from 'wavesurfer.js';
import { VoicePlayback, type VoiceDock } from './voice-playback';

export function voiceTime(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
}

@Component({
  selector: 'app-voice-player',
  imports: [IonIcon, IonSpinner, TranslocoPipe],
  templateUrl: './voice-player.html',
  styleUrl: './voice-player.scss',
})
export class VoicePlayer {
  readonly src = input.required<string>();
  /** Message voice messages pass their identity; the controls for them belong to the docked bar. */
  readonly dock = input<VoiceDock>();
  private readonly wave = viewChild.required<ElementRef<HTMLElement>>('wave');
  private readonly track = viewChild.required<ElementRef<HTMLElement>>('track');
  protected readonly playback = inject(VoicePlayback);
  protected readonly icons = { play, pause, refreshOutline };
  protected readonly time = voiceTime;
  readonly playing = signal(false);
  readonly loading = signal(false);
  readonly failed = signal(false);
  readonly elapsed = signal(0);
  readonly duration = signal(0);
  protected readonly waveform = signal(false);
  private audio?: HTMLAudioElement;
  private listeners: [string, () => void][] = [];
  private player?: WaveSurfer;
  private readonly destroy = inject(DestroyRef);
  constructor() {
    effect(() => {
      const src = this.src();
      untracked(() => this.prepare(src));
    });
    this.destroy.onDestroy(() => this.relinquish());
  }
  toggle() {
    if (this.playing() || this.loading()) {
      this.audio?.pause();
      this.loading.set(false);
      return;
    }
    // The media element that failed is rebuilt before the retry.
    const audio = this.failed() ? this.prepare(this.src()) : this.audio!;
    this.playback.claim(audio);
    if (this.dock()) this.playback.activate(this);
    this.loading.set(true);
    // Start in the click handler so iOS retains user activation.
    void audio.play().catch((error) => {
      if (this.audio !== audio) return;
      this.loading.set(false);
      if (error?.name !== 'AbortError') this.failed.set(true);
    });
  }
  speed() {
    this.playback.speed();
  }
  /** The docked bar's close control stops playback and releases the bar. */
  dismiss() {
    this.audio?.pause();
    this.playback.deactivate(this);
  }
  private prepare(src: string) {
    this.release();
    // A voice left playing by a destroyed player continues on the very same element.
    const held = this.playback.take(src);
    const audio = (this.audio = held?.audio ?? new Audio(src));
    if (held) {
      this.playing.set(held.playing);
      this.elapsed.set(held.elapsed);
      this.duration.set(held.duration);
    }
    audio.preload = 'metadata';
    audio.playbackRate = this.playback.rate();
    this.listen(audio, 'playing', () => {
      this.playing.set(true);
      this.loading.set(false);
    });
    this.listen(audio, 'pause', () => {
      this.playing.set(false);
      this.loading.set(false);
    });
    this.listen(audio, 'ended', () => {
      this.playing.set(false);
      this.playback.deactivate(this);
    });
    this.listen(audio, 'waiting', () => this.loading.set(true));
    this.listen(audio, 'timeupdate', () => this.elapsed.set(audio.currentTime));
    this.listen(audio, 'durationchange', () => {
      if (Number.isFinite(audio.duration)) this.duration.set(audio.duration);
    });
    this.listen(audio, 'error', () => {
      this.failed.set(true);
      this.loading.set(false);
      this.playing.set(false);
    });
    this.player = WaveSurfer.create({
      container: this.wave().nativeElement,
      media: audio,
      height: 26,
      waveColor: getComputedStyle(this.wave().nativeElement).color,
      progressColor: getComputedStyle(this.track().nativeElement).color,
      cursorWidth: 0,
      barWidth: 2,
      barGap: 2,
      barRadius: 2,
      barAlign: 'bottom',
      normalize: true,
      dragToSeek: true,
      ...(held ? { peaks: held.peaks, duration: held.duration } : {}),
    });
    this.player.on('decode', () => this.waveform.set(true));
    // Audio playback remains available if cross-origin restrictions prevent reading the waveform.
    this.player.on('error', () => this.waveform.set(false));
    if (!held) {
      // Failures, including aborted loads, are reported through the player's error event.
      void this.player.load(src).catch(() => {});
    }
    if (held && this.dock()) this.playback.activate(this);
    return audio;
  }
  private listen(audio: HTMLAudioElement, type: string, listener: () => void) {
    audio.addEventListener(type, listener);
    this.listeners.push([type, listener]);
  }
  /** Full discard: used when the source changes or when nothing needs to outlive the player. */
  private release() {
    for (const [type, listener] of this.listeners) this.audio?.removeEventListener(type, listener);
    this.listeners = [];
    this.playback.deactivate(this);
    this.audio?.pause();
    this.player?.destroy();
    this.player = undefined;
    this.audio?.removeAttribute('src');
    this.audio = undefined;
    this.playing.set(false);
    this.loading.set(false);
    this.failed.set(false);
    this.waveform.set(false);
    this.elapsed.set(0);
    this.duration.set(0);
  }
  /** A destroyed player hands a docked voice to the service so playback outlives the page. */
  private relinquish() {
    if (!this.playback.isActive(this) || !this.audio || !this.dock()) {
      this.release();
      return;
    }
    const peaks = this.waveform() ? this.player?.exportPeaks() : undefined;
    this.playback.adopt({
      src: this.src(),
      dock: this.dock()!,
      audio: this.audio,
      peaks,
      duration: this.duration(),
      elapsed: this.elapsed(),
      playing: this.playing() || this.loading(),
    });
    for (const [type, listener] of this.listeners) this.audio.removeEventListener(type, listener);
    this.listeners = [];
    this.player?.destroy();
    this.player = undefined;
    this.audio = undefined;
    this.playing.set(false);
    this.loading.set(false);
    this.waveform.set(false);
  }
}

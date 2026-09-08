import { Component, DestroyRef, ElementRef, effect, inject, input, signal, viewChild } from '@angular/core';
import { IonIcon, IonSpinner } from '@ionic/angular';
import { pause, play, refreshOutline } from 'ionicons/icons';
import WaveSurfer from 'wavesurfer.js';

let playingAudio: HTMLAudioElement | undefined;

@Component({
  selector: 'app-voice-player',
  imports: [IonIcon, IonSpinner],
  templateUrl: './voice-player.html',
  styleUrl: './voice-player.scss',
})
export class VoicePlayer {
  readonly src = input.required<string>();
  private readonly wave = viewChild.required<ElementRef<HTMLElement>>('wave');
  protected readonly icons = { play, pause, refreshOutline };
  protected readonly playing = signal(false);
  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  protected readonly waveform = signal(false);
  protected readonly elapsed = signal(0);
  protected readonly duration = signal(0);
  protected readonly rate = signal(1);
  private audio?: HTMLAudioElement;
  private player?: WaveSurfer;
  private readonly destroy = inject(DestroyRef);
  constructor() {
    effect(() => {
      this.src();
      this.reset();
    });
    this.destroy.onDestroy(() => this.reset());
  }
  protected toggle() {
    if (this.playing() || this.loading()) {
      this.audio?.pause();
      this.loading.set(false);
      return;
    }
    if (this.failed()) this.reset();
    if (!this.audio) {
      const audio = (this.audio = new Audio(this.src()));
      audio.preload = 'none';
      audio.playbackRate = this.rate();
      audio.addEventListener('playing', () => {
        this.playing.set(true);
        this.loading.set(false);
      });
      audio.addEventListener('pause', () => this.playing.set(false));
      audio.addEventListener('waiting', () => this.loading.set(true));
      audio.addEventListener('timeupdate', () => this.elapsed.set(audio.currentTime));
      audio.addEventListener('durationchange', () => {
        if (Number.isFinite(audio.duration)) this.duration.set(audio.duration);
      });
      audio.addEventListener('error', () => {
        this.failed.set(true);
        this.loading.set(false);
        this.playing.set(false);
      });
      const color = getComputedStyle(this.wave().nativeElement).color;
      this.player = WaveSurfer.create({
        container: this.wave().nativeElement,
        media: audio,
        height: 28,
        waveColor: color,
        progressColor: color,
        cursorWidth: 0,
        barWidth: 2,
        barGap: 2,
        barRadius: 2,
        normalize: true,
        dragToSeek: true,
      });
      this.player.on('decode', () => this.waveform.set(true));
      // Audio playback remains available if cross-origin restrictions prevent reading the waveform.
      this.player.on('error', () => this.waveform.set(false));
    }
    playingAudio?.pause();
    playingAudio = this.audio;
    this.failed.set(false);
    this.loading.set(true);
    // Start in the click handler so iOS retains user activation.
    const audio = this.audio;
    void audio.play().catch((error) => {
      if (this.audio !== audio) return;
      this.loading.set(false);
      if (error?.name !== 'AbortError') this.failed.set(true);
    });
  }
  protected speed() {
    const rate = this.rate() === 2 ? 1 : this.rate() + 0.5;
    this.rate.set(rate);
    if (this.audio) this.audio.playbackRate = rate;
  }
  protected seek(event: Event) {
    if (this.audio && this.duration()) this.audio.currentTime = Number((event.target as HTMLInputElement).value);
  }
  protected time(seconds: number) {
    return Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
  }
  private reset() {
    if (playingAudio === this.audio) playingAudio = undefined;
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
    this.rate.set(1);
  }
}

import { Component, DestroyRef, computed, inject, input, model, output, signal } from '@angular/core';
import { IonIcon, IonSpinner } from '@ionic/angular';
import { mic, trash, arrowUp, send } from 'ionicons/icons';

enum Phase {
  Idle,
  Requesting,
  Recording,
  Recorded,
}
enum Target {
  Origin,
  Cancel,
  Send,
}

@Component({
  selector: 'app-voice-recorder',
  templateUrl: './voice-recorder.html',
  styleUrl: './voice-recorder.scss',
  imports: [IonIcon, IonSpinner],
  host: { '[class.active]': 'active()' },
})
export class VoiceRecorder {
  readonly active = model(false);
  readonly disabled = input(false);
  readonly submitted = output<File>();
  readonly discarded = output();
  protected discard() {
    this.reset();
    this.discarded.emit();
  }
  protected readonly Phase = Phase;
  protected readonly Target = Target;
  protected readonly icons = { mic, trash, arrowUp, send };
  protected readonly phase = signal(Phase.Idle);
  protected readonly target = signal(Target.Origin);
  protected readonly holding = signal(false);
  protected readonly duration = signal(0);
  protected readonly elapsed = computed(() => {
    const seconds = Math.floor(this.duration() / 1000);
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  });
  protected readonly failed = signal(false);
  protected readonly tooShort = signal(false);
  protected readonly available = typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  protected readonly url = signal<string | undefined>(undefined);
  private file?: File;
  private pointer?: { id: number; x: number; y: number };
  private stream?: MediaStream;
  private recorder?: MediaRecorder;
  private version = 0;
  private timer?: ReturnType<typeof setInterval>;
  private sendOnStop = false;
  private readonly destroy = inject(DestroyRef);

  constructor() {
    this.destroy.onDestroy(() => this.reset());
  }

  protected start(event: PointerEvent) {
    if (!event.isPrimary || event.button !== 0 || this.disabled() || this.active() || !this.available) return;
    event.preventDefault();
    this.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.holding.set(true);
    this.target.set(Target.Origin);
    void this.record();
  }
  private destination(event: PointerEvent) {
    if (!this.pointer) return Target.Origin;
    const left = this.pointer.x - event.clientX;
    const up = this.pointer.y - event.clientY;
    if (Math.max(left, up) < 28) return Target.Origin;
    return left >= up ? Target.Cancel : Target.Send;
  }
  protected move(event: PointerEvent) {
    if (this.pointer?.id === event.pointerId) this.target.set(this.destination(event));
  }
  protected finish(event: PointerEvent, cancelled = false) {
    if (this.pointer?.id !== event.pointerId) return;
    const destination = this.destination(event);
    this.pointer = undefined;
    this.holding.set(false);
    this.target.set(Target.Origin);
    if (cancelled || destination === Target.Cancel || this.phase() === Phase.Requesting) {
      this.reset();
      return;
    }
    this.sendOnStop = destination === Target.Send;
    this.recorder?.stop();
  }
  private async record() {
    const version = ++this.version;
    this.failed.set(false);
    this.tooShort.set(false);
    this.duration.set(0);
    this.phase.set(Phase.Requesting);
    this.active.set(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (version !== this.version || this.destroy.destroyed) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      const mimeType = [
        'audio/ogg;codecs=opus',
        'audio/mp4;codecs=mp4a.40.2',
        'audio/mp4; codecs="mp4a.40.2"',
        'audio/mp4;codecs=aac',
        'audio/mpeg',
      ].find((type) => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('当前浏览器不支持录音格式');
      const recorder = (this.recorder = new MediaRecorder(stream, { mimeType }));
      const chunks: Blob[] = [];
      const started = Date.now();
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = () => {
        this.reset();
        this.failed.set(true);
      };
      recorder.onstop = () => {
        clearInterval(this.timer);
        stream.getTracks().forEach((track) => track.stop());
        if (version !== this.version) return;
        this.recorder = undefined;
        this.stream = undefined;
        this.duration.set(Date.now() - started);
        if (!chunks.length || this.duration() < 500) {
          this.reset();
          this.tooShort.set(true);
          return;
        }
        const type = recorder.mimeType || mimeType;
        this.file = new File(chunks, 'voice.' + (type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'mp3'), {
          type,
        });
        this.url.set(URL.createObjectURL(this.file));
        this.phase.set(Phase.Recorded);
        if (this.sendOnStop) this.submitted.emit(this.file);
      };
      recorder.start();
      this.phase.set(Phase.Recording);
      this.timer = setInterval(() => this.duration.set(Date.now() - started), 200);
    } catch {
      if (version === this.version) {
        this.reset();
        this.failed.set(true);
      }
    }
  }
  protected send() {
    if (this.file && !this.disabled()) this.submitted.emit(this.file);
  }
  reset() {
    this.version++;
    clearInterval(this.timer);
    if (this.recorder) {
      this.recorder.onstop = null;
      if (this.recorder.state !== 'inactive') this.recorder.stop();
      this.recorder = undefined;
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.file = undefined;
    const url = this.url();
    if (url) URL.revokeObjectURL(url);
    this.url.set(undefined);
    this.pointer = undefined;
    this.holding.set(false);
    this.target.set(Target.Origin);
    this.sendOnStop = false;
    this.phase.set(Phase.Idle);
    this.active.set(false);
  }
}

import { TestBed } from '@angular/core/testing';
import { micOffOutline, micOutline } from 'ionicons/icons';
import { vi } from 'vitest';
import { VoiceRecorder } from './voice-recorder';

describe('Voice recording gesture', () => {
  let recorder: FakeRecorder;
  let resolve: (stream: MediaStream) => void;
  let reject: (reason: unknown) => void;
  const getUserMedia = vi.fn<() => Promise<MediaStream>>();
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
  class FakeRecorder {
    static isTypeSupported(type: string) {
      return type.startsWith('audio/mp4');
    }
    mimeType = 'audio/mp4;codecs=mp4a.40.2';
    state = 'inactive';
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: () => void;
    onerror?: () => void;
    constructor() {
      recorder = this;
    }
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['recording']) });
      this.onstop?.();
    }
  }
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    getUserMedia.mockReset().mockImplementation(
      () =>
        new Promise<MediaStream>((onResolve, onReject) => {
          resolve = onResolve;
          reject = onReject;
        }),
    );
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:recording');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    stop.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  function render() {
    const fixture = TestBed.createComponent(VoiceRecorder);
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('.microphone') as HTMLButtonElement;
    button.setPointerCapture = vi.fn();
    const selected = vi.fn();
    fixture.componentInstance.submitted.subscribe(selected);
    const pointer = (type: string, x = 150, y = 150) =>
      button.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 1,
          isPrimary: true,
          pointerType: 'touch',
          button: 0,
          clientX: x,
          clientY: y,
        }),
      );
    return { fixture, button, pointer, selected };
  }
  async function recording() {
    const result = render();
    result.pointer('pointerdown');
    resolve(stream);
    await Promise.resolve();
    result.fixture.detectChanges();
    vi.advanceTimersByTime(800);
    return result;
  }
  it('shows the supported icon before and during the first permission request', () => {
    const { fixture, button, pointer, selected } = render();
    expect(button.disabled).toBe(false);
    expect(button.querySelector('ion-icon')?.icon).toBe(micOutline);
    expect(getUserMedia).not.toHaveBeenCalled();
    fixture.componentInstance['send']();
    expect(selected).not.toHaveBeenCalled();
    pointer('pointerdown');
    fixture.detectChanges();
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: true });
    expect(button.querySelector('ion-icon')?.icon).toBe(micOutline);
    expect(fixture.nativeElement.querySelector('ion-alert').isOpen).toBe(false);
    expect(fixture.nativeElement.querySelector('ion-spinner')).not.toBeNull();
  });
  it.each([
    ['MediaRecorder is missing', () => vi.stubGlobal('MediaRecorder', undefined)],
    ['mediaDevices is missing', () => vi.stubGlobal('navigator', {})],
    ['getUserMedia is missing', () => vi.stubGlobal('navigator', { mediaDevices: {} })],
    [
      'only incompatible encoding is supported',
      () => vi.spyOn(FakeRecorder, 'isTypeSupported').mockImplementation((type) => type.startsWith('audio/webm')),
    ],
  ])('shows an enabled mic-off button and a dismissible alert when %s', (_reason, unsupported) => {
    unsupported();
    const { fixture, button, pointer, selected } = render();
    expect(button.disabled).toBe(false);
    expect(button.querySelector('ion-icon')?.icon).toBe(micOffOutline);
    const alert = fixture.nativeElement.querySelector('ion-alert') as HTMLIonAlertElement;
    expect(alert.isOpen).toBe(false);
    pointer('pointerdown');
    pointer('pointerup');
    button.click();
    fixture.detectChanges();
    expect(alert.isOpen).toBe(true);
    expect(alert.message).toBe('当前浏览器不支持录音，请使用其他浏览器。');
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(button.setPointerCapture).not.toHaveBeenCalled();
    expect(fixture.componentInstance.active()).toBe(false);
    expect(selected).not.toHaveBeenCalled();
    alert.dispatchEvent(new CustomEvent('didDismiss'));
    fixture.detectChanges();
    expect(alert.isOpen).toBe(false);
    button.click();
    fixture.detectChanges();
    expect(alert.isOpen).toBe(true);
  });
  it('shows permission failures in an alert and allows another recording attempt', async () => {
    const { fixture, button, pointer } = render();
    pointer('pointerdown');
    reject(new DOMException('Permission denied', 'NotAllowedError'));
    await Promise.resolve();
    fixture.detectChanges();
    const alert = fixture.nativeElement.querySelector('ion-alert') as HTMLIonAlertElement;
    expect(alert.isOpen).toBe(true);
    expect(alert.message).toBe('无法录音，请检查麦克风权限。');
    expect(fixture.componentInstance.active()).toBe(false);
    expect(button.disabled).toBe(false);
    expect(button.querySelector('ion-icon')?.icon).toBe(micOutline);
    alert.dispatchEvent(new CustomEvent('didDismiss'));
    fixture.detectChanges();
    expect(alert.isOpen).toBe(false);
    pointer('pointerdown');
    resolve(stream);
    await Promise.resolve();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(recorder.state).toBe('recording');
  });
  it('cleans up an encoder failure and shows the recording alert', async () => {
    const { fixture, selected } = await recording();
    recorder.onerror?.();
    fixture.detectChanges();
    expect(stop).toHaveBeenCalled();
    expect(fixture.componentInstance.active()).toBe(false);
    expect(fixture.nativeElement.querySelector('ion-alert').isOpen).toBe(true);
    expect(fixture.nativeElement.querySelector('app-voice-player')).toBeNull();
    expect(selected).not.toHaveBeenCalled();
  });
  it('discards the preview and cannot send the discarded recording', async () => {
    const { fixture, pointer, selected } = await recording();
    const discarded = vi.fn();
    fixture.componentInstance.discarded.subscribe(discarded);
    pointer('pointerup');
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('.delete') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    button.click();
    fixture.detectChanges();
    expect(discarded).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:recording');
    expect(fixture.nativeElement.querySelector('app-voice-player')).toBeNull();
    fixture.componentInstance['send']();
    expect(selected).not.toHaveBeenCalled();
  });
  it('saves a recording on release and waits for the send action', async () => {
    const { fixture, pointer, selected } = await recording();
    pointer('pointerup');
    fixture.detectChanges();
    expect(recorder.state).toBe('inactive');
    expect(stop).toHaveBeenCalled();
    expect(selected).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('app-voice-player')).not.toBeNull();
    fixture.nativeElement.querySelector('.send').click();
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ type: 'audio/mp4;codecs=mp4a.40.2' }));
    fixture.destroy();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:recording');
  });
  it.each([
    ['left', 90, 150],
    ['cancel', 150, 90],
  ])('cancels on %s without emitting a file', async (kind, x, y) => {
    const { fixture, pointer, selected } = await recording();
    pointer(kind === 'cancel' ? 'pointercancel' : 'pointerup', x, y);
    fixture.detectChanges();
    expect(selected).not.toHaveBeenCalled();
    expect(fixture.componentInstance.active()).toBe(false);
    expect(stop).toHaveBeenCalled();
  });
  it('snaps upward and sends when released at the send target', async () => {
    const { fixture, pointer, selected } = await recording();
    pointer('pointermove', 150, 110);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.send-target')).not.toBeNull();
    pointer('pointerup', 150, 90);
    expect(selected).toHaveBeenCalledOnce();
  });
  it('releases a permission result arriving after the finger was lifted', async () => {
    const { fixture, pointer, selected } = render();
    pointer('pointerdown');
    pointer('pointerup');
    resolve(stream);
    await Promise.resolve();
    expect(stop).toHaveBeenCalled();
    expect(selected).not.toHaveBeenCalled();
    expect(fixture.componentInstance.active()).toBe(false);
  });
  it('does not send a very short recording', async () => {
    const { fixture, pointer, selected } = render();
    pointer('pointerdown');
    resolve(stream);
    await Promise.resolve();
    vi.advanceTimersByTime(100);
    pointer('pointerup', 150, 90);
    fixture.detectChanges();
    expect(selected).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('录音太短');
  });
});

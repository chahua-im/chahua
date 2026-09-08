import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { VoiceRecorder } from './voice-recorder';

describe('Voice recording gesture', () => {
  let recorder: FakeRecorder;
  let resolve: (stream: MediaStream) => void;
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
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(() => new Promise<MediaStream>((r) => (resolve = r))) },
    });
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
    const button = fixture.nativeElement.querySelector('.microphone') as HTMLElement;
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
    return { fixture, pointer, selected };
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
  it('saves a recording on release and waits for the send action', async () => {
    const { fixture, pointer, selected } = await recording();
    pointer('pointerup');
    fixture.detectChanges();
    expect(recorder.state).toBe('inactive');
    expect(stop).toHaveBeenCalled();
    expect(selected).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('audio')).not.toBeNull();
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

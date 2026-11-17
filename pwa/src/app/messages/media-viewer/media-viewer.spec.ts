import { TestBed } from '@angular/core/testing';
import { afterAll, beforeAll, vi } from 'vitest';
import { PanelNavigation } from '../../navigation/panel-navigation';
import { MediaKind } from '../message-attachments/media-kind';
import { MediaViewer } from './media-viewer';

const scrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
const scrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
beforeAll(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
});
afterAll(() => {
  if (scrollIntoView) Object.defineProperty(Element.prototype, 'scrollIntoView', scrollIntoView);
  else delete (Element.prototype as Partial<Element>).scrollIntoView;
  if (scrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollTo);
  else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
});
const album = [
  { url: 'https://media.invalid/one.jpg', kind: MediaKind.Image },
  { url: 'https://media.invalid/two.mp4', kind: MediaKind.Video },
  { url: 'https://media.invalid/three.jpg', kind: MediaKind.Image },
];
describe('MediaViewer', () => {
  const dismiss = vi.fn().mockResolvedValue(true);
  let resizeViewport: () => void;
  const disconnect = vi.fn();
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resizeViewport = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    TestBed.configureTestingModule({ providers: [{ provide: PanelNavigation, useValue: { back: dismiss } }] });
    vi.spyOn(HTMLMediaElement.prototype, 'pause')
      .mockImplementation(() => {})
      .mockClear();
    dismiss.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());
  function open(media = album, initial = 0) {
    const fixture = TestBed.createComponent(MediaViewer);
    fixture.componentRef.setInput('media', media);
    fixture.componentRef.setInput('initial', initial);
    fixture.detectChanges();
    return fixture;
  }
  function loadImage(width: number, height: number, viewportWidth = 390, viewportHeight = 700) {
    const fixture = open([album[0]]);
    const element: HTMLElement = fixture.nativeElement;
    const viewport = element.querySelector<HTMLElement>('.viewport')!;
    const image = element.querySelector<HTMLImageElement>('.canvas img')!;
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: viewportWidth },
      clientHeight: { configurable: true, value: viewportHeight },
    });
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, viewportWidth, viewportHeight));
    Object.defineProperties(image, { naturalWidth: { value: width }, naturalHeight: { value: height } });
    const factor = Math.min(1, viewportWidth / width, viewportHeight / height);
    vi.spyOn(image, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(
        (viewportWidth - width * factor) / 2,
        (viewportHeight - height * factor) / 2,
        width * factor,
        height * factor,
      ),
    );
    image.dispatchEvent(new Event('load'));
    fixture.detectChanges();
    return { fixture, viewport, image };
  }
  it.each([
    [1080, 20000, 390, (20000 * 390) / 1080],
    [20000, 1080, (20000 * 700) / 1080, 700],
  ])(
    'expands a %i × %i image to a readable viewport dimension beyond five times the overview',
    (width, height, expectedWidth, expectedHeight) => {
      const { fixture, viewport } = loadImage(width, height);
      fixture.componentInstance['toggleZoom']();
      expect(parseFloat(viewport.style.getPropertyValue('--media-width'))).toBeCloseTo(expectedWidth);
      expect(parseFloat(viewport.style.getPropertyValue('--media-height'))).toBeCloseTo(expectedHeight);
      expect(fixture.componentInstance['scale']()).toBeGreaterThan(5);
      fixture.componentInstance['toggleZoom']();
      expect(fixture.componentInstance['scale']()).toBe(1);
      expect(viewport.scrollLeft).toBe(0);
      expect(viewport.scrollTop).toBeCloseTo(0);
    },
  );
  it('lets the wheel reach native image dimensions beyond the old maximum', () => {
    const { fixture, viewport } = loadImage(1080, 20000);
    fixture.componentInstance['wheel'](new WheelEvent('wheel', { deltaY: -10000, clientX: 195, clientY: 350 }));
    expect(parseFloat(viewport.style.getPropertyValue('--media-width'))).toBeCloseTo(1080);
    expect(parseFloat(viewport.style.getPropertyValue('--media-height'))).toBeCloseTo(20000);
    expect(fixture.componentInstance['scale']()).toBeCloseTo(20000 / 700);
  });
  it('lets a pinch reach native dimensions and clears image dimensions when switching media', () => {
    const { fixture, viewport, image } = loadImage(1080, 20000);
    const canvas = image.parentElement!;
    const gesture = (type: string, distance: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, {
        touches: [
          { clientX: 195 - distance / 2, clientY: 350 },
          { clientX: 195 + distance / 2, clientY: 350 },
        ],
      });
      canvas.dispatchEvent(event);
    };
    gesture('touchstart', 10);
    gesture('touchmove', 300);
    expect(parseFloat(viewport.style.getPropertyValue('--media-width'))).toBeCloseTo(1080);
    expect(parseFloat(viewport.style.getPropertyValue('--media-height'))).toBeCloseTo(20000);
    fixture.componentRef.setInput('media', album);
    fixture.componentInstance['select'](1);
    fixture.detectChanges();
    expect(fixture.componentInstance['scale']()).toBe(1);
    expect(viewport.style.getPropertyValue('--media-width')).toBe('');
    expect(viewport.style.getPropertyValue('--media-height')).toBe('');
    expect(fixture.nativeElement.querySelector('.canvas video')).not.toBeNull();
  });
  it('uses native dimensions for a large ordinary photo and keeps small images unscaled initially', () => {
    const large = loadImage(4000, 3000);
    large.fixture.componentInstance['toggleZoom']();
    expect(parseFloat(large.viewport.style.getPropertyValue('--media-width'))).toBeCloseTo(4000);
    const small = loadImage(100, 100);
    expect(small.viewport.style.getPropertyValue('--media-width')).toBe('100px');
    expect(small.viewport.style.getPropertyValue('--media-height')).toBe('100px');
  });
  it('keeps the point under the wheel fixed while removing centered image margins', () => {
    const { fixture, viewport } = loadImage(1080, 20000);
    fixture.componentInstance['wheel'](
      new WheelEvent('wheel', {
        deltaY: -Math.log(20) / 0.002,
        clientX: 200,
        clientY: 200,
      }),
    );
    // The cursor starts 23.9px from the left image edge, then lies 478px from it at 20×.
    expect(viewport.scrollLeft).toBeCloseTo(278);
    expect(viewport.scrollTop).toBeCloseTo(3800);
  });
  it('recalculates fitted image dimensions on viewport resize and disconnects on destruction', () => {
    const { fixture, viewport, image } = loadImage(1080, 20000);
    Object.defineProperty(viewport, 'clientHeight', { value: 1000 });
    vi.mocked(viewport.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 390, 1000));
    vi.mocked(image.getBoundingClientRect).mockReturnValue(new DOMRect(176.1, 150, 37.8, 700));
    resizeViewport();
    expect(parseFloat(viewport.style.getPropertyValue('--media-width'))).toBeCloseTo(54);
    expect(viewport.style.getPropertyValue('--media-height')).toBe('1000px');
    fixture.destroy();
    expect(disconnect).toHaveBeenCalled();
  });
  it('opens the clicked video and switches through the same mixed album using thumbnails', () => {
    const fixture = open(album, 1);
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('ion-toolbar')).toBeNull();
    expect(element.querySelectorAll('.thumbnail')).toHaveLength(3);
    expect(element.querySelector('.counter')?.textContent).toBe('2 / 3');
    const video = element.querySelector<HTMLVideoElement>('.canvas video')!;
    expect(video.src).toBe(album[1].url);
    expect(video.controls && video.autoplay && video.playsInline).toBe(true);
    (element.querySelectorAll('.thumbnail')[1] as HTMLButtonElement).click();
    expect(video.pause).not.toHaveBeenCalled();
    (element.querySelectorAll('.thumbnail')[2] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(video.pause).toHaveBeenCalled();
    expect(element.querySelector('.canvas video')).toBeNull();
    expect(element.querySelector<HTMLImageElement>('.canvas img')?.src).toBe(album[2].url);
    expect(element.querySelector('.counter')?.textContent).toBe('3 / 3');
    expect((element.querySelector('.next') as HTMLButtonElement).disabled).toBe(true);
  });
  it('omits the gallery and navigation buttons for a single medium', () => {
    const fixture = open([album[0]]);
    expect(fixture.nativeElement.querySelector('.gallery')).toBeNull();
    expect(fixture.nativeElement.querySelector('.counter')).toBeNull();
    expect(fixture.nativeElement.querySelector('.previous')).toBeNull();
  });
  it('keeps media clicks open and dismisses from the background or close button', () => {
    const fixture = open([album[0]]);
    const element: HTMLElement = fixture.nativeElement;
    element.querySelector<HTMLImageElement>('.canvas img')!.click();
    expect(dismiss).not.toHaveBeenCalled();
    element.querySelector<HTMLElement>('.canvas')!.click();
    expect(dismiss).toHaveBeenCalledOnce();
    element.querySelector<HTMLButtonElement>('.close')!.click();
    expect(dismiss).toHaveBeenCalledTimes(2);
  });
  it('navigates with arrow keys and leaves Escape to the panel container', () => {
    const fixture = open(album);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(dismiss).not.toHaveBeenCalled();
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.counter')?.textContent).toBe('2 / 3');
  });
  it('pans zoomed images without dismissing on release and still allows a later background click', () => {
    const fixture = open([album[0]]);
    fixture.componentInstance['toggleZoom']();
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    const viewport = element.querySelector<HTMLElement>('.viewport')!;
    const canvas = element.querySelector<HTMLElement>('.canvas')!;
    const image = element.querySelector<HTMLImageElement>('.canvas img')!;
    const capture = vi.fn();
    image.setPointerCapture = capture;
    canvas.setPointerCapture = vi.fn();
    const pointer = (target: HTMLElement, type: string, x: number, y: number) => {
      const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
      Object.assign(event, { pointerType: 'mouse', pointerId: 1 });
      target.dispatchEvent(event);
    };
    viewport.scrollLeft = 100;
    viewport.scrollTop = 80;
    pointer(image, 'pointerdown', 200, 200);
    expect(capture).toHaveBeenCalledWith(1);
    pointer(image, 'pointermove', 150, 170);
    expect(viewport.scrollLeft).toBe(150);
    expect(viewport.scrollTop).toBe(110);
    pointer(image, 'pointerup', 150, 170);
    canvas.click();
    expect(dismiss).not.toHaveBeenCalled();
    pointer(viewport, 'pointermove', 100, 100);
    expect(viewport.scrollLeft).toBe(150);
    expect(viewport.scrollTop).toBe(110);

    pointer(canvas, 'pointerdown', 200, 200);
    pointer(canvas, 'pointermove', 250, 230);
    pointer(canvas, 'pointermove', 200, 200);
    pointer(canvas, 'pointerup', 200, 200);
    canvas.click();
    expect(dismiss).not.toHaveBeenCalled();

    pointer(canvas, 'pointerdown', 200, 200);
    canvas.dispatchEvent(new Event('lostpointercapture', { bubbles: true }));
    pointer(canvas, 'pointermove', 150, 150);
    expect(viewport.scrollLeft).toBe(150);
    expect(viewport.scrollTop).toBe(110);
    pointer(canvas, 'pointerup', 200, 200);
    canvas.click();
    expect(dismiss).toHaveBeenCalledOnce();
  });
  it('keeps the viewer open after touch panning and pinching back to the original scale', () => {
    const fixture = open([album[0]]);
    const component = fixture.componentInstance;
    component['toggleZoom']();
    fixture.detectChanges();
    const viewport = fixture.nativeElement.querySelector('.viewport') as HTMLElement;
    const canvas = fixture.nativeElement.querySelector('.canvas') as HTMLElement;
    const gesture = (type: string, touches: { clientX: number; clientY: number }[], changedTouches = touches) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { touches, changedTouches });
      canvas.dispatchEvent(event);
    };
    gesture('touchstart', [{ clientX: 200, clientY: 200 }]);
    gesture('touchmove', [{ clientX: 150, clientY: 170 }]);
    expect(viewport.scrollLeft).toBe(50);
    expect(viewport.scrollTop).toBe(30);
    gesture('touchend', []);
    canvas.click();
    expect(dismiss).not.toHaveBeenCalled();

    gesture('touchstart', [
      { clientX: 100, clientY: 100 },
      { clientX: 200, clientY: 100 },
    ]);
    gesture('touchmove', [
      { clientX: 100, clientY: 100 },
      { clientX: 150, clientY: 100 },
    ]);
    expect(component['scale']()).toBe(1);
    gesture('touchend', []);
    canvas.click();
    expect(dismiss).not.toHaveBeenCalled();
    gesture('touchstart', [{ clientX: 100, clientY: 100 }]);
    gesture('touchend', [], [{ clientX: 100, clientY: 100 }]);
    canvas.click();
    expect(dismiss).toHaveBeenCalledOnce();
  });
  it('clears zoom and errors when selecting another medium', () => {
    const fixture = open();
    const component = fixture.componentInstance;
    const image = fixture.nativeElement.querySelector('.canvas img');
    image.dispatchEvent(new Event('error'));
    component['toggleZoom']();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.load-error')).not.toBeNull();
    component['select'](2);
    fixture.detectChanges();
    expect(component['zoom']()).toBe(false);
    expect(fixture.nativeElement.querySelector('.load-error')).toBeNull();
    expect(fixture.nativeElement.querySelector('.media-loading')).not.toBeNull();
    fixture.nativeElement.querySelector('.canvas img').dispatchEvent(new Event('load'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.media-loading')).toBeNull();
  });
  it('swipes images without treating pinch zoom or vertical movements as album navigation', () => {
    const fixture = open();
    const component = fixture.componentInstance;
    const target = fixture.nativeElement.querySelector('.canvas img');
    const gesture = (type: string, touches: { clientX: number; clientY: number }[], changedTouches = touches) => {
      const event = new Event(type, { bubbles: true });
      Object.assign(event, { touches, changedTouches });
      target.dispatchEvent(event);
    };
    gesture('touchstart', [{ clientX: 180, clientY: 200 }]);
    gesture('touchend', [], [{ clientX: 90, clientY: 205 }]);
    expect(component['index']()).toBe(1);
    component['select'](0);
    gesture('touchstart', [
      { clientX: 180, clientY: 200 },
      { clientX: 260, clientY: 200 },
    ]);
    gesture('touchend', [], [{ clientX: 80, clientY: 200 }]);
    expect(component['index']()).toBe(0);
    gesture('touchstart', [{ clientX: 180, clientY: 200 }]);
    gesture('touchend', [], [{ clientX: 80, clientY: 400 }]);
    expect(component['index']()).toBe(0);
  });
});

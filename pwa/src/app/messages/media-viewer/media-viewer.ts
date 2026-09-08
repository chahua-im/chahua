import {
  afterRenderEffect,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { IonIcon, IonSpinner, ModalController } from '@ionic/angular';
import {
  chevronBackOutline,
  chevronForwardOutline,
  closeOutline,
  contractOutline,
  downloadOutline,
  expandOutline,
  play,
  scanOutline,
} from 'ionicons/icons';
import { MediaKind } from '../message-attachments/media-kind';

export interface ViewerMedia {
  url: string;
  kind: MediaKind;
  fileName?: string;
}

@Component({
  selector: 'app-media-viewer',
  templateUrl: './media-viewer.html',
  styleUrl: './media-viewer.scss',
  imports: [IonIcon, IonSpinner],
  host: { class: 'ion-page', '(document:keydown)': 'key($event)' },
})
export class MediaViewer {
  readonly media = input.required<readonly ViewerMedia[]>();
  readonly initial = input(0);
  protected readonly index = linkedSignal(() => this.initial());
  protected readonly current = computed(() => this.media()[this.index()]);
  protected readonly scale = signal(1);
  protected readonly zoom = computed(() => this.scale() > 1);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly canFullscreen = !!document.documentElement.requestFullscreen;
  protected readonly loading = linkedSignal(() => {
    this.current();
    return true;
  });
  protected readonly failed = linkedSignal(() => {
    this.current();
    return false;
  });
  protected readonly Kind = MediaKind;
  protected readonly icons = {
    chevronBackOutline,
    chevronForwardOutline,
    closeOutline,
    contractOutline,
    downloadOutline,
    expandOutline,
    play,
    scanOutline,
  };
  protected readonly modals = inject(ModalController);
  private readonly viewport = viewChild<ElementRef<HTMLElement>>('viewport');
  private readonly gallery = viewChild<ElementRef<HTMLElement>>('gallery');
  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  protected touch?: { x: number; y: number };

  constructor() {
    afterRenderEffect(() => {
      const thumbnail = this.gallery()?.nativeElement.children[this.index()];
      thumbnail?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    inject(DestroyRef).onDestroy(() => this.video()?.nativeElement.pause());
  }
  protected select(index: number) {
    const next = Math.max(0, Math.min(this.media().length - 1, index));
    if (next === this.index()) return;
    this.video()?.nativeElement.pause();
    this.index.set(next);
    this.resize(1);
    this.touch = undefined;
    this.viewport()?.nativeElement.scrollTo(0, 0);
  }
  protected move(delta: number) {
    this.select(this.index() + delta);
  }
  protected toggleZoom() {
    if (this.current().kind !== MediaKind.Image) return;
    this.resize(this.zoom() ? 1 : 2);
  }
  protected background(event: MouseEvent) {
    if (event.target === event.currentTarget) void this.modals.dismiss();
  }
  protected async fullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await this.host.nativeElement.requestFullscreen();
  }
  protected key(event: KeyboardEvent) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      this.move(event.key === 'ArrowRight' ? 1 : -1);
    }
  }
  private resize(value: number, x?: number, y?: number) {
    const viewport = this.viewport()?.nativeElement;
    const scale = Math.max(1, Math.min(5, value));
    if (!viewport) {
      this.scale.set(scale);
      return;
    }
    const rect = viewport.getBoundingClientRect();
    const px = (x ?? rect.left + rect.width / 2) - rect.left;
    const py = (y ?? rect.top + rect.height / 2) - rect.top;
    const ratio = scale / this.scale();
    const left = (viewport.scrollLeft + px) * ratio - px;
    const top = (viewport.scrollTop + py) * ratio - py;
    viewport.style.setProperty('--media-scale', String(scale));
    this.scale.set(scale);
    viewport.scrollLeft = left;
    viewport.scrollTop = top;
  }
  protected wheel(event: WheelEvent) {
    if (this.current().kind !== MediaKind.Image) return;
    event.preventDefault();
    this.resize(this.scale() * Math.exp(-event.deltaY * 0.002), event.clientX, event.clientY);
  }
  private pinch?: { distance: number; scale: number };
  private pan?: { x: number; y: number; left: number; top: number };
  protected drag(event: PointerEvent) {
    if (event.pointerType !== 'mouse' || !this.zoom() || event.button !== 0) return;
    const viewport = this.viewport()!.nativeElement;
    viewport.setPointerCapture(event.pointerId);
    this.pan = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
  }
  protected dragging(event: PointerEvent) {
    if (event.pointerType !== 'mouse' || !this.pan) return;
    this.panTo(event.clientX, event.clientY);
  }
  protected stopDrag() {
    this.pan = undefined;
  }
  private panTo(x: number, y: number) {
    const viewport = this.viewport()?.nativeElement;
    if (viewport && this.pan) {
      viewport.scrollLeft = this.pan.left + this.pan.x - x;
      viewport.scrollTop = this.pan.top + this.pan.y - y;
    }
  }
  protected touchMove(event: TouchEvent) {
    if (this.current().kind !== MediaKind.Image) return;
    event.preventDefault();
    if (event.touches.length === 2 && this.pinch) {
      const [a, b] = Array.from(event.touches);
      this.resize(
        (this.pinch.scale * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)) / this.pinch.distance,
        (a.clientX + b.clientX) / 2,
        (a.clientY + b.clientY) / 2,
      );
    } else if (event.touches.length === 1 && this.pan) this.panTo(event.touches[0].clientX, event.touches[0].clientY);
  }
  protected start(event: TouchEvent) {
    if (event.touches.length === 2) {
      const [a, b] = Array.from(event.touches);
      this.pinch = { distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), scale: this.scale() };
      this.pan = undefined;
    } else if (this.zoom()) {
      const viewport = this.viewport()!.nativeElement;
      this.pan = {
        x: event.touches[0].clientX,
        y: event.touches[0].clientY,
        left: viewport.scrollLeft,
        top: viewport.scrollTop,
      };
    }
    this.touch =
      !this.zoom() && event.touches.length === 1 && !(event.target as HTMLElement).closest('video')
        ? { x: event.touches[0].clientX, y: event.touches[0].clientY }
        : undefined;
  }
  protected end(event: TouchEvent) {
    this.pinch = undefined;
    this.pan = undefined;
    const start = this.touch;
    this.touch = undefined;
    if (!start || this.zoom() || event.touches.length) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(touch.clientY - start.y)) this.move(dx < 0 ? 1 : -1);
  }
}

export async function openMediaViewer(modals: ModalController, media: readonly ViewerMedia[], initial: number) {
  const overlay = await modals.create({
    component: MediaViewer,
    componentProps: { media, initial: Math.max(0, initial) },
    cssClass: 'media-viewer-overlay',
    animated: false,
  });
  await overlay.present();
}

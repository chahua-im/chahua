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
import { Router } from '@angular/router';
import { IonIcon, IonSpinner } from '@ionic/angular';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  chevronBackOutline,
  chevronForwardOutline,
  contractOutline,
  downloadOutline,
  expandOutline,
  play,
  scanOutline,
} from 'ionicons/icons';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { PanelNavigation } from '../../navigation/panel-navigation';
import { ModalButton } from '../../ui/modal-button';
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
  imports: [ContentScrollbars, ModalButton, IonIcon, IonSpinner, TranslocoPipe],
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
    contractOutline,
    downloadOutline,
    expandOutline,
    play,
    scanOutline,
  };
  protected readonly panels = inject(PanelNavigation);
  private readonly viewport = viewChild<ElementRef<HTMLElement>>('viewport');
  private readonly gallery = viewChild<ElementRef<HTMLElement>>('gallery');
  private readonly image = viewChild<ElementRef<HTMLImageElement>>('image');
  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  protected touch?: { x: number; y: number };

  constructor() {
    afterRenderEffect((onCleanup) => {
      const viewport = this.viewport()?.nativeElement;
      if (!viewport) return;
      const observer = new ResizeObserver(() => this.resize(this.scale()));
      observer.observe(viewport);
      onCleanup(() => observer.disconnect());
    });
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
    const viewport = this.viewport()?.nativeElement;
    viewport?.style.removeProperty('--media-width');
    viewport?.style.removeProperty('--media-height');
    this.touch = undefined;
    this.viewport()?.nativeElement.scrollTo(0, 0);
  }
  protected move(delta: number) {
    this.select(this.index() + delta);
  }
  protected toggleZoom(event?: MouseEvent) {
    if (this.current().kind !== MediaKind.Image) return;
    const fit = this.fitImage();
    const target = fit?.reading ?? 2;
    this.resize(this.zoom() ? 1 : target, event?.clientX, event?.clientY);
  }
  protected background(event: MouseEvent) {
    if (!this.dragged && event.target === event.currentTarget) void this.panels.back();
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
  protected imageLoaded() {
    this.loading.set(false);
    this.resize(this.scale());
  }
  private fitImage() {
    const image = this.image()?.nativeElement;
    const viewport = this.viewport()?.nativeElement;
    // Images have no intrinsic size while loading, and hidden viewports have no usable bounds.
    if (!image?.naturalWidth || !viewport?.clientWidth || !viewport.clientHeight) return;
    const factor = Math.min(1, viewport.clientWidth / image.naturalWidth, viewport.clientHeight / image.naturalHeight);
    const width = image.naturalWidth * factor;
    const height = image.naturalHeight * factor;
    const reading =
      image.naturalHeight >= image.naturalWidth * 3
        ? viewport.clientWidth / width
        : image.naturalWidth >= image.naturalHeight * 3
          ? viewport.clientHeight / height
          : Math.max(2, 1 / factor);
    return { image, width, height, factor, reading };
  }
  private resize(value: number, x?: number, y?: number) {
    const viewport = this.viewport()?.nativeElement;
    const fit = this.fitImage();
    const maximum = fit ? Math.max(5, 1 / fit.factor, fit.reading) : 5;
    const scale = Math.max(1, Math.min(maximum, value));
    if (!viewport) {
      this.scale.set(scale);
      return;
    }
    const rect = viewport.getBoundingClientRect();
    const px = (x ?? rect.left + rect.width / 2) - rect.left;
    const py = (y ?? rect.top + rect.height / 2) - rect.top;
    const ratio = scale / this.scale();
    let left = (viewport.scrollLeft + px) * ratio - px;
    let top = (viewport.scrollTop + py) * ratio - py;
    if (fit) {
      const bounds = fit.image.getBoundingClientRect();
      const width = fit.width * scale;
      const height = fit.height * scale;
      if (bounds.width && bounds.height) {
        // Account for centered letterboxing when keeping the image point under the gesture.
        left = (px - (bounds.left - rect.left)) * (width / bounds.width) + Math.max(0, (rect.width - width) / 2) - px;
        top = (py - (bounds.top - rect.top)) * (height / bounds.height) + Math.max(0, (rect.height - height) / 2) - py;
      }
      viewport.style.setProperty('--media-width', `${width}px`);
      viewport.style.setProperty('--media-height', `${height}px`);
      left = Math.max(0, Math.min(Math.max(0, width - viewport.clientWidth), left));
      top = Math.max(0, Math.min(Math.max(0, height - viewport.clientHeight), top));
    }
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
  private dragged = false;
  protected drag(event: PointerEvent) {
    this.dragged = false;
    if (event.pointerType !== 'mouse' || !this.zoom() || event.button !== 0) return;
    const viewport = this.viewport()!.nativeElement;
    // Keep the release click on the pressed element instead of retargeting it to the background.
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
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
      if (Math.hypot(x - this.pan.x, y - this.pan.y) > 4) this.dragged = true;
      viewport.scrollLeft = this.pan.left + this.pan.x - x;
      viewport.scrollTop = this.pan.top + this.pan.y - y;
    }
  }
  protected touchMove(event: TouchEvent) {
    if (this.current().kind !== MediaKind.Image) return;
    event.preventDefault();
    if (
      this.touch &&
      Math.hypot(event.touches[0].clientX - this.touch.x, event.touches[0].clientY - this.touch.y) > 4
    ) {
      this.dragged = true;
    }
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
    this.dragged = event.touches.length > 1;
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

export function openMediaViewer(router: Router, media: readonly ViewerMedia[], initial: number) {
  // History state keeps the whole album available on Back/Forward and reload without putting signed file URLs in the address.
  return router.navigate(['/media'], { state: { media, initial: Math.max(0, initial) } });
}

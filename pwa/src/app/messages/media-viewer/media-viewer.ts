import { Component, input, signal, computed, effect, inject } from '@angular/core';
import { IonHeader, IonToolbar, IonTitle, IonButtons, IonButton, IonContent, ModalController } from '@ionic/angular';
import { ContentScrollbars } from '../../content-scrollbars';
export interface ViewerImage {
  url: string;
  fileName?: string;
}
@Component({
  selector: 'app-media-viewer',
  templateUrl: './media-viewer.html',
  styleUrl: './media-viewer.scss',
  imports: [ContentScrollbars, IonHeader, IonToolbar, IonTitle, IonButtons, IonButton, IonContent],
  host: { class: 'ion-page' },
})
export class MediaViewer {
  readonly images = input.required<readonly ViewerImage[]>();
  readonly initial = input(0);
  protected readonly index = signal(0);
  protected readonly zoom = signal(false);
  protected readonly modals = inject(ModalController);
  protected readonly current = computed(() => this.images()[this.index()]);
  private x = 0;
  private y = 0;
  constructor() {
    effect(() => this.index.set(this.initial()));
  }
  protected move(delta: number) {
    this.index.update((i) => Math.max(0, Math.min(this.images().length - 1, i + delta)));
    this.zoom.set(false);
  }
  protected start(event: TouchEvent) {
    if (event.touches.length === 1) {
      this.x = event.touches[0].clientX;
      this.y = event.touches[0].clientY;
    }
  }
  protected end(event: TouchEvent) {
    if (this.zoom()) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - this.x;
    if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(touch.clientY - this.y)) this.move(dx < 0 ? 1 : -1);
  }
}

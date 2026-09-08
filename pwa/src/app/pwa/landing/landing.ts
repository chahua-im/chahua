import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import {
  IonCard,
  IonCardContent,
  IonContent,
  IonHeader,
  IonIcon,
  IonSegment,
  IonSegmentButton,
  IonText,
  IonTitle,
  IonToolbar,
  isPlatform,
  ModalController,
} from '@ionic/angular';
import {
  ellipsisHorizontal,
  ellipsisVertical,
  logoApple,
  logoChrome,
  logoEdge,
  menuOutline,
  shareOutline,
} from 'ionicons/icons';
import { StartChat, StartChatKind } from '../../chats/start-chat/start-chat';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { SessionStore } from '../../session/session-store';
export enum LandingPlatform {
  android = 'android',
  ios = 'ios',
  windows = 'windows',
  macos = 'macos',
  linux = 'linux',
}
function platform() {
  if (isPlatform('ios')) return LandingPlatform.ios;
  if (isPlatform('android')) return LandingPlatform.android;
  const name = (
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform
  ).toLowerCase();
  if (name.includes('win')) return LandingPlatform.windows;
  if (name.includes('mac')) return LandingPlatform.macos;
  if (name.includes('linux') || name.includes('x11')) return LandingPlatform.linux;
  return LandingPlatform.android;
}
@Component({
  selector: 'app-landing',
  templateUrl: './landing.html',
  styleUrl: './landing.scss',
  imports: [
    ContentScrollbars,
    IonCard,
    IonCardContent,
    IonContent,
    IonHeader,
    IonIcon,
    IonSegment,
    IonSegmentButton,
    IonText,
    IonTitle,
    IonToolbar,
  ],
  host: { class: 'ion-page' },
})
export class Landing {
  protected readonly Platform = LandingPlatform;
  protected readonly detected = platform();
  protected readonly selected = signal(this.detected);
  protected readonly icons = {
    ellipsisHorizontal,
    ellipsisVertical,
    logoApple,
    logoChrome,
    logoEdge,
    menuOutline,
    shareOutline,
  };
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly modals = inject(ModalController);
  private readonly session = inject(SessionStore);
  protected select(value: unknown) {
    if (Object.values(LandingPlatform).includes(value as LandingPlatform)) this.selected.set(value as LandingPlatform);
  }
  async ionViewDidEnter() {
    const code = this.route.snapshot.queryParamMap.get('invite');
    if (isPlatform('pwa')) {
      await this.router.navigate(code ? ['/chats/join', code] : ['/chats'], { replaceUrl: true });
      return;
    }
    if (code && this.session.user()) {
      const modal = await this.modals.create({
        component: StartChat,
        componentProps: { kind: StartChatKind.Join, code },
      });
      await modal.present();
    }
  }
}

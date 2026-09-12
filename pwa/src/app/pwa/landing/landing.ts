import { Component, signal } from '@angular/core';
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
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
enum LandingPlatform {
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
  protected select(value: unknown) {
    if (Object.values(LandingPlatform).includes(value as LandingPlatform)) this.selected.set(value as LandingPlatform);
  }
}

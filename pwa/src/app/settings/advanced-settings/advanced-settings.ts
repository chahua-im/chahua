import { ModalButton } from '../../ui/modal-button';
import { Component, inject } from '@angular/core';
import { IonButtons, IonContent, IonHeader, IonItem, IonList, IonTitle, IonToggle, IonToolbar } from '@ionic/angular';
import { TranslocoPipe } from '@jsverse/transloco';
import { PanelNavigation } from '../../navigation/panel-navigation';
import { DiagnosticsCopy } from '../../pwa/diagnostics-copy';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { Preferences } from '../preferences';

@Component({
  selector: 'app-advanced-settings',
  templateUrl: './advanced-settings.html',
  imports: [
    ModalButton,
    ContentScrollbars,
    DiagnosticsCopy,
    TranslocoPipe,
    IonButtons,
    IonContent,
    IonHeader,
    IonItem,
    IonList,
    IonTitle,
    IonToggle,
    IonToolbar,
  ],
  host: { class: 'ion-page' },
})
export class AdvancedSettings {
  protected readonly panels = inject(PanelNavigation);
  protected readonly preferences = inject(Preferences);
}

import { Component, inject } from '@angular/core';
import { LocalDatePipe } from '../../i18n/local-date.pipe';
import { IonButton, IonButtons, IonIcon, IonSpinner, IonToolbar } from '@ionic/angular';
import { closeCircleOutline, pause, play, refreshOutline } from 'ionicons/icons';
import { ConversationNavigation } from '../../conversations/conversation-navigation';
import { VoicePlayback } from './voice-playback';
import { voiceTime } from './voice-player';

@Component({
  selector: 'app-voice-bar',
  imports: [LocalDatePipe, IonButton, IonButtons, IonIcon, IonSpinner, IonToolbar],
  templateUrl: './voice-bar.html',
  styleUrl: './voice-bar.scss',
})
export class VoiceBar {
  protected readonly playback = inject(VoicePlayback);
  private readonly navigation = inject(ConversationNavigation);
  protected readonly voice = this.playback.active;
  protected readonly rate = this.playback.rate;
  protected readonly icons = { play, pause, refreshOutline, close: closeCircleOutline };
  protected readonly time = voiceTime;
  protected locate() {
    const dock = this.voice()?.dock();
    if (dock) void this.navigation.open(dock.chatId, undefined, dock.messageId);
  }
}

import { Component, input, linkedSignal, output, viewChild } from '@angular/core';
import { applyWhen, disabled, form, FormField, pattern, required } from '@angular/forms/signals';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonList,
  IonModal,
  IonNote,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';

export interface StickerEditorValue {
  name: string;
  emoji: string;
}

@Component({
  selector: 'app-sticker-editor',
  imports: [
    ContentScrollbars,
    FormField,
    TranslocoPipe,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonInput,
    IonItem,
    IonList,
    IonModal,
    IonNote,
    IonSpinner,
    IonTitle,
    IonToolbar,
  ],
  template: `
    <ion-modal [isOpen]="true" [canDismiss]="canDismiss" (didDismiss)="closed.emit()" #modal>
      <ng-template>
        <ion-header
          ><ion-toolbar>
            <ion-buttons slot="start">
              <ion-button [disabled]="busy()" (click)="modal.dismiss()">{{ 'common.cancel' | transloco }}</ion-button>
            </ion-buttons>
            <ion-title>{{ title() }}</ion-title>
            <ion-buttons slot="end">
              <ion-button [disabled]="fields().disabled() || fields().invalid() || unchanged()" (click)="submit()">
                @if (busy()) {
                  <ion-spinner />
                } @else {
                  {{ 'common.save' | transloco }}
                }
              </ion-button>
            </ion-buttons>
          </ion-toolbar></ion-header
        >
        <ion-content appScrollbars color="light">
          <ion-list [inset]="true">
            @if (withEmoji()) {
              <ion-item
                ><ion-input
                  [label]="'stickers.emojiLabel' | transloco"
                  [placeholder]="'stickers.emojiPlaceholder' | transloco"
                  [formField]="fields.emoji"
              /></ion-item>
            }
            <ion-item lines="none"
              ><ion-input
                [label]="(withEmoji() ? 'stickers.optionalName' : 'common.name') | transloco"
                [formField]="fields.name"
            /></ion-item>
            @if (error()) {
              <ion-item lines="none"
                ><ion-note color="danger">{{ error() }}</ion-note></ion-item
              >
            }
          </ion-list>
        </ion-content>
      </ng-template>
    </ion-modal>
  `,
})
export class StickerEditor {
  readonly title = input.required<string>();
  readonly initialName = input('');
  readonly withEmoji = input(false);
  readonly busy = input(false);
  readonly error = input<string>();
  readonly closed = output<void>();
  readonly confirmed = output<StickerEditorValue>();
  private readonly modal = viewChild.required(IonModal);
  protected readonly canDismiss = async (_data?: unknown, role?: string) =>
    !this.busy() || role === 'saved' || role === 'navigate' || role === 'parent-dismissed' || role === 'parent-removed';

  dismiss() {
    return this.modal().dismiss(undefined, 'saved');
  }

  protected readonly value = linkedSignal(() => ({ name: this.initialName(), emoji: '' }));
  protected readonly fields = form(this.value, (fields) => {
    disabled(fields, () => this.busy());
    applyWhen(
      fields,
      () => !this.withEmoji(),
      (f) => {
        required(f.name);
        pattern(f.name, /\S/);
      },
    );
    applyWhen(
      fields,
      () => this.withEmoji(),
      (f) => {
        required(f.emoji);
        pattern(f.emoji, /\S/);
      },
    );
  });
  protected unchanged() {
    return !this.withEmoji() && !!this.initialName() && this.value().name.trim() === this.initialName();
  }
  protected submit() {
    if (this.fields().disabled() || this.fields().invalid() || this.unchanged()) return;
    this.confirmed.emit({ name: this.value().name.trim(), emoji: this.value().emoji.trim() });
  }
}

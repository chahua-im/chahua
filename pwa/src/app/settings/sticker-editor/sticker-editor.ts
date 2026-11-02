import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, input, linkedSignal, output, signal, TemplateRef, viewChild } from '@angular/core';
import { applyWhen, disabled, form, FormField, pattern, required } from '@angular/forms/signals';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { TranslocoPipe } from '@jsverse/transloco';
import { addOutline } from 'ionicons/icons';
import { EmojiPanel, emojiPanelAnimation } from '../../messages/emoji-panel/emoji-panel';
import { extractEmojiSequences } from '../emoji-sequences';
import { StickerPackVisibility } from '../../../generated/models';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonList,
  IonModal,
  IonNote,
  IonSelect,
  IonSelectOption,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';

export interface StickerEditorValue {
  name: string;
  emoji: string;
  visibility?: StickerPackVisibility;
}

@Component({
  selector: 'app-sticker-editor',
  imports: [
    ContentScrollbars,
    EmojiPanel,
    NgTemplateOutlet,
    FormField,
    TranslocoPipe,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonInput,
    IonItem,
    IonList,
    IonModal,
    IonNote,
    IonSelect,
    IonSelectOption,
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
              <ion-button
                [disabled]="fields().disabled() || fields().invalid() || unchanged() || saveDisabled() || !validEmoji()"
                (click)="submit()"
              >
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
            <ng-container [ngTemplateOutlet]="content() ?? null" />
            @if (withEmoji()) {
              <ion-item>
                <ion-input
                  [label]="'stickers.emojiLabel' | transloco"
                  [placeholder]="'stickers.emojiExample' | transloco"
                  [formField]="fields.emoji"
                />
                <ion-button slot="end" fill="clear" [disabled]="busy()" (click)="openEmojiPicker()">
                  <ion-icon slot="icon-only" [icon]="emojiIcon" />
                </ion-button>
              </ion-item>
            }
            <ion-item lines="none"
              ><ion-input
                [label]="(withEmoji() ? 'stickers.optionalName' : 'common.name') | transloco"
                [formField]="fields.name"
            /></ion-item>
            @if (initialVisibility() != null) {
              <ion-item>
                <ion-select
                  [label]="'settings.stickerPack.visibility' | transloco"
                  [value]="value().visibility"
                  [disabled]="busy()"
                  [cancelText]="'common.cancel' | transloco"
                  [okText]="'common.confirm' | transloco"
                  (ionChange)="setVisibility($event.detail.value)"
                >
                  <ion-select-option [value]="Visibility.public">{{
                    'settings.stickerPack.public' | transloco
                  }}</ion-select-option>
                  <ion-select-option [value]="Visibility.private">{{
                    'settings.stickerPack.private' | transloco
                  }}</ion-select-option>
                </ion-select>
              </ion-item>
              @if (value().visibility === Visibility.private) {
                <ion-item lines="none">
                  <ion-note color="danger">{{ 'settings.stickerPack.visibilityHint' | transloco }}</ion-note>
                </ion-item>
              }
            }
            @if (error()) {
              <ion-item lines="none"
                ><ion-note color="danger">{{ error() }}</ion-note></ion-item
              >
            }
          </ion-list>
        </ion-content>
      </ng-template>
    </ion-modal>
    <ion-modal
      [enterAnimation]="enterEmojiAnimation"
      [leaveAnimation]="leaveEmojiAnimation"
      class="emoji-panel-modal"
      [keepContentsMounted]="true"
      [isOpen]="choosingEmoji()"
      (didDismiss)="choosingEmoji.set(false)"
    >
      <ng-template>
        <app-emoji-panel
          [active]="choosingEmoji()"
          [title]="'stickers.emojiLabel' | transloco"
          (chosen)="chooseEmoji($event)"
          (back)="choosingEmoji.set(false)"
          (dismissed)="choosingEmoji.set(false)"
        />
      </ng-template>
    </ion-modal>
  `,
})
export class StickerEditor {
  readonly title = input.required<string>();
  readonly initialName = input('');
  readonly initialVisibility = input<StickerPackVisibility>();
  readonly withEmoji = input(false);
  readonly busy = input(false);
  readonly error = input<string>();
  readonly content = input<TemplateRef<unknown>>();
  readonly saveDisabled = input(false);
  readonly closed = output<void>();
  readonly confirmed = output<StickerEditorValue>();
  private readonly modal = viewChild.required(IonModal);
  protected readonly canDismiss = async (_data?: unknown, role?: string) =>
    !this.busy() || role === 'saved' || role === 'navigate' || role === 'parent-dismissed' || role === 'parent-removed';

  dismiss() {
    return this.modal().dismiss(undefined, 'saved');
  }

  protected readonly choosingEmoji = signal(false);
  protected readonly enterEmojiAnimation = (element: HTMLElement) => emojiPanelAnimation(element, true);
  protected readonly leaveEmojiAnimation = (element: HTMLElement) => emojiPanelAnimation(element, false);
  protected readonly emojiIcon = addOutline;
  protected openEmojiPicker() {
    if (!this.busy()) this.choosingEmoji.set(true);
  }
  protected chooseEmoji(emoji: string) {
    this.value.update((value) => ({ ...value, emoji: value.emoji + emoji }));
    this.choosingEmoji.set(false);
  }

  protected readonly Visibility = StickerPackVisibility;
  protected readonly value = linkedSignal<StickerEditorValue>(() => ({
    name: this.initialName(),
    emoji: '',
    ...(this.initialVisibility() != null ? { visibility: this.initialVisibility() } : {}),
  }));
  protected setVisibility(visibility: StickerPackVisibility) {
    this.value.update((value) => ({ ...value, visibility }));
  }
  protected readonly validEmoji = computed(() => {
    if (!this.withEmoji()) return true;
    const value = this.value().emoji.trim();
    const emojis = extractEmojiSequences(value);
    return emojis.length >= 1 && emojis.length <= 4 && emojis.join('') === value;
  });
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
    return (
      !this.withEmoji() &&
      !!this.initialName() &&
      this.value().name.trim() === this.initialName() &&
      this.value().visibility === this.initialVisibility()
    );
  }
  protected submit() {
    if (
      this.fields().disabled() ||
      this.fields().invalid() ||
      this.unchanged() ||
      this.saveDisabled() ||
      !this.validEmoji()
    )
      return;
    this.confirmed.emit({ ...this.value(), name: this.value().name.trim(), emoji: this.value().emoji.trim() });
  }
}

import { Component, input } from '@angular/core';

@Component({
  selector: 'app-message-list-skeleton',
  templateUrl: './message-list-skeleton.html',
  styleUrl: './message-list-skeleton.scss',
})
export class MessageListSkeleton {
  readonly showDetails = input.required<boolean>();
  readonly showAllAvatars = input.required<boolean>();
}

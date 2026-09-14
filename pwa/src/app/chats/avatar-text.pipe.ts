import { computed, Directive, input, Pipe, PipeTransform } from '@angular/core';
import { userColors } from '../messages/user-colors';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

@Pipe({ name: 'avatarText' })
export class AvatarTextPipe implements PipeTransform {
  transform(name: string | null | undefined, count = 1): string {
    let text = '';
    // Slice whole visible characters, including emoji sequences and combining marks.
    for (const { segment } of segmenter.segment(name ?? '')) {
      text += segment;
      if (--count === 0) break;
    }
    return text;
  }
}

@Directive({
  selector: '[avatarColor]',
  host: {
    '[class.avatar-placeholder]': 'avatarColor() != null',
    '[style.--avatar-light]': 'colors().light',
    '[style.--avatar-dark]': 'colors().dark',
    '[style.background]': "avatarColor() != null ? 'var(--avatar-background)' : null",
  },
})
export class AvatarColor {
  readonly avatarColor = input<string | null>();
  protected readonly colors = computed(() => userColors(this.avatarColor() ?? ''));
}

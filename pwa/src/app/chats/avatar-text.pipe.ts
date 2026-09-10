import { Pipe, PipeTransform } from '@angular/core';

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

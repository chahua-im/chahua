/** Extracts complete emoji sequences in order, dropping plain text and whitespace. */
const RGI_EMOJI = new RegExp('\\p{RGI_Emoji}', 'gv');

export function extractEmojiSequences(value: string): string[] {
  return value.match(RGI_EMOJI) ?? [];
}

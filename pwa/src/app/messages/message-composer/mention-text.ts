export interface MentionSpan {
  start: number;
  end: number;
  uid: number;
}
export interface EditableText {
  text: string;
  mentions: MentionSpan[];
}
export function displayText(wire: string, names: ReadonlyMap<number, string>): EditableText {
  let text = '';
  let last = 0;
  const mentions: MentionSpan[] = [];
  for (const match of wire.matchAll(/@\[uid:(\d+)\]/g)) {
    text += wire.slice(last, match.index);
    const start = text.length;
    const uid = Number(match[1]);
    text += '@' + (names.get(uid) || 'User ' + uid);
    mentions.push({ start, end: text.length, uid });
    last = match.index + match[0].length;
  }
  return { text: text + wire.slice(last), mentions };
}
export function wireText(value: EditableText): string {
  let text = '';
  let last = 0;
  for (const mention of value.mentions) {
    text += value.text.slice(last, mention.start) + '@[uid:' + mention.uid + ']';
    last = mention.end;
  }
  return text + value.text.slice(last);
}
/** Retain mention identity only when an edit leaves the whole visible mention intact. */
export function editText(previous: EditableText, text: string): EditableText {
  let start = 0;
  while (start < previous.text.length && start < text.length && previous.text[start] === text[start]) start++;
  let before = previous.text.length;
  let after = text.length;
  while (before > start && after > start && previous.text[before - 1] === text[after - 1]) {
    before--;
    after--;
  }
  const delta = after - before;
  return {
    text,
    mentions: previous.mentions.flatMap((mention) =>
      mention.end <= start
        ? [mention]
        : mention.start >= before
          ? [{ ...mention, start: mention.start + delta, end: mention.end + delta }]
          : [],
    ),
  };
}

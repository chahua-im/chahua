import type { MessageResponse } from '../../generated/models';

export function patchMessages(current: MessageResponse[], update: (message: MessageResponse) => MessageResponse) {
  let messages: MessageResponse[] | undefined;
  for (let index = 0; index < current.length; index++) {
    const updated = update(current[index]);
    if (updated !== current[index]) (messages ??= current.slice())[index] = updated;
  }
  return messages ?? current;
}

export function mergeMessages(current: MessageResponse[], incoming: MessageResponse[]) {
  const messages = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    if (!messages.has(message.id)) messages.set(message.id, message);
  }
  return [...messages.values()].sort((a, b) => a.id - b.id);
}

/** A delayed publication belongs inside a loaded interval even away from the live tail. */
export function mergeMessageArrivals(
  current: MessageResponse[],
  incoming: Iterable<MessageResponse>,
  atLatest: boolean,
  atOldest = false,
) {
  const first = current[0]?.id;
  const last = current.at(-1)?.id;
  const accepted = Array.from(incoming).filter(
    ({ id }) =>
      (first != null && last != null && (atOldest || first <= id) && id <= last) ||
      (atLatest && (last == null || id > last)),
  );
  return accepted.length ? mergeMessages(current, accepted) : current;
}

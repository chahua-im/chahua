import type { MessageResponse } from '../../generated/models';

export function mergeMessages(current: MessageResponse[], incoming: MessageResponse[]) {
  const messages = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    if (!messages.has(message.id)) messages.set(message.id, message);
  }
  return [...messages.values()].sort((a, b) => a.id - b.id);
}

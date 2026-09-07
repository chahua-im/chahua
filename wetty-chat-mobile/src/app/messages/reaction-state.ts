import type { MessageResponse, ReactionSummary } from '../../generated/models';

export function preserveReactionOwnership(current: ReactionSummary[], incoming: ReactionSummary[]) {
  return incoming.map((reaction) => {
    const previous = current.find((item) => item.emoji === reaction.emoji);
    return reaction.reactedByMe == null && previous?.reactedByMe != null
      ? { ...reaction, reactedByMe: previous.reactedByMe }
      : reaction;
  });
}

export function exceedsReactionLimit(message: MessageResponse, emoji: string) {
  const existing = message.reactions.find((reaction) => reaction.emoji === emoji);
  return (
    !existing?.reactedByMe &&
    (message.reactions.filter((reaction) => reaction.reactedByMe).length >= 5 ||
      (message.reactions.length >= 50 && !existing))
  );
}

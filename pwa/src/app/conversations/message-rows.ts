import { MessageType, type MessageResponse } from '../../generated/models';

const MAX_GROUP_SPAN_MS = 10 * 60 * 1000;

export function messageRows<T extends Pick<MessageResponse, 'createdAt' | 'messageType' | 'sender'>>(
  messages: readonly T[],
) {
  const dates = messages.map((message) => new Date(message.createdAt).toDateString());
  const continuesGroup = (left: number, right: number) => {
    const previous = messages[left];
    const next = messages[right];
    return (
      previous &&
      next &&
      previous.messageType !== MessageType.system &&
      next.messageType !== MessageType.system &&
      previous.sender.uid === next.sender.uid &&
      dates[left] === dates[right]
    );
  };
  let groupStart = 0;
  const rows = messages.map((message, index) => {
    const first =
      !continuesGroup(index - 1, index) ||
      Date.parse(message.createdAt) - Date.parse(messages[groupStart].createdAt) > MAX_GROUP_SPAN_MS;
    if (first) groupStart = index;
    return {
      message,
      first,
      last: false,
      dateBreak: index === 0 || dates[index - 1] !== dates[index],
    };
  });
  for (let index = 0; index < rows.length; index++) {
    rows[index].last = rows[index + 1]?.first ?? true;
  }
  return rows;
}

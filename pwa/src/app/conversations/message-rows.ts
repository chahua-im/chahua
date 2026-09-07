import { MessageType, type MessageResponse } from '../../generated/models';

export function messageRows(messages: readonly MessageResponse[]) {
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
  return messages.map((message, index) => ({
    message,
    first: !continuesGroup(index - 1, index),
    last: !continuesGroup(index, index + 1),
    dateBreak: index === 0 || dates[index - 1] !== dates[index],
  }));
}

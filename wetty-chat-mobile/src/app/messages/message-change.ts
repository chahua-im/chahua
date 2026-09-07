import { ServerWsMessageType, type ServerWsMessage } from '../../generated/models';

export type MessageChange = Extract<
  ServerWsMessage,
  {
    type: `${
      | ServerWsMessageType.messageUpdated
      | ServerWsMessageType.messageDeleted
      | ServerWsMessageType.messagesBulkDeleted
      | ServerWsMessageType.reactionUpdated}`;
  }
>;

export function isMessageChange(event: ServerWsMessage): event is MessageChange {
  return (
    event.type === ServerWsMessageType.messageUpdated ||
    event.type === ServerWsMessageType.messageDeleted ||
    event.type === ServerWsMessageType.messagesBulkDeleted ||
    event.type === ServerWsMessageType.reactionUpdated
  );
}

export type PinChange = Extract<
  ServerWsMessage,
  { type: 'pinAdded' | 'pinRemoved' | 'threadPinAdded' | 'threadPinRemoved' }
>;

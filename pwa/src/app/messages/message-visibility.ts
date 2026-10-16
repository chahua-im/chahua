import type { MessageResponse } from '../../generated/models';

// A recalled message stays visible only when it is a thread root: the server keeps
// it in the around window (`deleted_at IS NULL OR has_thread`) so the topic entry survives.
export function isVisibleMessage(message: Pick<MessageResponse, 'isDeleted' | 'threadInfo'>) {
  return !message.isDeleted || !!message.threadInfo;
}

import type { MessageType } from '@/api/messages';
export type OverlayActionKey =
  | 'copy'
  | 'copy-link'
  | 'favorite'
  | 'save'
  | 'reply'
  | 'forward'
  | 'thread'
  | 'edit'
  | 'delete'
  | 'pin'
  | 'reaction-details';

export interface OverlayActionPolicyInput {
  messageType: MessageType;
  text: string | null | undefined;
  hasAttachments: boolean;
  isDeleted: boolean;
  isOptimistic: boolean;
  hasThreadInfo: boolean;
  isOwn: boolean;
  isAdmin: boolean;
  isThreadView: boolean;
  savedMessagesEnabled: boolean;
  isPinned: boolean;
  hasReactions: boolean;
  isForwarded: boolean;
}

export type OverlayActionPolicyItem =
  | { key: Exclude<OverlayActionKey, 'copy' | 'pin'> }
  | { key: 'copy'; copyVariant: 'message' | 'text' }
  | { key: 'pin'; pinState: 'pinned' | 'unpinned' };

export function getOverlayActionPolicy(input: OverlayActionPolicyInput): OverlayActionPolicyItem[] {
  const audioMessage = input.messageType === 'audio';
  const stickerMessage = input.messageType === 'sticker';
  const isDeletableAction = !input.isDeleted && !input.isOptimistic;
  const actions: OverlayActionPolicyItem[] = [];

  // 1. Reply
  actions.push({ key: 'reply' });

  // 2. Thread
  if (!input.isThreadView && !input.hasThreadInfo && !input.isDeleted) {
    actions.push({ key: 'thread' });
  }

  // 3. Pin
  if (!input.isThreadView && !input.isDeleted && input.isAdmin) {
    actions.push({ key: 'pin', pinState: input.isPinned ? 'pinned' : 'unpinned' });
  }

  // 4. Copy
  if (!audioMessage && !stickerMessage && input.text?.trim()) {
    actions.push({ key: 'copy', copyVariant: input.hasAttachments ? 'text' : 'message' });
  }

  // 5. Forward
  actions.push({ key: 'forward' });

  // 6. Edit
  if (input.isOwn && !input.isDeleted && !input.isForwarded && !audioMessage && !stickerMessage) {
    actions.push({ key: 'edit' });
  }

  // 7. Save / Favorite
  if (stickerMessage && isDeletableAction) {
    actions.push({ key: 'favorite' });
  } else if (input.savedMessagesEnabled && isDeletableAction && input.messageType !== 'system') {
    actions.push({ key: 'save' });
  }

  // 8. Copy-link
  actions.push({ key: 'copy-link' });

  // 9. Delete
  if ((input.isOwn || input.isAdmin) && !input.isDeleted) {
    actions.push({ key: 'delete' });
  }

  // 10. Details
  if (input.hasReactions) {
    actions.push({ key: 'reaction-details' });
  }

  if (stickerMessage) {
    return actions.filter(
      (action) =>
        action.key === 'reply' ||
        action.key === 'forward' ||
        action.key === 'delete' ||
        action.key === 'copy-link' ||
        action.key === 'favorite',
    );
  }

  if (input.messageType === 'invite') {
    return actions.filter((action) => action.key === 'reply' || action.key === 'pin' || action.key === 'delete');
  }

  return actions;
}

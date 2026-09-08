import type { MessageType } from '@/api/messages';

export type OverlayActionKey =
  | 'copy'
  | 'copy-link'
  | 'favorite'
  | 'save'
  | 'reply'
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
  isDm: boolean;
  /** Dead DM (friendship ended/blocked): history is readable but no member writes. */
  deadDm: boolean;
  isThreadView: boolean;
  savedMessagesEnabled: boolean;
  isPinned: boolean;
  hasReactions: boolean;
}

export type OverlayActionPolicyItem =
  | { key: Exclude<OverlayActionKey, 'copy' | 'pin'> }
  | { key: 'copy'; copyVariant: 'message' | 'text' }
  | { key: 'pin'; pinState: 'pinned' | 'unpinned' };

export function getOverlayActionPolicy(input: OverlayActionPolicyInput): OverlayActionPolicyItem[] {
  const audioMessage = input.messageType === 'audio';
  const stickerMessage = input.messageType === 'sticker';
  const isDeletableAction = !input.isDeleted && !input.isOptimistic;
  // A dead DM only offers read-only affordances (copy, details). Only DMs
  // can be dead, so the flag is ignored for regular groups.
  const canWrite = !(input.isDm && input.deadDm);
  const actions: OverlayActionPolicyItem[] = [];

  // 1. Reply
  if (canWrite) {
    actions.push({ key: 'reply' });
  }

  // 2. Thread
  if (canWrite && input.messageType === 'text' && !input.isThreadView && !input.hasThreadInfo && !input.isDeleted) {
    actions.push({ key: 'thread' });
  }

  // 3. Pin
  if (canWrite && !input.isDeleted && (input.isAdmin || input.isDm)) {
    actions.push({ key: 'pin', pinState: input.isPinned ? 'pinned' : 'unpinned' });
  }

  // 4. Copy
  if (!audioMessage && !stickerMessage && input.text?.trim()) {
    actions.push({ key: 'copy', copyVariant: input.hasAttachments ? 'text' : 'message' });
  }

  // 5. Edit
  if (canWrite && input.isOwn && !input.isDeleted && !audioMessage && !stickerMessage && input.messageType !== 'file') {
    actions.push({ key: 'edit' });
  }

  // 6. Save / Favorite
  if (stickerMessage && isDeletableAction) {
    actions.push({ key: 'favorite' });
  } else if (input.savedMessagesEnabled && isDeletableAction && input.messageType !== 'system') {
    actions.push({ key: 'save' });
  }

  // 7. Copy-link
  if (!input.isDm) {
    actions.push({ key: 'copy-link' });
  }

  // 8. Delete
  if (canWrite && (input.isOwn || input.isAdmin) && !input.isDeleted) {
    actions.push({ key: 'delete' });
  }

  // 9. Details
  if (input.hasReactions) {
    actions.push({ key: 'reaction-details' });
  }

  if (stickerMessage) {
    return actions.filter(
      (action) =>
        action.key === 'reply' || action.key === 'delete' || action.key === 'copy-link' || action.key === 'favorite',
    );
  }

  if (input.messageType === 'invite') {
    return actions.filter((action) => action.key === 'reply' || action.key === 'pin' || action.key === 'delete');
  }

  return actions;
}

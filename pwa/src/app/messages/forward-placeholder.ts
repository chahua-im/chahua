/** Backend reason codes in the message field of a placeholder message. */
export enum ForwardPlaceholder {
  PendingAudio = 'pendingAudio',
  NestedForward = 'nestedForward',
  GroupInvite = 'groupInvite',
}

export function placeholderLabel(reason: string | undefined): string {
  switch (reason) {
    case ForwardPlaceholder.PendingAudio:
      return 'messages.placeholder.pendingAudio';
    case ForwardPlaceholder.NestedForward:
      return 'messages.preview.forwarded';
    case ForwardPlaceholder.GroupInvite:
      return 'messages.placeholder.groupInvite';
    default:
      return 'messages.placeholder.unavailable';
  }
}

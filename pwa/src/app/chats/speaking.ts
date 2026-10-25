import { HttpErrorResponse } from '@angular/common/http';
import { GroupRole, SpeakingMode } from '../../generated/models';

export enum SpeakingAction {
  ChatMessage,
  CreateThread,
  ThreadReply,
}

export function allowsSpeaking(mode: SpeakingMode | undefined, action: SpeakingAction): boolean {
  switch (mode) {
    case SpeakingMode.readOnly:
      return false;
    case SpeakingMode.repliesOnly:
      return action === SpeakingAction.ThreadReply;
    case SpeakingMode.threadsOnly:
      return action !== SpeakingAction.ChatMessage;
    default:
      // Details may still be loading. The server always authorizes the actual write.
      return true;
  }
}

export function effectiveSpeakingMode(
  role: GroupRole | undefined,
  group: SpeakingMode | undefined,
  member: SpeakingMode | undefined,
): SpeakingMode | undefined {
  if (role === GroupRole.admin) return SpeakingMode.unrestricted;
  for (const mode of [SpeakingMode.readOnly, SpeakingMode.repliesOnly, SpeakingMode.threadsOnly])
    if (group === mode || member === mode) return mode;
  return group ?? member;
}

export function speakingErrorMode(error: unknown): SpeakingMode | undefined {
  if (!(error instanceof HttpErrorResponse) || error.status !== 403) return undefined;
  const body: unknown = error.error;
  return body != null &&
    typeof body === 'object' &&
    'code' in body &&
    body.code === 'speakingRestricted' &&
    'effectiveSpeakingMode' in body &&
    Object.values(SpeakingMode).includes(body.effectiveSpeakingMode as SpeakingMode)
    ? (body.effectiveSpeakingMode as SpeakingMode)
    : undefined;
}

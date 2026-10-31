import { RpcError, RpcErrorCode } from '../api/rpc-error';
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
  if (!(error instanceof RpcError) || error.code !== RpcErrorCode.SpeakingRestricted) return undefined;
  const data = error.data;
  return data != null &&
    typeof data === 'object' &&
    'effectiveSpeakingMode' in data &&
    Object.values(SpeakingMode).includes(data.effectiveSpeakingMode as SpeakingMode)
    ? (data.effectiveSpeakingMode as SpeakingMode)
    : undefined;
}

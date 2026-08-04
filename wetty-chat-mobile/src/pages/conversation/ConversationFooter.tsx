import type { Ref } from 'react';
import { IonFooter } from '@ionic/react';
import {
  type ComposeSendPayload,
  type ComposeUploadInput,
  type ComposeUploadResult,
  type EditingMessage,
  MessageComposeBar,
  type MessageComposeBarHandle,
  type ReplyTo,
} from '@/components/chat/compose/MessageComposeBar';

interface ConversationFooterProps {
  chatId: string;
  draftKey: string;
  isKeyboardOpen: boolean;
  composeBarRef: Ref<MessageComposeBarHandle>;
  onRestoreReply?: (replyToMessageId: string, replyToUsername?: string) => void;
  onSend: (payload: ComposeSendPayload) => void;
  uploadAttachment: (input: ComposeUploadInput) => Promise<ComposeUploadResult>;
  onError: (message: string) => void;
  onFocusChange: (focused: boolean) => void;
  replyTo?: ReplyTo;
  onCancelReply: () => void;
  editing?: EditingMessage;
  onCancelEdit: () => void;
  onRequestEditLastMessage: () => boolean;
  composeDisabled?: boolean;
  composeDisabledReason?: string;
}

export function ConversationFooter({
  chatId,
  draftKey,
  isKeyboardOpen,
  composeBarRef,
  onRestoreReply,
  onSend,
  uploadAttachment,
  onError,
  onFocusChange,
  replyTo,
  onCancelReply,
  editing,
  onCancelEdit,
  onRequestEditLastMessage,
  composeDisabled,
  composeDisabledReason,
}: ConversationFooterProps) {
  return (
    <IonFooter className={`conversation-footer${isKeyboardOpen ? ' keyboard-open' : ''}`}>
      <MessageComposeBar
        ref={composeBarRef}
        chatId={chatId}
        draftKey={draftKey}
        onRestoreReply={onRestoreReply}
        onSend={onSend}
        uploadAttachment={uploadAttachment}
        onError={onError}
        onFocusChange={onFocusChange}
        replyTo={replyTo}
        onCancelReply={onCancelReply}
        editing={editing}
        onCancelEdit={onCancelEdit}
        onRequestEditLastMessage={onRequestEditLastMessage}
        composeDisabled={composeDisabled}
        composeDisabledReason={composeDisabledReason}
      />
    </IonFooter>
  );
}

import { useCallback } from 'react';
import { t } from '@lingui/core/macro';
import { useDispatch } from 'react-redux';
import {
  markMessagesAsRead,
  type MessageResponse,
  sendMessage,
  sendThreadMessage,
  updateMessage,
} from '@/api/messages';
import { markThreadAsRead as apiMarkThreadAsRead } from '@/api/threads';
import { requestUploadUrl, uploadFileToS3 } from '@/api/upload';
import type {
  ComposeSendPayload,
  ComposeUploadInput,
  EditingMessage,
} from '@/components/chat/compose/MessageComposeBar';
import { setChatLastReadMessageId, setChatUnreadCount } from '@/store/chatsSlice';
import { messageAdded, messageConfirmed, messagePatched, messagesBulkDeleted } from '@/store/messageEvents';
import { uploadProgressCleared, uploadProgressSet } from '@/store/uploadProgressSlice';
import { setThreadReadState } from '@/store/threadsSlice';
import { syncAppBadgeCount } from '@/utils/badges';
import { detectFileMimeType } from '@/utils/fileType';
import {
  areAttachmentIdsEqual,
  buildOptimisticUploadedAttachments,
  generateClientId,
} from '../utils/conversationUtils';

export interface ChatMessageEditSession extends EditingMessage {
  originalMessage: MessageResponse;
}

interface UseChatMessageSenderArgs {
  chatId: string;
  storeChatId: string;
  threadId?: string;
  currentUserId?: number | null;
  currentUserName?: string | null;
  currentUserAvatarUrl?: string | null;
  threadSubscribed: boolean | null;
  replyingTo: MessageResponse | null;
  editingSession: ChatMessageEditSession | null;
  messageLookup: Map<string, MessageResponse>;
  setReplyingTo: (message: MessageResponse | null) => void;
  setEditingSession: (session: ChatMessageEditSession | null) => void;
  revealLatestAfterSend: () => void;
  markThreadSubscribedOptimistically: () => void;
  showToast: (text: string, duration?: number, options?: { positionAnchor?: string }) => void;
}

function buildReplyPreview(replyingTo: MessageResponse | null): MessageResponse['replyToMessage'] {
  return replyingTo
    ? {
        id: replyingTo.id,
        message: replyingTo.message,
        messageType: replyingTo.messageType,
        sticker: replyingTo.sticker,
        sender: replyingTo.sender,
        isDeleted: replyingTo.isDeleted,
        attachments: replyingTo.attachments,
        mentions: replyingTo.mentions,
      }
    : undefined;
}

export function useChatMessageSender({
  chatId,
  storeChatId,
  threadId,
  currentUserId,
  currentUserName,
  currentUserAvatarUrl,
  threadSubscribed,
  replyingTo,
  editingSession,
  messageLookup,
  setReplyingTo,
  setEditingSession,
  revealLatestAfterSend,
  markThreadSubscribedOptimistically,
  showToast,
}: UseChatMessageSenderArgs) {
  const dispatch = useDispatch();

  const uploadAttachment = useCallback(
    async ({ file, purpose, dimensions, onProgress, signal, order }: ComposeUploadInput) => {
      const contentType = await detectFileMimeType(file);
      const res = await requestUploadUrl(
        {
          filename: file.name,
          contentType,
          size: file.size,
          purpose,
          order,
          dimensions,
        },
        signal,
      );

      const { uploadUrl, attachmentId, uploadHeaders } = res.data;
      await uploadFileToS3(uploadUrl, file, uploadHeaders, { onProgress, signal });

      return { attachmentId };
    },
    [],
  );

  const markConfirmedMessageAsRead = useCallback(
    (confirmedMessageId: string) => {
      if (threadId) {
        void apiMarkThreadAsRead(chatId, threadId, confirmedMessageId).then((res) => {
          dispatch(
            setThreadReadState({
              threadRootId: threadId,
              lastReadMessageId: res.data.lastReadMessageId,
              unreadCount: res.data.unreadCount,
            }),
          );
        });
        return;
      }

      dispatch(setChatUnreadCount({ chatId, unreadCount: 0 }));
      dispatch(setChatLastReadMessageId({ chatId, lastReadMessageId: confirmedMessageId }));
      void markMessagesAsRead(chatId, confirmedMessageId).then((res) => {
        dispatch(setChatUnreadCount({ chatId, unreadCount: res.data.unreadCount }));
        dispatch(setChatLastReadMessageId({ chatId, lastReadMessageId: res.data.lastReadMessageId }));
      });
      void syncAppBadgeCount();
    },
    [chatId, dispatch, threadId],
  );

  const handleSend = useCallback(
    (payload: ComposeSendPayload) => {
      if (!chatId) return;
      if (threadId && !threadSubscribed) {
        markThreadSubscribedOptimistically();
      }

      if (payload.kind === 'text') {
        const { text, attachmentIds, existingAttachments, uploadedAttachments } = payload;
        const { attachments: optimisticUploadedAttachments, revoke } =
          buildOptimisticUploadedAttachments(uploadedAttachments);

        if (!text.trim() && attachmentIds.length === 0) {
          revoke();
          return;
        }

        if (editingSession) {
          const originalAttachmentIds = (editingSession.attachments ?? []).map((attachment) => attachment.id);
          if (!text.trim() && attachmentIds.length === 0) {
            revoke();
            showToast(t`Message cannot be empty`);
            return;
          }
          if (
            text.trim() === editingSession.text.trim() &&
            areAttachmentIdsEqual(attachmentIds, originalAttachmentIds)
          ) {
            revoke();
            return;
          }

          const messageId = editingSession.messageId;
          const currentMessage = messageLookup.get(messageId) ?? editingSession.originalMessage;
          const optimisticMsg = {
            ...currentMessage,
            message: text,
            attachments: [...existingAttachments, ...optimisticUploadedAttachments],
            hasAttachments: attachmentIds.length > 0,
            isEdited: true,
          };

          dispatch(messagePatched({ chatId, messageId, message: optimisticMsg }));
          setEditingSession(null);

          updateMessage(chatId, messageId, { message: text, attachmentIds })
            .then((res) => {
              dispatch(messagePatched({ chatId, messageId, message: res.data }));
            })
            .catch((err: Error) => {
              dispatch(messagePatched({ chatId, messageId, message: editingSession.originalMessage }));
              showToast(err.message || t`Failed to edit message`);
            })
            .finally(() => {
              revoke();
            });
          return;
        }

        const clientGeneratedId = generateClientId();
        const replyPreview = buildReplyPreview(replyingTo);
        const optimistic: MessageResponse = {
          id: clientGeneratedId,
          message: text,
          messageType: 'text',
          replyRootId: threadId ?? null,
          replyToMessage: replyPreview,
          clientGeneratedId,
          sender: {
            uid: currentUserId || 0,
            gender: 0,
            name: currentUserName ?? null,
            avatarUrl: currentUserAvatarUrl || undefined,
          },
          chatId,
          createdAt: new Date().toISOString(),
          isEdited: false,
          isDeleted: false,
          hasAttachments: attachmentIds.length > 0,
          attachments: optimisticUploadedAttachments,
          threadInfo: undefined,
        };

        console.debug('[msg-trace] handleSend:optimistic', {
          cgId: clientGeneratedId,
          chatId,
          storeChatId,
          threadId: threadId ?? null,
        });
        dispatch(
          messageAdded({
            chatId,
            storeChatId,
            message: optimistic,
            origin: 'optimistic',
            scope: threadId ? 'thread' : 'main',
          }),
        );
        setReplyingTo(null);
        revealLatestAfterSend();

        const messagePayload = {
          message: text,
          messageType: 'text' as const,
          clientGeneratedId,
          replyToId: replyingTo?.id,
          attachmentIds,
        };

        const sendPromise = threadId
          ? sendThreadMessage(chatId, threadId, messagePayload)
          : sendMessage(chatId, messagePayload);

        sendPromise
          .then((res) => {
            const postResponse = res.data;
            const confirmed: MessageResponse = {
              ...postResponse,
              replyToMessage: postResponse.replyToMessage
                ? {
                    ...optimistic.replyToMessage,
                    ...postResponse.replyToMessage,
                    attachments: postResponse.replyToMessage.attachments ?? optimistic.replyToMessage?.attachments,
                  }
                : optimistic.replyToMessage,
            };
            console.debug('[msg-trace] handleSend:apiConfirm', {
              cgId: clientGeneratedId,
              confirmedId: confirmed.id,
              storeChatId,
            });
            dispatch(
              messageConfirmed({
                chatId,
                storeChatId,
                clientGeneratedId,
                message: confirmed,
                origin: 'api_confirm',
                scope: threadId ? 'thread' : 'main',
              }),
            );
            markConfirmedMessageAsRead(confirmed.id);
          })
          .catch((err: Error) => {
            showToast(err.message || t`Failed to send`);
            dispatch(
              messagePatched({
                chatId,
                messageId: clientGeneratedId,
                message: { ...optimistic, isDeleted: true },
              }),
            );
          })
          .finally(() => {
            revoke();
          });
        return;
      }

      if (payload.kind === 'file') {
        const clientGeneratedId = generateClientId();
        const objectUrl = URL.createObjectURL(payload.file);
        const replyPreview = buildReplyPreview(replyingTo);
        const optimistic: MessageResponse = {
          id: clientGeneratedId,
          message: '',
          messageType: 'file',
          replyRootId: threadId ?? null,
          replyToMessage: replyPreview,
          clientGeneratedId,
          sender: {
            uid: currentUserId || 0,
            gender: 0,
            name: currentUserName ?? null,
            avatarUrl: currentUserAvatarUrl || undefined,
          },
          chatId,
          createdAt: new Date().toISOString(),
          isEdited: false,
          isDeleted: false,
          hasAttachments: true,
          attachments: [
            {
              id: `local_${clientGeneratedId}`,
              url: objectUrl,
              kind: payload.file.type || 'application/octet-stream',
              size: payload.file.size,
              fileName: payload.file.name,
            },
          ],
          threadInfo: undefined,
        };
        dispatch(
          messageAdded({
            chatId,
            storeChatId,
            message: optimistic,
            origin: 'optimistic',
            scope: threadId ? 'thread' : 'main',
          }),
        );
        setReplyingTo(null);
        revealLatestAfterSend();
        dispatch(uploadProgressSet({ clientGeneratedId, progress: 0 }));

        const controller = new AbortController();
        uploadAttachment({
          file: payload.file,
          purpose: 'file',
          signal: controller.signal,
          onProgress: (progress) => dispatch(uploadProgressSet({ clientGeneratedId, progress })),
        })
          .then(({ attachmentId }) => {
            const messagePayload = {
              message: '',
              messageType: 'file' as const,
              clientGeneratedId,
              replyToId: replyingTo?.id,
              attachmentIds: [attachmentId],
            };
            return threadId ? sendThreadMessage(chatId, threadId, messagePayload) : sendMessage(chatId, messagePayload);
          })
          .then((res) => {
            const postResponse = res.data;
            const confirmed: MessageResponse = {
              ...postResponse,
              replyToMessage: postResponse.replyToMessage ?? optimistic.replyToMessage,
            };
            dispatch(
              messageConfirmed({
                chatId,
                storeChatId,
                clientGeneratedId,
                message: confirmed,
                origin: 'api_confirm',
                scope: threadId ? 'thread' : 'main',
              }),
            );
            markConfirmedMessageAsRead(confirmed.id);
          })
          .catch((err: Error) => {
            showToast(err.message || t`Failed to send`);
            dispatch(messagesBulkDeleted({ chatId, messageIds: [clientGeneratedId] }));
          })
          .finally(() => {
            dispatch(uploadProgressCleared({ clientGeneratedId }));
            URL.revokeObjectURL(objectUrl);
          });
        return;
      }

      if (payload.kind === 'sticker') {
        const clientGeneratedId = generateClientId();
        const replyPreview = buildReplyPreview(replyingTo);
        const optimistic: MessageResponse = {
          id: clientGeneratedId,
          message: null,
          messageType: 'sticker',
          sticker: payload.sticker,
          replyRootId: threadId ?? null,
          replyToMessage: replyPreview,
          clientGeneratedId,
          sender: {
            uid: currentUserId || 0,
            gender: 0,
            name: currentUserName ?? null,
            avatarUrl: currentUserAvatarUrl || undefined,
          },
          chatId,
          createdAt: new Date().toISOString(),
          isEdited: false,
          isDeleted: false,
          hasAttachments: false,
          attachments: [],
          threadInfo: undefined,
        };
        dispatch(
          messageAdded({
            chatId,
            storeChatId,
            message: optimistic,
            origin: 'optimistic',
            scope: threadId ? 'thread' : 'main',
          }),
        );
        setReplyingTo(null);
        revealLatestAfterSend();

        const messagePayload = {
          messageType: 'sticker' as const,
          stickerId: payload.sticker.id,
          clientGeneratedId,
          replyToId: replyingTo?.id,
          attachmentIds: [],
        };

        const sendPromise = threadId
          ? sendThreadMessage(chatId, threadId, messagePayload)
          : sendMessage(chatId, messagePayload);

        sendPromise
          .then((res) => {
            const postResponse = res.data;
            const confirmed: MessageResponse = {
              ...postResponse,
              sticker: postResponse.sticker ?? payload.sticker,
              replyToMessage: postResponse.replyToMessage
                ? {
                    ...optimistic.replyToMessage,
                    ...postResponse.replyToMessage,
                    attachments: postResponse.replyToMessage.attachments ?? optimistic.replyToMessage?.attachments,
                  }
                : optimistic.replyToMessage,
            };
            dispatch(
              messageConfirmed({
                chatId,
                storeChatId,
                clientGeneratedId,
                message: confirmed,
                origin: 'api_confirm',
                scope: threadId ? 'thread' : 'main',
              }),
            );
            markConfirmedMessageAsRead(confirmed.id);
          })
          .catch((err: Error) => {
            showToast(err.message || t`Failed to send`);
            dispatch(
              messagePatched({
                chatId,
                messageId: clientGeneratedId,
                message: { ...optimistic, isDeleted: true },
              }),
            );
          });
        return;
      }

      const { attachmentId, uploadedAttachment } = payload;
      const { attachments: optimisticAudioAttachments, revoke } = buildOptimisticUploadedAttachments([
        uploadedAttachment,
      ]);
      const clientGeneratedId = generateClientId();
      const replyPreview = buildReplyPreview(replyingTo);
      const optimistic: MessageResponse = {
        id: clientGeneratedId,
        message: '',
        messageType: 'audio',
        replyRootId: threadId ?? null,
        replyToMessage: replyPreview,
        clientGeneratedId,
        sender: {
          uid: currentUserId || 0,
          gender: 0,
          name: currentUserName ?? null,
          avatarUrl: currentUserAvatarUrl || undefined,
        },
        chatId,
        createdAt: new Date().toISOString(),
        isEdited: false,
        isDeleted: false,
        hasAttachments: true,
        attachments: optimisticAudioAttachments,
        threadInfo: undefined,
      };
      dispatch(
        messageAdded({
          chatId,
          storeChatId,
          message: optimistic,
          origin: 'optimistic',
          scope: threadId ? 'thread' : 'main',
        }),
      );
      setReplyingTo(null);
      revealLatestAfterSend();

      const messagePayload = {
        message: '',
        messageType: 'audio' as const,
        clientGeneratedId,
        replyToId: replyingTo?.id,
        attachmentIds: [attachmentId],
      };

      const sendPromise = threadId
        ? sendThreadMessage(chatId, threadId, messagePayload)
        : sendMessage(chatId, messagePayload);

      sendPromise
        .then((res) => {
          const postResponse = res.data;
          const confirmed: MessageResponse = {
            ...postResponse,
            replyToMessage: postResponse.replyToMessage
              ? {
                  ...optimistic.replyToMessage,
                  ...postResponse.replyToMessage,
                  attachments: postResponse.replyToMessage.attachments ?? optimistic.replyToMessage?.attachments,
                }
              : optimistic.replyToMessage,
          };
          dispatch(
            messageConfirmed({
              chatId,
              storeChatId,
              clientGeneratedId,
              message: confirmed,
              origin: 'api_confirm',
              scope: threadId ? 'thread' : 'main',
            }),
          );
          markConfirmedMessageAsRead(confirmed.id);
        })
        .catch((err: Error) => {
          showToast(err.message || t`Failed to send`);
          dispatch(
            messagePatched({
              chatId,
              messageId: clientGeneratedId,
              message: { ...optimistic, isDeleted: true },
            }),
          );
        })
        .finally(() => {
          revoke();
        });
    },
    [
      chatId,
      currentUserAvatarUrl,
      currentUserId,
      currentUserName,
      dispatch,
      editingSession,
      markConfirmedMessageAsRead,
      markThreadSubscribedOptimistically,
      messageLookup,
      replyingTo,
      revealLatestAfterSend,
      setEditingSession,
      setReplyingTo,
      showToast,
      storeChatId,
      threadId,
      threadSubscribed,
      uploadAttachment,
    ],
  );

  return {
    handleSend,
    uploadAttachment,
  };
}

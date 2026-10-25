import { MessageType, SystemMessageKind } from '../../generated/models';
import { isMembershipMessage, systemMessagePresentation } from './system-message';

it.each([
  SystemMessageKind.member_joined,
  SystemMessageKind.member_left,
  SystemMessageKind.member_added,
  SystemMessageKind.member_removed,
])('filters %s even when its body changes', (systemKind) => {
  const message = { messageType: MessageType.system, systemKind, message: 'new wording without protocol phrases' };
  expect(isMembershipMessage(message)).toBe(true);
});

it.each([
  SystemMessageKind.message_pinned,
  SystemMessageKind.message_unpinned,
  SystemMessageKind.thread_message_pinned,
  SystemMessageKind.thread_message_unpinned,
  SystemMessageKind.friend_request_accepted,
  SystemMessageKind.unknown,
  undefined,
])('does not infer membership from text for %s', (systemKind) => {
  const message = { messageType: MessageType.system, systemKind, message: 'joined the chat' };
  expect(isMembershipMessage(message)).toBe(false);
});

it('keeps ordinary messages outside the system event classifier', () => {
  const message = {
    messageType: MessageType.text,
    systemKind: SystemMessageKind.member_joined,
    message: 'joined the chat',
  };
  expect(isMembershipMessage(message)).toBe(false);
  expect(systemMessagePresentation(message)).toBeUndefined();
});

it('selects presentation by explicit event kind and leaves unknown events untranslated', () => {
  const message = {
    messageType: MessageType.system,
    systemKind: SystemMessageKind.member_joined,
    message: 'new wording',
  };
  expect(systemMessagePresentation(message)?.kind).toBe('joined');
  expect(
    systemMessagePresentation({ ...message, systemKind: SystemMessageKind.unknown, message: 'joined the chat' }),
  ).toBeUndefined();
});

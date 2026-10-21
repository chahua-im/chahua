import { GroupKind, MessageType } from '../../generated/models';
import { encodeId } from '../api/snowflake-id';
import { testMessage, testUser } from '../api/testing';
import { notificationText, shouldNotify } from './notification-policy';

const zhCNPlaceholders: Record<string, string> = {
  'pwa.notification.invite': '[邀请]',
  'pwa.notification.sticker': '[表情]',
  'pwa.notification.audio': '[语音]',
  'pwa.notification.file': '[文件]',
  'pwa.notification.image': '[图片]',
  'pwa.notification.video': '[视频]',
  'pwa.notification.message': '[消息]',
};

const message = { ...testMessage, sender: { uid: 2, name: '朋友', gender: 0 } };
const muted = { kind: GroupKind.group, mutedUntil: '9999-12-31T23:59:59Z' };
const mention = { ...message, mentions: [{ uid: testUser.uid, username: '我', gender: 0 }] };
const reply = { ...message, replyToMessage: { ...testMessage, mentions: [] } };
const topic = { ...message, replyRootId: encodeId('9007199254740999') };

describe('notification policy', () => {
  it('treats constructed DM mentions and replies like ordinary messages', () => {
    for (const incoming of [message, mention, reply]) {
      expect(shouldNotify(incoming, 1, { kind: GroupKind.dm }, undefined)).toBe(true);
      expect(shouldNotify(incoming, 1, { ...muted, kind: GroupKind.dm }, undefined)).toBe(false);
      expect(shouldNotify(incoming, 1, { archived: true, kind: GroupKind.dm }, undefined)).toBe(false);
      const inThread = { ...incoming, replyRootId: topic.replyRootId };
      for (const state of [undefined, { subscribed: false, archived: false }, { subscribed: true, archived: true }]) {
        expect(shouldNotify(inThread, 1, { kind: GroupKind.dm }, state)).toBe(false);
      }
      expect(shouldNotify(inThread, 1, { kind: GroupKind.dm }, { subscribed: true, archived: false })).toBe(true);
      expect(
        shouldNotify(inThread, 1, { kind: GroupKind.dm, archived: true }, { subscribed: true, archived: false }),
      ).toBe(false);
    }
  });
  it('excludes outgoing, deleted and system messages but accepts an expired mute', () => {
    expect(shouldNotify(testMessage, 1, undefined, undefined)).toBe(false);
    expect(shouldNotify({ ...message, isDeleted: true }, 1, undefined, undefined)).toBe(false);
    expect(shouldNotify({ ...message, messageType: MessageType.system }, 1, undefined, undefined)).toBe(false);
    expect(shouldNotify(message, 1, { mutedUntil: '2000-01-01' }, undefined)).toBe(true);
  });
  it('keeps mentions and ordinary replies through a mute', () => {
    expect(shouldNotify(message, 1, muted, undefined)).toBe(false);
    expect(shouldNotify(mention, 1, muted, undefined)).toBe(true);
    expect(shouldNotify(reply, 1, muted, undefined)).toBe(true);
  });
  it('only ordinary replies bypass parent archive', () => {
    expect(shouldNotify(mention, 1, { archived: true }, undefined)).toBe(false);
    expect(shouldNotify(reply, 1, { kind: GroupKind.group, archived: true }, undefined)).toBe(true);
    expect(
      shouldNotify(
        { ...topic, replyToMessage: { ...testMessage, mentions: [] } },
        1,
        { archived: true },
        { subscribed: true, archived: false },
      ),
    ).toBe(false);
  });
  it('lets subscribed topics bypass parent mute, while archived or unsubscribed topics need a mention or reply', () => {
    expect(shouldNotify(topic, 1, muted, { subscribed: true, archived: false })).toBe(true);
    for (const state of [undefined, { subscribed: false, archived: false }, { subscribed: true, archived: true }]) {
      expect(shouldNotify(topic, 1, muted, state)).toBe(false);
      expect(shouldNotify({ ...topic, mentions: mention.mentions }, 1, muted, state)).toBe(true);
      expect(shouldNotify({ ...topic, replyToMessage: reply.replyToMessage }, 1, muted, state)).toBe(true);
      expect(
        shouldNotify(
          { ...topic, replyToMessage: { ...reply.replyToMessage, sender: message.sender } },
          1,
          muted,
          state,
        ),
      ).toBe(false);
      expect(
        shouldNotify({ ...topic, replyToMessage: reply.replyToMessage }, 1, { ...muted, archived: true }, state),
      ).toBe(false);
    }
  });
  const t = (key: string) => zhCNPlaceholders[key] ?? key;

  it('describes an invitation without exposing the protocol code and preserves ordinary captions', () => {
    expect(notificationText({ ...message, messageType: MessageType.invite, message: 'abcdefghij' }, t)).toBe('[邀请]');
    expect(notificationText({ ...message, messageType: MessageType.file, message: '文件说明' }, t)).toBe('文件说明');
  });
  it('expands mentions and describes media when the system notification has no text', () => {
    expect(notificationText({ ...mention, message: '你好 @[uid:1]' }, t)).toBe('你好 @我');
    expect(notificationText({ ...message, message: '', messageType: MessageType.audio }, t)).toBe('[语音]');
    expect(notificationText({ ...message, message: '', messageType: MessageType.file }, t)).toBe('[文件]');
  });
});

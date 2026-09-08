import { MessageType } from '../../generated/models';
import { encodeId } from '../api/snowflake-id';
import { testMessage, testUser } from '../api/testing';
import { notificationText, shouldNotify } from './notification-policy';

const message = { ...testMessage, sender: { uid: 2, name: '朋友', gender: 0 } };
const muted = { mutedUntil: '9999-12-31T23:59:59Z' };
const mention = { ...message, mentions: [{ uid: testUser.uid, username: '我', gender: 0 }] };
const reply = { ...message, replyToMessage: { ...testMessage, mentions: [] } };
const topic = { ...message, replyRootId: encodeId('9007199254740999') };

describe('notification policy', () => {
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
    expect(shouldNotify(reply, 1, { archived: true }, undefined)).toBe(true);
    expect(
      shouldNotify(
        { ...topic, replyToMessage: { ...testMessage, mentions: [] } },
        1,
        { archived: true },
        { subscribed: true, archived: false },
      ),
    ).toBe(false);
  });
  it('lets subscribed topics bypass parent mute, while archived or unsubscribed topics need a mention', () => {
    expect(shouldNotify(topic, 1, muted, { subscribed: true, archived: false })).toBe(true);
    for (const state of [undefined, { subscribed: false, archived: false }, { subscribed: true, archived: true }]) {
      expect(shouldNotify(topic, 1, muted, state)).toBe(false);
      expect(shouldNotify({ ...topic, mentions: mention.mentions }, 1, muted, state)).toBe(true);
    }
  });
  it('describes an invitation without exposing the protocol code and preserves ordinary captions', () => {
    expect(notificationText({ ...message, messageType: MessageType.invite, message: 'abcdefghij' })).toBe('[邀请]');
    expect(notificationText({ ...message, messageType: MessageType.file, message: '文件说明' })).toBe('文件说明');
  });
  it('expands mentions and describes media when the system notification has no text', () => {
    expect(notificationText({ ...mention, message: '你好 @[uid:1]' })).toBe('你好 @我');
    expect(notificationText({ ...message, message: '', messageType: MessageType.audio })).toBe('[语音]');
    expect(notificationText({ ...message, message: '', messageType: MessageType.file })).toBe('[文件]');
  });
});

import { describe, expect, it } from 'vitest';
import { getOverlayActionPolicy, type OverlayActionPolicyInput } from './overlayActionPolicy';

const baseInput: OverlayActionPolicyInput = {
  messageType: 'text',
  text: 'hello',
  hasAttachments: false,
  isDeleted: false,
  isOptimistic: false,
  hasThreadInfo: false,
  isOwn: false,
  isAdmin: false,
  isDm: false,
  isThreadView: false,
  savedMessagesEnabled: true,
  isPinned: false,
  hasReactions: false,
};

function keys(input: Partial<OverlayActionPolicyInput> = {}) {
  return getOverlayActionPolicy({ ...baseInput, ...input }).map((action) => action.key);
}

describe('overlay action policy', () => {
  it('preserves default text message action order', () => {
    expect(keys()).toEqual(['reply', 'thread', 'copy', 'save', 'copy-link']);
  });

  it('uses copy text variant when a text message also has attachments', () => {
    expect(getOverlayActionPolicy({ ...baseInput, hasAttachments: true })[2]).toEqual({
      key: 'copy',
      copyVariant: 'text',
    });
  });

  it('omits copy when a regular message has no text', () => {
    expect(keys({ text: '', hasAttachments: true })).toEqual(['reply', 'thread', 'save', 'copy-link']);
  });

  it('adds edit and delete for own regular messages, but not when deleted', () => {
    expect(keys({ isOwn: true, isOptimistic: true })).toEqual([
      'reply',
      'thread',
      'copy',
      'edit',
      'copy-link',
      'delete',
    ]);
    expect(keys({ isOwn: true, isDeleted: true, text: null })).toEqual(['reply', 'copy-link']);
  });

  it('only offers start thread for text messages', () => {
    expect(keys({ messageType: 'text' })).toContain('thread');

    for (const messageType of ['audio', 'file', 'sticker', 'invite', 'system'] as const) {
      expect(keys({ messageType })).not.toContain('thread');
    }
  });

  it('adds delete and pin state for admins in main chat', () => {
    expect(keys({ isAdmin: true })).toEqual(['reply', 'thread', 'pin', 'copy', 'save', 'copy-link', 'delete']);
    expect(getOverlayActionPolicy({ ...baseInput, isAdmin: true, isPinned: true }).at(2)).toEqual({
      key: 'pin',
      pinState: 'pinned',
    });
  });

  it('offers pin but not start thread inside thread view for admins', () => {
    expect(keys({ isThreadView: true, isAdmin: true })).toEqual([
      'reply',
      'pin',
      'copy',
      'save',
      'copy-link',
      'delete',
    ]);
  });

  it('does not offer pin inside thread view for non-admins', () => {
    expect(keys({ isThreadView: true, isAdmin: false })).not.toContain('pin');
  });

  it('offers pin to DM participants without admin role', () => {
    expect(keys({ isDm: true })).toContain('pin');
    expect(getOverlayActionPolicy({ ...baseInput, isDm: true, isPinned: true }).at(2)).toEqual({
      key: 'pin',
      pinState: 'pinned',
    });
  });

  it('omits copy-link in DM chats', () => {
    expect(keys({ isDm: true })).not.toContain('copy-link');
    expect(keys({ isDm: true, hasReactions: true })).toEqual([
      'reply',
      'thread',
      'pin',
      'copy',
      'save',
      'reaction-details',
    ]);
  });

  it('does not offer pin for non-admins in regular group chats', () => {
    expect(keys({ isDm: false })).not.toContain('pin');
  });

  it('does not offer start thread when the message already has thread info', () => {
    expect(keys({ hasThreadInfo: true })).toEqual(['reply', 'copy', 'save', 'copy-link']);
  });

  it('preserves current optimistic and deleted save/pin restrictions', () => {
    expect(keys({ isOptimistic: true })).toEqual(['reply', 'thread', 'copy', 'copy-link']);
    expect(keys({ isDeleted: true, text: null, isAdmin: true })).toEqual(['reply', 'copy-link']);
  });

  it('keeps sticker actions filtered to reply delete copy link and favorite', () => {
    expect(
      keys({
        messageType: 'sticker',
        isAdmin: true,
        hasReactions: true,
      }),
    ).toEqual(['reply', 'favorite', 'copy-link', 'delete']);
  });

  it('uses audio action rules without thread, copy, or edit', () => {
    expect(keys({ messageType: 'audio', isOwn: true, isAdmin: true })).toEqual([
      'reply',
      'pin',
      'save',
      'copy-link',
      'delete',
    ]);
  });

  it('adds reaction details only when reactions are present for non-sticker messages', () => {
    expect(keys({ hasReactions: true })).toEqual(['reply', 'thread', 'copy', 'save', 'copy-link', 'reaction-details']);
  });

  it('disables save when the feature is off or the message is system', () => {
    expect(keys({ savedMessagesEnabled: false })).toEqual(['reply', 'thread', 'copy', 'copy-link']);
    expect(keys({ messageType: 'system' })).toEqual(['reply', 'copy', 'copy-link']);
  });
});

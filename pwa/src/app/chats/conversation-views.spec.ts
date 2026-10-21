import { ConversationCategory } from '../../generated/models';
import { encodeId } from '../api/snowflake-id';
import { builtinConversationViews, containsConversation, conversationView } from './conversation-views';
import { ListTab } from './list-tabs';

describe('conversation view definitions', () => {
  it('uses distinct collection keys for archives and the message thread preference', () => {
    const views = builtinConversationViews();
    expect(new Set(views.map((view) => view.key)).size).toBe(10);
    expect(
      conversationView({ tab: ListTab.Friends, archived: false, requestHistory: false }, true).selector.categories,
    ).toEqual([ConversationCategory.dm]);
    const selection = { tab: ListTab.Messages, archived: false, requestHistory: false };
    expect(conversationView(selection, false).selector.categories).toEqual([
      ConversationCategory.group,
      ConversationCategory.dm,
    ]);
    expect(conversationView(selection, true).selector.categories).toHaveLength(4);
  });

  it('keeps explicit chats separate from threads and applies exclusions before inclusion', () => {
    const main = { chatId: encodeId('9007199254740993') };
    const thread = { ...main, threadId: encodeId('9007199254740995') };
    const selector = { include: [main], archived: false };
    expect(containsConversation(selector, main, ConversationCategory.dm, false)).toBe(true);
    expect(containsConversation(selector, thread, ConversationCategory.dmThread, false)).toBe(false);
    expect(
      containsConversation(
        { ...selector, categories: [ConversationCategory.dm], exclude: [main] },
        main,
        ConversationCategory.dm,
        false,
      ),
    ).toBe(false);
    expect(containsConversation(selector, main, ConversationCategory.dm, true)).toBe(false);
  });
});

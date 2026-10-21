import {
  ConversationCategory,
  type ConversationRef,
  type ConversationSelector,
  type ConversationView,
} from '../../generated/models';
import { ListTab, type ListSelection } from './list-tabs';

export const mainCategories = [ConversationCategory.group, ConversationCategory.dm];
export const threadCategories = [ConversationCategory.groupThread, ConversationCategory.dmThread];

export function conversationView(selection: ListSelection, showThreadsInMessages: boolean): ConversationView {
  const { tab, archived } = selection;
  const categories =
    tab === ListTab.Groups
      ? [ConversationCategory.group]
      : tab === ListTab.Friends
        ? [ConversationCategory.dm]
        : tab === ListTab.Threads
          ? threadCategories
          : [...mainCategories, ...(showThreadsInMessages ? threadCategories : [])];
  return {
    key: `${tab}${tab === ListTab.Messages && showThreadsInMessages ? '-with-threads' : ''}${archived ? '-archived' : ''}`,
    selector: { categories, archived },
  };
}

/** Both message-tab variants are fetched together, so changing the preference cannot reuse another collection's total. */
export function builtinConversationViews(): ConversationView[] {
  return [false, true].flatMap((archived) => [
    ...Object.values(ListTab).map((tab) => conversationView({ tab, archived, requestHistory: false }, false)),
    conversationView({ tab: ListTab.Messages, archived, requestHistory: false }, true),
  ]);
}

export function containsConversation(
  selector: ConversationSelector,
  scope: ConversationRef,
  category: ConversationCategory,
  archived: boolean,
): boolean {
  const same = (ref: ConversationRef) =>
    ref.chatId === scope.chatId && (ref.threadId ?? null) === (scope.threadId ?? null);
  return (
    (selector.archived ?? false) === archived &&
    !selector.exclude?.some(same) &&
    (!!selector.categories?.includes(category) || !!selector.include?.some(same))
  );
}

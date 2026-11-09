import type { Emoji, SkinTone } from '@nicematic/emoji-picker';
import type { DBSchema, IDBPDatabase } from 'idb';
import type { SnowflakeID } from '../api/snowflake-id';

export enum AccountStore {
  Preferences = 'preferences',
  Usage = 'usage',
  Drafts = 'drafts',
}

export interface Draft {
  text: string;
  replyTo?: string;
  savedAt: number;
}

export interface RecentEmoji extends Readonly<Omit<Emoji, 'keywords'>> {
  readonly keywords: readonly string[];
  readonly count: number;
  readonly lastUsed: number;
}

export interface AccountData {
  [AccountStore.Preferences]: {
    showThreadsInMessages: boolean;
    showAllAvatars: boolean;
    showDmDetails: boolean;
    pinnedReactions: readonly string[];
    autoSortStickerPacks: boolean;
    autoSortFavoriteStickers: boolean;
    skinTone: SkinTone;
  };
  [AccountStore.Usage]: {
    recentReactions: readonly string[];
    favoriteStickerOrder: readonly Readonly<{ stickerId: string | SnowflakeID; lastUsedOn: number }>[];
    emojiRecents: readonly RecentEmoji[];
  };
  [AccountStore.Drafts]: Record<string, Readonly<Draft>>;
}

export const ACCOUNT_DATABASE = 'chahua-accounts';

export type AccountScope = [environment: string, uid: number];
type AccountKey = [...AccountScope, key: string];

interface AccountRecord<Value = unknown> {
  environment: string;
  uid: number;
  key: string;
  value: Value;
}

export interface AccountDatabaseSchema extends DBSchema {
  preferences: { key: AccountKey; value: AccountRecord };
  usage: { key: AccountKey; value: AccountRecord };
  drafts: { key: AccountKey; value: AccountRecord<Readonly<Draft>> };
  meta: { key: string; value: { key: string; value: unknown } };
}

export type AccountDatabase = IDBPDatabase<AccountDatabaseSchema>;

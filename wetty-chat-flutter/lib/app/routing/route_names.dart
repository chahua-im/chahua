abstract final class AppRoutes {
  static const bootstrap = '/bootstrap';
  static const login = '/login';
  static const chats = '/';
  static const archivedThreads = '/threads/archived';
  static String chatDetail(String chatId) => '/chat/$chatId';
  static String chatMembers(String chatId) => '/chat/$chatId/members';
  static String chatSettings(String chatId) => '/chat/$chatId/settings';
  static String chatMessageSearch(String chatId) =>
      '/chat/$chatId/settings/search';
  static String nestedThreadDetail(String chatId, String threadRootId) =>
      '/chat/$chatId/thread/$threadRootId';
  static String nestedNewThread(String chatId, String threadRootId) =>
      '/chat/$chatId/thread/$threadRootId/new';
  static String threadDetail(String chatId, String threadRootId) =>
      '/thread/$chatId/$threadRootId';
  static const settings = '/settings';
  static const splitSettingsModal = '/settings-modal';
  static const general = '/settings/general';
  static const language = '/settings/general/language';
  static const cache = '/settings/general/cache';
  static const appearance = '/settings/appearance';
  static const fontSize = '/settings/appearance/text-size';
  static const badgeColor = '/settings/appearance/badge-color';
  static const devSession = '/settings/developer-session';
  static const notifications = '/settings/notifications';
  static const stickerPackDetailRoot = '/sticker-packs';
  static String stickerPackDetail(String packId) => '/sticker-packs/$packId';
  static const stickerPacks = '/settings/stickers';
  static String settingsStickerPackDetail(String packId) =>
      '/settings/stickers/$packId';
  static const attachmentViewer = '/attachment-viewer';
}

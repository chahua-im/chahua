// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for English (`en`).
class AppLocalizationsEn extends AppLocalizations {
  AppLocalizationsEn([String locale = 'en']) : super(locale);

  @override
  String get appTitle => 'Wetty Chat';

  @override
  String get tabChats => 'Chats';

  @override
  String get tabSettings => 'Settings';

  @override
  String get login => 'Login';

  @override
  String get loginInfo => 'Login Info';

  @override
  String get username => 'Username';

  @override
  String get password => 'Password';

  @override
  String get securityQuestion => 'Security Question';

  @override
  String get securityQuestionHint => 'Security question (ignore if not set)';

  @override
  String get sqMothersName => 'Mother\'s name';

  @override
  String get sqGrandfathersName => 'Grandfather\'s name';

  @override
  String get sqFathersBirthCity => 'Father\'s birth city';

  @override
  String get sqTeachersName => 'Name of one of your teachers';

  @override
  String get sqComputerModel => 'Your computer model';

  @override
  String get sqFavoriteRestaurant => 'Your favorite restaurant';

  @override
  String get sqDriversLicenseLast4 => 'Last 4 digits of driver\'s license';

  @override
  String get loginSuccess => 'Login successful';

  @override
  String get loginFailed => 'Login failed';

  @override
  String get missingFields => 'Missing fields';

  @override
  String get processing => 'Processing';

  @override
  String get ready => 'Ready';

  @override
  String get newChat => 'New Chat';

  @override
  String get chatName => 'Chat Name';

  @override
  String get optional => 'Optional';

  @override
  String get create => 'Create';

  @override
  String get chatCreated => 'Chat created';

  @override
  String get noMessagesYet => 'No messages yet';

  @override
  String get groupMembers => 'Group Members';

  @override
  String get groupSettings => 'Group Settings';

  @override
  String get messageSearchAction => 'Search';

  @override
  String get messageSearchTitle => 'Search';

  @override
  String get messageSearchPlaceholder => 'Search messages';

  @override
  String get messageSearchEmptyPrompt => 'Search messages in this chat';

  @override
  String get messageSearchMinChars => 'Enter at least 2 characters';

  @override
  String get messageSearchNoResults => 'No messages found';

  @override
  String get messageSearchFailed => 'Failed to search messages';

  @override
  String get messageSearchThreadContext => 'In thread';

  @override
  String get messageSearchLoadMore => 'Load More';

  @override
  String get noMembers => 'No members';

  @override
  String get retry => 'Retry';

  @override
  String get settingsLanguage => 'Language';

  @override
  String get languageSystem => 'System';

  @override
  String get languageEnglish => 'English';

  @override
  String get languageChineseCN => 'Simplified Chinese';

  @override
  String get languageChineseTW => 'Traditional Chinese';

  @override
  String get settingsTextSize => 'Text Size';

  @override
  String get badgeColor => 'Badge Color';

  @override
  String get badgeColorPreview => 'Preview';

  @override
  String get resetBadgeColor => 'Reset to Default';

  @override
  String get settingsCache => 'Cache';

  @override
  String get settingsCacheTitle => 'Cache';

  @override
  String get settingsCacheSectionHeader => 'APP CACHE';

  @override
  String get settingsCacheDescription =>
      'Includes managed cached media such as images, downloaded audio files, transcoded audio, and waveform data.';

  @override
  String get settingsCacheUsage => 'Storage Used';

  @override
  String get settingsClearCache => 'Clear Cache';

  @override
  String get settingsClearCacheTitle => 'Clear cache?';

  @override
  String get settingsClearCacheMessage =>
      'This removes cached media files and waveform data stored on this device.';

  @override
  String get settingsChat => 'Chat';

  @override
  String get settingsShowAllTab => 'Show \'All\' Tab';

  @override
  String get settingsGeneral => 'General';

  @override
  String get settingsAppearance => 'Appearance';

  @override
  String get settingsEmojisAndStickers => 'Emojis & Stickers';

  @override
  String get settingsUser => 'User';

  @override
  String get settingsProfile => 'Profile';

  @override
  String get settingsNotifications => 'Notifications';

  @override
  String get settingsDeveloperSession => 'Developer Session';

  @override
  String get logOut => 'Log Out';

  @override
  String get logOutConfirmTitle => 'Log out?';

  @override
  String get logOutConfirmMessage =>
      'This will clear the login state saved on this device.';

  @override
  String get cancel => 'Cancel';

  @override
  String get ok => 'OK';

  @override
  String get error => 'Error';

  @override
  String get close => 'Close';

  @override
  String get copied => 'Copied';

  @override
  String get message => 'Message';

  @override
  String get camera => 'Camera';

  @override
  String get media => 'Media';

  @override
  String get reply => 'Reply';

  @override
  String get copyMessageAction => 'Copy';

  @override
  String get edit => 'Edit';

  @override
  String get delete => 'Delete';

  @override
  String get deleteMessageAction => 'Delete';

  @override
  String get deleteMessageTitle => 'Delete message?';

  @override
  String get deleteMessageBody => 'This cannot be undone.';

  @override
  String get all => 'All';

  @override
  String get groups => 'Groups';

  @override
  String get threads => 'Threads';

  @override
  String get thread => 'Thread';

  @override
  String get newThread => 'New Thread';

  @override
  String get startThread => 'Start Thread';

  @override
  String get pinMessage => 'Pin';

  @override
  String get pinMessageTitle => 'Pin message?';

  @override
  String get pinMessageBody => 'This pins it for everyone in the chat.';

  @override
  String get unpinMessage => 'Unpin';

  @override
  String get unpinMessageTitle => 'Unpin message?';

  @override
  String get unpinMessageBody =>
      'This removes it from pinned messages for everyone.';

  @override
  String get pinnedMessages => 'Pinned Messages';

  @override
  String get newThreadInstruction =>
      'Reply to this message to start the thread.';

  @override
  String get subscribeThreadAction => 'Subscribe to thread';

  @override
  String get archiveThreadAction => 'Archive thread';

  @override
  String get unarchiveThreadAction => 'Unarchive thread';

  @override
  String get unarchiveThreadTitle => 'Unarchive thread?';

  @override
  String get unarchiveThreadMessage =>
      'This thread will move back to Threads. Continue?';

  @override
  String get noGroupsYet => 'No groups yet';

  @override
  String get noThreadsYet => 'No threads yet';

  @override
  String get archivedThreads => 'Archived threads';

  @override
  String get noArchivedThreads => 'No archived threads';

  @override
  String get noChatsOrThreadsYet => 'No chats or threads yet';

  @override
  String threadReplyCount(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count replies',
      one: '1 reply',
    );
    return '$_temp0';
  }

  @override
  String chatFallbackName(String id) {
    return 'Chat $id';
  }

  @override
  String userFallbackName(int uid) {
    return 'User $uid';
  }

  @override
  String get unknownUser => 'Unknown';

  @override
  String get draftPrefix => '[Draft]';

  @override
  String get previewDeleted => '[Deleted]';

  @override
  String get previewInvite => '[Invite]';

  @override
  String get previewSticker => '[Sticker]';

  @override
  String get previewVoiceMessage => '[Voice message]';

  @override
  String get previewImage => '[Image]';

  @override
  String get previewVideo => '[Video]';

  @override
  String get previewAttachment => '[Attachment]';

  @override
  String get mediaImageSaved => 'Image saved to Photos.';

  @override
  String get mediaVideoSaved => 'Video saved to Photos.';

  @override
  String get mediaSaveFailed => 'Failed to save media.';

  @override
  String get mediaImageLoadFailed => 'Failed to load image';

  @override
  String get mediaVideoLoadFailed => 'Failed to load video';

  @override
  String get voiceMessage => 'Voice message';

  @override
  String get voiceWaitingForMicrophone => 'Waiting for microphone…';

  @override
  String get voiceReleaseToSave => 'Release to save';

  @override
  String get voiceSlideLeftToCancel => 'Slide left to cancel';

  @override
  String voiceUploadingProgress(int progress) {
    return 'Uploading $progress%';
  }

  @override
  String get voiceRecordingUnsupported =>
      'Voice recording is not supported on this device.';

  @override
  String get voiceMicrophonePermissionDenied =>
      'Microphone permission is required to record audio.';

  @override
  String get voiceRecordingTooShort => 'Recording is too short.';

  @override
  String get voiceRecordingStartFailed => 'Failed to start recording.';

  @override
  String get voiceMessageUploadFailed => 'Failed to upload voice message.';

  @override
  String get voiceMessageSendFailed => 'Failed to send voice message.';

  @override
  String get deleteRecording => 'Delete recording';

  @override
  String get sendVoiceMessage => 'Send voice message';

  @override
  String get fontSize => 'Font Size';

  @override
  String get messagesFontSize => 'Messages Font Size';

  @override
  String get sampleUser => 'Sample User';

  @override
  String get fontSizePreviewMessage =>
      'This is how your messages will look in chat.';

  @override
  String get dateToday => 'Today';

  @override
  String get dateYesterday => 'Yesterday';

  @override
  String relativeMinutes(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count minutes ago',
      one: '1 minute ago',
    );
    return '$_temp0';
  }

  @override
  String relativeHours(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count hours ago',
      one: '1 hour ago',
    );
    return '$_temp0';
  }

  @override
  String get swipeActionMarkRead => 'Read';

  @override
  String get swipeActionMarkUnread => 'Unread';

  @override
  String get swipeActionArchive => 'Archive';

  @override
  String get swipeActionUnarchive => 'Unarchive';

  @override
  String get selectChatPlaceholder => 'Select a chat';
}

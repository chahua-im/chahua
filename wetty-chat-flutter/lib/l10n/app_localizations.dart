import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/intl.dart' as intl;

import 'app_localizations_en.dart';
import 'app_localizations_zh.dart';

// ignore_for_file: type=lint

/// Callers can lookup localized strings with an instance of AppLocalizations
/// returned by `AppLocalizations.of(context)`.
///
/// Applications need to include `AppLocalizations.delegate()` in their app's
/// `localizationDelegates` list, and the locales they support in the app's
/// `supportedLocales` list. For example:
///
/// ```dart
/// import 'l10n/app_localizations.dart';
///
/// return MaterialApp(
///   localizationsDelegates: AppLocalizations.localizationsDelegates,
///   supportedLocales: AppLocalizations.supportedLocales,
///   home: MyApplicationHome(),
/// );
/// ```
///
/// ## Update pubspec.yaml
///
/// Please make sure to update your pubspec.yaml to include the following
/// packages:
///
/// ```yaml
/// dependencies:
///   # Internationalization support.
///   flutter_localizations:
///     sdk: flutter
///   intl: any # Use the pinned version from flutter_localizations
///
///   # Rest of dependencies
/// ```
///
/// ## iOS Applications
///
/// iOS applications define key application metadata, including supported
/// locales, in an Info.plist file that is built into the application bundle.
/// To configure the locales supported by your app, you’ll need to edit this
/// file.
///
/// First, open your project’s ios/Runner.xcworkspace Xcode workspace file.
/// Then, in the Project Navigator, open the Info.plist file under the Runner
/// project’s Runner folder.
///
/// Next, select the Information Property List item, select Add Item from the
/// Editor menu, then select Localizations from the pop-up menu.
///
/// Select and expand the newly-created Localizations item then, for each
/// locale your application supports, add a new item and select the locale
/// you wish to add from the pop-up menu in the Value field. This list should
/// be consistent with the languages listed in the AppLocalizations.supportedLocales
/// property.
abstract class AppLocalizations {
  AppLocalizations(String locale)
    : localeName = intl.Intl.canonicalizedLocale(locale.toString());

  final String localeName;

  static AppLocalizations? of(BuildContext context) {
    return Localizations.of<AppLocalizations>(context, AppLocalizations);
  }

  static const LocalizationsDelegate<AppLocalizations> delegate =
      _AppLocalizationsDelegate();

  /// A list of this localizations delegate along with the default localizations
  /// delegates.
  ///
  /// Returns a list of localizations delegates containing this delegate along with
  /// GlobalMaterialLocalizations.delegate, GlobalCupertinoLocalizations.delegate,
  /// and GlobalWidgetsLocalizations.delegate.
  ///
  /// Additional delegates can be added by appending to this list in
  /// MaterialApp. This list does not have to be used at all if a custom list
  /// of delegates is preferred or required.
  static const List<LocalizationsDelegate<dynamic>> localizationsDelegates =
      <LocalizationsDelegate<dynamic>>[
        delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
      ];

  /// A list of this localizations delegate's supported locales.
  static const List<Locale> supportedLocales = <Locale>[
    Locale('en'),
    Locale('zh'),
    Locale('zh', 'TW'),
  ];

  /// The application title
  ///
  /// In en, this message translates to:
  /// **'Wetty Chat'**
  String get appTitle;

  /// Bottom tab label for chats
  ///
  /// In en, this message translates to:
  /// **'Chats'**
  String get tabChats;

  /// Bottom tab label for settings
  ///
  /// In en, this message translates to:
  /// **'Settings'**
  String get tabSettings;

  /// Login button / page title
  ///
  /// In en, this message translates to:
  /// **'Login'**
  String get login;

  /// Login info section header
  ///
  /// In en, this message translates to:
  /// **'Login Info'**
  String get loginInfo;

  /// Username field label
  ///
  /// In en, this message translates to:
  /// **'Username'**
  String get username;

  /// Password field label
  ///
  /// In en, this message translates to:
  /// **'Password'**
  String get password;

  /// Security question section header
  ///
  /// In en, this message translates to:
  /// **'Security Question'**
  String get securityQuestion;

  /// Security question hint text
  ///
  /// In en, this message translates to:
  /// **'Security question (ignore if not set)'**
  String get securityQuestionHint;

  /// Security question option
  ///
  /// In en, this message translates to:
  /// **'Mother\'s name'**
  String get sqMothersName;

  /// Security question option
  ///
  /// In en, this message translates to:
  /// **'Grandfather\'s name'**
  String get sqGrandfathersName;

  /// Security question option
  ///
  /// In en, this message translates to:
  /// **'Father\'s birth city'**
  String get sqFathersBirthCity;

  /// Security question option
  ///
  /// In en, this message translates to:
  /// **'Name of one of your teachers'**
  String get sqTeachersName;

  /// Security question option
  ///
  /// In en, this message translates to:
  /// **'Your computer model'**
  String get sqComputerModel;

  /// Security question option
  ///
  /// In en, this message translates to:
  /// **'Your favorite restaurant'**
  String get sqFavoriteRestaurant;

  /// Security question option
  ///
  /// In en, this message translates to:
  /// **'Last 4 digits of driver\'s license'**
  String get sqDriversLicenseLast4;

  /// Toast shown on successful login
  ///
  /// In en, this message translates to:
  /// **'Login successful'**
  String get loginSuccess;

  /// Toast shown on failed login
  ///
  /// In en, this message translates to:
  /// **'Login failed'**
  String get loginFailed;

  /// Error when required fields are empty
  ///
  /// In en, this message translates to:
  /// **'Missing fields'**
  String get missingFields;

  /// Status while request is in progress
  ///
  /// In en, this message translates to:
  /// **'Processing'**
  String get processing;

  /// Status when ready
  ///
  /// In en, this message translates to:
  /// **'Ready'**
  String get ready;

  /// New chat page title
  ///
  /// In en, this message translates to:
  /// **'New Chat'**
  String get newChat;

  /// Chat name field label
  ///
  /// In en, this message translates to:
  /// **'Chat Name'**
  String get chatName;

  /// Placeholder for optional fields
  ///
  /// In en, this message translates to:
  /// **'Optional'**
  String get optional;

  /// Create button label
  ///
  /// In en, this message translates to:
  /// **'Create'**
  String get create;

  /// Toast shown when chat is created
  ///
  /// In en, this message translates to:
  /// **'Chat created'**
  String get chatCreated;

  /// Placeholder when chat has no messages
  ///
  /// In en, this message translates to:
  /// **'No messages yet'**
  String get noMessagesYet;

  /// Group members page title
  ///
  /// In en, this message translates to:
  /// **'Group Members'**
  String get groupMembers;

  /// Group settings page title
  ///
  /// In en, this message translates to:
  /// **'Group Settings'**
  String get groupSettings;

  /// Group info action label for message search
  ///
  /// In en, this message translates to:
  /// **'Search'**
  String get messageSearchAction;

  /// Message search page title
  ///
  /// In en, this message translates to:
  /// **'Search'**
  String get messageSearchTitle;

  /// Placeholder for the message search field
  ///
  /// In en, this message translates to:
  /// **'Search messages'**
  String get messageSearchPlaceholder;

  /// Empty prompt before entering a message search query
  ///
  /// In en, this message translates to:
  /// **'Search messages in this chat'**
  String get messageSearchEmptyPrompt;

  /// Message shown when a search query is too short
  ///
  /// In en, this message translates to:
  /// **'Enter at least 2 characters'**
  String get messageSearchMinChars;

  /// Empty state when message search returns no results
  ///
  /// In en, this message translates to:
  /// **'No messages found'**
  String get messageSearchNoResults;

  /// Error state when message search request fails
  ///
  /// In en, this message translates to:
  /// **'Failed to search messages'**
  String get messageSearchFailed;

  /// Label shown on a search result that belongs to a thread
  ///
  /// In en, this message translates to:
  /// **'In thread'**
  String get messageSearchThreadContext;

  /// Button label for loading more message search results
  ///
  /// In en, this message translates to:
  /// **'Load More'**
  String get messageSearchLoadMore;

  /// Sort option for message search relevance ranking
  ///
  /// In en, this message translates to:
  /// **'Best'**
  String get messageSearchSortBest;

  /// Sort option for newest message search results first
  ///
  /// In en, this message translates to:
  /// **'Recent'**
  String get messageSearchSortRecent;

  /// Title for the message search sort picker
  ///
  /// In en, this message translates to:
  /// **'Sort messages'**
  String get messageSearchSortPickerTitle;

  /// Accessibility label for adding a message search filter
  ///
  /// In en, this message translates to:
  /// **'Add filter'**
  String get messageSearchAddFilter;

  /// Label for adding a sender filter in message search
  ///
  /// In en, this message translates to:
  /// **'From someone'**
  String get messageSearchFromFilter;

  /// Empty state shown when the reaction emoji picker has no recently used emoji
  ///
  /// In en, this message translates to:
  /// **'No Recents'**
  String get reactionPickerNoRecents;

  /// Placeholder when group has no members
  ///
  /// In en, this message translates to:
  /// **'No members'**
  String get noMembers;

  /// Retry button label
  ///
  /// In en, this message translates to:
  /// **'Retry'**
  String get retry;

  /// Language setting label
  ///
  /// In en, this message translates to:
  /// **'Language'**
  String get settingsLanguage;

  /// System language option
  ///
  /// In en, this message translates to:
  /// **'System'**
  String get languageSystem;

  /// English language option
  ///
  /// In en, this message translates to:
  /// **'English'**
  String get languageEnglish;

  /// Simplified Chinese language option
  ///
  /// In en, this message translates to:
  /// **'Simplified Chinese'**
  String get languageChineseCN;

  /// Traditional Chinese language option
  ///
  /// In en, this message translates to:
  /// **'Traditional Chinese'**
  String get languageChineseTW;

  /// Text size setting label
  ///
  /// In en, this message translates to:
  /// **'Text Size'**
  String get settingsTextSize;

  /// Unread badge color setting label and page title
  ///
  /// In en, this message translates to:
  /// **'Badge Color'**
  String get badgeColor;

  /// Header for the badge color preview section
  ///
  /// In en, this message translates to:
  /// **'Preview'**
  String get badgeColorPreview;

  /// Action to reset the unread badge color to the default
  ///
  /// In en, this message translates to:
  /// **'Reset to Default'**
  String get resetBadgeColor;

  /// Cache settings entry label
  ///
  /// In en, this message translates to:
  /// **'Cache'**
  String get settingsCache;

  /// Cache settings page title
  ///
  /// In en, this message translates to:
  /// **'Cache'**
  String get settingsCacheTitle;

  /// Header for the cache settings section
  ///
  /// In en, this message translates to:
  /// **'APP CACHE'**
  String get settingsCacheSectionHeader;

  /// Description of what the managed media cache contains
  ///
  /// In en, this message translates to:
  /// **'Includes managed cached media such as images, downloaded audio files, transcoded audio, and waveform data.'**
  String get settingsCacheDescription;

  /// Label for managed cache usage
  ///
  /// In en, this message translates to:
  /// **'Storage Used'**
  String get settingsCacheUsage;

  /// Clear cache action label
  ///
  /// In en, this message translates to:
  /// **'Clear Cache'**
  String get settingsClearCache;

  /// Confirmation dialog title for clearing cache
  ///
  /// In en, this message translates to:
  /// **'Clear cache?'**
  String get settingsClearCacheTitle;

  /// Confirmation dialog message for clearing cache
  ///
  /// In en, this message translates to:
  /// **'This removes cached media files and waveform data stored on this device.'**
  String get settingsClearCacheMessage;

  /// Chat settings section header
  ///
  /// In en, this message translates to:
  /// **'Chat'**
  String get settingsChat;

  /// Toggle to show or hide the All tab in chat list
  ///
  /// In en, this message translates to:
  /// **'Show \'All\' Tab'**
  String get settingsShowAllTab;

  /// General settings section header
  ///
  /// In en, this message translates to:
  /// **'General'**
  String get settingsGeneral;

  /// Appearance settings section header
  ///
  /// In en, this message translates to:
  /// **'Appearance'**
  String get settingsAppearance;

  /// Emojis and stickers settings entry label
  ///
  /// In en, this message translates to:
  /// **'Emojis & Stickers'**
  String get settingsEmojisAndStickers;

  /// User settings section header
  ///
  /// In en, this message translates to:
  /// **'User'**
  String get settingsUser;

  /// Profile setting label
  ///
  /// In en, this message translates to:
  /// **'Profile'**
  String get settingsProfile;

  /// Notifications setting label
  ///
  /// In en, this message translates to:
  /// **'Notifications'**
  String get settingsNotifications;

  /// Developer session settings entry label
  ///
  /// In en, this message translates to:
  /// **'Developer Session'**
  String get settingsDeveloperSession;

  /// Log out button label
  ///
  /// In en, this message translates to:
  /// **'Log Out'**
  String get logOut;

  /// Log out confirmation dialog title
  ///
  /// In en, this message translates to:
  /// **'Log out?'**
  String get logOutConfirmTitle;

  /// Log out confirmation dialog message
  ///
  /// In en, this message translates to:
  /// **'This will clear the login state saved on this device.'**
  String get logOutConfirmMessage;

  /// Cancel button label
  ///
  /// In en, this message translates to:
  /// **'Cancel'**
  String get cancel;

  /// OK button label
  ///
  /// In en, this message translates to:
  /// **'OK'**
  String get ok;

  /// Error dialog title
  ///
  /// In en, this message translates to:
  /// **'Error'**
  String get error;

  /// Close button label
  ///
  /// In en, this message translates to:
  /// **'Close'**
  String get close;

  /// Toast shown when text is copied
  ///
  /// In en, this message translates to:
  /// **'Copied'**
  String get copied;

  /// Composer placeholder for a text message
  ///
  /// In en, this message translates to:
  /// **'Message'**
  String get message;

  /// Attachment source label for capturing a photo with the camera
  ///
  /// In en, this message translates to:
  /// **'Camera'**
  String get camera;

  /// Attachment source label for choosing photos or videos from the library
  ///
  /// In en, this message translates to:
  /// **'Media'**
  String get media;

  /// Message action label for replying
  ///
  /// In en, this message translates to:
  /// **'Reply'**
  String get reply;

  /// Message action label for copying message text
  ///
  /// In en, this message translates to:
  /// **'Copy'**
  String get copyMessageAction;

  /// Message action label for editing
  ///
  /// In en, this message translates to:
  /// **'Edit'**
  String get edit;

  /// Message action label for deleting
  ///
  /// In en, this message translates to:
  /// **'Delete'**
  String get delete;

  /// Action label for deleting/recalling a chat message
  ///
  /// In en, this message translates to:
  /// **'Delete'**
  String get deleteMessageAction;

  /// Action label for discarding a failed local-only chat message
  ///
  /// In en, this message translates to:
  /// **'Delete Message'**
  String get deleteFailedMessageAction;

  /// Action sheet title for a failed local-only chat message
  ///
  /// In en, this message translates to:
  /// **'Message failed to send'**
  String get failedMessageActionsTitle;

  /// Delete confirmation title for a message
  ///
  /// In en, this message translates to:
  /// **'Delete message?'**
  String get deleteMessageTitle;

  /// Delete confirmation message for a message
  ///
  /// In en, this message translates to:
  /// **'This cannot be undone.'**
  String get deleteMessageBody;

  /// Chat list segment for all conversations
  ///
  /// In en, this message translates to:
  /// **'All'**
  String get all;

  /// Chat list segment for group chats
  ///
  /// In en, this message translates to:
  /// **'Groups'**
  String get groups;

  /// Chat list segment for threads
  ///
  /// In en, this message translates to:
  /// **'Threads'**
  String get threads;

  /// Thread detail page title
  ///
  /// In en, this message translates to:
  /// **'Thread'**
  String get thread;

  /// New thread detail page title
  ///
  /// In en, this message translates to:
  /// **'New Thread'**
  String get newThread;

  /// Message action label for starting a thread
  ///
  /// In en, this message translates to:
  /// **'Start Thread'**
  String get startThread;

  /// Message action label for pinning a message
  ///
  /// In en, this message translates to:
  /// **'Pin'**
  String get pinMessage;

  /// Confirmation dialog title for pinning a message
  ///
  /// In en, this message translates to:
  /// **'Pin message?'**
  String get pinMessageTitle;

  /// Confirmation dialog body for pinning a message
  ///
  /// In en, this message translates to:
  /// **'This pins it for everyone in the chat.'**
  String get pinMessageBody;

  /// Message action label for unpinning a message
  ///
  /// In en, this message translates to:
  /// **'Unpin'**
  String get unpinMessage;

  /// Confirmation dialog title for unpinning a pinned message
  ///
  /// In en, this message translates to:
  /// **'Unpin message?'**
  String get unpinMessageTitle;

  /// Confirmation dialog body for unpinning a pinned message
  ///
  /// In en, this message translates to:
  /// **'This removes it from pinned messages for everyone.'**
  String get unpinMessageBody;

  /// Title for the pinned messages list
  ///
  /// In en, this message translates to:
  /// **'Pinned Messages'**
  String get pinnedMessages;

  /// Instruction shown above a new thread composer
  ///
  /// In en, this message translates to:
  /// **'Reply to this message to start the thread.'**
  String get newThreadInstruction;

  /// Accessibility label for the thread detail bell action when the user is not subscribed
  ///
  /// In en, this message translates to:
  /// **'Subscribe to thread'**
  String get subscribeThreadAction;

  /// Accessibility label for the thread detail bell action when the thread is active
  ///
  /// In en, this message translates to:
  /// **'Archive thread'**
  String get archiveThreadAction;

  /// Accessibility label for the thread detail bell action when the thread is archived
  ///
  /// In en, this message translates to:
  /// **'Unarchive thread'**
  String get unarchiveThreadAction;

  /// Confirmation dialog title before unarchiving a thread from the detail page
  ///
  /// In en, this message translates to:
  /// **'Unarchive thread?'**
  String get unarchiveThreadTitle;

  /// Confirmation dialog message before unarchiving a thread from the detail page
  ///
  /// In en, this message translates to:
  /// **'This thread will move back to Threads. Continue?'**
  String get unarchiveThreadMessage;

  /// Empty state for the group chat list
  ///
  /// In en, this message translates to:
  /// **'No groups yet'**
  String get noGroupsYet;

  /// Empty state for the thread list
  ///
  /// In en, this message translates to:
  /// **'No threads yet'**
  String get noThreadsYet;

  /// Title and folder row label for archived threads
  ///
  /// In en, this message translates to:
  /// **'Archived threads'**
  String get archivedThreads;

  /// Empty state for the archived thread list
  ///
  /// In en, this message translates to:
  /// **'No archived threads'**
  String get noArchivedThreads;

  /// Empty state for the combined chat/thread list
  ///
  /// In en, this message translates to:
  /// **'No chats or threads yet'**
  String get noChatsOrThreadsYet;

  /// Fallback summary for a thread reply count
  ///
  /// In en, this message translates to:
  /// **'{count, plural, =1{1 reply} other{{count} replies}}'**
  String threadReplyCount(int count);

  /// Fallback display name for a chat when no name is available
  ///
  /// In en, this message translates to:
  /// **'Chat {id}'**
  String chatFallbackName(String id);

  /// Fallback display name for a user when no name is available
  ///
  /// In en, this message translates to:
  /// **'User {uid}'**
  String userFallbackName(int uid);

  /// Fallback label for an unknown user
  ///
  /// In en, this message translates to:
  /// **'Unknown'**
  String get unknownUser;

  /// Prefix shown before a draft message preview
  ///
  /// In en, this message translates to:
  /// **'[Draft]'**
  String get draftPrefix;

  /// Message preview label for a deleted message
  ///
  /// In en, this message translates to:
  /// **'[Deleted]'**
  String get previewDeleted;

  /// Message preview label for an invite message
  ///
  /// In en, this message translates to:
  /// **'[Invite]'**
  String get previewInvite;

  /// Message preview label for a sticker message
  ///
  /// In en, this message translates to:
  /// **'[Sticker]'**
  String get previewSticker;

  /// Message preview label for a voice message
  ///
  /// In en, this message translates to:
  /// **'[Voice message]'**
  String get previewVoiceMessage;

  /// Message preview label for an image attachment
  ///
  /// In en, this message translates to:
  /// **'[Image]'**
  String get previewImage;

  /// Message preview label for a video attachment
  ///
  /// In en, this message translates to:
  /// **'[Video]'**
  String get previewVideo;

  /// Message preview label for a generic attachment
  ///
  /// In en, this message translates to:
  /// **'[Attachment]'**
  String get previewAttachment;

  /// Status shown after saving an image attachment
  ///
  /// In en, this message translates to:
  /// **'Image saved to Photos.'**
  String get mediaImageSaved;

  /// Status shown after saving a video attachment
  ///
  /// In en, this message translates to:
  /// **'Video saved to Photos.'**
  String get mediaVideoSaved;

  /// Status shown when saving media fails
  ///
  /// In en, this message translates to:
  /// **'Failed to save media.'**
  String get mediaSaveFailed;

  /// Error shown when an image attachment cannot load
  ///
  /// In en, this message translates to:
  /// **'Failed to load image'**
  String get mediaImageLoadFailed;

  /// Error shown when a video attachment cannot load
  ///
  /// In en, this message translates to:
  /// **'Failed to load video'**
  String get mediaVideoLoadFailed;

  /// Label for an audio message
  ///
  /// In en, this message translates to:
  /// **'Voice message'**
  String get voiceMessage;

  /// Recorder hint shown while waiting for microphone access
  ///
  /// In en, this message translates to:
  /// **'Waiting for microphone…'**
  String get voiceWaitingForMicrophone;

  /// Recorder hint shown while holding the audio record button
  ///
  /// In en, this message translates to:
  /// **'Release to save'**
  String get voiceReleaseToSave;

  /// Recorder hint shown while recording audio
  ///
  /// In en, this message translates to:
  /// **'Slide left to cancel'**
  String get voiceSlideLeftToCancel;

  /// Recorder hint shown while uploading an audio message
  ///
  /// In en, this message translates to:
  /// **'Uploading {progress}%'**
  String voiceUploadingProgress(int progress);

  /// Error shown when audio recording is unsupported
  ///
  /// In en, this message translates to:
  /// **'Voice recording is not supported on this device.'**
  String get voiceRecordingUnsupported;

  /// Error shown when microphone permission is denied
  ///
  /// In en, this message translates to:
  /// **'Microphone permission is required to record audio.'**
  String get voiceMicrophonePermissionDenied;

  /// Error shown when an audio recording is below the minimum duration
  ///
  /// In en, this message translates to:
  /// **'Recording is too short.'**
  String get voiceRecordingTooShort;

  /// Error shown when audio recording cannot start
  ///
  /// In en, this message translates to:
  /// **'Failed to start recording.'**
  String get voiceRecordingStartFailed;

  /// Error shown when an audio message upload fails
  ///
  /// In en, this message translates to:
  /// **'Failed to upload voice message.'**
  String get voiceMessageUploadFailed;

  /// Error shown when an audio message send fails
  ///
  /// In en, this message translates to:
  /// **'Failed to send voice message.'**
  String get voiceMessageSendFailed;

  /// Accessibility label or action for deleting a recorded audio draft
  ///
  /// In en, this message translates to:
  /// **'Delete recording'**
  String get deleteRecording;

  /// Accessibility label or action for sending a recorded audio message
  ///
  /// In en, this message translates to:
  /// **'Send voice message'**
  String get sendVoiceMessage;

  /// Font size settings page title
  ///
  /// In en, this message translates to:
  /// **'Font Size'**
  String get fontSize;

  /// Messages font size label
  ///
  /// In en, this message translates to:
  /// **'Messages Font Size'**
  String get messagesFontSize;

  /// Example user name in font size preview
  ///
  /// In en, this message translates to:
  /// **'Sample User'**
  String get sampleUser;

  /// Font size preview sample message
  ///
  /// In en, this message translates to:
  /// **'This is how your messages will look in chat.'**
  String get fontSizePreviewMessage;

  /// Date separator label for today
  ///
  /// In en, this message translates to:
  /// **'Today'**
  String get dateToday;

  /// Date separator label for yesterday
  ///
  /// In en, this message translates to:
  /// **'Yesterday'**
  String get dateYesterday;

  /// Relative time in minutes (e.g. 5 minutes ago)
  ///
  /// In en, this message translates to:
  /// **'{count, plural, =1{1 minute ago} other{{count} minutes ago}}'**
  String relativeMinutes(int count);

  /// Relative time in hours (e.g. 3 hours ago)
  ///
  /// In en, this message translates to:
  /// **'{count, plural, =1{1 hour ago} other{{count} hours ago}}'**
  String relativeHours(int count);

  /// Swipe action label to mark a chat as read
  ///
  /// In en, this message translates to:
  /// **'Read'**
  String get swipeActionMarkRead;

  /// Swipe action label to mark a chat as unread
  ///
  /// In en, this message translates to:
  /// **'Unread'**
  String get swipeActionMarkUnread;

  /// Swipe action label to archive a thread
  ///
  /// In en, this message translates to:
  /// **'Archive'**
  String get swipeActionArchive;

  /// Swipe action label to unarchive a thread
  ///
  /// In en, this message translates to:
  /// **'Unarchive'**
  String get swipeActionUnarchive;

  /// Title shown when realtime websocket is reconnecting
  ///
  /// In en, this message translates to:
  /// **'Reconnecting...'**
  String get webSocketReconnectingTitle;

  /// Message shown when realtime websocket is reconnecting
  ///
  /// In en, this message translates to:
  /// **'Messages may be delayed.'**
  String get webSocketReconnectingMessage;

  /// Title shown while realtime websocket is connecting
  ///
  /// In en, this message translates to:
  /// **'Connecting...'**
  String get webSocketConnectingTitle;

  /// Message shown while realtime websocket is connecting
  ///
  /// In en, this message translates to:
  /// **'Realtime updates will resume shortly.'**
  String get webSocketConnectingMessage;

  /// Placeholder in the desktop split view when no chat is selected
  ///
  /// In en, this message translates to:
  /// **'Select a chat'**
  String get selectChatPlaceholder;
}

class _AppLocalizationsDelegate
    extends LocalizationsDelegate<AppLocalizations> {
  const _AppLocalizationsDelegate();

  @override
  Future<AppLocalizations> load(Locale locale) {
    return SynchronousFuture<AppLocalizations>(lookupAppLocalizations(locale));
  }

  @override
  bool isSupported(Locale locale) =>
      <String>['en', 'zh'].contains(locale.languageCode);

  @override
  bool shouldReload(_AppLocalizationsDelegate old) => false;
}

AppLocalizations lookupAppLocalizations(Locale locale) {
  // Lookup logic when language+country codes are specified.
  switch (locale.languageCode) {
    case 'zh':
      {
        switch (locale.countryCode) {
          case 'TW':
            return AppLocalizationsZhTw();
        }
        break;
      }
  }

  // Lookup logic when only language code is specified.
  switch (locale.languageCode) {
    case 'en':
      return AppLocalizationsEn();
    case 'zh':
      return AppLocalizationsZh();
  }

  throw FlutterError(
    'AppLocalizations.delegate failed to load unsupported locale "$locale". This is likely '
    'an issue with the localizations generation tool. Please file an issue '
    'on GitHub with a reproducible sample app and the gen-l10n configuration '
    'that was used.',
  );
}

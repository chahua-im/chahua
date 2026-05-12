import 'dart:ui' show ImageFilter;

import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:chahua/app/theme/style_config.dart';
import 'package:chahua/core/notifications/unread_badge_provider.dart';
import 'package:chahua/core/session/current_user_profile.dart';
import 'package:chahua/core/session/dev_session_store.dart';
import 'package:chahua/core/settings/app_settings_store.dart';
import 'package:chahua/features/shared/presentation/app_avatar.dart';
import 'package:chahua/l10n/app_localizations.dart';

import 'widgets/chat_list_segment.dart';
import '../application/all_list_v2_view_model.dart';
import '../application/chat_list_v2_scope.dart';
import '../application/group_list_v2_view_model.dart';
import '../application/thread_list_v2_view_model.dart';
import 'widgets/chat_list_v2_tab_body.dart';
import 'widgets/websocket_connection_banner.dart';

class ChatListV2Page extends ConsumerStatefulWidget {
  const ChatListV2Page({
    super.key,
    this.scope = ChatListV2Scope.active,
    this.embedded = false,
    this.selectedChatId,
    this.selectedThreadRootId,
    this.onOpenSettings,
  });

  final ChatListV2Scope scope;
  final bool embedded;
  final String? selectedChatId;
  final int? selectedThreadRootId;
  final VoidCallback? onOpenSettings;

  @override
  ConsumerState<ChatListV2Page> createState() => _ChatListV2PageState();
}

class _ChatListV2PageState extends ConsumerState<ChatListV2Page> {
  late final ScrollController _scrollController;
  ChatListTab? _activeTab;
  bool _isScrolledUnder = false;

  bool get _supportsPullToRefresh {
    if (kIsWeb) return false;
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
      case TargetPlatform.iOS:
        return true;
      case TargetPlatform.windows:
      case TargetPlatform.macOS:
      case TargetPlatform.linux:
      case TargetPlatform.fuchsia:
        return false;
    }
  }

  @override
  void initState() {
    super.initState();
    _scrollController = ScrollController()..addListener(_onScroll);
  }

  @override
  void dispose() {
    _scrollController.removeListener(_onScroll);
    _scrollController.dispose();
    super.dispose();
  }

  ChatListTab _effectiveTab(bool showAllTab) {
    final tab = _activeTab;
    if (tab == null) {
      return showAllTab ? ChatListTab.all : ChatListTab.groups;
    }
    if (!showAllTab && tab == ChatListTab.all) {
      return ChatListTab.groups;
    }
    return tab;
  }

  void _onScroll() {
    _updateScrolledUnder();

    final position = _scrollController.position;
    if (position.pixels < position.maxScrollExtent - 200) {
      return;
    }

    final settings = ref.read(appSettingsProvider);
    final activeTab = _effectiveTab(settings.showAllTab);
    if (activeTab == ChatListTab.groups) {
      final viewState = ref.read(groupListV2ViewModelProvider).value;
      if (viewState == null || !viewState.hasMore || viewState.isLoadingMore) {
        return;
      }
      ref.read(groupListV2ViewModelProvider.notifier).loadMoreGroups();
      return;
    }

    if (activeTab == ChatListTab.threads) {
      final provider = _threadListProviderForScope(widget.scope);
      final threadState = ref.read(provider).value;
      if (threadState == null ||
          !threadState.hasMore ||
          threadState.isLoadingMore) {
        return;
      }
      ref.read(provider.notifier).loadMoreThreads();
      return;
    }

    if (activeTab == ChatListTab.all) {
      final allState = ref.read(allListV2ViewModelProvider);
      if (allState.isLoadingMore) {
        return;
      }
      ref.read(allListV2ViewModelProvider.notifier).loadMoreAll();
    }
  }

  void _updateScrolledUnder() {
    final isScrolledUnder =
        _scrollController.hasClients && _scrollController.offset > 0;
    if (_isScrolledUnder == isScrolledUnder) {
      return;
    }
    setState(() => _isScrolledUnder = isScrolledUnder);
  }

  Future<void> _refreshActiveTab(ChatListTab activeTab) {
    return switch (activeTab) {
      ChatListTab.groups =>
        ref.read(groupListV2ViewModelProvider.notifier).refreshGroups(),
      ChatListTab.threads =>
        ref
            .read(_threadListProviderForScope(widget.scope).notifier)
            .refreshThreads(),
      ChatListTab.all =>
        ref.read(allListV2ViewModelProvider.notifier).refreshAll(),
    };
  }

  AsyncNotifierProvider<ThreadListV2ViewModel, ThreadListV2ViewState>
  _threadListProviderForScope(ChatListV2Scope scope) {
    return switch (scope) {
      ChatListV2Scope.active => activeThreadListV2ViewModelProvider,
      ChatListV2Scope.archived => archivedThreadListV2ViewModelProvider,
    };
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final settings = ref.watch(appSettingsProvider);
    final showAllTab = settings.showAllTab;
    final activeTab = _effectiveTab(showAllTab);

    final unreadState = ref.watch(unreadBadgeProvider);

    final groupsUnread = unreadState.chatUnreadTotal;
    final threadsUnread = unreadState.threadUnreadTotal;
    final allUnread = unreadState.combinedUnreadTotal;
    final chromeBackgroundColor = _isScrolledUnder
        ? CupertinoTheme.of(context).barBackgroundColor
        : CupertinoColors.systemBackground;
    final title = switch (widget.scope) {
      ChatListV2Scope.active => l10n.tabChats,
      ChatListV2Scope.archived => l10n.archived,
    };

    final scrollView = CustomScrollView(
      controller: _scrollController,
      physics: _supportsPullToRefresh
          ? const AlwaysScrollableScrollPhysics(parent: BouncingScrollPhysics())
          : const AlwaysScrollableScrollPhysics(),
      slivers: [
        SliverPersistentHeader(
          pinned: true,
          delegate: _ChatListSegmentHeaderDelegate(
            activeTab: activeTab,
            showAllTab: showAllTab,
            isScrolledUnder: _isScrolledUnder,
            allUnreadCount: allUnread,
            groupsUnreadCount: groupsUnread,
            threadsUnreadCount: threadsUnread,
            onTabChanged: (tab) => setState(() => _activeTab = tab),
          ),
        ),
        if (_supportsPullToRefresh)
          CupertinoSliverRefreshControl(
            onRefresh: () => _refreshActiveTab(activeTab),
          ),
        const WebSocketConnectionBannerSliver(),
        ChatListV2TabBody(
          scope: widget.scope,
          activeTab: activeTab,
          selectedChatId: widget.selectedChatId,
          selectedThreadRootId: widget.selectedThreadRootId,
        ),
      ],
    );

    if (widget.embedded) {
      return ColoredBox(
        color: context.appColors.backgroundPrimary,
        child: Column(
          children: [
            CupertinoNavigationBar(
              backgroundColor: chromeBackgroundColor,
              leading: widget.onOpenSettings == null
                  ? null
                  : _CurrentUserSettingsButton(
                      semanticLabel: l10n.tabSettings,
                      onPressed: widget.onOpenSettings!,
                    ),
              middle: Text(title),
            ),
            Expanded(
              child: SafeArea(top: false, bottom: false, child: scrollView),
            ),
          ],
        ),
      );
    }

    return CupertinoPageScaffold(
      navigationBar: CupertinoNavigationBar(
        backgroundColor: chromeBackgroundColor,
        middle: Text(title),
      ),
      child: SafeArea(bottom: false, child: scrollView),
    );
  }
}

class _CurrentUserSettingsButton extends ConsumerWidget {
  const _CurrentUserSettingsButton({
    required this.semanticLabel,
    required this.onPressed,
  });

  final String semanticLabel;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(authSessionProvider);
    final profile = ref
        .watch(currentUserProfileProvider)
        .maybeWhen(data: (profile) => profile, orElse: () => null);
    final fallbackName = profile?.username ?? session.currentUserId.toString();

    return CupertinoButton(
      padding: EdgeInsets.zero,
      minimumSize: const Size.square(44),
      onPressed: onPressed,
      child: Semantics(
        label: semanticLabel,
        button: true,
        child: AppAvatar(
          name: fallbackName,
          imageUrl: profile?.avatarUrl,
          size: 30,
          memCacheWidth: 60,
        ),
      ),
    );
  }
}

class _ChatListSegmentHeaderDelegate extends SliverPersistentHeaderDelegate {
  _ChatListSegmentHeaderDelegate({
    required this.activeTab,
    required this.showAllTab,
    required this.isScrolledUnder,
    required this.allUnreadCount,
    required this.groupsUnreadCount,
    required this.threadsUnreadCount,
    required this.onTabChanged,
  });

  static const double _extent = 48;

  final ChatListTab activeTab;
  final bool showAllTab;
  final bool isScrolledUnder;
  final int allUnreadCount;
  final int groupsUnreadCount;
  final int threadsUnreadCount;
  final ValueChanged<ChatListTab> onTabChanged;

  @override
  double get minExtent => _extent;

  @override
  double get maxExtent => _extent;

  @override
  Widget build(
    BuildContext context,
    double shrinkOffset,
    bool overlapsContent,
  ) {
    final backgroundColor = isScrolledUnder
        ? CupertinoTheme.of(context).barBackgroundColor
        : CupertinoColors.systemBackground;
    final resolvedBackgroundColor = CupertinoDynamicColor.resolve(
      backgroundColor,
      context,
    );

    return ClipRect(
      child: BackdropFilter(
        enabled: resolvedBackgroundColor.a < 1,
        filter: ImageFilter.blur(sigmaX: 10, sigmaY: 10),
        child: ColoredBox(
          color: resolvedBackgroundColor,
          child: SizedBox.expand(
            child: ChatListSegment(
              activeTab: activeTab,
              showAllTab: showAllTab,
              allUnreadCount: allUnreadCount,
              groupsUnreadCount: groupsUnreadCount,
              threadsUnreadCount: threadsUnreadCount,
              onTabChanged: onTabChanged,
            ),
          ),
        ),
      ),
    );
  }

  @override
  bool shouldRebuild(covariant _ChatListSegmentHeaderDelegate oldDelegate) {
    return activeTab != oldDelegate.activeTab ||
        showAllTab != oldDelegate.showAllTab ||
        isScrolledUnder != oldDelegate.isScrolledUnder ||
        allUnreadCount != oldDelegate.allUnreadCount ||
        groupsUnreadCount != oldDelegate.groupsUnreadCount ||
        threadsUnreadCount != oldDelegate.threadsUnreadCount ||
        onTabChanged != oldDelegate.onTabChanged;
  }
}

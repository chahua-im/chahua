import 'package:chahua/features/chat_list/presentation/chat_list_v2_page.dart';
import 'package:chahua/features/chat_list/presentation/chat_workspace_shell.dart';
import 'package:chahua/features/chat_list/presentation/archived_thread_list_v2_page.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:chahua/app/presentation/home_root_view.dart';
import 'package:chahua/app/routing/route_names.dart';
import 'package:chahua/core/session/dev_session_store.dart';
import 'package:chahua/features/auth/presentation/auth_bootstrap_view.dart';
import 'package:chahua/features/auth/presentation/auth_login_view.dart';
import 'package:chahua/features/conversation/shared/domain/launch_request.dart';
import 'package:chahua/features/conversation/media/presentation/attachment_viewer_page.dart';
import 'package:chahua/features/conversation/media/presentation/attachment_viewer_request.dart';
import 'package:chahua/features/conversation/shared/presentation/chat_detail_v2_view.dart';
import 'package:chahua/features/conversation/shared/presentation/thread_detail_v2_view.dart';
import 'package:chahua/features/groups/members/presentation/group_members_view.dart';
import 'package:chahua/features/groups/settings/presentation/group_settings_view.dart';
import 'package:chahua/features/conversation/search/presentation/message_search_page.dart';
import 'package:chahua/features/settings/presentation/appearance/appearance_settings_view.dart';
import 'package:chahua/features/settings/presentation/appearance/badge_color_settings_view.dart';
import 'package:chahua/features/settings/presentation/appearance/font_size_settings_view.dart';
import 'package:chahua/features/settings/presentation/developer/dev_session_settings_view.dart';
import 'package:chahua/features/settings/presentation/general/cache_settings_view.dart';
import 'package:chahua/features/settings/presentation/general/general_settings_view.dart';
import 'package:chahua/features/settings/presentation/general/language_settings_view.dart';
import 'package:chahua/features/settings/presentation/notifications/notification_settings_view.dart';
import 'package:chahua/features/settings/presentation/settings_modal_page.dart';
import 'package:chahua/features/settings/presentation/settings_page.dart';
import 'package:chahua/features/stickers/presentation/sticker_pack_detail_page.dart';
import 'package:chahua/features/stickers/presentation/sticker_pack_list_page.dart';

final GlobalKey<NavigatorState> _rootNavigatorKey = GlobalKey<NavigatorState>(
  debugLabel: 'root',
);
final GlobalKey<NavigatorState> _chatsBranchNavigatorKey =
    GlobalKey<NavigatorState>(debugLabel: 'chats-branch');
final GlobalKey<NavigatorState> _settingsBranchNavigatorKey =
    GlobalKey<NavigatorState>(debugLabel: 'settings-branch');

final appRouterProvider = Provider<GoRouter>((ref) {
  final sessionNotifier = ValueNotifier(ref.read(authSessionProvider));
  ref.listen<AuthSessionState>(authSessionProvider, (_, next) {
    sessionNotifier.value = next;
  });
  ref.onDispose(() => sessionNotifier.dispose());

  return GoRouter(
    navigatorKey: _rootNavigatorKey,
    initialLocation: AppRoutes.bootstrap,
    refreshListenable: sessionNotifier,
    redirect: (context, state) {
      final session = ref.read(authSessionProvider);
      final location = state.matchedLocation;
      final isBootstrap = location == AppRoutes.bootstrap;
      final isLogin = location == AppRoutes.login;

      if (session.isBootstrapping) {
        return isBootstrap ? null : AppRoutes.bootstrap;
      }
      if (!session.isAuthenticated) {
        return isLogin ? null : AppRoutes.login;
      }
      if (isBootstrap || isLogin) {
        return AppRoutes.chats;
      }
      return null;
    },
    routes: [
      GoRoute(
        path: AppRoutes.bootstrap,
        pageBuilder: (context, state) =>
            CupertinoPage(key: state.pageKey, child: const AuthBootstrapPage()),
      ),
      GoRoute(
        path: AppRoutes.login,
        pageBuilder: (context, state) =>
            CupertinoPage(key: state.pageKey, child: const AuthLoginPage()),
      ),
      // Full-screen routes outside the shell (no bottom nav, swipe-back enabled).
      GoRoute(
        path: '/attachment-viewer',
        pageBuilder: (context, state) {
          final request = state.extra! as AttachmentViewerRequest;
          return CustomTransitionPage<void>(
            key: state.pageKey,
            transitionDuration: const Duration(milliseconds: 200),
            reverseTransitionDuration: const Duration(milliseconds: 180),
            transitionsBuilder:
                (context, animation, secondaryAnimation, child) {
                  return FadeTransition(opacity: animation, child: child);
                },
            child: AttachmentViewerPage(request: request),
          );
        },
      ),
      GoRoute(
        path: '${AppRoutes.stickerPackDetailRoot}/:packId',
        pageBuilder: (context, state) {
          final packId = state.pathParameters['packId']!;
          return CupertinoPage(
            key: state.pageKey,
            child: StickerPackDetailPage(packId: packId),
          );
        },
      ),
      GoRoute(
        path: AppRoutes.splitSettingsModal,
        pageBuilder: (context, state) {
          return CustomTransitionPage<void>(
            key: state.pageKey,
            opaque: false,
            barrierDismissible: true,
            barrierColor: CupertinoColors.black.withAlpha(76),
            transitionDuration: const Duration(milliseconds: 180),
            reverseTransitionDuration: const Duration(milliseconds: 140),
            transitionsBuilder:
                (context, animation, secondaryAnimation, child) {
                  final curved = CurvedAnimation(
                    parent: animation,
                    curve: Curves.easeOutCubic,
                    reverseCurve: Curves.easeInCubic,
                  );
                  return FadeTransition(
                    opacity: curved,
                    child: ScaleTransition(
                      scale: Tween<double>(begin: 0.98, end: 1).animate(curved),
                      child: child,
                    ),
                  );
                },
            child: const SettingsModalPage(),
          );
        },
      ),
      StatefulShellRoute.indexedStack(
        builder: (context, state, navigationShell) => HomeShell(
          navigationShell: navigationShell,
          location: state.uri.toString(),
        ),
        branches: [
          // ── Branch 0: Chats ──
          StatefulShellBranch(
            navigatorKey: _chatsBranchNavigatorKey,
            routes: [
              ShellRoute(
                builder: (context, state, child) => ChatWorkspaceShell(
                  location: state.uri.toString(),
                  child: child,
                ),
                routes: [
                  GoRoute(
                    path: AppRoutes.chats,
                    pageBuilder: (context, state) => CupertinoPage(
                      key: state.pageKey,
                      child: const ChatListV2Page(),
                    ),
                    routes: [
                      GoRoute(
                        path: 'chat/:chatId',
                        pageBuilder: (context, state) {
                          final chatId = int.parse(
                            state.pathParameters['chatId']!,
                          );
                          final extra = state.extra as Map<String, dynamic>?;
                          return _chatWorkspacePage(
                            key: ValueKey("chat/$chatId"),
                            disableTransition: _disableTransition(state),
                            child: ChatDetailV2Page(
                              chatId: chatId,
                              launchRequest:
                                  extra?['launchRequest'] as LaunchRequest? ??
                                  const LaunchRequest.latest(),
                            ),
                          );
                        },
                        routes: [
                          GoRoute(
                            parentNavigatorKey: _rootNavigatorKey,
                            path: 'members',
                            pageBuilder: (context, state) {
                              final chatId = state.pathParameters['chatId']!;
                              return CupertinoPage(
                                key: state.pageKey,
                                child: GroupMembersPage(chatId: chatId),
                              );
                            },
                          ),
                          GoRoute(
                            parentNavigatorKey: _rootNavigatorKey,
                            path: 'settings',
                            pageBuilder: (context, state) {
                              final chatId = state.pathParameters['chatId']!;
                              return CupertinoPage(
                                key: state.pageKey,
                                child: GroupSettingsPage(chatId: chatId),
                              );
                            },
                            routes: [
                              GoRoute(
                                parentNavigatorKey: _rootNavigatorKey,
                                path: 'search',
                                pageBuilder: (context, state) {
                                  final chatId = int.parse(
                                    state.pathParameters['chatId']!,
                                  );
                                  return CupertinoPage(
                                    key: state.pageKey,
                                    child: MessageSearchPage(chatId: chatId),
                                  );
                                },
                              ),
                            ],
                          ),
                          GoRoute(
                            path: 'thread/:threadId/new',
                            pageBuilder: (context, state) {
                              final chatId = int.parse(
                                state.pathParameters['chatId']!,
                              );
                              final threadId = int.parse(
                                state.pathParameters['threadId']!,
                              );
                              final extra =
                                  state.extra as Map<String, dynamic>?;
                              return CupertinoPage(
                                key: ValueKey("thread/$threadId/new"),
                                child: ThreadDetailV2Page(
                                  chatId: chatId,
                                  threadRootId: threadId,
                                  launchRequest:
                                      extra?['launchRequest']
                                          as LaunchRequest? ??
                                      const LaunchRequest.latest(),
                                  isNewThread: true,
                                  implyLeadingInSplit: true,
                                ),
                              );
                            },
                          ),
                          GoRoute(
                            path: 'thread/:threadId',
                            pageBuilder: (context, state) {
                              final chatId = int.parse(
                                state.pathParameters['chatId']!,
                              );
                              final threadId = int.parse(
                                state.pathParameters['threadId']!,
                              );
                              final extra =
                                  state.extra as Map<String, dynamic>?;
                              return CupertinoPage(
                                key: ValueKey("thread/$threadId"),
                                child: ThreadDetailV2Page(
                                  chatId: chatId,
                                  threadRootId: threadId,
                                  launchRequest:
                                      extra?['launchRequest']
                                          as LaunchRequest? ??
                                      const LaunchRequest.latest(),
                                  implyLeadingInSplit: true,
                                ),
                              );
                            },
                          ),
                        ],
                      ),
                      GoRoute(
                        path: 'threads/archived',
                        pageBuilder: (context, state) => _chatWorkspacePage(
                          key: const ValueKey('threads/archived'),
                          disableTransition: _disableTransition(state),
                          child: const ArchivedThreadListV2Page(),
                        ),
                      ),
                      GoRoute(
                        path: 'thread/:chatId/:threadId',
                        pageBuilder: (context, state) {
                          final chatId = int.parse(
                            state.pathParameters['chatId']!,
                          );
                          final threadId = int.parse(
                            state.pathParameters['threadId']!,
                          );
                          final extra = state.extra as Map<String, dynamic>?;
                          return _chatWorkspacePage(
                            key: ValueKey("thread/$chatId/$threadId"),
                            disableTransition: _disableTransition(state),
                            child: ThreadDetailV2Page(
                              chatId: chatId,
                              threadRootId: threadId,
                              launchRequest:
                                  extra?['launchRequest'] as LaunchRequest? ??
                                  const LaunchRequest.latest(),
                            ),
                          );
                        },
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),

          // ── Branch 1: Settings ──
          StatefulShellBranch(
            navigatorKey: _settingsBranchNavigatorKey,
            routes: [
              GoRoute(
                path: '/settings',
                pageBuilder: (context, state) => CupertinoPage(
                  key: state.pageKey,
                  child: const SettingsPage(),
                ),
                routes: [
                  GoRoute(
                    path: 'general',
                    pageBuilder: (context, state) => CupertinoPage(
                      key: state.pageKey,
                      child: const GeneralSettingsPage(),
                    ),
                    routes: [
                      GoRoute(
                        path: 'language',
                        pageBuilder: (context, state) => CupertinoPage(
                          key: state.pageKey,
                          child: const LanguageSettingsPage(),
                        ),
                      ),
                      GoRoute(
                        path: 'cache',
                        pageBuilder: (context, state) => CupertinoPage(
                          key: state.pageKey,
                          child: const CacheSettingsPage(),
                        ),
                      ),
                    ],
                  ),
                  GoRoute(
                    path: 'appearance',
                    pageBuilder: (context, state) => CupertinoPage(
                      key: state.pageKey,
                      child: const AppearanceSettingsPage(),
                    ),
                    routes: [
                      GoRoute(
                        path: 'text-size',
                        pageBuilder: (context, state) => CupertinoPage(
                          key: state.pageKey,
                          child: const FontSizeSettingsPage(),
                        ),
                      ),
                      GoRoute(
                        path: 'badge-color',
                        pageBuilder: (context, state) => CupertinoPage(
                          key: state.pageKey,
                          child: const BadgeColorSettingsPage(),
                        ),
                      ),
                    ],
                  ),
                  GoRoute(
                    path: 'language',
                    redirect: (_, _) => AppRoutes.language,
                  ),
                  GoRoute(
                    path: 'font-size',
                    redirect: (_, _) => AppRoutes.fontSize,
                  ),
                  GoRoute(path: 'cache', redirect: (_, _) => AppRoutes.cache),
                  GoRoute(
                    path: 'dev-session',
                    redirect: (_, _) => AppRoutes.devSession,
                  ),
                  GoRoute(
                    path: 'sticker-packs/:packId',
                    redirect: (_, state) => AppRoutes.settingsStickerPackDetail(
                      state.pathParameters['packId']!,
                    ),
                  ),
                  GoRoute(
                    path: 'sticker-packs',
                    redirect: (_, _) => AppRoutes.stickerPacks,
                  ),
                  GoRoute(
                    path: 'profile',
                    redirect: (_, _) => AppRoutes.settings,
                  ),
                  GoRoute(
                    path: 'developer-session',
                    pageBuilder: (context, state) => CupertinoPage(
                      key: state.pageKey,
                      child: const DevSessionSettingsPage(),
                    ),
                  ),
                  GoRoute(
                    path: 'notifications',
                    pageBuilder: (context, state) => CupertinoPage(
                      key: state.pageKey,
                      child: const NotificationSettingsPage(),
                    ),
                  ),
                  GoRoute(
                    path: 'stickers',
                    pageBuilder: (context, state) => CupertinoPage(
                      key: state.pageKey,
                      child: const StickerPackListPage(),
                    ),
                    routes: [
                      GoRoute(
                        path: ':packId',
                        pageBuilder: (context, state) {
                          final packId = state.pathParameters['packId']!;
                          return CupertinoPage(
                            key: state.pageKey,
                            child: StickerPackDetailPage(packId: packId),
                          );
                        },
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  );
});

Page<void> _chatWorkspacePage({
  required LocalKey key,
  required Widget child,
  required bool disableTransition,
}) {
  if (disableTransition) {
    return NoTransitionPage<void>(key: key, child: child);
  }
  return CupertinoPage<void>(key: key, child: child);
}

bool _disableTransition(GoRouterState state) {
  final extra = state.extra;
  return extra is Map<String, dynamic> && extra['disableTransition'] == true;
}

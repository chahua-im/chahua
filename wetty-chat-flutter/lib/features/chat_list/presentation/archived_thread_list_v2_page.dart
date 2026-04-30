import 'package:chahua/app/routing/route_names.dart';
import 'package:chahua/app/theme/style_config.dart';
import 'package:chahua/l10n/app_localizations.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../application/thread_list_v2_view_model.dart';
import '../model/thread_list_item.dart';
import 'chat_workspace_layout_scope.dart';
import 'widgets/thread_list_row.dart';

class ArchivedThreadListV2Page extends ConsumerStatefulWidget {
  const ArchivedThreadListV2Page({super.key});

  @override
  ConsumerState<ArchivedThreadListV2Page> createState() =>
      _ArchivedThreadListV2PageState();
}

class _ArchivedThreadListV2PageState
    extends ConsumerState<ArchivedThreadListV2Page> {
  late final ScrollController _scrollController;
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

  void _onScroll() {
    _updateScrolledUnder();

    final position = _scrollController.position;
    if (position.pixels < position.maxScrollExtent - 200) {
      return;
    }

    final viewState = ref.read(archivedThreadListV2ViewModelProvider).value;
    if (viewState == null || !viewState.hasMore || viewState.isLoadingMore) {
      return;
    }
    ref.read(archivedThreadListV2ViewModelProvider.notifier).loadMoreThreads();
  }

  void _updateScrolledUnder() {
    final isScrolledUnder =
        _scrollController.hasClients && _scrollController.offset > 0;
    if (_isScrolledUnder == isScrolledUnder) {
      return;
    }
    setState(() => _isScrolledUnder = isScrolledUnder);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final chromeBackgroundColor = _isScrolledUnder
        ? CupertinoTheme.of(context).barBackgroundColor
        : CupertinoColors.systemBackground;

    return CupertinoPageScaffold(
      navigationBar: CupertinoNavigationBar(
        backgroundColor: chromeBackgroundColor,
        middle: Text(l10n.archivedThreads),
      ),
      child: SafeArea(
        bottom: false,
        child: CustomScrollView(
          controller: _scrollController,
          physics: _supportsPullToRefresh
              ? const AlwaysScrollableScrollPhysics(
                  parent: BouncingScrollPhysics(),
                )
              : const AlwaysScrollableScrollPhysics(),
          slivers: [
            if (_supportsPullToRefresh)
              CupertinoSliverRefreshControl(
                onRefresh: () => ref
                    .read(archivedThreadListV2ViewModelProvider.notifier)
                    .refreshThreads(),
              ),
            const _ArchivedThreadListSliver(),
          ],
        ),
      ),
    );
  }
}

class _ArchivedThreadListSliver extends ConsumerWidget {
  const _ArchivedThreadListSliver();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final asyncState = ref.watch(archivedThreadListV2ViewModelProvider);

    return asyncState.when(
      loading: () => const SliverFillRemaining(
        hasScrollBody: false,
        child: Center(child: CupertinoActivityIndicator()),
      ),
      error: (error, _) => SliverFillRemaining(
        hasScrollBody: false,
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text(error.toString(), textAlign: TextAlign.center),
              const SizedBox(height: 16),
              CupertinoButton.filled(
                onPressed: () =>
                    ref.invalidate(archivedThreadListV2ViewModelProvider),
                child: Text(l10n.retry),
              ),
            ],
          ),
        ),
      ),
      data: (viewState) {
        if (viewState.errorMessage != null && viewState.threads.isEmpty) {
          return SliverFillRemaining(
            hasScrollBody: false,
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(viewState.errorMessage!, textAlign: TextAlign.center),
                  const SizedBox(height: 16),
                  CupertinoButton.filled(
                    onPressed: () =>
                        ref.invalidate(archivedThreadListV2ViewModelProvider),
                    child: Text(l10n.retry),
                  ),
                ],
              ),
            ),
          );
        }

        if (viewState.threads.isEmpty) {
          return SliverFillRemaining(
            hasScrollBody: false,
            child: Center(
              child: Text(
                l10n.noArchivedThreads,
                style: appSecondaryTextStyle(context),
              ),
            ),
          );
        }

        return SliverMainAxisGroup(
          slivers: [
            SliverList.builder(
              itemCount: viewState.threads.length,
              itemBuilder: (context, index) {
                return _ArchivedThreadListRow(thread: viewState.threads[index]);
              },
            ),
            if (viewState.isLoadingMore)
              const SliverToBoxAdapter(
                child: Padding(
                  padding: EdgeInsets.symmetric(vertical: 16),
                  child: Center(child: CupertinoActivityIndicator()),
                ),
              ),
          ],
        );
      },
    );
  }
}

class _ArchivedThreadListRow extends StatelessWidget {
  const _ArchivedThreadListRow({required this.thread});

  final ThreadListItem thread;

  @override
  Widget build(BuildContext context) {
    return ThreadListRow(
      thread: thread,
      onTap: () {
        context.go(
          AppRoutes.threadDetail(thread.chatId, thread.threadRootId.toString()),
          extra: {
            'disableTransition': ChatWorkspaceLayoutScope.isSplitLayout(
              context,
            ),
          },
        );
      },
    );
  }
}

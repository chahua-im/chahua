import 'package:chahua/core/feature_gates/feature_gates.dart';
import 'package:chahua/core/api/models/messages_api_models.dart';
import 'package:chahua/features/conversation/search/data/message_search_api_service.dart';
import 'package:chahua/features/conversation/search/presentation/message_search_page.dart';
import 'package:chahua/features/conversation/search/domain/message_search_sort.dart';
import 'package:chahua/features/groups/members/data/group_member_api_service.dart';
import 'package:chahua/features/groups/members/data/group_member_models.dart';
import 'package:chahua/features/groups/members/data/group_member_repository.dart';
import 'package:chahua/l10n/app_localizations.dart';
import 'package:dio/dio.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

void main() {
  group('MessageSearchPage controls', () {
    testWidgets('shows compact sort control and opens the sort picker', (
      tester,
    ) async {
      await _pumpPage(tester, inlineTagsEnabled: false);

      expect(find.text('Best'), findsOneWidget);

      await tester.tap(find.text('Best'));
      await tester.pumpAndSettle();

      expect(find.text('Sort messages'), findsOneWidget);
      expect(find.text('Recent'), findsOneWidget);
    });

    testWidgets('selecting recent reruns the active query with recent sort', (
      tester,
    ) async {
      final searchApi = _FakeMessageSearchApiService();
      await _pumpPage(tester, inlineTagsEnabled: false, searchApi: searchApi);

      await tester.enterText(find.byType(CupertinoTextField), 'hello');
      await tester.pump(const Duration(milliseconds: 350));
      await tester.pump();

      expect(searchApi.requests, [
        (query: 'hello', sort: MessageSearchSort.best, offset: 0),
      ]);

      await tester.tap(find.text('Best'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Recent'));
      await tester.pumpAndSettle();

      expect(searchApi.requests, [
        (query: 'hello', sort: MessageSearchSort.best, offset: 0),
        (query: 'hello', sort: MessageSearchSort.recent, offset: 0),
      ]);
      expect(find.text('Recent'), findsOneWidget);
    });

    testWidgets('hides inline tag affordance when the gate is disabled', (
      tester,
    ) async {
      await _pumpPage(tester, inlineTagsEnabled: false);

      expect(find.byIcon(CupertinoIcons.plus), findsNothing);
    });

    testWidgets('shows inline tag affordance when the gate is enabled', (
      tester,
    ) async {
      await _pumpPage(tester, inlineTagsEnabled: true);

      expect(find.byIcon(CupertinoIcons.plus), findsOneWidget);
    });

    testWidgets('adds a from tag through the filter button path', (
      tester,
    ) async {
      final members = _FakeGroupMemberRepository([
        const GroupMember(uid: 7, username: 'Alice', role: 'member'),
      ]);
      await _pumpPage(
        tester,
        inlineTagsEnabled: true,
        memberRepository: members,
      );

      await tester.tap(find.byIcon(CupertinoIcons.plus));
      await tester.pump();
      await tester.pump();

      expect(find.text('Alice'), findsOneWidget);

      await tester.tap(find.text('Alice'));
      await tester.pump();

      expect(find.text('from: Alice'), findsOneWidget);
      expect(members.queries, ['']);
    });

    testWidgets('adds a from tag from typed inline syntax', (tester) async {
      final members = _FakeGroupMemberRepository([
        const GroupMember(uid: 7, username: 'Alice', role: 'member'),
      ]);
      await _pumpPage(
        tester,
        inlineTagsEnabled: true,
        memberRepository: members,
      );

      await tester.enterText(find.byType(CupertinoTextField), 'from:@al');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump();

      expect(find.text('Alice'), findsOneWidget);

      await tester.tap(find.text('Alice'));
      await tester.pump();

      expect(find.text('from: Alice'), findsOneWidget);
      expect(members.queries, ['al']);
    });
  });
}

Future<void> _pumpPage(
  WidgetTester tester, {
  required bool inlineTagsEnabled,
  GroupMemberRepository? memberRepository,
  _FakeMessageSearchApiService? searchApi,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        featureGateConfigProvider.overrideWithValue(
          FeatureGateConfig(
            overrides: {
              AppFeatureGate.messageSearchInlineTags: inlineTagsEnabled,
            },
          ),
        ),
        if (memberRepository != null)
          groupMemberRepositoryProvider.overrideWithValue(memberRepository),
        messageSearchApiServiceProvider.overrideWithValue(
          searchApi ?? _FakeMessageSearchApiService(),
        ),
      ],
      child: const CupertinoApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: MessageSearchPage(chatId: 42),
      ),
    ),
  );
}

class _FakeMessageSearchApiService extends MessageSearchApiService {
  _FakeMessageSearchApiService() : super(Dio());

  final List<({String query, MessageSearchSort sort, int offset})> requests =
      [];

  @override
  Future<SearchMessagesResponseDto> searchMessages(
    int chatId, {
    required String query,
    MessageSearchSort sort = MessageSearchSort.best,
    int limit = 20,
    int offset = 0,
  }) async {
    requests.add((query: query, sort: sort, offset: offset));
    return const SearchMessagesResponseDto();
  }
}

class _FakeGroupMemberRepository extends GroupMemberRepository {
  _FakeGroupMemberRepository(this.members)
    : super(GroupMemberApiService(Dio()));

  final List<GroupMember> members;
  final List<String> queries = [];

  @override
  Future<GroupMembersPage> fetchMembers(
    String chatId, {
    int limit = 50,
    int? after,
    String? query,
    GroupMemberSearchMode? searchMode,
  }) async {
    queries.add(query ?? '');
    return GroupMembersPage(members: members.take(limit).toList());
  }
}

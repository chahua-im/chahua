import 'dart:async';

import 'package:chahua/core/api/models/messages_api_models.dart';
import 'package:chahua/core/session/current_user_profile.dart';
import 'package:chahua/core/session/dev_session_store.dart';
import 'package:chahua/features/audio/application/audio_waveform_cache_service.dart';
import 'package:chahua/features/conversation/compose/application/audio_recorder_service.dart';
import 'package:chahua/features/conversation/compose/data/message_api_service_v2.dart';
import 'package:chahua/features/conversation/compose/presentation/conversation_composer_view_model.dart';
import 'package:chahua/features/conversation/shared/application/conversation_canonical_message_store.dart';
import 'package:chahua/features/conversation/shared/domain/conversation_identity.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('optimistic text send uses current user profile sender', () async {
    final api = _FakeMessageApiService(completeSends: false);
    final container = _container(
      api: api,
      profile: Future<CurrentUserProfile?>.value(
        const CurrentUserProfile(
          uid: 42,
          username: 'Alice',
          avatarUrl: 'https://example.com/alice.png',
          gender: 1,
        ),
      ),
    );
    addTearDown(container.dispose);
    await container.read(currentUserProfileProvider.future);

    await container
        .read(conversationComposerViewModelProvider(_identity).notifier)
        .send(text: 'Hello');

    final message = _singleOptimisticMessage(container);
    expect(message.sender.uid, 42);
    expect(message.sender.name, 'Alice');
    expect(message.sender.avatarUrl, 'https://example.com/alice.png');
    expect(message.sender.gender, 1);
    api.completeAll();
  });

  test('optimistic text send falls back while profile is loading', () async {
    final api = _FakeMessageApiService(completeSends: false);
    final pendingProfile = Completer<CurrentUserProfile?>();
    final container = _container(api: api, profile: pendingProfile.future);
    addTearDown(container.dispose);

    await container
        .read(conversationComposerViewModelProvider(_identity).notifier)
        .send(text: 'Hello');

    final message = _singleOptimisticMessage(container);
    expect(message.sender.uid, 42);
    expect(message.sender.name, 'User 42');
    expect(message.sender.avatarUrl, isNull);
    expect(message.sender.gender, 0);

    pendingProfile.complete(null);
    api.completeAll();
  });

  test('rapid text sends create distinct optimistic messages', () async {
    final api = _FakeMessageApiService(completeSends: false);
    final container = _container(
      api: api,
      profile: Future<CurrentUserProfile?>.value(
        const CurrentUserProfile(
          uid: 42,
          username: 'Alice',
          avatarUrl: null,
          gender: 0,
        ),
      ),
    );
    addTearDown(container.dispose);
    await container.read(currentUserProfileProvider.future);

    final notifier = container.read(
      conversationComposerViewModelProvider(_identity).notifier,
    );
    await Future.wait([
      notifier.send(text: 'First'),
      notifier.send(text: 'Second'),
    ]);

    final scope = container.read(
      conversationTimelineMessageStoreProvider,
    )[_identity]!;
    final optimisticMessages = scope.optimisticMessages;
    expect(optimisticMessages, hasLength(2));
    expect(optimisticMessages.map(_messageText), ['First', 'Second']);
    expect(
      optimisticMessages.map((message) => message.clientGeneratedId).toSet(),
      hasLength(2),
    );
    expect(api.requests.map((request) => request.clientGeneratedId), [
      optimisticMessages.first.clientGeneratedId,
    ]);

    api.completeNext();
    await _flushMicrotasks();

    expect(
      api.requests.map((request) => request.clientGeneratedId),
      optimisticMessages.map((message) => message.clientGeneratedId),
    );

    api.completeAll();
  });
}

const _identity = (chatId: 42, threadRootId: null);

ProviderContainer _container({
  required _FakeMessageApiService api,
  required Future<CurrentUserProfile?> profile,
}) {
  return ProviderContainer(
    overrides: [
      authSessionProvider.overrideWith(_AuthenticatedSessionNotifier.new),
      currentUserProfileProvider.overrideWith((ref) => profile),
      messageApiServiceV2Provider.overrideWithValue(api),
      audioRecorderServiceProvider.overrideWithValue(
        _FakeAudioRecorderService(),
      ),
      audioWaveformCacheServiceProvider.overrideWithValue(
        _FakeAudioWaveformCacheService(),
      ),
    ],
  );
}

ConversationMessageV2 _singleOptimisticMessage(ProviderContainer container) {
  final scope = container.read(
    conversationTimelineMessageStoreProvider,
  )[_identity];
  expect(scope, isNotNull);
  expect(scope!.optimisticMessages, hasLength(1));
  return scope.optimisticMessages.single;
}

String _messageText(ConversationMessageV2 message) {
  return switch (message.content) {
    TextMessageContent(:final text) => text,
    _ => throw StateError('Expected text message in test'),
  };
}

Future<void> _flushMicrotasks() async {
  await Future<void>.delayed(Duration.zero);
  await Future<void>.delayed(Duration.zero);
}

class _AuthenticatedSessionNotifier extends AuthSessionNotifier {
  @override
  AuthSessionState build() {
    return const AuthSessionState(
      status: AuthBootstrapStatus.authenticated,
      mode: AuthSessionMode.devHeader,
      developerUserId: 42,
      currentUserId: 42,
    );
  }
}

class _FakeMessageApiService extends MessageApiServiceV2 {
  _FakeMessageApiService({this.completeSends = true}) : super(Dio(), 42);

  final bool completeSends;
  final requests = <_SendRequest>[];
  final _pendingSends = <Completer<MessageItemDto>>[];
  var _nextResponseId = 100;

  @override
  Future<MessageItemDto> sendConversationMessage(
    ConversationIdentity identity,
    String text, {
    required String messageType,
    int? replyToId,
    List<String> attachmentIds = const <String>[],
    required String clientGeneratedId,
    String? stickerId,
  }) async {
    requests.add((
      text: text,
      messageType: messageType,
      clientGeneratedId: clientGeneratedId,
    ));
    final response = _responseFor(
      id: _nextResponseId++,
      text: text,
      messageType: messageType,
      clientGeneratedId: clientGeneratedId,
    );
    if (completeSends) {
      return response;
    }
    final completer = Completer<MessageItemDto>();
    _pendingSends.add(completer);
    return completer.future;
  }

  void completeAll() {
    while (_pendingSends.isNotEmpty) {
      completeNext();
    }
  }

  void completeNext() {
    final request = requests[requests.length - _pendingSends.length];
    _pendingSends
        .removeAt(0)
        .complete(
          _responseFor(
            id: _nextResponseId++,
            text: request.text,
            messageType: request.messageType,
            clientGeneratedId: request.clientGeneratedId,
          ),
        );
  }

  MessageItemDto _responseFor({
    required int id,
    required String text,
    required String messageType,
    required String clientGeneratedId,
  }) {
    return MessageItemDto(
      id: id,
      message: text,
      messageType: messageType,
      sender: const UserDto(uid: 42, name: 'Alice'),
      chatId: 42,
      clientGeneratedId: clientGeneratedId,
    );
  }
}

typedef _SendRequest = ({
  String text,
  String messageType,
  String clientGeneratedId,
});

class _FakeAudioRecorderService implements AudioRecorderService {
  @override
  Future<void> cancel() => Future<void>.value();

  @override
  Future<void> dispose() => Future<void>.value();

  @override
  Future<bool> hasPermission() async => true;

  @override
  Future<bool> isRecording() async => false;

  @override
  Future<void> start() => Future<void>.value();

  @override
  Future<RecordedAudioFile?> stop({required Duration duration}) async => null;
}

class _FakeAudioWaveformCacheService implements AudioWaveformCacheService {
  @override
  void clearMemory() {}

  @override
  Future<AudioWaveformSnapshot?> primeFromAttachmentMetadata({
    required String attachmentId,
    required Duration duration,
    required List<int> samples,
  }) async {
    return null;
  }

  @override
  Future<AudioWaveformSnapshot?> primeFromLocalRecording({
    required String attachmentId,
    required String audioFilePath,
    required Duration duration,
  }) async {
    return null;
  }

  @override
  Future<AudioWaveformSnapshot?> resolveForAttachment(
    AttachmentItem attachment, {
    Duration? preferredDuration,
    String? waveformInputPath,
  }) async {
    return null;
  }
}

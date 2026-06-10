import 'dart:async';

import 'package:chahua/core/api/models/messages_api_models.dart';
import 'package:chahua/features/conversation/compose/data/message_api_service_v2.dart';
import 'package:chahua/features/conversation/shared/application/conversation_canonical_message_store.dart';
import 'package:chahua/features/conversation/shared/data/conversation_outbound_message_queue.dart';
import 'package:chahua/features/conversation/shared/domain/conversation_identity.dart';
import 'package:chahua/features/conversation/shared/domain/conversation_timeline_v2_active_segment.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('rapid sends are visible immediately but POST one at a time', () async {
    final api = _ControllableMessageApiService();
    final container = _container(api);
    addTearDown(container.dispose);

    final queue = container.read(
      conversationOutboundMessageQueueProvider(_identity),
    );
    await queue.enqueue(
      optimisticMessage: _optimisticMessage('client-a', 'A'),
      attachmentIds: const <String>[],
    );
    await queue.enqueue(
      optimisticMessage: _optimisticMessage('client-b', 'B'),
      attachmentIds: const <String>[],
    );
    await _flushMicrotasks();

    expect(_activeLatestTexts(container), ['A', 'B']);
    expect(api.requests.map((request) => request.clientGeneratedId), [
      'client-a',
    ]);

    api.completeNext(id: 10);
    await _flushMicrotasks();

    expect(api.requests.map((request) => request.clientGeneratedId), [
      'client-a',
      'client-b',
    ]);

    api.completeNext(id: 11);
    await _flushMicrotasks();

    final messages = _activeLatestMessages(container);
    expect(messages.map((message) => message.serverMessageId), [10, 11]);
    expect(
      messages.map((message) => message.deliveryState),
      everyElement(ConversationDeliveryState.confirmed),
    );
  });

  test('failed earlier send remains before later confirmed send', () async {
    final api = _ControllableMessageApiService();
    final container = _container(api);
    addTearDown(container.dispose);

    final queue = container.read(
      conversationOutboundMessageQueueProvider(_identity),
    );
    await queue.enqueue(
      optimisticMessage: _optimisticMessage('client-a', 'A'),
      attachmentIds: const <String>[],
    );
    await queue.enqueue(
      optimisticMessage: _optimisticMessage('client-b', 'B'),
      attachmentIds: const <String>[],
    );
    await _flushMicrotasks();

    api.failNext();
    await _flushMicrotasks();
    api.completeNext(id: 20);
    await _flushMicrotasks();

    final messages = _activeLatestMessages(container);
    expect(messages.map((message) => message.clientGeneratedId), [
      'client-a',
      'client-b',
    ]);
    expect(messages.first.deliveryState, ConversationDeliveryState.failed);
    expect(messages.first.serverMessageId, isNull);
    expect(messages.last.deliveryState, ConversationDeliveryState.confirmed);
    expect(messages.last.serverMessageId, 20);
  });

  test(
    'retry reuses the failed client id and confirms in local order',
    () async {
      final api = _ControllableMessageApiService();
      final container = _container(api);
      addTearDown(container.dispose);

      final queue = container.read(
        conversationOutboundMessageQueueProvider(_identity),
      );
      await queue.enqueue(
        optimisticMessage: _optimisticMessage('client-a', 'A'),
        attachmentIds: const <String>[],
      );
      await queue.enqueue(
        optimisticMessage: _optimisticMessage('client-b', 'B'),
        attachmentIds: const <String>[],
      );
      await _flushMicrotasks();
      api.failNext();
      await _flushMicrotasks();
      api.completeNext(id: 20);
      await _flushMicrotasks();

      queue.retryFailed('client-a');
      await _flushMicrotasks();

      expect(api.requests.map((request) => request.clientGeneratedId), [
        'client-a',
        'client-b',
        'client-a',
      ]);

      api.completeNext(id: 19);
      await _flushMicrotasks();

      final messages = _activeLatestMessages(container);
      expect(messages.map((message) => message.clientGeneratedId), [
        'client-a',
        'client-b',
      ]);
      expect(messages.map((message) => message.serverMessageId), [19, 20]);
    },
  );

  test('discard removes only the failed local message', () async {
    final api = _ControllableMessageApiService();
    final container = _container(api);
    addTearDown(container.dispose);

    final queue = container.read(
      conversationOutboundMessageQueueProvider(_identity),
    );
    await queue.enqueue(
      optimisticMessage: _optimisticMessage('client-a', 'A'),
      attachmentIds: const <String>[],
    );
    await queue.enqueue(
      optimisticMessage: _optimisticMessage('client-b', 'B'),
      attachmentIds: const <String>[],
    );
    await _flushMicrotasks();
    api.failNext();
    await _flushMicrotasks();
    api.completeNext(id: 20);
    await _flushMicrotasks();

    queue.discardFailed('client-a');
    await _flushMicrotasks();

    final messages = _activeLatestMessages(container);
    expect(messages.map((message) => message.clientGeneratedId), ['client-b']);
    expect(messages.single.serverMessageId, 20);
  });
}

const _identity = (chatId: 42, threadRootId: null);

ProviderContainer _container(_ControllableMessageApiService api) {
  return ProviderContainer(
    overrides: [messageApiServiceV2Provider.overrideWithValue(api)],
  );
}

Future<void> _flushMicrotasks() async {
  await Future<void>.delayed(Duration.zero);
  await Future<void>.delayed(Duration.zero);
}

List<ConversationMessageV2> _activeLatestMessages(ProviderContainer container) {
  final activeSegment = container.read(
    conversationTimelineActiveSegmentProvider((
      identity: _identity,
      mode: const ConversationTimelineActiveSegmentMode.latest(),
    )),
  );
  expect(activeSegment, isNotNull);
  return activeSegment!.orderedMessages;
}

List<String> _activeLatestTexts(ProviderContainer container) {
  return _activeLatestMessages(container)
      .map((message) {
        return switch (message.content) {
          TextMessageContent(:final text) => text,
          _ => throw StateError('Expected text message'),
        };
      })
      .toList(growable: false);
}

ConversationMessageV2 _optimisticMessage(
  String clientGeneratedId,
  String text,
) {
  return ConversationMessageV2(
    clientGeneratedId: clientGeneratedId,
    sender: const User(uid: 42, name: 'Alice'),
    createdAt: DateTime(2026, 6, 5, 12),
    deliveryState: ConversationDeliveryState.sending,
    content: TextMessageContent(text: text),
  );
}

class _ControllableMessageApiService extends MessageApiServiceV2 {
  _ControllableMessageApiService() : super(Dio(), 42);

  final requests = <_SendRequest>[];
  final _pending = <Completer<MessageItemDto>>[];

  @override
  Future<MessageItemDto> sendConversationMessage(
    ConversationIdentity identity,
    String text, {
    required String messageType,
    int? replyToId,
    List<String> attachmentIds = const <String>[],
    required String clientGeneratedId,
    String? stickerId,
  }) {
    requests.add((
      text: text,
      messageType: messageType,
      clientGeneratedId: clientGeneratedId,
    ));
    final completer = Completer<MessageItemDto>();
    _pending.add(completer);
    return completer.future;
  }

  void completeNext({required int id}) {
    final request = requests[requests.length - _pending.length];
    _pending
        .removeAt(0)
        .complete(
          MessageItemDto(
            id: id,
            message: request.text,
            messageType: request.messageType,
            sender: const UserDto(uid: 42, name: 'Alice'),
            chatId: _identity.chatId,
            clientGeneratedId: request.clientGeneratedId,
          ),
        );
  }

  void failNext() {
    _pending.removeAt(0).completeError(Exception('offline'));
  }
}

typedef _SendRequest = ({
  String text,
  String messageType,
  String clientGeneratedId,
});

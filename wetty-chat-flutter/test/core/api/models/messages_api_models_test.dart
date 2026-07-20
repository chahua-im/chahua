import 'package:chahua/core/api/models/messages_api_models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('MessagePreviewDto parses all attachment kinds', () {
    final dto = MessagePreviewDto.fromJson(<String, dynamic>{
      'id': '42',
      'sender': <String, dynamic>{'uid': 7, 'name': 'Alice', 'gender': 0},
      'message': 'photos',
      'messageType': 'text',
      'attachments': <dynamic>[
        <String, dynamic>{'kind': 'image/png'},
        <String, dynamic>{'kind': 'application/pdf'},
      ],
      'mentions': <dynamic>[],
    });

    expect(
      dto.attachments.map((attachment) => attachment.kind),
      <String>['image/png', 'application/pdf'],
    );
  });

  test('MessageItemDto parses forwarded preview', () {
    final dto = MessageItemDto.fromJson(<String, dynamic>{
      'id': '9007199254740993',
      'message': 'Forwarded 4 messages',
      'messageType': 'forwarded',
      'sender': <String, dynamic>{'uid': 7, 'name': 'Alice', 'gender': 0},
      'chatId': '42',
      'createdAt': '2026-06-26T12:00:00Z',
      'isEdited': false,
      'isDeleted': false,
      'clientGeneratedId': 'forward-client-id',
      'hasAttachments': false,
      'attachments': <dynamic>[],
      'reactions': <dynamic>[],
      'mentions': <dynamic>[],
      'forwardedPreview': <String, dynamic>{
        'total': 4,
        'messages': <dynamic>[
          <String, dynamic>{
            'originalMessageId': '123',
            'originalChatId': '24',
            'message': 'hello @[uid:8]',
            'messageType': 'text',
            'sender': <String, dynamic>{'uid': '8', 'name': 'Bob', 'gender': 0},
            'originalCreatedAt': '2026-06-25T12:00:00Z',
            'attachments': [
              {'kind': 'image/png'},
            ],
            'mentions': <dynamic>[
              <String, dynamic>{'uid': 8, 'username': 'Bob', 'gender': 0},
              <String, dynamic>{'uid': 9, 'username': 'Carol', 'gender': 0},
            ],
          },
        ],
      },
    });

    expect(dto.messageType, 'forwarded');
    expect(dto.forwardedPreview?.total, 4);

    final forwarded = dto.forwardedPreview!.messages.single;
    expect(forwarded.originalMessageId, 123);
    expect(forwarded.originalChatId, 24);
    expect(forwarded.sender.uid, 8);
    expect(forwarded.attachments.single.kind, 'image/png');
    expect(forwarded.mentions.map((mention) => mention.uid), <int>[8, 9]);
    expect(forwarded.mentions.first.username, 'Bob');
  });

  test('ForwardedMessagesResponseDto parses full forwarded messages', () {
    final dto = ForwardedMessagesResponseDto.fromJson(<String, dynamic>{
      'total': 1,
      'messages': <dynamic>[
        <String, dynamic>{
          'originalMessageId': '123',
          'originalChatId': '24',
          'message': 'hello @[uid:8]',
          'messageType': 'text',
          'sender': <String, dynamic>{'uid': '8', 'name': 'Bob', 'gender': 0},
          'originalCreatedAt': '2026-06-25T12:00:00Z',
          'replyToMessage': <String, dynamic>{
            'id': '99',
            'clientGeneratedId': 'reply-client-id',
            'createdAt': '2026-06-25T11:59:00Z',
            'sender': <String, dynamic>{'uid': 9, 'name': 'Carol', 'gender': 0},
            'message': 'reply root',
            'messageType': 'text',
            'attachments': <dynamic>[],
            'isDeleted': false,
            'mentions': <dynamic>[],
          },
          'attachments': <dynamic>[
            <String, dynamic>{
              'id': '55',
              'url': 'https://example.com/file.png',
              'kind': 'image/png',
              'size': 12,
              'fileName': 'file.png',
            },
          ],
          'mentions': <dynamic>[
            <String, dynamic>{'uid': 8, 'username': 'Bob', 'gender': 0},
          ],
        },
      ],
    });

    expect(dto.total, 1);

    final forwarded = dto.messages.single;
    expect(forwarded.originalMessageId, 123);
    expect(forwarded.originalChatId, 24);
    expect(forwarded.sender.uid, 8);
    expect(forwarded.replyToMessage?.id, 99);
    expect(forwarded.attachments.single.kind, 'image/png');
    expect(forwarded.mentions.single.username, 'Bob');
  });
}

// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'message_preview.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;
/// @nodoc
mixin _$MessagePreview {

 int get messageId; String? get clientGeneratedId; User get sender; String? get message; String get messageType; StickerSummary? get sticker; DateTime? get createdAt; List<String> get attachmentKinds; List<ReactionSummary> get reactions; bool get isDeleted; List<MentionInfo> get mentions;
/// Create a copy of MessagePreview
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$MessagePreviewCopyWith<MessagePreview> get copyWith => _$MessagePreviewCopyWithImpl<MessagePreview>(this as MessagePreview, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is MessagePreview&&(identical(other.messageId, messageId) || other.messageId == messageId)&&(identical(other.clientGeneratedId, clientGeneratedId) || other.clientGeneratedId == clientGeneratedId)&&(identical(other.sender, sender) || other.sender == sender)&&(identical(other.message, message) || other.message == message)&&(identical(other.messageType, messageType) || other.messageType == messageType)&&(identical(other.sticker, sticker) || other.sticker == sticker)&&(identical(other.createdAt, createdAt) || other.createdAt == createdAt)&&const DeepCollectionEquality().equals(other.attachmentKinds, attachmentKinds)&&const DeepCollectionEquality().equals(other.reactions, reactions)&&(identical(other.isDeleted, isDeleted) || other.isDeleted == isDeleted)&&const DeepCollectionEquality().equals(other.mentions, mentions));
}


@override
int get hashCode => Object.hash(runtimeType,messageId,clientGeneratedId,sender,message,messageType,sticker,createdAt,const DeepCollectionEquality().hash(attachmentKinds),const DeepCollectionEquality().hash(reactions),isDeleted,const DeepCollectionEquality().hash(mentions));

@override
String toString() {
  return 'MessagePreview(messageId: $messageId, clientGeneratedId: $clientGeneratedId, sender: $sender, message: $message, messageType: $messageType, sticker: $sticker, createdAt: $createdAt, attachmentKinds: $attachmentKinds, reactions: $reactions, isDeleted: $isDeleted, mentions: $mentions)';
}


}

/// @nodoc
abstract mixin class $MessagePreviewCopyWith<$Res>  {
  factory $MessagePreviewCopyWith(MessagePreview value, $Res Function(MessagePreview) _then) = _$MessagePreviewCopyWithImpl;
@useResult
$Res call({
 int messageId, String? clientGeneratedId, User sender, String? message, String messageType, StickerSummary? sticker, DateTime? createdAt, List<String> attachmentKinds, List<ReactionSummary> reactions, bool isDeleted, List<MentionInfo> mentions
});


$UserCopyWith<$Res> get sender;$StickerSummaryCopyWith<$Res>? get sticker;

}
/// @nodoc
class _$MessagePreviewCopyWithImpl<$Res>
    implements $MessagePreviewCopyWith<$Res> {
  _$MessagePreviewCopyWithImpl(this._self, this._then);

  final MessagePreview _self;
  final $Res Function(MessagePreview) _then;

/// Create a copy of MessagePreview
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? messageId = null,Object? clientGeneratedId = freezed,Object? sender = null,Object? message = freezed,Object? messageType = null,Object? sticker = freezed,Object? createdAt = freezed,Object? attachmentKinds = null,Object? reactions = null,Object? isDeleted = null,Object? mentions = null,}) {
  return _then(_self.copyWith(
messageId: null == messageId ? _self.messageId : messageId // ignore: cast_nullable_to_non_nullable
as int,clientGeneratedId: freezed == clientGeneratedId ? _self.clientGeneratedId : clientGeneratedId // ignore: cast_nullable_to_non_nullable
as String?,sender: null == sender ? _self.sender : sender // ignore: cast_nullable_to_non_nullable
as User,message: freezed == message ? _self.message : message // ignore: cast_nullable_to_non_nullable
as String?,messageType: null == messageType ? _self.messageType : messageType // ignore: cast_nullable_to_non_nullable
as String,sticker: freezed == sticker ? _self.sticker : sticker // ignore: cast_nullable_to_non_nullable
as StickerSummary?,createdAt: freezed == createdAt ? _self.createdAt : createdAt // ignore: cast_nullable_to_non_nullable
as DateTime?,attachmentKinds: null == attachmentKinds ? _self.attachmentKinds : attachmentKinds // ignore: cast_nullable_to_non_nullable
as List<String>,reactions: null == reactions ? _self.reactions : reactions // ignore: cast_nullable_to_non_nullable
as List<ReactionSummary>,isDeleted: null == isDeleted ? _self.isDeleted : isDeleted // ignore: cast_nullable_to_non_nullable
as bool,mentions: null == mentions ? _self.mentions : mentions // ignore: cast_nullable_to_non_nullable
as List<MentionInfo>,
  ));
}
/// Create a copy of MessagePreview
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$UserCopyWith<$Res> get sender {
  
  return $UserCopyWith<$Res>(_self.sender, (value) {
    return _then(_self.copyWith(sender: value));
  });
}/// Create a copy of MessagePreview
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$StickerSummaryCopyWith<$Res>? get sticker {
    if (_self.sticker == null) {
    return null;
  }

  return $StickerSummaryCopyWith<$Res>(_self.sticker!, (value) {
    return _then(_self.copyWith(sticker: value));
  });
}
}


/// Adds pattern-matching-related methods to [MessagePreview].
extension MessagePreviewPatterns on MessagePreview {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _MessagePreview value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _MessagePreview() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _MessagePreview value)  $default,){
final _that = this;
switch (_that) {
case _MessagePreview():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _MessagePreview value)?  $default,){
final _that = this;
switch (_that) {
case _MessagePreview() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( int messageId,  String? clientGeneratedId,  User sender,  String? message,  String messageType,  StickerSummary? sticker,  DateTime? createdAt,  List<String> attachmentKinds,  List<ReactionSummary> reactions,  bool isDeleted,  List<MentionInfo> mentions)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _MessagePreview() when $default != null:
return $default(_that.messageId,_that.clientGeneratedId,_that.sender,_that.message,_that.messageType,_that.sticker,_that.createdAt,_that.attachmentKinds,_that.reactions,_that.isDeleted,_that.mentions);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( int messageId,  String? clientGeneratedId,  User sender,  String? message,  String messageType,  StickerSummary? sticker,  DateTime? createdAt,  List<String> attachmentKinds,  List<ReactionSummary> reactions,  bool isDeleted,  List<MentionInfo> mentions)  $default,) {final _that = this;
switch (_that) {
case _MessagePreview():
return $default(_that.messageId,_that.clientGeneratedId,_that.sender,_that.message,_that.messageType,_that.sticker,_that.createdAt,_that.attachmentKinds,_that.reactions,_that.isDeleted,_that.mentions);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( int messageId,  String? clientGeneratedId,  User sender,  String? message,  String messageType,  StickerSummary? sticker,  DateTime? createdAt,  List<String> attachmentKinds,  List<ReactionSummary> reactions,  bool isDeleted,  List<MentionInfo> mentions)?  $default,) {final _that = this;
switch (_that) {
case _MessagePreview() when $default != null:
return $default(_that.messageId,_that.clientGeneratedId,_that.sender,_that.message,_that.messageType,_that.sticker,_that.createdAt,_that.attachmentKinds,_that.reactions,_that.isDeleted,_that.mentions);case _:
  return null;

}
}

}

/// @nodoc


class _MessagePreview extends MessagePreview {
  const _MessagePreview({required this.messageId, this.clientGeneratedId, required this.sender, this.message, this.messageType = 'text', this.sticker, this.createdAt, final  List<String> attachmentKinds = const [], final  List<ReactionSummary> reactions = const [], this.isDeleted = false, final  List<MentionInfo> mentions = const []}): _attachmentKinds = attachmentKinds,_reactions = reactions,_mentions = mentions,super._();
  

@override final  int messageId;
@override final  String? clientGeneratedId;
@override final  User sender;
@override final  String? message;
@override@JsonKey() final  String messageType;
@override final  StickerSummary? sticker;
@override final  DateTime? createdAt;
 final  List<String> _attachmentKinds;
@override@JsonKey() List<String> get attachmentKinds {
  if (_attachmentKinds is EqualUnmodifiableListView) return _attachmentKinds;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_attachmentKinds);
}

 final  List<ReactionSummary> _reactions;
@override@JsonKey() List<ReactionSummary> get reactions {
  if (_reactions is EqualUnmodifiableListView) return _reactions;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_reactions);
}

@override@JsonKey() final  bool isDeleted;
 final  List<MentionInfo> _mentions;
@override@JsonKey() List<MentionInfo> get mentions {
  if (_mentions is EqualUnmodifiableListView) return _mentions;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_mentions);
}


/// Create a copy of MessagePreview
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$MessagePreviewCopyWith<_MessagePreview> get copyWith => __$MessagePreviewCopyWithImpl<_MessagePreview>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _MessagePreview&&(identical(other.messageId, messageId) || other.messageId == messageId)&&(identical(other.clientGeneratedId, clientGeneratedId) || other.clientGeneratedId == clientGeneratedId)&&(identical(other.sender, sender) || other.sender == sender)&&(identical(other.message, message) || other.message == message)&&(identical(other.messageType, messageType) || other.messageType == messageType)&&(identical(other.sticker, sticker) || other.sticker == sticker)&&(identical(other.createdAt, createdAt) || other.createdAt == createdAt)&&const DeepCollectionEquality().equals(other._attachmentKinds, _attachmentKinds)&&const DeepCollectionEquality().equals(other._reactions, _reactions)&&(identical(other.isDeleted, isDeleted) || other.isDeleted == isDeleted)&&const DeepCollectionEquality().equals(other._mentions, _mentions));
}


@override
int get hashCode => Object.hash(runtimeType,messageId,clientGeneratedId,sender,message,messageType,sticker,createdAt,const DeepCollectionEquality().hash(_attachmentKinds),const DeepCollectionEquality().hash(_reactions),isDeleted,const DeepCollectionEquality().hash(_mentions));

@override
String toString() {
  return 'MessagePreview(messageId: $messageId, clientGeneratedId: $clientGeneratedId, sender: $sender, message: $message, messageType: $messageType, sticker: $sticker, createdAt: $createdAt, attachmentKinds: $attachmentKinds, reactions: $reactions, isDeleted: $isDeleted, mentions: $mentions)';
}


}

/// @nodoc
abstract mixin class _$MessagePreviewCopyWith<$Res> implements $MessagePreviewCopyWith<$Res> {
  factory _$MessagePreviewCopyWith(_MessagePreview value, $Res Function(_MessagePreview) _then) = __$MessagePreviewCopyWithImpl;
@override @useResult
$Res call({
 int messageId, String? clientGeneratedId, User sender, String? message, String messageType, StickerSummary? sticker, DateTime? createdAt, List<String> attachmentKinds, List<ReactionSummary> reactions, bool isDeleted, List<MentionInfo> mentions
});


@override $UserCopyWith<$Res> get sender;@override $StickerSummaryCopyWith<$Res>? get sticker;

}
/// @nodoc
class __$MessagePreviewCopyWithImpl<$Res>
    implements _$MessagePreviewCopyWith<$Res> {
  __$MessagePreviewCopyWithImpl(this._self, this._then);

  final _MessagePreview _self;
  final $Res Function(_MessagePreview) _then;

/// Create a copy of MessagePreview
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? messageId = null,Object? clientGeneratedId = freezed,Object? sender = null,Object? message = freezed,Object? messageType = null,Object? sticker = freezed,Object? createdAt = freezed,Object? attachmentKinds = null,Object? reactions = null,Object? isDeleted = null,Object? mentions = null,}) {
  return _then(_MessagePreview(
messageId: null == messageId ? _self.messageId : messageId // ignore: cast_nullable_to_non_nullable
as int,clientGeneratedId: freezed == clientGeneratedId ? _self.clientGeneratedId : clientGeneratedId // ignore: cast_nullable_to_non_nullable
as String?,sender: null == sender ? _self.sender : sender // ignore: cast_nullable_to_non_nullable
as User,message: freezed == message ? _self.message : message // ignore: cast_nullable_to_non_nullable
as String?,messageType: null == messageType ? _self.messageType : messageType // ignore: cast_nullable_to_non_nullable
as String,sticker: freezed == sticker ? _self.sticker : sticker // ignore: cast_nullable_to_non_nullable
as StickerSummary?,createdAt: freezed == createdAt ? _self.createdAt : createdAt // ignore: cast_nullable_to_non_nullable
as DateTime?,attachmentKinds: null == attachmentKinds ? _self._attachmentKinds : attachmentKinds // ignore: cast_nullable_to_non_nullable
as List<String>,reactions: null == reactions ? _self._reactions : reactions // ignore: cast_nullable_to_non_nullable
as List<ReactionSummary>,isDeleted: null == isDeleted ? _self.isDeleted : isDeleted // ignore: cast_nullable_to_non_nullable
as bool,mentions: null == mentions ? _self._mentions : mentions // ignore: cast_nullable_to_non_nullable
as List<MentionInfo>,
  ));
}

/// Create a copy of MessagePreview
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$UserCopyWith<$Res> get sender {
  
  return $UserCopyWith<$Res>(_self.sender, (value) {
    return _then(_self.copyWith(sender: value));
  });
}/// Create a copy of MessagePreview
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$StickerSummaryCopyWith<$Res>? get sticker {
    if (_self.sticker == null) {
    return null;
  }

  return $StickerSummaryCopyWith<$Res>(_self.sticker!, (value) {
    return _then(_self.copyWith(sticker: value));
  });
}
}

// dart format on

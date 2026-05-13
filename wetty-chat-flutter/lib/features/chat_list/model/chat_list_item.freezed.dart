// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'chat_list_item.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;
/// @nodoc
mixin _$ChatListItem {

 String get id; String? get name; String? get avatarUrl; DateTime? get lastMessageAt; int get unreadCount; String? get lastReadMessageId; MessagePreview? get lastMessage; DateTime? get mutedUntil; bool get archived;
/// Create a copy of ChatListItem
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatListItemCopyWith<ChatListItem> get copyWith => _$ChatListItemCopyWithImpl<ChatListItem>(this as ChatListItem, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatListItem&&(identical(other.id, id) || other.id == id)&&(identical(other.name, name) || other.name == name)&&(identical(other.avatarUrl, avatarUrl) || other.avatarUrl == avatarUrl)&&(identical(other.lastMessageAt, lastMessageAt) || other.lastMessageAt == lastMessageAt)&&(identical(other.unreadCount, unreadCount) || other.unreadCount == unreadCount)&&(identical(other.lastReadMessageId, lastReadMessageId) || other.lastReadMessageId == lastReadMessageId)&&(identical(other.lastMessage, lastMessage) || other.lastMessage == lastMessage)&&(identical(other.mutedUntil, mutedUntil) || other.mutedUntil == mutedUntil)&&(identical(other.archived, archived) || other.archived == archived));
}


@override
int get hashCode => Object.hash(runtimeType,id,name,avatarUrl,lastMessageAt,unreadCount,lastReadMessageId,lastMessage,mutedUntil,archived);

@override
String toString() {
  return 'ChatListItem(id: $id, name: $name, avatarUrl: $avatarUrl, lastMessageAt: $lastMessageAt, unreadCount: $unreadCount, lastReadMessageId: $lastReadMessageId, lastMessage: $lastMessage, mutedUntil: $mutedUntil, archived: $archived)';
}


}

/// @nodoc
abstract mixin class $ChatListItemCopyWith<$Res>  {
  factory $ChatListItemCopyWith(ChatListItem value, $Res Function(ChatListItem) _then) = _$ChatListItemCopyWithImpl;
@useResult
$Res call({
 String id, String? name, String? avatarUrl, DateTime? lastMessageAt, int unreadCount, String? lastReadMessageId, MessagePreview? lastMessage, DateTime? mutedUntil, bool archived
});


$MessagePreviewCopyWith<$Res>? get lastMessage;

}
/// @nodoc
class _$ChatListItemCopyWithImpl<$Res>
    implements $ChatListItemCopyWith<$Res> {
  _$ChatListItemCopyWithImpl(this._self, this._then);

  final ChatListItem _self;
  final $Res Function(ChatListItem) _then;

/// Create a copy of ChatListItem
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? id = null,Object? name = freezed,Object? avatarUrl = freezed,Object? lastMessageAt = freezed,Object? unreadCount = null,Object? lastReadMessageId = freezed,Object? lastMessage = freezed,Object? mutedUntil = freezed,Object? archived = null,}) {
  return _then(_self.copyWith(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,name: freezed == name ? _self.name : name // ignore: cast_nullable_to_non_nullable
as String?,avatarUrl: freezed == avatarUrl ? _self.avatarUrl : avatarUrl // ignore: cast_nullable_to_non_nullable
as String?,lastMessageAt: freezed == lastMessageAt ? _self.lastMessageAt : lastMessageAt // ignore: cast_nullable_to_non_nullable
as DateTime?,unreadCount: null == unreadCount ? _self.unreadCount : unreadCount // ignore: cast_nullable_to_non_nullable
as int,lastReadMessageId: freezed == lastReadMessageId ? _self.lastReadMessageId : lastReadMessageId // ignore: cast_nullable_to_non_nullable
as String?,lastMessage: freezed == lastMessage ? _self.lastMessage : lastMessage // ignore: cast_nullable_to_non_nullable
as MessagePreview?,mutedUntil: freezed == mutedUntil ? _self.mutedUntil : mutedUntil // ignore: cast_nullable_to_non_nullable
as DateTime?,archived: null == archived ? _self.archived : archived // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}
/// Create a copy of ChatListItem
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$MessagePreviewCopyWith<$Res>? get lastMessage {
    if (_self.lastMessage == null) {
    return null;
  }

  return $MessagePreviewCopyWith<$Res>(_self.lastMessage!, (value) {
    return _then(_self.copyWith(lastMessage: value));
  });
}
}


/// Adds pattern-matching-related methods to [ChatListItem].
extension ChatListItemPatterns on ChatListItem {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _ChatListItem value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _ChatListItem() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _ChatListItem value)  $default,){
final _that = this;
switch (_that) {
case _ChatListItem():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _ChatListItem value)?  $default,){
final _that = this;
switch (_that) {
case _ChatListItem() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String id,  String? name,  String? avatarUrl,  DateTime? lastMessageAt,  int unreadCount,  String? lastReadMessageId,  MessagePreview? lastMessage,  DateTime? mutedUntil,  bool archived)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _ChatListItem() when $default != null:
return $default(_that.id,_that.name,_that.avatarUrl,_that.lastMessageAt,_that.unreadCount,_that.lastReadMessageId,_that.lastMessage,_that.mutedUntil,_that.archived);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String id,  String? name,  String? avatarUrl,  DateTime? lastMessageAt,  int unreadCount,  String? lastReadMessageId,  MessagePreview? lastMessage,  DateTime? mutedUntil,  bool archived)  $default,) {final _that = this;
switch (_that) {
case _ChatListItem():
return $default(_that.id,_that.name,_that.avatarUrl,_that.lastMessageAt,_that.unreadCount,_that.lastReadMessageId,_that.lastMessage,_that.mutedUntil,_that.archived);case _:
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String id,  String? name,  String? avatarUrl,  DateTime? lastMessageAt,  int unreadCount,  String? lastReadMessageId,  MessagePreview? lastMessage,  DateTime? mutedUntil,  bool archived)?  $default,) {final _that = this;
switch (_that) {
case _ChatListItem() when $default != null:
return $default(_that.id,_that.name,_that.avatarUrl,_that.lastMessageAt,_that.unreadCount,_that.lastReadMessageId,_that.lastMessage,_that.mutedUntil,_that.archived);case _:
  return null;

}
}

}

/// @nodoc


class _ChatListItem implements ChatListItem {
  const _ChatListItem({required this.id, this.name, this.avatarUrl, this.lastMessageAt, this.unreadCount = 0, this.lastReadMessageId, this.lastMessage, this.mutedUntil, this.archived = false});
  

@override final  String id;
@override final  String? name;
@override final  String? avatarUrl;
@override final  DateTime? lastMessageAt;
@override@JsonKey() final  int unreadCount;
@override final  String? lastReadMessageId;
@override final  MessagePreview? lastMessage;
@override final  DateTime? mutedUntil;
@override@JsonKey() final  bool archived;

/// Create a copy of ChatListItem
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$ChatListItemCopyWith<_ChatListItem> get copyWith => __$ChatListItemCopyWithImpl<_ChatListItem>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _ChatListItem&&(identical(other.id, id) || other.id == id)&&(identical(other.name, name) || other.name == name)&&(identical(other.avatarUrl, avatarUrl) || other.avatarUrl == avatarUrl)&&(identical(other.lastMessageAt, lastMessageAt) || other.lastMessageAt == lastMessageAt)&&(identical(other.unreadCount, unreadCount) || other.unreadCount == unreadCount)&&(identical(other.lastReadMessageId, lastReadMessageId) || other.lastReadMessageId == lastReadMessageId)&&(identical(other.lastMessage, lastMessage) || other.lastMessage == lastMessage)&&(identical(other.mutedUntil, mutedUntil) || other.mutedUntil == mutedUntil)&&(identical(other.archived, archived) || other.archived == archived));
}


@override
int get hashCode => Object.hash(runtimeType,id,name,avatarUrl,lastMessageAt,unreadCount,lastReadMessageId,lastMessage,mutedUntil,archived);

@override
String toString() {
  return 'ChatListItem(id: $id, name: $name, avatarUrl: $avatarUrl, lastMessageAt: $lastMessageAt, unreadCount: $unreadCount, lastReadMessageId: $lastReadMessageId, lastMessage: $lastMessage, mutedUntil: $mutedUntil, archived: $archived)';
}


}

/// @nodoc
abstract mixin class _$ChatListItemCopyWith<$Res> implements $ChatListItemCopyWith<$Res> {
  factory _$ChatListItemCopyWith(_ChatListItem value, $Res Function(_ChatListItem) _then) = __$ChatListItemCopyWithImpl;
@override @useResult
$Res call({
 String id, String? name, String? avatarUrl, DateTime? lastMessageAt, int unreadCount, String? lastReadMessageId, MessagePreview? lastMessage, DateTime? mutedUntil, bool archived
});


@override $MessagePreviewCopyWith<$Res>? get lastMessage;

}
/// @nodoc
class __$ChatListItemCopyWithImpl<$Res>
    implements _$ChatListItemCopyWith<$Res> {
  __$ChatListItemCopyWithImpl(this._self, this._then);

  final _ChatListItem _self;
  final $Res Function(_ChatListItem) _then;

/// Create a copy of ChatListItem
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? id = null,Object? name = freezed,Object? avatarUrl = freezed,Object? lastMessageAt = freezed,Object? unreadCount = null,Object? lastReadMessageId = freezed,Object? lastMessage = freezed,Object? mutedUntil = freezed,Object? archived = null,}) {
  return _then(_ChatListItem(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,name: freezed == name ? _self.name : name // ignore: cast_nullable_to_non_nullable
as String?,avatarUrl: freezed == avatarUrl ? _self.avatarUrl : avatarUrl // ignore: cast_nullable_to_non_nullable
as String?,lastMessageAt: freezed == lastMessageAt ? _self.lastMessageAt : lastMessageAt // ignore: cast_nullable_to_non_nullable
as DateTime?,unreadCount: null == unreadCount ? _self.unreadCount : unreadCount // ignore: cast_nullable_to_non_nullable
as int,lastReadMessageId: freezed == lastReadMessageId ? _self.lastReadMessageId : lastReadMessageId // ignore: cast_nullable_to_non_nullable
as String?,lastMessage: freezed == lastMessage ? _self.lastMessage : lastMessage // ignore: cast_nullable_to_non_nullable
as MessagePreview?,mutedUntil: freezed == mutedUntil ? _self.mutedUntil : mutedUntil // ignore: cast_nullable_to_non_nullable
as DateTime?,archived: null == archived ? _self.archived : archived // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}

/// Create a copy of ChatListItem
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$MessagePreviewCopyWith<$Res>? get lastMessage {
    if (_self.lastMessage == null) {
    return null;
  }

  return $MessagePreviewCopyWith<$Res>(_self.lastMessage!, (value) {
    return _then(_self.copyWith(lastMessage: value));
  });
}
}

// dart format on

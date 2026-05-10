// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'conversation_timeline_view_model.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;
/// @nodoc
mixin _$ConversationTimelineState implements DiagnosticableTreeMixin {

 List<ConversationMessageV2> get beforeMessages; List<ConversationMessageV2> get afterMessages; bool get canLoadOlder; bool get canLoadNewer; bool get isLoadingOlder; bool get isLoadingNewer; bool get isResolvingJump; ConversationMessageHighlight? get highlight; ConversationTimelineViewportCommand get viewportCommand; int get viewportCommandGeneration; bool get isBootstrapping;
/// Create a copy of ConversationTimelineState
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ConversationTimelineStateCopyWith<ConversationTimelineState> get copyWith => _$ConversationTimelineStateCopyWithImpl<ConversationTimelineState>(this as ConversationTimelineState, _$identity);


@override
void debugFillProperties(DiagnosticPropertiesBuilder properties) {
  properties
    ..add(DiagnosticsProperty('type', 'ConversationTimelineState'))
    ..add(DiagnosticsProperty('beforeMessages', beforeMessages))..add(DiagnosticsProperty('afterMessages', afterMessages))..add(DiagnosticsProperty('canLoadOlder', canLoadOlder))..add(DiagnosticsProperty('canLoadNewer', canLoadNewer))..add(DiagnosticsProperty('isLoadingOlder', isLoadingOlder))..add(DiagnosticsProperty('isLoadingNewer', isLoadingNewer))..add(DiagnosticsProperty('isResolvingJump', isResolvingJump))..add(DiagnosticsProperty('highlight', highlight))..add(DiagnosticsProperty('viewportCommand', viewportCommand))..add(DiagnosticsProperty('viewportCommandGeneration', viewportCommandGeneration))..add(DiagnosticsProperty('isBootstrapping', isBootstrapping));
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ConversationTimelineState&&const DeepCollectionEquality().equals(other.beforeMessages, beforeMessages)&&const DeepCollectionEquality().equals(other.afterMessages, afterMessages)&&(identical(other.canLoadOlder, canLoadOlder) || other.canLoadOlder == canLoadOlder)&&(identical(other.canLoadNewer, canLoadNewer) || other.canLoadNewer == canLoadNewer)&&(identical(other.isLoadingOlder, isLoadingOlder) || other.isLoadingOlder == isLoadingOlder)&&(identical(other.isLoadingNewer, isLoadingNewer) || other.isLoadingNewer == isLoadingNewer)&&(identical(other.isResolvingJump, isResolvingJump) || other.isResolvingJump == isResolvingJump)&&(identical(other.highlight, highlight) || other.highlight == highlight)&&(identical(other.viewportCommand, viewportCommand) || other.viewportCommand == viewportCommand)&&(identical(other.viewportCommandGeneration, viewportCommandGeneration) || other.viewportCommandGeneration == viewportCommandGeneration)&&(identical(other.isBootstrapping, isBootstrapping) || other.isBootstrapping == isBootstrapping));
}


@override
int get hashCode => Object.hash(runtimeType,const DeepCollectionEquality().hash(beforeMessages),const DeepCollectionEquality().hash(afterMessages),canLoadOlder,canLoadNewer,isLoadingOlder,isLoadingNewer,isResolvingJump,highlight,viewportCommand,viewportCommandGeneration,isBootstrapping);

@override
String toString({ DiagnosticLevel minLevel = DiagnosticLevel.info }) {
  return 'ConversationTimelineState(beforeMessages: $beforeMessages, afterMessages: $afterMessages, canLoadOlder: $canLoadOlder, canLoadNewer: $canLoadNewer, isLoadingOlder: $isLoadingOlder, isLoadingNewer: $isLoadingNewer, isResolvingJump: $isResolvingJump, highlight: $highlight, viewportCommand: $viewportCommand, viewportCommandGeneration: $viewportCommandGeneration, isBootstrapping: $isBootstrapping)';
}


}

/// @nodoc
abstract mixin class $ConversationTimelineStateCopyWith<$Res>  {
  factory $ConversationTimelineStateCopyWith(ConversationTimelineState value, $Res Function(ConversationTimelineState) _then) = _$ConversationTimelineStateCopyWithImpl;
@useResult
$Res call({
 List<ConversationMessageV2> beforeMessages, List<ConversationMessageV2> afterMessages, bool canLoadOlder, bool canLoadNewer, bool isLoadingOlder, bool isLoadingNewer, bool isResolvingJump, ConversationMessageHighlight? highlight, ConversationTimelineViewportCommand viewportCommand, int viewportCommandGeneration, bool isBootstrapping
});




}
/// @nodoc
class _$ConversationTimelineStateCopyWithImpl<$Res>
    implements $ConversationTimelineStateCopyWith<$Res> {
  _$ConversationTimelineStateCopyWithImpl(this._self, this._then);

  final ConversationTimelineState _self;
  final $Res Function(ConversationTimelineState) _then;

/// Create a copy of ConversationTimelineState
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? beforeMessages = null,Object? afterMessages = null,Object? canLoadOlder = null,Object? canLoadNewer = null,Object? isLoadingOlder = null,Object? isLoadingNewer = null,Object? isResolvingJump = null,Object? highlight = freezed,Object? viewportCommand = null,Object? viewportCommandGeneration = null,Object? isBootstrapping = null,}) {
  return _then(_self.copyWith(
beforeMessages: null == beforeMessages ? _self.beforeMessages : beforeMessages // ignore: cast_nullable_to_non_nullable
as List<ConversationMessageV2>,afterMessages: null == afterMessages ? _self.afterMessages : afterMessages // ignore: cast_nullable_to_non_nullable
as List<ConversationMessageV2>,canLoadOlder: null == canLoadOlder ? _self.canLoadOlder : canLoadOlder // ignore: cast_nullable_to_non_nullable
as bool,canLoadNewer: null == canLoadNewer ? _self.canLoadNewer : canLoadNewer // ignore: cast_nullable_to_non_nullable
as bool,isLoadingOlder: null == isLoadingOlder ? _self.isLoadingOlder : isLoadingOlder // ignore: cast_nullable_to_non_nullable
as bool,isLoadingNewer: null == isLoadingNewer ? _self.isLoadingNewer : isLoadingNewer // ignore: cast_nullable_to_non_nullable
as bool,isResolvingJump: null == isResolvingJump ? _self.isResolvingJump : isResolvingJump // ignore: cast_nullable_to_non_nullable
as bool,highlight: freezed == highlight ? _self.highlight : highlight // ignore: cast_nullable_to_non_nullable
as ConversationMessageHighlight?,viewportCommand: null == viewportCommand ? _self.viewportCommand : viewportCommand // ignore: cast_nullable_to_non_nullable
as ConversationTimelineViewportCommand,viewportCommandGeneration: null == viewportCommandGeneration ? _self.viewportCommandGeneration : viewportCommandGeneration // ignore: cast_nullable_to_non_nullable
as int,isBootstrapping: null == isBootstrapping ? _self.isBootstrapping : isBootstrapping // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}

}


/// Adds pattern-matching-related methods to [ConversationTimelineState].
extension ConversationTimelineStatePatterns on ConversationTimelineState {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _ConversationTimelineState value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _ConversationTimelineState() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _ConversationTimelineState value)  $default,){
final _that = this;
switch (_that) {
case _ConversationTimelineState():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _ConversationTimelineState value)?  $default,){
final _that = this;
switch (_that) {
case _ConversationTimelineState() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( List<ConversationMessageV2> beforeMessages,  List<ConversationMessageV2> afterMessages,  bool canLoadOlder,  bool canLoadNewer,  bool isLoadingOlder,  bool isLoadingNewer,  bool isResolvingJump,  ConversationMessageHighlight? highlight,  ConversationTimelineViewportCommand viewportCommand,  int viewportCommandGeneration,  bool isBootstrapping)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _ConversationTimelineState() when $default != null:
return $default(_that.beforeMessages,_that.afterMessages,_that.canLoadOlder,_that.canLoadNewer,_that.isLoadingOlder,_that.isLoadingNewer,_that.isResolvingJump,_that.highlight,_that.viewportCommand,_that.viewportCommandGeneration,_that.isBootstrapping);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( List<ConversationMessageV2> beforeMessages,  List<ConversationMessageV2> afterMessages,  bool canLoadOlder,  bool canLoadNewer,  bool isLoadingOlder,  bool isLoadingNewer,  bool isResolvingJump,  ConversationMessageHighlight? highlight,  ConversationTimelineViewportCommand viewportCommand,  int viewportCommandGeneration,  bool isBootstrapping)  $default,) {final _that = this;
switch (_that) {
case _ConversationTimelineState():
return $default(_that.beforeMessages,_that.afterMessages,_that.canLoadOlder,_that.canLoadNewer,_that.isLoadingOlder,_that.isLoadingNewer,_that.isResolvingJump,_that.highlight,_that.viewportCommand,_that.viewportCommandGeneration,_that.isBootstrapping);case _:
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( List<ConversationMessageV2> beforeMessages,  List<ConversationMessageV2> afterMessages,  bool canLoadOlder,  bool canLoadNewer,  bool isLoadingOlder,  bool isLoadingNewer,  bool isResolvingJump,  ConversationMessageHighlight? highlight,  ConversationTimelineViewportCommand viewportCommand,  int viewportCommandGeneration,  bool isBootstrapping)?  $default,) {final _that = this;
switch (_that) {
case _ConversationTimelineState() when $default != null:
return $default(_that.beforeMessages,_that.afterMessages,_that.canLoadOlder,_that.canLoadNewer,_that.isLoadingOlder,_that.isLoadingNewer,_that.isResolvingJump,_that.highlight,_that.viewportCommand,_that.viewportCommandGeneration,_that.isBootstrapping);case _:
  return null;

}
}

}

/// @nodoc


class _ConversationTimelineState with DiagnosticableTreeMixin implements ConversationTimelineState {
  const _ConversationTimelineState({final  List<ConversationMessageV2> beforeMessages = const <ConversationMessageV2>[], final  List<ConversationMessageV2> afterMessages = const <ConversationMessageV2>[], this.canLoadOlder = false, this.canLoadNewer = false, this.isLoadingOlder = false, this.isLoadingNewer = false, this.isResolvingJump = false, this.highlight, this.viewportCommand = const (kind: ConversationTimelineViewportCommandKind.none, placement: ConversationTimelineViewportPlacement.bottomPreferred), this.viewportCommandGeneration = 0, this.isBootstrapping = true}): _beforeMessages = beforeMessages,_afterMessages = afterMessages;
  

 final  List<ConversationMessageV2> _beforeMessages;
@override@JsonKey() List<ConversationMessageV2> get beforeMessages {
  if (_beforeMessages is EqualUnmodifiableListView) return _beforeMessages;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_beforeMessages);
}

 final  List<ConversationMessageV2> _afterMessages;
@override@JsonKey() List<ConversationMessageV2> get afterMessages {
  if (_afterMessages is EqualUnmodifiableListView) return _afterMessages;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_afterMessages);
}

@override@JsonKey() final  bool canLoadOlder;
@override@JsonKey() final  bool canLoadNewer;
@override@JsonKey() final  bool isLoadingOlder;
@override@JsonKey() final  bool isLoadingNewer;
@override@JsonKey() final  bool isResolvingJump;
@override final  ConversationMessageHighlight? highlight;
@override@JsonKey() final  ConversationTimelineViewportCommand viewportCommand;
@override@JsonKey() final  int viewportCommandGeneration;
@override@JsonKey() final  bool isBootstrapping;

/// Create a copy of ConversationTimelineState
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$ConversationTimelineStateCopyWith<_ConversationTimelineState> get copyWith => __$ConversationTimelineStateCopyWithImpl<_ConversationTimelineState>(this, _$identity);


@override
void debugFillProperties(DiagnosticPropertiesBuilder properties) {
  properties
    ..add(DiagnosticsProperty('type', 'ConversationTimelineState'))
    ..add(DiagnosticsProperty('beforeMessages', beforeMessages))..add(DiagnosticsProperty('afterMessages', afterMessages))..add(DiagnosticsProperty('canLoadOlder', canLoadOlder))..add(DiagnosticsProperty('canLoadNewer', canLoadNewer))..add(DiagnosticsProperty('isLoadingOlder', isLoadingOlder))..add(DiagnosticsProperty('isLoadingNewer', isLoadingNewer))..add(DiagnosticsProperty('isResolvingJump', isResolvingJump))..add(DiagnosticsProperty('highlight', highlight))..add(DiagnosticsProperty('viewportCommand', viewportCommand))..add(DiagnosticsProperty('viewportCommandGeneration', viewportCommandGeneration))..add(DiagnosticsProperty('isBootstrapping', isBootstrapping));
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _ConversationTimelineState&&const DeepCollectionEquality().equals(other._beforeMessages, _beforeMessages)&&const DeepCollectionEquality().equals(other._afterMessages, _afterMessages)&&(identical(other.canLoadOlder, canLoadOlder) || other.canLoadOlder == canLoadOlder)&&(identical(other.canLoadNewer, canLoadNewer) || other.canLoadNewer == canLoadNewer)&&(identical(other.isLoadingOlder, isLoadingOlder) || other.isLoadingOlder == isLoadingOlder)&&(identical(other.isLoadingNewer, isLoadingNewer) || other.isLoadingNewer == isLoadingNewer)&&(identical(other.isResolvingJump, isResolvingJump) || other.isResolvingJump == isResolvingJump)&&(identical(other.highlight, highlight) || other.highlight == highlight)&&(identical(other.viewportCommand, viewportCommand) || other.viewportCommand == viewportCommand)&&(identical(other.viewportCommandGeneration, viewportCommandGeneration) || other.viewportCommandGeneration == viewportCommandGeneration)&&(identical(other.isBootstrapping, isBootstrapping) || other.isBootstrapping == isBootstrapping));
}


@override
int get hashCode => Object.hash(runtimeType,const DeepCollectionEquality().hash(_beforeMessages),const DeepCollectionEquality().hash(_afterMessages),canLoadOlder,canLoadNewer,isLoadingOlder,isLoadingNewer,isResolvingJump,highlight,viewportCommand,viewportCommandGeneration,isBootstrapping);

@override
String toString({ DiagnosticLevel minLevel = DiagnosticLevel.info }) {
  return 'ConversationTimelineState(beforeMessages: $beforeMessages, afterMessages: $afterMessages, canLoadOlder: $canLoadOlder, canLoadNewer: $canLoadNewer, isLoadingOlder: $isLoadingOlder, isLoadingNewer: $isLoadingNewer, isResolvingJump: $isResolvingJump, highlight: $highlight, viewportCommand: $viewportCommand, viewportCommandGeneration: $viewportCommandGeneration, isBootstrapping: $isBootstrapping)';
}


}

/// @nodoc
abstract mixin class _$ConversationTimelineStateCopyWith<$Res> implements $ConversationTimelineStateCopyWith<$Res> {
  factory _$ConversationTimelineStateCopyWith(_ConversationTimelineState value, $Res Function(_ConversationTimelineState) _then) = __$ConversationTimelineStateCopyWithImpl;
@override @useResult
$Res call({
 List<ConversationMessageV2> beforeMessages, List<ConversationMessageV2> afterMessages, bool canLoadOlder, bool canLoadNewer, bool isLoadingOlder, bool isLoadingNewer, bool isResolvingJump, ConversationMessageHighlight? highlight, ConversationTimelineViewportCommand viewportCommand, int viewportCommandGeneration, bool isBootstrapping
});




}
/// @nodoc
class __$ConversationTimelineStateCopyWithImpl<$Res>
    implements _$ConversationTimelineStateCopyWith<$Res> {
  __$ConversationTimelineStateCopyWithImpl(this._self, this._then);

  final _ConversationTimelineState _self;
  final $Res Function(_ConversationTimelineState) _then;

/// Create a copy of ConversationTimelineState
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? beforeMessages = null,Object? afterMessages = null,Object? canLoadOlder = null,Object? canLoadNewer = null,Object? isLoadingOlder = null,Object? isLoadingNewer = null,Object? isResolvingJump = null,Object? highlight = freezed,Object? viewportCommand = null,Object? viewportCommandGeneration = null,Object? isBootstrapping = null,}) {
  return _then(_ConversationTimelineState(
beforeMessages: null == beforeMessages ? _self._beforeMessages : beforeMessages // ignore: cast_nullable_to_non_nullable
as List<ConversationMessageV2>,afterMessages: null == afterMessages ? _self._afterMessages : afterMessages // ignore: cast_nullable_to_non_nullable
as List<ConversationMessageV2>,canLoadOlder: null == canLoadOlder ? _self.canLoadOlder : canLoadOlder // ignore: cast_nullable_to_non_nullable
as bool,canLoadNewer: null == canLoadNewer ? _self.canLoadNewer : canLoadNewer // ignore: cast_nullable_to_non_nullable
as bool,isLoadingOlder: null == isLoadingOlder ? _self.isLoadingOlder : isLoadingOlder // ignore: cast_nullable_to_non_nullable
as bool,isLoadingNewer: null == isLoadingNewer ? _self.isLoadingNewer : isLoadingNewer // ignore: cast_nullable_to_non_nullable
as bool,isResolvingJump: null == isResolvingJump ? _self.isResolvingJump : isResolvingJump // ignore: cast_nullable_to_non_nullable
as bool,highlight: freezed == highlight ? _self.highlight : highlight // ignore: cast_nullable_to_non_nullable
as ConversationMessageHighlight?,viewportCommand: null == viewportCommand ? _self.viewportCommand : viewportCommand // ignore: cast_nullable_to_non_nullable
as ConversationTimelineViewportCommand,viewportCommandGeneration: null == viewportCommandGeneration ? _self.viewportCommandGeneration : viewportCommandGeneration // ignore: cast_nullable_to_non_nullable
as int,isBootstrapping: null == isBootstrapping ? _self.isBootstrapping : isBootstrapping // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc
mixin _$TimelineViewportFacts implements DiagnosticableTreeMixin {

 bool get isNearTop; bool get isNearBottom;
/// Create a copy of TimelineViewportFacts
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$TimelineViewportFactsCopyWith<TimelineViewportFacts> get copyWith => _$TimelineViewportFactsCopyWithImpl<TimelineViewportFacts>(this as TimelineViewportFacts, _$identity);


@override
void debugFillProperties(DiagnosticPropertiesBuilder properties) {
  properties
    ..add(DiagnosticsProperty('type', 'TimelineViewportFacts'))
    ..add(DiagnosticsProperty('isNearTop', isNearTop))..add(DiagnosticsProperty('isNearBottom', isNearBottom));
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is TimelineViewportFacts&&(identical(other.isNearTop, isNearTop) || other.isNearTop == isNearTop)&&(identical(other.isNearBottom, isNearBottom) || other.isNearBottom == isNearBottom));
}


@override
int get hashCode => Object.hash(runtimeType,isNearTop,isNearBottom);

@override
String toString({ DiagnosticLevel minLevel = DiagnosticLevel.info }) {
  return 'TimelineViewportFacts(isNearTop: $isNearTop, isNearBottom: $isNearBottom)';
}


}

/// @nodoc
abstract mixin class $TimelineViewportFactsCopyWith<$Res>  {
  factory $TimelineViewportFactsCopyWith(TimelineViewportFacts value, $Res Function(TimelineViewportFacts) _then) = _$TimelineViewportFactsCopyWithImpl;
@useResult
$Res call({
 bool isNearTop, bool isNearBottom
});




}
/// @nodoc
class _$TimelineViewportFactsCopyWithImpl<$Res>
    implements $TimelineViewportFactsCopyWith<$Res> {
  _$TimelineViewportFactsCopyWithImpl(this._self, this._then);

  final TimelineViewportFacts _self;
  final $Res Function(TimelineViewportFacts) _then;

/// Create a copy of TimelineViewportFacts
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? isNearTop = null,Object? isNearBottom = null,}) {
  return _then(_self.copyWith(
isNearTop: null == isNearTop ? _self.isNearTop : isNearTop // ignore: cast_nullable_to_non_nullable
as bool,isNearBottom: null == isNearBottom ? _self.isNearBottom : isNearBottom // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}

}


/// Adds pattern-matching-related methods to [TimelineViewportFacts].
extension TimelineViewportFactsPatterns on TimelineViewportFacts {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _TimelineViewportFacts value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _TimelineViewportFacts() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _TimelineViewportFacts value)  $default,){
final _that = this;
switch (_that) {
case _TimelineViewportFacts():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _TimelineViewportFacts value)?  $default,){
final _that = this;
switch (_that) {
case _TimelineViewportFacts() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( bool isNearTop,  bool isNearBottom)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _TimelineViewportFacts() when $default != null:
return $default(_that.isNearTop,_that.isNearBottom);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( bool isNearTop,  bool isNearBottom)  $default,) {final _that = this;
switch (_that) {
case _TimelineViewportFacts():
return $default(_that.isNearTop,_that.isNearBottom);case _:
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( bool isNearTop,  bool isNearBottom)?  $default,) {final _that = this;
switch (_that) {
case _TimelineViewportFacts() when $default != null:
return $default(_that.isNearTop,_that.isNearBottom);case _:
  return null;

}
}

}

/// @nodoc


class _TimelineViewportFacts with DiagnosticableTreeMixin implements TimelineViewportFacts {
  const _TimelineViewportFacts({this.isNearTop = false, this.isNearBottom = true});
  

@override@JsonKey() final  bool isNearTop;
@override@JsonKey() final  bool isNearBottom;

/// Create a copy of TimelineViewportFacts
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$TimelineViewportFactsCopyWith<_TimelineViewportFacts> get copyWith => __$TimelineViewportFactsCopyWithImpl<_TimelineViewportFacts>(this, _$identity);


@override
void debugFillProperties(DiagnosticPropertiesBuilder properties) {
  properties
    ..add(DiagnosticsProperty('type', 'TimelineViewportFacts'))
    ..add(DiagnosticsProperty('isNearTop', isNearTop))..add(DiagnosticsProperty('isNearBottom', isNearBottom));
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _TimelineViewportFacts&&(identical(other.isNearTop, isNearTop) || other.isNearTop == isNearTop)&&(identical(other.isNearBottom, isNearBottom) || other.isNearBottom == isNearBottom));
}


@override
int get hashCode => Object.hash(runtimeType,isNearTop,isNearBottom);

@override
String toString({ DiagnosticLevel minLevel = DiagnosticLevel.info }) {
  return 'TimelineViewportFacts(isNearTop: $isNearTop, isNearBottom: $isNearBottom)';
}


}

/// @nodoc
abstract mixin class _$TimelineViewportFactsCopyWith<$Res> implements $TimelineViewportFactsCopyWith<$Res> {
  factory _$TimelineViewportFactsCopyWith(_TimelineViewportFacts value, $Res Function(_TimelineViewportFacts) _then) = __$TimelineViewportFactsCopyWithImpl;
@override @useResult
$Res call({
 bool isNearTop, bool isNearBottom
});




}
/// @nodoc
class __$TimelineViewportFactsCopyWithImpl<$Res>
    implements _$TimelineViewportFactsCopyWith<$Res> {
  __$TimelineViewportFactsCopyWithImpl(this._self, this._then);

  final _TimelineViewportFacts _self;
  final $Res Function(_TimelineViewportFacts) _then;

/// Create a copy of TimelineViewportFacts
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? isNearTop = null,Object? isNearBottom = null,}) {
  return _then(_TimelineViewportFacts(
isNearTop: null == isNearTop ? _self.isNearTop : isNearTop // ignore: cast_nullable_to_non_nullable
as bool,isNearBottom: null == isNearBottom ? _self.isNearBottom : isNearBottom // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

// dart format on

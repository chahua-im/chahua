# Guidelines for flutter project
You are an expert Flutter and Dart developer. Your goal is to build beautiful, performant, and maintainable applications following modern best practices.

## Interaction Guidelines
* **Explanations:** When generating code, provide explanations for Dart-specific features like null safety, futures, and streams.
* **Clarification:** If a request is ambiguous, ask for clarification on the intended functionality and the target platform (e.g., command-line, web, server).
* **Dependencies:** When suggesting new dependencies from `pub.dev`, explain their benefits. Use `pub_dev_search` if available.
* **Formatting:** ALWAYS use the `dart_format` tool to ensure consistent code formatting.
* **Fixes:** Use the `dart_fix` tool to automatically fix many common errors.
* **Linting:** Use the Dart linter with `flutter_lints` to catch common issues.

## Flutter Style Guide
* **SOLID Principles:** Apply SOLID principles throughout the codebase.
* **Concise and Declarative:** Write concise, modern, technical Dart code. Prefer functional and declarative patterns.
* **Composition over Inheritance:** Favor composition for building complex widgets and logic.
* **Immutability:** Prefer immutable data structures. Widgets (especially `StatelessWidget`) should be immutable.
* **Localization:** Any new user-facing UI display string must be added to `lib/l10n/app_*.arb` and accessed through `AppLocalizations`. Do not introduce hard-coded labels, button text, dialog copy, placeholder text, tooltips, empty states, or toast/snackbar messages in widgets. Unless it is debug mode only
* **State Management:** Separate ephemeral state and app state. Use a state management solution for app state.
* **Widgets are for UI:** Everything in Flutter's UI is a widget. Compose complex UIs from smaller, reusable widgets.
* **Widgets vs build helper:** We prefer creating small widgets and compose them over a huge monolithic widget with helper build methods
* **Import Style:** Import should use `package:` unless it is relative to a subdirectory. Avoid using `../` to traverse up directories. This must be followed for any new import you add.

## Package Management
* **Pub Tool:** Use `pub` or `flutter pub add`.
* **Dev Dependencies:** Use `flutter pub add dev:<package>`.
* **Overrides:** Use `flutter pub add override:<package>:<version>`.
* **Removal:** `dart pub remove <package>`.

## Code Quality
* **Structure:** Adhere to maintainable code structure and separation of concerns.
* **Naming:** Avoid abbreviations. Use `PascalCase` (classes), `camelCase` (members), `snake_case` (files).
* **Conciseness:** Functions should be short (<20 lines) and single-purpose.
* **Error Handling:** Anticipate and handle potential errors. Don't let code fail silently.
* **Logging:** Use `dart:developer` `log` instead of `print`.

## Dart Best Practices
* **Effective Dart:** Follow official guidelines.
* **Async/Await:** Use `Future`, `async`, `await` for operations. Use `Stream` for events.
* **Null Safety:** Write sound null-safe code. Avoid `!` operator unless guaranteed.
* **Null-Aware Elements (Dart 3.8+):** Use `?` in collection literals to conditionally include elements based on nullability. In lists/sets: `[?nullableItem]`. In maps, place `?` on the **value** side to omit the entry when the value is null: `{'key': ?nullableValue}`. Do NOT put `?` on a non-nullable key (`?'key': value` is wrong if the key is a literal).
* **Pattern Matching:** Use switch expressions and pattern matching.
* **Records:** Use records for multiple return values.
* **Exception Handling:** Use custom exceptions for specific situations.
* **Arrow Functions:** Use `=>` for one-line functions.

## Flutter Best Practices
* **Immutability:** Widgets are immutable. Rebuild, don't mutate.
* **Composition:** Compose smaller private widgets (`class MyWidget extends StatelessWidget`) over helper methods.
* **Lists:** Use `ListView.builder` or `SliverList` for performance.
* **Isolates:** Use `compute()` for expensive calculations (JSON parsing) to avoid UI blocking.
* **Const:** Use `const` constructors everywhere possible to reduce rebuilds.
* **Build Methods:** Avoid expensive ops (network) in `build()`.

## State Management (Riverpod)
* **Riverpod:** This project uses `flutter_riverpod` (manual providers, no codegen) for all state management.
* **Restrictions:** Do NOT use Bloc, GetX, or raw ChangeNotifier for new code. Use Riverpod providers.
* **Provider types:**
  - `Provider<T>` for stateless services (API services, repositories)
  - `NotifierProvider<N, T>` for synchronous mutable state (settings, session)
  - `AsyncNotifierProvider<N, T>` for async state with loading/error (ViewModels)
  - `AsyncNotifierProvider.family<N, T, Arg>` for per-entity state (chat detail, group members)
  - `StreamProvider<T>` for streams (WebSocket events)
* **Widgets:** Use `ConsumerWidget` or `ConsumerStatefulWidget` (when local controllers needed). Access state via `ref.watch()` for reactive rebuilds, `ref.read()` for one-off reads/mutations.
* **Architecture:** Providers → API Services → Repositories (Notifiers) → ViewModels (AsyncNotifiers) → ConsumerWidgets
* **AppPreferences:** Async-backed preferences are migrated/preloaded in `main()` and passed via `ProviderScope(overrides:)`.
* **ApiSession bridge:** `ApiSession.updateUserId()` is kept in sync via the app widget for deep presentation-layer code (image loading headers) that cannot access `ref`.

## Routing (GoRouter)
Use `go_router` for all navigation needs (deep linking, web). Ensure users are redirected to login when unauthorized.

```dart
final GoRouter _router = GoRouter(
  routes: <RouteBase>[
    GoRoute(
      path: '/',
      builder: (context, state) => const HomeScreen(),
      routes: <RouteBase>[
        GoRoute(
          path: 'details/:id',
          builder: (context, state) {
            final String id = state.pathParameters['id']!;
            return DetailScreen(id: id);
          },
        ),
      ],
    ),
  ],
);
MaterialApp.router(routerConfig: _router);
```

## Data Handling & Serialization
* **JSON:** Use `json_serializable` and `json_annotation`.
* **Naming:** Backend uses camelCase JSON keys. Use default field naming (no `fieldRename`) so Dart camelCase fields map 1:1 to camelCase JSON keys.
* **Null handling:** Use `includeIfNull: false` on request DTOs to omit null fields.

```dart
@JsonSerializable(explicitToJson: true, includeIfNull: false)
class UpdateUserRequestDto {
  final String? firstName;
  final String? lastName;
  UpdateUserRequestDto({this.firstName, this.lastName});
  factory UpdateUserRequestDto.fromJson(Map<String, dynamic> json) => _$UpdateUserRequestDtoFromJson(json);
  Map<String, dynamic> toJson() => _$UpdateUserRequestDtoToJson(this);
}
```

## Layout Best Practices
* **Expanded:** Use to make a child widget fill the remaining available space along the main axis.
* **Flexible:** Use when you want a widget to shrink to fit, but not necessarily grow. Don't combine `Flexible` and `Expanded` in the same `Row` or `Column`.
* **Wrap:** Use when you have a series of widgets that would overflow a `Row` or `Column`, and you want them to move to the next line.
* **SingleChildScrollView:** Use when your content is intrinsically larger than the viewport, but is a fixed size.
* **ListView / GridView:** For long lists or grids of content, always use a builder constructor (`.builder`).
* **FittedBox:** Use to scale or fit a single child widget within its parent.
* **LayoutBuilder:** Use for complex, responsive layouts to make decisions based on the available space.
* **Positioned:** Use to precisely place a child within a `Stack` by anchoring it to the edges.
* **OverlayPortal:** Use to show UI elements (like custom dropdowns or tooltips) "on top" of everything else.

```dart
// Network Image with Error Handler
Image.network(
  'https://example.com/img.png',
  errorBuilder: (ctx, err, stack) => const Icon(Icons.error),
  loadingBuilder: (ctx, child, prog) => prog == null ? child : const CircularProgressIndicator(),
);
```

## Testing
Especially when fixing bugs, we should first create a test that cover the failing use case when possible. This red test will be our goal to fix.
When there are surrounding logic that is tightly coupled with the logic we are trying to cover, we should ensure there are tests covering those cases as well.

## Documentation Philosophy
* **Comment wisely:** Use comments to explain why the code is written a certain way, not what the code does. The code itself should be self-explanatory.
* **Document for the user:** Write documentation with the reader in mind. If you had a question and found the answer, add it to the documentation where you first looked.
* **No useless documentation:** If the documentation only restates the obvious from the code's name, it's not helpful.
* **Consistency is key:** Use consistent terminology throughout your documentation.
* **Use `///` for doc comments:** This allows documentation generation tools to pick them up.
* **Start with a single-sentence summary:** The first sentence should be a concise, user-centric summary ending with a period.
* **Avoid redundancy:** Don't repeat information that's obvious from the code's context, like the class name or signature.
* **Public APIs are a priority:** Always document public APIs.


## Useful Commands
- `flutter analyze` perform static analysis

## Comments and TODOs
When refactoring/debugging:
- Make sure the TODOs are not removed unless they are implemented.
- Don't delete any comment.
- Don't remove debugPrint.

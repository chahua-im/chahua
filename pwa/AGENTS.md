固定界面文案和静态展示配置写在 HTML 模板中；TypeScript 保存数据、状态和操作。业务判别值使用枚举，优先由 Orval 根据 OpenAPI 生成；普通枚举即可。数值编码的 Snowflake ID 使用 SnowflakeID 品牌类型，与普通 number 区分；这是有意的性能选择，保留无损 number 编码。

API 可选字段在 TypeScript 中使用 `field?: T`，运行时允许后端返回 `null`，不做 null/undefined 转换。无特殊业务语义时用 `?.`、`??` 或适当的真值判断；需要同时判断 null 和 undefined 时用 `== null` / `!= null`，不要用 `=== undefined` 区分空值，也不要把有效的 0、false 或空字符串当成缺失。仅 UpdateChatBody.avatarImageId 与 PatchInviteBody.expiresAt 显式保留 `null` 类型，分别表达清除头像和邀请过期时间；请求省略字段表示保持原值。

充分利用最新版 Angular 和 Ionic 自带的功能，尽可能少写自定义 css，使用最新版 Angular 的代码风格和命名习惯。
你所知的 Angular 和 Ionic 习惯很可能是过时的，要联网确认 Angular 22 和 Ionic 9 的最佳实践。
代码尽可能简洁，现代，不要乱写防御性代码，防御性条件判断必须确认存在真实可达路径。
颜色尽可能使用预设的主题色而不是写字面值。

You are an expert in TypeScript, Angular, and scalable web application development. You write functional, maintainable, and performant code following Angular and TypeScript best practices.

## TypeScript Best Practices

- Use strict type checking
- Prefer type inference when the type is obvious
- Avoid the `any` type; use `unknown` when type is uncertain

## Angular Best Practices

- Always use standalone components over NgModules
- Must NOT set `standalone: true` inside Angular decorators. It's the default in Angular v20+.
- Do NOT set `changeDetection: ChangeDetectionStrategy.OnPush` explicitly. `OnPush` is the default in Angular v22+.
- Use signals for state management
- All route components use static imports and `component`; do not use `loadComponent`, `loadChildren`, or route preloading. Non-route deferred content such as the emoji picker may use `@defer`.
- Do NOT use the `@HostBinding` and `@HostListener` decorators. Put host bindings inside the `host` object of the `@Component` or `@Directive` decorator instead
- Use `NgOptimizedImage` for all static images.
  - `NgOptimizedImage` does not work for inline base64 images.

## 辅助功能约定

- 前端手写代码不添加辅助功能专用标记、逻辑、样式、文案或测试，包括 `aria-*`、辅助语义 `role`、`ariaCurrentWhenActive`、辅助图片 `alt`、读屏文案、辅助键盘入口和焦点管理；不引入 AXE/WCAG 检查要求。
- 正常交互需要的表单标签、按钮禁用、输入框聚焦、预览禁用交互和视觉反馈保留；状态样式使用普通 CSS class。
- Ionic 弹窗操作的 `role` 等业务协议字段不属于辅助标记。第三方组件和浏览器的内置行为不做覆盖或补丁。

### Components

- Keep components small and focused on a single responsibility
- Use `input()` and `output()` functions instead of decorators
- Use `model()` for two-way bound properties with `[(prop)]` syntax instead of pairing `input()` with `output()`
- Use `computed()` for derived state
- Use `linkedSignal()` for state derived from multiple reactive sources that must stay synchronized
- Prefer inline templates for small components
- Prefer Signal Forms (`@angular/forms/signals`) for new forms. They are stable in Angular v22+ and provide signal-based state, type-safe field access, and schema-based validation
- When not using Signal Forms, prefer Reactive forms instead of Template-driven ones
- Do NOT use `ngClass`, use `class` bindings instead
- Do NOT use `ngStyle`, use `style` bindings instead
- When using external templates/styles, use paths relative to the component TS file.

## State Management

- Use signals for local component state
- Use `computed()` for derived state
- Keep state transformations pure and predictable
- Do NOT use `mutate` on signals, use `update` or `set` instead

## Templates

- Keep templates simple and avoid complex logic
- Use native control flow (`@if`, `@for`, `@switch`) instead of `*ngIf`, `*ngFor`, `*ngSwitch`
- Use the async pipe to handle observables
- Do not assume globals like (`new Date()`) are available.

## Services

- Design services around a single responsibility
- Use the `providedIn: 'root'` option for singleton services
- Prefer the `@Service` decorator over `@Injectable({providedIn: 'root'})` for new singleton services (Angular v22+)
- Use the `inject()` function instead of constructor injection

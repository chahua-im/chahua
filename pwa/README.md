# 茶话 PWA

基于 Angular 22、Ionic 9 和 TypeScript 的 Web 聊天客户端。界面使用 iOS 模式，支持手机单页导航和桌面分栏布局。

## 文档

- [需求与边界](docs/requirements.md)：现有功能、交互要求与协议限制。
- [外观](docs/appearance.md)：尺寸依据、Telegram 对照与样式归属。
- [目录结构](docs/directory-structure.md)：文件归属与代码边界。
- [数据流](docs/data-flow.md)：状态所有权、请求时机、实时事件与一致性范围。
- [组件](docs/components.md)：组件树、输入输出、局部状态与服务依赖。
- [加载与操作反馈](docs/loading-indicators.md)：各场景的加载标识和等待行为。
- [代码约定](AGENTS.md)：模板、类型与 Angular/Ionic 约定。

## 开发

```bash
npm ci
npm start
npm run build
npm test -- --watch=false
npm run test:pwa
```

安装指引位于 `/landing`；已安装应用从该入口直接进入聊天。

开发服务地址为 `http://localhost:4200`，生产构建输出位于 `dist/app`。HTTP 和 WebSocket 使用同源的 `/_api` 路径；开发服务代理到 `https://chahui.app/_api`。

构建版本使用 Angular `define` 注入的 `CHAHUA_APP_VERSION`，设置页和 API 请求头 `X-App-Version` 共用该值。`angular.json` 默认值为 `PWA2-dev`；Jenkins 通过 `npm run build -- --define "CHAHUA_APP_VERSION='PWA2-${BUILD_NUMBER}'"` 覆盖为 CI 构建号，不修改 `package.json`。 修改 `angular.json` 中的构建常量后需要重启开发服务，代码热更新不会重新读取这些配置。

登录 token 的优先级是 URL 的 `token` 参数、localStorage、开发预设。
开发预设放在 Git 忽略的 `.env.local`，格式见 `.env.example`。`npm start` 通过编译常量注入 `CHAHUA_DEV_TOKEN`，修改后需要重启开发服务。生产构建不读取该文件。预设会随开发页面下发，能够访问开发服务的浏览器可以使用该身份；真实 token 不应提交到仓库。

## 测试与行为约定

修改前以[需求与边界](docs/requirements.md)为准；需求记录产品行为，其他文档分别描述尺寸、组件所有权与请求时机，避免同一规则多处维护。回归测试随实现放置，关键覆盖包括分页范围、导航生命周期、滚动锚点、队列顺序/撤回、媒体取消和通知去重。

单元测试使用 `src/test-providers.ts` 的 HTTP 与弹窗替身；浏览器自动化同样必须拦截 HTTP、WebSocket 与上传。禁止向生产服写测试数据，禁止测试上传 S3。必须实测写入时使用本地后端及开发数据库 `10.198.3.214`，并以临时代理配置覆盖默认生产代理，例如 `npm start -- --proxy-config /tmp/chahua-local-proxy.json`。本地前端地址本身不意味着后端也是本地。

## API 生成

```bash
npm run api:generate
```

Orval 默认读取 `http://127.0.0.1:3000/api-docs/openapi.json`。环境变量 `OPENAPI_URL` 可以指定其他规格 URL 或本地文件。

`src/generated/endpoints/` 包含按标签生成的 HttpClient 服务与 resource，`src/generated/models/` 包含模型，共用模型位于 models 根目录。`scripts/api-codegen.ts` 负责契约转换、Snowflake 类型和 JSON 编解码元数据。生成文件随仓库保存，修改来源是 OpenAPI 与生成配置；普通构建无需运行后端。

应用中的业务 ID 使用 `SnowflakeID` 品牌类型，路由和协议边界负责精确转换；用户 UID、计数和日期游标保留各自类型。数值 ID 编码是性能选择，普通 UID 不参与编码。可选字段在 TypeScript 中声明为 `field?: T`，运行时的 `null` 原样保留，使用可选链、空值合并等自然消费。`UpdateChatBody.avatarImageId` 与 `PatchInviteBody.expiresAt` 显式声明请求 `null`，用于清除字段。

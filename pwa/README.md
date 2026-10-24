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
npm run dev              # 当前 worktree 的本地后端，端口由 runspace 分配
npm run dev:online       # 生产后端，使用独立的 HTTPS 前端端口
npm start                # 同 npm run dev
npm run build
npm test -- --watch=false
npm run test:pwa
```

以上开发命令统一转发到仓库的 runspace。首次配置、前后端一起启动、worktree 与共享服务管理见[本地开发](../docs/local-setup.md)。`npm run dev:online` 不要求启动本地后端或 Docker。

安装指引位于 `/landing`；已安装应用从该入口直接进入聊天。

`npm ci` 的 `postinstall` 使用 `scripts/scope-emoji-picker.mjs` 将 `@nicematic/emoji-picker` 的样式限定在 `nicematic-picker` 内，避免全局 Tailwind 重置影响 Ionic 布局。依赖固定为 2.3.6；升级时需要复核样式隔离脚本。使用 `--ignore-scripts` 安装后，须手动运行 `npm run postinstall` 再启动或构建。脚本只处理样式，保留组件原生交互及最近记录。

选择器数据由固定版本 `emojibase-data` 生成，执行 `npm run emoji:picker:generate` 并提交 `picker-emojis.generated.json` 与 `public/emoji-data-LICENSE.txt`。数据与 Unicode 17 的输入校验保持一致；升级时同时复核数据覆盖和 `emoji:generate` 使用的 Unicode 版本。数据服务接入及搜索规则见[组件文档](docs/components.md)。

开发模式自动注册仅处理通知的 Service Worker，支持通知权限、Web Push 和通知点击跳转，不缓存页面、JS、CSS 或 API，不影响热更新；“检查更新”在开发模式保持禁用。局域网测试需要浏览器信任的 HTTPS 证书，可沿用 `npm run dev:online -- --host 0.0.0.0 --ssl-cert /path/to/dev.pem --ssl-key /path/to/dev-key.pem`；证书必须包含访问 IP，测试设备需信任签发证书的根 CA。生产构建继续使用 Angular 的资源缓存与更新机制。

`npm start` 和 `npm run dev` 使用当前 worktree 的本地 HTTP 端口；`npm run dev:online` 使用另一个 HTTPS 端口。开发模式的登录 Cookie 按完整 origin（协议、主机、端口）命名，与 localStorage 一起隔离不同 worktree 和本地/线上模式；不读取旧的无作用域登录 Cookie。生产构建仍使用原有 Cookie，支持安装 PWA 时继承登录。默认端口保存在 `runspace/.env`，启动时打印访问地址；`npm run dev -- --port 14443` 可临时覆盖前端端口，不修改配置文件，`dev:online` 同样支持。runspace 统一选择代理目标，`proxy.conf.dev.mjs` 同时代理 HTTP 和 WebSocket，并去掉 `/_api` 前缀；本地模式指向当前 worktree 后端，线上模式指向 `https://chahui.app/_api`。不再从 shell 或 `.env.local` 读取 `API_PROXY_TARGET`。默认 `npm run build` 生成同源构建，部署目录为 `dist/app/browser`。HTTP 与 WebSocket 的基地址见[身份、协议与入口](docs/data-flow.md#身份协议与入口)。

`npm run build:prod` 生成跨域生产构建，部署目录为 `dist/prod/browser`。编译后的 JS、CSS 和延迟加载模块从 `https://chahui.app/` 加载；HTML、manifest、图标、表情数据和 Service Worker 保留在页面源。构建脚本同步改写 `ngsw.json` 中的编译资源 URL 与哈希表键，保留内容校验；不要用单独的 `ng build --configuration production,prod` 替代完整脚本。

资源域必须实际部署对应构建的文件，以正确 MIME 类型返回，并通过 CORS 允许页面源；缺失的 JS/CSS 不能回退为 HTML。当前资源域允许的页面源为 `https://chahua.app`，不能直接在 localhost 或任意 staging 域验证跨域生产包。发布时先上传资源，再发布页面源的 HTML 和 Worker manifest，并保留旧版本仍需使用的资源。

Apache 部署需一并上传构建目录中的 `.htaccess`，启用 `mod_rewrite`，并为站点目录允许 `AllowOverride FileInfo Indexes`。规则将不存在的 GET/HEAD 页面路径回退到 `index.html`；已有文件、目录、`/_api`、静态资源目录和带扩展名的文件路径不参与回退，避免把缺失的 JS/CSS、Worker 或 `ngsw.json` 返回为 HTML。nginx 不读取 `.htaccess`，需在站点配置中提供等效规则。

构建版本使用 Angular `define` 注入的 `CHAHUA_APP_VERSION`，设置页和 API 请求头 `X-App-Version` 共用 `app-version.ts` 中的值；未注入时回退为 `PWA2-dev`。Jenkins 通过 `npm run build -- --define "CHAHUA_APP_VERSION='PWA2-${BUILD_NUMBER}'"` 注入 CI 构建号，跨域构建使用 `npm run build:prod -- --define "CHAHUA_APP_VERSION='PWA2-${BUILD_NUMBER}'"`，不修改 `package.json`。修改构建常量后需要重启开发服务。

登录 token 的优先级是 URL 的 `token` 参数、localStorage、开发预设。
开发构建在没有 token 时请求 `POST /auth/dev-session`，使用 sessionStorage 的 `uid`（默认 1）获取身份，不需要填写 JWT；切换用户可在控制台执行 `sessionStorage.setItem('uid', '7')` 后刷新。该接口要求后端启用 `debug_auth_enabled`，否则返回 404。
开发预设放在 Git 忽略的 `.env.local`，格式见 `.env.example`；存在预设时优先于自动开发会话。`npm start`、`npm run dev` 和 `npm run dev:online` 通过编译常量注入 `CHAHUA_DEV_TOKEN`，修改后需要重启开发服务。生产构建不读取该文件。预设会随开发页面下发，能够访问开发服务的浏览器可以使用该身份；真实 token 不应提交到仓库。

## 测试与行为约定

修改前以[需求与边界](docs/requirements.md)为准；需求记录产品行为，其他文档分别描述尺寸、组件所有权与请求时机，避免同一规则多处维护。回归测试随实现放置，关键覆盖包括分页范围、导航生命周期、滚动锚点、队列顺序/撤回、媒体取消和通知去重。

单元测试使用 `src/test-providers.ts` 的 HTTP 与弹窗替身。测试拦截 HTTP、WebSocket 和上传，禁止生产写入与 S3 测试上传等约定见[代码约定](AGENTS.md)；必须实测写入时，使用 `node runspace/dev.mjs dev` 启动本地前后端。`npm run dev:online` 连接生产，不能用于写入测试。

## CI 与发布

根目录 `Jenkinsfile` 中的 PWA 检查针对 `pwa/`，执行 Angular 构建、单元测试和独立 Worker/启动更新测试；`npm run test:ci` 使用 Angular 的 CI 配置，一次性运行并同时输出终端结果与 `test_output/unit.xml`（相对于 `pwa/`）。开发时的 `npm test` 保留默认交互行为。后端使用独立的检查阶段。PWA 检查与产物构建均使用 `node:22.22.3-bookworm`。

`chahua/chahua-pwa-build` 使用 `ci/Jenkinsfile.pwa-build`，按上游传入的 `GIT_COMMIT_SHA` 检出源代码；手动构建未指定时使用 `origin/main`。同一次检出生成两个 ZIP，均使用 `PWA2-构建号`，归档根目录包含 `index.html`、`.htaccess` 和 Worker 文件，不包含外层 `browser/` 目录。

| 归档 | 构建目录 | 用途 |
| --- | --- | --- |
| `pwa/chahua-staging.zip` | `pwa/dist/app/browser` | 同源 staging |
| `pwa/chahua-prod.zip` | `pwa/dist/prod/browser` | 跨域生产 |

根目录的 `pwa-artifact-metadata.json` 记录检出提交和构建信息。产物构建自动触发 `chahua/deploy/pwa-staging-deploy`；生产部署保持手动选择 `PWA_BUILD`。两个部署任务的参数项目均为 `chahua/chahua-pwa-build`，`copyArtifacts` 的过滤器分别为：

```groovy
// Staging
filter: 'pwa/chahua-staging.zip,pwa-artifact-metadata.json'
// Production
filter: 'pwa/chahua-prod.zip,pwa-artifact-metadata.json'
```

生产页面域和资源域共用生产 rsync 部署目录，不发布 PWA 容器镜像。直接向站点目录执行 `rsync --delete` 不是原子发布，且会删除旧构建资源；部署侧应遵守前述完整版本发布与旧资源保留约定。

## API 生成

```bash
npm run api:generate
```

Orval 默认读取当前 worktree 的 `runspace/.env` 中的 `API_PORT`，访问对应本地后端的 `/api-docs/openapi.json`；请先启动该后端。环境变量 `OPENAPI_URL` 优先级更高，可以指定其他规格 URL 或本地文件，无需本地 runspace 配置。

`src/generated/endpoints/` 包含按标签生成的 HttpClient 服务与 resource，`src/generated/models/` 包含模型，共用模型位于 models 根目录。`scripts/api-codegen.ts` 负责契约转换、Snowflake 类型和 JSON 编解码元数据。生成文件随仓库保存，修改来源是 OpenAPI 与生成配置；普通构建无需运行后端。

应用中的业务 ID 使用 `SnowflakeID` 品牌类型，路由和协议边界负责精确转换；用户 UID、计数和日期游标保留各自类型。数值 ID 编码是性能选择，普通 UID 不参与编码。可选字段在 TypeScript 中声明为 `field?: T`，运行时的 `null` 原样保留，使用可选链、空值合并等自然消费。`UpdateChatBody.avatarImageId` 与 `PatchInviteBody.expiresAt` 显式声明请求 `null`，用于清除字段。

启动前错误页面可通过 `npm run preview:startup-failures` 在本地逐项模拟，具体步骤见[启动页面手动验证](docs/startup-verification.md)。

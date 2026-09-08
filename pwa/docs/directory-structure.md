# 目录结构

工程按功能组织。功能目录容纳状态、操作和工具；每个组件独占一个子目录，组件的 TypeScript、HTML、SCSS 和测试文件放在一起。简单组件可使用内联模板或样式。

```text
src/
├── main.ts                       Angular、Ionic、路由、HTTP 和 Service Worker 配置
├── index.html                    HTML 入口、启动占位和系统主题色
├── styles.scss                   Ionic 样式、公共消息布局与操作反馈样式
├── generated/
│   ├── endpoints/                Orval 按标签生成的 HTTP 服务和 resource
│   ├── models/                   按标签生成的模型，共用模型位于根目录
│   └── json-codecs.ts            根据契约生成的 ID 编解码路径
└── app/
    ├── app/                      App 组件：根布局、身份初始化与桌面列表选择
    ├── app.routes.ts             应用路由配置
    ├── app.routes.spec.ts        路由测试
    ├── api/                      Connection、HTTP 拦截器、ID 边界、查询工具和测试辅助
    ├── session/                  SessionStore
    ├── chats/                    ChatStore、ChatPins、ChatListStore、分类与日期格式
    │   ├── chat-list-page/        移动端路由页面与 Ionic 生命周期
    │   ├── chat-list/             分类、混合排序与列表渲染
    │   ├── chat-list-item/        通用列表项与局部操作反馈
    │   ├── chat-avatar/           列表与资料共用的可缩放头像、话题角标
    │   ├── start-chat/            创建、加入、添加好友入口
    │   ├── directory-search/      群组与用户搜索
    │   ├── user-profile/          用户资料与好友关系操作
    │   ├── chat-details/          聊天资料及子视图
    │   ├── chat-members/          成员搜索与管理
    │   ├── chat-invites/          邀请管理与分享
    │   └── chat-link/             链接解析和导航
    ├── conversations/            ConversationStore、导航、草稿、消息分组与滚动工具
    │   ├── conversation/         连续消息页面
    │   ├── pinned-messages/       置顶消息页面
    │   ├── saved-messages/        全部或单聊天收藏及快照展示
    │   ├── chat-search/           聊天内消息搜索
    │   └── chat-attachments/      聊天附件汇总
    ├── messages/                 MessageActions、事件类型、合并、表态与媒体规则
    │   ├── message/              消息气泡与手势
    │   ├── message-text/         提及和链接展示
    │   ├── message-composer/     输入、下方面板、附件及提及编辑工具
    │   ├── voice-recorder/       录音手势、计时与本地预览
    │   ├── media-processing/     图片／视频压缩、HEIC 转换和动图保护
    │   ├── sticker-picker/       贴纸选择、收藏与订阅
    │   ├── media-viewer/         图片查看器
    │   ├── upload.ts             可移交的附件上传任务、媒体尺寸与签名上传
    │   ├── message-outbox.ts      待发队列、服务器确认与失败重试
    │   ├── message-status.ts      消息时间后的发送状态图标
    │   ├── message-author/        作者展示
    │   ├── message-attachments/   附件展示与媒体类型判断
    │   ├── message-menu/          菜单、确认、操作反馈与权限展示
    │   ├── message-preview/       消息摘要
    │   ├── message-reactions/     表态按钮
    │   ├── message-thread/        话题入口
    │   └── emoji-picker/          按需加载的表情选择器
    ├── settings/
    │   ├── preferences.ts        本地展示偏好
    │   ├── settings/             设置主页面
    │   ├── settings-modal/        设置弹窗与浏览器历史
    │   ├── general-settings/      通用设置
    │   └── friend-verification-settings/ 好友验证表单
    └── pwa/                      AppUpdates、PushNotifications
```

## 文件边界

- `src/generated/` 是生成代码，`src/app/` 是手写应用代码。应用直接引用生成客户端与模型。
- `api/snowflake-id.ts` 定义数值 ID 编码，`api/json-ids.ts` 按生成路径转换 JSON 中的 ID。`scripts/api-codegen.ts` 处理契约与生成规则，不做运行时空值转换。
- `chats/` 关注聊天关系、共享资料和列表；`conversations/` 关注消息页面及连续消息区间；`messages/` 关注单条消息的展示、操作与内容规则。三个目录按关注范围组织，状态所有权由数据的消费者与生命周期决定。
- `ChatPins` 位于 `chats/`，置顶页面位于 `conversations/`；`MessageActions`、表态规则和表情选择器位于 `messages/`。消息的日期分隔与连续作者分组由 `conversations/message-rows.ts` 处理。
- `ChatStore` 持有共享聊天资料、摘要、已读、订阅与置顶；`ChatListStore` 持有列表成员、分页、好友请求及计数查询；`ConversationStore` 仅持有所在页面的连续消息区间。
- `ChatPins` 是 `ChatStore` 内部按聊天/话题缓存的普通对象，封装一份置顶集合及其请求。它不提供独立注入作用域。
- `MessageMenu` 接收页面的消息数组，使用 `ChatStore` 查询权限和置顶，使用自身提供的 `MessageActions` 执行收藏、撤回和表态。
- `SavedMessagesPage` 自己持有分页快照，`savedMessageContent` 映射展示字段。`PinnedMessagesPage` 消费共享置顶集合。两个页面复用 `Message` 展示组件。
- 页面直接渲染消息列表和日期，公共布局使用 `src/styles.scss` 中的 `.message-list`、`.message-date`；内容背景由页面设置。
- `app/` 子目录只包含根组件的 TypeScript、HTML、SCSS 和测试；应用路由及其测试位于外层。所有路由页面静态导入，通过 `component` 配置，不启用路由懒加载或预加载；表情选择器使用独立的 `@defer`。
- 测试随实现放置，组件和状态直接通过具体文件导入。

根目录保存构建配置，`scripts/` 保存开发和生成脚本，`public/` 保存静态资源及推送 Worker，`docs/` 描述工程当前状态。服务的注入作用域见[数据流](data-flow.md)，组件间关系见[Components](components.md)。

资料表单、搜索结果、成员和邀请分页由消费它们的组件局部持有，不进入 ChatStore。会话资料使用内联 IonModal，其他弹窗由 Ionic ModalController 创建，`useSetInputAPI` 支持 signal inputs。所有页面和弹窗使用静态组件引用；既有 EmojiPicker 保留 `@defer`。

`src/test-providers.ts` 提供测试用路由、HTTP mock 和弹窗替身；测试不会使用开发 token 或生产代理。

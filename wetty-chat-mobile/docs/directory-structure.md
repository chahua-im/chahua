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
│   └── json-codecs.ts            根据契约生成的 JSON 编解码元数据
└── app/
    ├── app.*                     根布局、登录启动状态与路由
    ├── api/                      Connection、HTTP 拦截器、ID/JSON 边界、查询工具和测试辅助
    ├── session/                  SessionStore
    ├── chats/                    ChatStore、ChatListStore、列表分类与日期格式
    │   ├── chat-list-page/        路由页面与 Ionic 生命周期
    │   ├── chat-list/             分类、混合排序与列表渲染
    │   └── chat-list-item/        通用列表项与局部操作反馈
    ├── conversations/            ConversationStore、MessageActions、导航、草稿和滚动工具
    │   ├── conversation/         ConversationPage
    │   └── conversation-collection/ 收藏与置顶共用页及收藏内容适配
    ├── messages/                 消息合并、事件类型、媒体规则和用户颜色
    │   ├── message/              消息气泡与手势
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
- `api/snowflake-id.ts` 是手写代码和生成客户端共用的 ID 边界，`scripts/api-codegen.ts` 是生成工具。
- `ChatListStore` 管理列表、计数、已读和订阅；`ChatStore` 管理聊天资料；`ConversationStore` 管理当前页面的消息区间和置顶状态。
- `MessageMenu` 是消息操作的界面协调组件，通过页面作用域的 `ConversationStore` 和自身提供的 `MessageActions` 执行操作。消息气泡、摘要、附件等展示组件通过输入输出通信。
- `savedMessageContent` 把收藏快照转换成 `Message` 的展示字段，收藏来源和取消收藏操作属于集合页。
- 页面直接渲染消息列表和日期，公共布局使用 `src/styles.scss` 中的 `.message-list`、`.message-date`；内容背景由页面设置。
- 测试随实现放置，组件和状态直接通过具体文件导入。

根目录保存构建配置，`scripts/` 保存开发和生成脚本，`public/` 保存静态资源及推送 Worker，`docs/` 描述工程当前状态。服务的注入作用域见[数据流](data-flow.md)，组件间关系见[Components](components.md)。

# 目录结构

目录按业务关注范围划分，组件按实体集中。`conversation/` 是一个具体组件的目录，`conversations/` 是连续消息页面这一类功能；不把组件的四个文件散在分类根目录。

```text
pwa/
├── AGENTS.md / README.md       代码约定、开发与文档入口
├── docs/                      产品约定、架构与外观
├── scripts/                   开发启动、API 生成与 Worker 测试
├── public/                    静态资源、推送 Worker
├── orval.config.ts            生成入口与 splitByTags 配置
└── src/
    ├── main.ts                Angular、Ionic、HTTP、路由与 Worker 配置
    ├── index.html             启动占位、系统主题和静态入口
    ├── styles.scss            框架入口、主题、文字层级与公共样式
    ├── generated/
    │   ├── endpoints/         按标签生成的客户端与 resource
    │   ├── models/            按标签组织的模型，共用模型位于根目录
    │   └── json-codecs.ts      ID 编解码路径
    └── app/
        ├── app/               App 根组件的模板、逻辑、样式和测试
        ├── app.routes.ts      所有路由的静态导入
        ├── api/               Connection、拦截器、ID 编码、查询与测试工具
        ├── session/           SessionStore
        ├── scrolling/         悬浮滚动条、首屏补页、触摸和惯性状态
        ├── chats/             聊天关系、列表与信息
        ├── conversations/     连续消息、收藏和置顶页面、草稿与导航
        ├── messages/          单条消息、输入、队列、附件和媒体
        ├── settings/          设置页面、本地偏好与设置历史
        └── pwa/               安装、应用更新、通知和静音提醒规则
```

## 三个业务范围

| 目录          | 共享逻辑                                                                                                | 组件范围                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| chats         | ChatStore、ChatListStore、ChatPins；分类、日期、邀请与弹窗关闭工具                                      | ChatListPage → ChatList → ChatListContent → ChatListItem；头像、资料、群话题/成员/附件、搜索、邀请、静音、好友资料、创建/加入与旧链接入口 |
| conversations | ConversationStore、DraftStore、ConversationNavigation；messageRows 分组                                 | ConversationPage、PinnedMessagesPage、SavedMessagesPage；收藏快照转换放在收藏组件旁                                                       |
| messages      | MessageOutbox、MessageActions、AttachmentUpload；发送状态、变化协议、区间合并、表态、作者配色与媒体规则 | Message 及作者/正文/预览/附件/表态等子组件；Composer、菜单、贴纸、录音/播放、全屏媒体与压缩                                               |

信息页的成员、话题、媒体、搜索和邀请组件属于 `chats`；显示一组搜索结果不等于管理连续的消息区间。收藏与置顶页面复用 Message，不继承 ConversationPage。组件详细树与字段见[组件](components.md)。

## 放置与依赖规则

- 每个组件独占子目录；HTML、SCSS、测试随组件放置。短模板/样式可以内联，不为满足文件数量拆分。
- 应用共享资料、列表查询、页面连续消息是不同生命周期，不合并成一个总 Store；具体所有权见[数据流](data-flow.md)。
- ChatPins 是 ChatStore 内部的普通对象，MessageActions 是菜单提供的操作集合；无跨组件状态的逻辑用函数，不为每个 API 单独增加手写服务。
- 用户显示色在 `messages/user-colors.ts`，沿用旧版用户名 hash；用户组色由 MessageAuthor 直接消费后端字段。发送状态是纯枚举，队列不依赖图标组件。
- 不同协议的分页由对应组件持有游标，仅共享 `fillScrollViewport` 这种 DOM 行为；不使用通用分页页面、继承层级或全局搜索结果 Store。
- `scrolling` 不知道聊天或消息模型；`api` 只负责边界与通用请求机制，不持有业务页面状态。
- `src/generated` 只保存生成代码。`scripts/api-codegen.ts` 处理契约与生成规则，`api/snowflake-id.ts` 和 `api/json-ids.ts` 处理运行时边界；不转换 null/undefined。生成代码随仓库保存，普通构建不要求后端运行。
- 所有路由静态导入；非路由的表情选择器和编解码资源可以延迟加载。没有额外的通用 utils、messaging 总目录或 Service 包装层。

## 样式、测试和文档

公共主题、字体角色、消息列表/日期和加载反馈在 `styles.scss`；组件内只保留其特有几何和状态样式。Ionic 的 shadow/scoped 控件与第三方库样式通过公开变量或 part 调整，归属见[外观](appearance.md#样式归属)。

测试随实现放置，`src/test-providers.ts` 提供 HTTP、路由与弹窗替身。推送 Worker 的测试位于 `scripts/push-worker.test.mjs`，不运行真实推送或上传。

文档分工由 README 索引：需求描述产品行为，数据流描述请求与一致性，组件描述输入输出和字段，外观描述尺寸与 CSS，加载反馈描述等待时如何显示。协议边界和不做的功能集中在[需求](requirements.md)。

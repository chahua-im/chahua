# 目录结构

工程按关注范围组织：`chats` 负责聊天关系和列表，`conversations` 负责连续消息页面，`messages` 负责单条消息、输入和媒体。每个组件独占子目录，模板、样式和测试随组件放置；很短的模板与样式可以内联。

```text
src/
├── main.ts                        Angular、Ionic、HTTP、路由与 Service Worker 配置
├── index.html                     启动 spinner、系统主题和静态入口
├── styles.scss                    框架入口、主题、公共消息布局与操作反馈
├── generated/
│   ├── endpoints/                 Orval 按标签生成的客户端与 resource
│   ├── models/                    生成模型，共用模型位于根目录
│   └── json-codecs.ts             ID 编解码路径
└── app/
    ├── app/                       App 根组件
    ├── app.routes.ts              静态路由
    ├── api/                       Connection、拦截器、ID 编码、查询工具与测试辅助
    ├── session/                   SessionStore
    ├── scrolling/                 悬浮滚动条、首屏补页、触摸与惯性状态
    ├── chats/
    │   ├── chat-store.ts          共享聊天资料、摘要、已读、好友关系与订阅
    │   ├── chat-list-store.ts     列表成员、分页、好友请求与计数查询
    │   ├── chat-pins.ts           ChatStore 内部的置顶集合
    │   ├── invite.ts              邀请码解析与邀请状态
    │   ├── list-tabs.ts           列表分类与路由选择
    │   ├── chat-date.pipe.ts      聊天列表时间格式
    │   ├── dismiss-chat-overlays.ts  导航前关闭资料弹窗
    │   ├── chat-list-page/        单列路由页面与生命周期
    │   ├── chat-list/             列表内容与混合排序
    │   ├── chat-list-item/        通用列表行与操作反馈
    │   ├── chat-avatar/           可缩放头像、话题角标与占位
    │   ├── chat-details/          资料面板及子视图选择
    │   ├── chat-threads/          聊天内的话题列表
    │   ├── chat-members/          群成员搜索与管理
    │   ├── chat-attachments/      聊天媒体汇总
    │   ├── chat-search/           聊天内消息搜索
    │   ├── chat-invites/          邀请管理
    │   ├── chat-mute/             静音时长菜单
    │   ├── user-profile/          用户资料与好友操作
    │   ├── directory-search/      用户、群搜索与用户选择
    │   ├── start-chat/            创建群、加入群和添加好友入口
    │   └── chat-link/             消息、用户、贴纸与邀请链接入口
    ├── conversations/
    │   ├── conversation-store.ts  页面连续消息区间
    │   ├── conversation-navigation.ts  同一会话的即时导航指令
    │   ├── draft-store.ts         按账号、聊天和话题保存草稿
    │   ├── message-rows.ts        日期与连续作者分组
    │   ├── conversation/          连续消息页面、编辑与滚动锚点
    │   ├── pinned-messages/       置顶消息页面
    │   └── saved-messages/        收藏快照页面与字段映射
    ├── messages/
    │   ├── message-outbox.ts      待发、编辑、撤回与重试
    │   ├── message-delivery.ts    发送状态枚举
    │   ├── message-actions.ts     收藏、撤回与表态操作
    │   ├── upload.ts              可移交、取消与重试的上传任务
    │   ├── message-change.ts      消息变化协议
    │   ├── message-merge.ts       消息区间合并
    │   ├── media-overlay.ts       媒体时间戳样式规则
    │   ├── user-colors.ts         UID 配色与用户组颜色
    │   ├── reaction-state.ts      表态合并与限制
    │   ├── message-notice.ts      操作结果枚举
    │   ├── message/              气泡、消息手势与子组件装配
    │   ├── message-author/       用户名、用户组与性别
    │   ├── message-text/         提及和链接
    │   ├── message-preview/      正文、媒体和系统消息摘要
    │   ├── message-reactions/    表态按钮与头像
    │   ├── message-thread/       讨论入口
    │   ├── message-status/       发送状态图标
    │   ├── message-attachments/  附件展示与类型判断
    │   ├── message-menu/         长按菜单、确认与操作反馈
    │   ├── message-composer/     输入、提及编辑与附件/贴纸面板
    │   ├── voice-recorder/       录音设备与手势
    │   ├── voice-player/         波形语音播放器
    │   ├── sticker-picker/       贴纸浏览、收藏、订阅与上传
    │   ├── reaction-details/     完整表态名单
    │   ├── invite-card/          邀请预览
    │   ├── media-viewer/         全屏图片与视频
    │   ├── media-processing/     类型检测、尺寸读取与压缩
    │   └── emoji-picker/         按需加载的表情选择器
    ├── settings/
    │   ├── preferences.ts        本地偏好与最近表情
    │   ├── settings/             设置主页
    │   ├── settings-modal/       弹窗和浏览器历史
    │   ├── general-settings/     展示偏好
    │   └── friend-verification-settings/  好友验证表单
    └── pwa/
        ├── app-updates.ts        应用更新
        ├── push-notifications.ts 在线提醒、Push 注册、通知跳转与角标
        ├── notification-policy.ts  提醒规则与通知纯文本
        ├── notification-banner/ 单列布局的顶部通知
        └── landing/             旧版安装指引
```

`src/generated` 仅保存生成代码。`scripts/api-codegen.ts` 处理契约与生成规则，`api/snowflake-id.ts` 和 `api/json-ids.ts` 处理运行时 ID 边界；不转换 null/undefined。生成文件随仓库保存，普通构建无需运行后端。

`scrolling` 只包含 DOM 与滚动工具，不持有聊天数据。聊天资料的成员、话题、媒体、搜索和邀请组件与 `ChatDetails` 同在 `chats`；只有连续消息、收藏和置顶页面属于 `conversations`。

共享数据按生命周期放置，不按每个 API 拆服务。ChatPins 是普通对象；MessageActions 是操作集合；MessageDelivery 是纯枚举，队列不依赖状态图标组件。分页协议不同的组件直接持有局部游标，不使用通用分页框架或页面继承。

根目录保存构建配置，`scripts` 保存开发与生成脚本，`public` 保存静态资源和推送 Worker。测试随实现放置，`src/test-providers.ts` 提供 HTTP、路由与弹窗替身。所有路由静态导入，非路由的表情和编解码资源可按需加载。

状态所有权和请求时机见[数据流](data-flow.md)，父子传递和字段见[组件](components.md)。

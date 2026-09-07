# 数据流

客户端通过生成的 HTTP 客户端和一个 WebSocket 连接访问后端。列表和跨页面资料存于应用共享服务；连续消息区间属于页面；菜单、滚动、表单和操作反馈属于组件。

## 状态所有权

| 所有者                         | 作用域与持有数据                                                                      | 消费者                                    |
| ------------------------------ | ------------------------------------------------------------------------------------- | ----------------------------------------- |
| SessionStore                   | 应用：token、当前用户                                                                 | App、认证拦截器、Connection、用户相关组件 |
| Connection                     | 应用：连接、心跳、重连和最近 256 个新消息 ID                                          | 列表、聊天资料、消息区间和页面            |
| ChatListStore                  | 应用：普通/归档聊天与话题列表、好友请求、归档计数、已读与订阅状态                     | ChatList、ConversationPage                |
| ChatStore                      | 应用：按 chatId 缓存 kind、name、avatar、peer、myRole，以及基础资料和权限详情的有效性 | 列表、页面标题、消息菜单                  |
| DraftStore                     | 应用与 localStorage：按账号及 chatId/threadId 保存文字、回复目标 ID、保存时间         | 列表预览和对话输入                        |
| Preferences                    | 应用与 localStorage：消息页话题开关、全部头像开关                                     | ChatList、页面、设置                      |
| ConversationStore              | 每个对话页/集合页：消息区间、双向游标、加载状态、待应用补丁、置顶列表与请求上下文     | 所在页面、MessageMenu                     |
| MessageActions                 | 每个 MessageMenu：收藏、撤回、表态的请求操作；不持有消息缓存                          | MessageMenu                               |
| ConversationNavigation         | 应用：即时导航指令流，不缓存页面数据                                                  | ChatList 发出，当前 ConversationPage 接收 |
| AppUpdates / PushNotifications | 应用：更新与通知订阅状态                                                              | 设置页面                                  |

组件持有的详细字段和父子传递关系见 [Components](components.md)。

```mermaid
flowchart TD
  HTTP[Orval HTTP 客户端] --> LISTS[ChatListStore]
  HTTP --> CHAT[ChatStore]
  HTTP --> STORE[ConversationStore]
  WS[WebSocket] --> CONNECTION[Connection]
  CONNECTION -->|列表摘要与刷新| LISTS
  CONNECTION -->|资料失效| CHAT
  CONNECTION -->|编辑、撤回、表态、置顶、话题统计| STORE
  CONNECTION -->|新消息与重连| PAGE[ConversationPage]
  LISTS -->|列表、计数| LIST[ChatList]
  LISTS -->|读位置与订阅| PAGE
  CHAT -->|名称、头像| LIST
  CHAT -->|标题| PAGE
  CHAT -->|权限| MENU[MessageMenu]
  DRAFT[DraftStore] -->|预览与排序时间| LIST
  PAGE <-->|编辑与恢复| DRAFT
  PAGE -->|打开、分页、新消息| STORE
  STORE -->|消息与置顶| PAGE
  STORE -->|所选消息、置顶状态| MENU
  PAGE -->|选中消息、表态点击| MENU
  MENU -->|回复、打开话题| PAGE
  MENU -->|setPinned| STORE
  MENU -->|收藏、撤回、表态| ACTIONS[MessageActions]
  STORE -->|置顶写结果| CONNECTION
  ACTIONS -->|消息变化| CONNECTION
  ACTIONS -->|写请求| HTTP
  PAGE -->|已读与订阅操作| LISTS
  PAGE -->|发送成功| CONNECTION
  PAGE --> VIEW[Message 及展示子组件]
  VIEW -->|输入事件| PAGE
```

集合页使用独立的 `ConversationStore`，不共享其他对话页的消息区间或置顶缓存。它的置顶消息菜单使用相同的数据和操作路径；收藏分页与取消收藏由集合页自己管理。

## 协议与本地存储

请求基地址是 `/_api`。`SessionStore.initialize()` 依次检查 URL token、localStorage 和开发预设，执行 `POST /auth/refresh` 与 `GET /users/me`。启动加载和错误由 App 持有，身份就绪后显示业务页面。开发预设的配置见 [README](../README.md)。

业务 ID 使用 `SnowflakeID` 品牌类型：有限、非零、可排序的 number，可以无损表示非负 i64。HTTP 与 WS 响应在边界编码；路由输入使用 `encodeId`，链接和协议输出使用 `decodeId`。普通 UID、计数和日期游标不参与这种转换。

HTTP 和 WS 的可选响应字段规范为 `undefined`，同时保留显式字段键，使响应能够清除缓存里的旧值。请求中用于清除头像或过期时间的协议级 `null` 保留。生成的 `json-codecs.ts` 为 JSON 转换提供类型路径。

消息、列表和资料缓存保存在内存。token、展示偏好和草稿保存在 localStorage。Service Worker 缓存应用资源和表情数据，没有 API 数据缓存或离线消息数据库。

## 请求时机

下表省略 `/_api`。`c` 表示 chatId，`t` 表示 threadRootId，`m` 表示 messageId。

### 列表与计数

| 触发条件                           | 请求                                                      | 数据流向                                        |
| ---------------------------------- | --------------------------------------------------------- | ----------------------------------------------- |
| 激活需要聊天的分类，查询已失效     | `GET /chats?limit=50`；归档页加 `archived=true`           | ChatListStore → ChatList；群组/好友由 kind 过滤 |
| 聊天列表续页                       | 同接口加 `after=游标`                                     | 合并到同一查询                                  |
| 激活话题 tab，或消息 tab 开启话题  | `GET /threads?limit=20&archived=false或true`              | ChatListStore → ChatList                        |
| 话题列表续页                       | 同接口加 `before=时间游标`                                | 合并到同一查询                                  |
| 消息/好友分类展示活跃好友请求      | `GET /friends/requests?archived=false`                    | ChatListStore → ChatList                        |
| 打开好友请求历史页                 | `GET /friends/requests?archived=true`                     | 独立历史查询；前端没有续页操作                  |
| 普通分类展示归档角标               | `GET /chats/unread`；需要话题时再取 `GET /threads/unread` | 只激活当前分类消费的计数                        |
| 话题行缺少所属聊天资料             | 每个未缓存 chatId 调用 `GET /group/{c}`                   | ChatStore → 行头像、名称、聊天类型              |
| 下拉刷新、前台恢复、重连或相关推送 | 查询失效；有消费者时请求，无消费者时等待下次激活          | 共享查询及资料缓存                              |

群组与好友分类都显示后端返回的**归档对话未读消息总数**。消息分类在显示话题时叠加归档话题未读消息数；话题分类只显示话题计数。

“已归档”入口在主列表固定存在；好友分类还固定显示“好友请求”历史入口。入口不依赖计数或历史列表成功加载。归档明细和好友请求历史只在进入对应页面时加载。

### 对话与已读

| 触发条件                                     | 请求                                                         | 结果用途                                    |
| -------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------- |
| 进入对话，基础资料无有效缓存                 | `GET /group/{c}`                                             | ChatStore → 标题                            |
| 普通对话恢复，已读状态无有效缓存             | `GET /chats/{c}/unread`                                      | 页面决定打开位置                            |
| 话题恢复，列表无有效读位置                   | `GET /chats/{c}/threads/{t}/read-state`                      | 页面决定打开位置                            |
| 当前话题缺少订阅状态                         | `GET /chats/{c}/threads/{t}/subscribe`                       | ChatListStore → 订阅/归档按钮               |
| 打开消息区间                                 | `GET /chats/{c}/messages?max=50`，按需加 `around=m`          | ConversationStore → 页面消息行              |
| 加载历史/后续消息                            | 同接口加 `before=olderCursor` 或 `after=newerCursor`         | 同一连续消息区间；话题读取均带 `threadId=t` |
| 点击引用、消息链接或置顶预览，目标未在区间内 | 同消息接口加 `around=m`                                      | 精确定位；不存在时保留当前区间并提示        |
| 恢复草稿的回复预览                           | `GET /chats/{c}/messages/{m}`                                | 页面回复预览；读取失败时文字仍可编辑        |
| 页面活跃可见，消息底部进入视口               | `POST /chats/{c}/read` 或 `POST /chats/{c}/threads/{t}/read` | 1 秒合并读目标，响应更新已读状态与角标      |
| 用户标记未读                                 | `POST /chats/{c}/unread`                                     | 与正在发送的已读操作协调，应用后端结果      |
| 位于最新区间时重连                           | 消息接口加 `after=当前最后ID`，最多补一页                    | 其余空隙通过后续分页补齐                    |

页面进入时固定未读边界。短尾部可直接定位最新，较长的未读区间定位到未读分隔线；切换到最新位置或精确消息使用同一页面导航操作。

### 消息操作与设置

| 操作                   | 请求与状态归属                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 打开消息菜单           | MessageMenu 调用 ChatStore.ensureDetails 和 ConversationStore.ensurePins；必要时读取 `GET /group/{c}` 和当前范围的 pins      |
| 读取置顶               | `GET /chats/{c}/pins` 或 `GET /chats/{c}/threads/{t}/pins`；ConversationStore 持有                                           |
| 置顶/取消置顶          | ConversationStore.setPinned 发出同范围 pins 的 POST 或 `DELETE .../pins/{pinId}`，发布置顶变化                               |
| 收藏                   | MessageActions：`PUT /saved-messages/{m}`                                                                                    |
| 撤回                   | MessageActions：`DELETE /chats/{c}/messages/{m}`，成功后发布消息删除事件                                                     |
| 添加/取消表态          | MessageActions 立即发布个人选择，再 `PUT/DELETE /chats/{c}/messages/{m}/reactions/{emoji}`                                   |
| 查看收藏/续页          | 集合页：`GET /saved-messages?limit=50`，续页加 `before=游标`                                                                 |
| 取消收藏               | 集合页：`DELETE /saved-messages/by-id/{savedId}`                                                                             |
| 发送文字               | 页面：`POST /chats/{c}/messages` 或 `POST /chats/{c}/threads/{t}/messages`；成功结果进入 Connection                          |
| 聊天归档/恢复          | ChatListStore：`PUT/DELETE /chats/{c}/archive`；更新列表和计数                                                               |
| 聊天静音/恢复          | ChatListStore：`PUT/DELETE /group/{c}/mute`；更新列表和计数                                                                  |
| 话题订阅               | ChatListStore：`PUT /chats/{c}/threads/{t}/subscribe`                                                                        |
| 话题归档/恢复          | ChatListStore：`PUT/DELETE /chats/{c}/threads/{t}/archive`                                                                   |
| 接受/拒绝/归档好友请求 | ChatListStore：`POST .../requests/{id}/accept`、`POST .../reject`、`PUT .../archive`；操作后刷新请求列表，接受还刷新聊天列表 |
| 打开/保存好友验证设置  | 表单组件：`GET/PUT /friends/me/settings`                                                                                     |
| 打开设置，检查通知订阅 | PushNotifications：读取浏览器订阅；存在时 `GET /push/subscription-status?endpoint=...`                                       |
| 开启通知               | 浏览器授权、必要时 `GET /push/vapid-public-key`，创建浏览器订阅并 `POST /push/subscribe`                                     |
| 关闭通知               | `POST /push/unsubscribe`，随后取消浏览器订阅                                                                                 |
| 检查更新               | AppUpdates 调用 Angular Service Worker 更新检查，不经过业务 API                                                              |

## 分页与缓存规则

聊天与话题查询对组件提供 `items`、`loading`、`loadingMore`、`hasMore`、`loadedThrough`、`activate`、`refresh`、`loadMore`。游标由各自实现持有。聊天错误使用 `ChatListError` 区分首次读取、已读、近期刷新和续页；话题与好友请求使用错误标志。

查询按普通/归档范围共享缓存和进行中的请求。最后一个消费者释放时取消列表读取。刷新从第一页读取到已加载的条目数量或列表末尾；结果齐备后整体替换，刷新期间保留内容。

只有“消息”tab 且开启“在消息中显示话题”时使用共同覆盖范围。两个来源记录服务器最后一页覆盖到的时间，未加载为 `Infinity`，加载到底为 `-Infinity`；混合列表展示时间不早于两个边界较新者的行。触底只补覆盖较浅的来源，边界相同则一起补。群组、好友、话题 tab 独立展示和分页。

列表初次显示或切换分类时等待该分类的列表请求结束，已有局部缓存也参与这一等待。后续刷新保留列表节点。固定入口和独立角标不参与首次内容等待。

消息采用普通 DOM 列表，每页最多 50 条，不使用虚拟列表。距离边缘不足 1.5 个视口时预取，同一时间只加载一个方向。历史页等待手指离开且滚动惯性停止后合并，保持首条可见消息底部的视口位置；这一锚点覆盖相同作者分组时作者栏消失的高度变化。媒体尺寸在资源加载前预留，缺尺寸的媒体使用固定回退框。

## 实时事件与一致性

| 事件                                                      | 消费与更新                                                                                                                                          |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| message                                                   | Connection 对 HTTP 成功与 WS 回声按 ID 去重；ChatListStore 更新列表预览和未读，当前页面筛选所属对话并交给 ConversationStore；是否跟随底部由页面决定 |
| messageUpdated / messageDeleted / messagesBulkDeleted     | ChatListStore 更新摘要与必要查询；ConversationStore 更新消息区间和置顶内容，进行中的消息读取保留事件补丁                                            |
| reactionUpdated                                           | ConversationStore 更新消息与置顶表态；广播未带个人选择时保留已知 reactedByMe                                                                        |
| pinAdded / pinRemoved / threadPinAdded / threadPinRemoved | ConversationStore 按聊天/话题范围更新置顶列表                                                                                                       |
| threadUpdate                                              | ConversationStore 更新根消息的话题统计；ChatListStore 刷新话题列表与计数                                                                            |
| threadMembershipChanged                                   | 订阅缓存失效，当前话题页面补取订阅状态，列表和话题计数刷新                                                                                          |
| friendRequestReceived / friendRequestResolved             | 好友请求查询失效；接受请求还刷新聊天列表                                                                                                            |
| chatArchiveStateChanged                                   | 更新聊天归档/静音字段，刷新列表与聊天归档计数                                                                                                       |
| friendshipRemoved                                         | 刷新聊天归档计数                                                                                                                                    |
| 首次 presenceUpdate、恢复前台                             | Connection 发出 resync，活跃查询刷新，聊天资料失效，当前页面补取需要的数据                                                                          |

Connection 维护一条认证连接，每 10 秒发送心跳。重连采用有上限的退避；页面恢复前台时检查连接新鲜度。历史消息区间在重连时不做后台重验，断线期间的编辑、撤回和表态变化可能在重新打开区间后才可见。

`presenceUpdate` 用于连接握手和心跳，没有在线用户列表消费者。`stickerPackOrderUpdated` 经 Connection 转发，界面没有消费该事件。

没有对应推送的信息依靠操作响应、页面进入时的必要读取、手动刷新和 resync 更新。收藏是保存时的快照；好友验证设置进入时读取；展示偏好和草稿为本地数据。表态操作即时更新本地选择，服务端广播更新总数；失败显示操作提示，不额外读取消息详情或自动回滚。

已读与预览覆盖记录用于保护比进行中的列表响应更新的状态；列表吸收后释放。消息页中的事件补丁用于防止进行中的快照覆盖事件结果，不构成全局消息仓库。

## 页面生命周期

Ionic 可以保留离开的页面实例。页面离开时重置 ConversationStore、取消消息/置顶/收藏读取、清空菜单与当前输入展示并释放已读持有者；DraftStore 中的持久草稿保留。组件销毁也执行清理。[Ionic 页面生命周期](https://ionicframework.com/docs/angular/lifecycle)

写操作不会因为页面离开而主动取消；组件销毁时由 DestroyRef 结束其请求。异步结果使用上下文或版本检查，防止旧页面操作覆盖新的 UI。MessageMenu.reset 清空菜单、确认和提示，正在结束的旧操作不会向新页面展示结果。

草稿输入和回复选择同步到 DraftStore；发送成功只清除仍对应这条发送请求的草稿。列表用消息活动时间与草稿保存时间中的较新者排序，未加载的聊天不会因本地草稿而单独创建列表行。

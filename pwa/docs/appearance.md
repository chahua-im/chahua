# 外观与样式边界

Ionic iOS 模式负责 toolbar、列表、按钮、modal、popover、segment 和 spinner。应用 CSS 负责聊天特有的内容形状与布局，不为每个页面重新定义同类 Ionic 控件的颜色。

## 尺寸与 Telegram 参考

比较单位是 CSS px 与 iOS 布局点，不能直接用截图物理像素相减。设备缩放、系统字体和字形栅格化会产生细小差异；校准的是元素几何与基线关系，不是特定设备的字形像素。

| 部位       | 本应用                                                                              | 参考与取舍                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 气泡内引用 | 14px 字号；3px 作者色竖边；4px/8px 内边距                                           | TG 按基础字号乘 14/17 并取整，默认得到 14pt。保持单行作者和单行省略摘要。                                   |
| 回复输入栏 | 36px 高，与单行输入一致；12px/14px 字号和行高；29px 高、2px 宽的直线                | TG ReplyAccessoryPanel 为 45pt 高、15pt 字号、35pt 竖线。本应用采用明确的紧凑版本，不把高度差当作渲染误差。 |
| 回复对齐   | 竖线起点与 textarea 文字起点共用 composer-padding-start                             | 取消按钮与贴纸按钮对齐。以文字区域的实际起点校验，不增加某一台 iPhone 专用的 1px 平移。                     |
| 消息密度   | 正文 14px，作者 12px；连续消息间距较小，换作者增加间隔                              | 与 TG 常用的较大正文字号不同，维持当前紧凑密度；字号、行高和气泡内边距作为整体设计。                        |
| 原生控件   | Ionic 默认主题字号、图标和按钮颜色                                                  | 不为返回、设置、收藏和置顶按钮分别混合稍微不同的蓝色。                                                      |
| 发送气泡   | 应用蓝色与白色文字                                                                  | 保留应用配色，不复制 TG 某个主题的绿色气泡或壁纸。                                                          |
| 表态头像   | 23px 头像、26px 气泡高度、头像重叠；少量半像素间距                                  | 采用旧版经过调整的紧凑几何，半像素并非自动判定为错误。                                                      |
| 应用内通知 | 仅单列；顶部安全区内浮动，24px 圆角、半透明表面、44px 头像、15px 文字、最多两行摘要 | 采用 iOS 通知卡片的视觉关系。TG 自己的通知也有 64/74pt 等多种尺寸，不以一个固定截图覆盖全部环境。           |
| 媒体预览   | 图片/视频从顶部开始；按钮悬浮，底部同消息 gallery                                   | 悬浮控件需要遮罩、层级与命中控制；这部分不能由普通内容 modal 的默认留白代替。                               |

来源为 [Telegram iOS 引用布局](https://github.com/TelegramMessenger/Telegram-iOS/blob/6ad963e5b62d354da79040f388ae2b9132fb17b8/submodules/TelegramUI/Components/Chat/ChatMessageReplyInfoNode/Sources/ChatMessageReplyInfoNode.swift)、[回复输入栏](https://github.com/TelegramMessenger/Telegram-iOS/blob/6ad963e5b62d354da79040f388ae2b9132fb17b8/submodules/TelegramUI/Components/Chat/ReplyAccessoryPanelNode/Sources/ReplyAccessoryPanelNode.swift)、[应用内通知](https://github.com/TelegramMessenger/Telegram-iOS/blob/6ad963e5b62d354da79040f388ae2b9132fb17b8/submodules/TelegramUI/Components/Chat/ChatMessageNotificationItem/Sources/ChatMessageNotificationItem.swift)。这些参数属于该源码版本，不代表所有主题、字体设置与系统版本都逐像素一致。

## 样式归属

下表覆盖手写 SCSS 和内联样式。每一组样式对应可见需求或布局约束，框架及库内部样式不在应用中复制。

| 文件/组件                              | 保留的用途                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| styles.scss                            | Ionic 与滚动条库入口、应用主色、系统顶部背景、全屏遮罩共同边界、消息日期、统一加载/操作反馈、原生输入与 Windows 滚动条。 |
| index.html                             | Angular 尚未启动时的居中占位和八辐 spinner；尺寸、线宽和动画对应 Ionic spinner。                                         |
| App                                    | 384px 聊天列表侧栏与启动内容居中。                                                                                       |
| ChatListPage                           | 空会话提示的居中布局。                                                                                                   |
| ChatList                               | 顶栏 26px 头像和小屏可容纳的分类标签。                                                                                   |
| ChatListItem                           | 列表行密度、选中态、时间/未读布局、系统预览色与静音标记。                                                                |
| ChatAvatar                             | 同一头像按 48/88 等尺寸缩放；话题角标、边框及占位。                                                                      |
| ChatDetails                            | 内容容器、安全区、居中资料、横排操作及五个等分标签。                                                                     |
| ConversationPage                       | 360px 信息栏、手动锚点下关闭浏览器二次锚定、未读线、下箭头与置顶/回复栏。                                                |
| SavedMessagesPage / PinnedMessagesPage | 消息背景；收藏来源与快照操作排列。                                                                                       |
| Message                                | 气泡、尾巴、作者分组、媒体贴边、时间、引用、桌面 hover 与手机回复手势反馈。                                              |
| MessageAuthor                          | 用户名、用户组和性别在同一行的颜色及密度。                                                                               |
| MessageReactions                       | 表情、计数、重叠用户头像与气泡内外两种排布。                                                                             |
| MessageThread                          | 气泡下的讨论入口分隔与可点击区域。                                                                                       |
| MessageAttachments                     | 资源未加载时的尺寸框、媒体时间、文件行、上传遮罩和视频打开按钮。                                                         |
| MessageComposer                        | 输入/附件/发送的布局、面板、提及列表及待发送附件；36px 控件尺寸通过 CSS 变量传入录音组件。                               |
| VoiceRecorder                          | 录音、计时、取消/发送拖动目标与短录音提示。                                                                              |
| StickerPicker                          | 固定面板高度、可滚动贴纸网格、包分类和按下反馈。                                                                         |
| MessageMenu                            | 消息预览、表态条、操作网格与遮罩命中；菜单几何由 DOM 测量负责。                                                          |
| MediaViewer                            | 全屏画布、悬浮控制、缩放、加载状态、翻页与 gallery。                                                                     |
| ChatAttachments                        | 三列正方形媒体摘要与打开时的反馈。                                                                                       |
| VoicePlayer                            | 固定高度的播放、波形、时间与倍速；波形库 shadow part 由全局入口设置。                                                    |
| InviteCard                             | 230px × 66px 固定卡片、44px 头像和单行摘要；外层消息只负责点击。                                                         |
| Landing                                | 旧版五平台安装指引的布局与样式。                                                                                         |
| Settings                               | 88px 居中头像及占位图标。                                                                                                |
| NotificationBanner                     | 顶部卡片、安全区、亮暗色、两行省略与入场动画。                                                                           |
| MessageText（内联）                    | 提及与链接的继承字号和链接色，长词换行。                                                                                 |
| MessagePreview（内联）                 | 系统行为摘要继承调用位置指定的颜色。                                                                                     |
| MessageStatus（内联）                  | 时间旁的状态图标对齐。                                                                                                   |
| EmojiPicker（内联）                    | 第三方表情选择器的尺寸和主题变量。                                                                                       |

资源占位、Safari 惯性期间的稳定布局、安全区、隐藏控件与预览禁用命中属于功能需求。它们和装饰样式一起审查，但不因默认截图里没有出现就判定为无效。外观验证覆盖亮暗色、单列/多列、长文字、回复、媒体、贴纸和菜单。

VoicePlayer 采用圆形播放按钮、条状真实波形、时长和倍速的横排布局；自己的蓝色气泡使用白色波形，其余位置使用 primary 色。波形未读取前保持相同尺寸。Landing 的五个平台指引和 SCSS 来自旧版，Ionic 组件负责相同的页头、分段和卡片。信息栏头像区域上下内边距为 32px/24px，操作区底部保留 24px 背景色区域，标签上方没有额外白色分隔块。

Safari 顶部染色使用 body 末尾的空背景元素，保留 12px 采样区域并以 background-clip: text 避免绘制覆盖层；颜色跟随 toolbar 与深浅主题。媒体画布缩放尺寸仅由 --media-scale 定义，邀请卡片几何仅由 InviteCard 定义。

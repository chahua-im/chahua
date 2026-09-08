# 加载与操作反馈

加载图标不搭配文字。错误提示和重试入口显示文字。应用内使用 Ionic 默认 spinner。

## 数据加载

| 场景                             | 标识                                                 | 状态归属                                               |
| -------------------------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| Angular 挂载前                   | index.html 的内联 SVG 短线菊花，屏幕居中；适应深浅色 | 静态 HTML                                              |
| 登录初始化                       | 居中 spinner                                         | App.loading                                            |
| 列表首次加载、切换分类、点击重试 | 内容区 spinner                                       | 当前分类查询 loading 汇总与 ChatList.ready             |
| 列表下拉刷新                     | Ionic refresher；不同时显示内容区加载图标            | ChatList.refreshing 与查询 loading                     |
| 列表续页                         | Ionic infinite-scroll spinner                        | 查询 loadingMore                                       |
| 对话首次加载                     | 内容区居中 spinner                                   | ConversationStore.loading                              |
| 对话历史/后续消息分页            | 顶部/底部固定尺寸菊花控件                            | ConversationStore.pagingDirection                      |
| 收藏/置顶页面加载                | 内容区 spinner                                       | SavedMessagesPage.loading / PinnedMessagesPage.loading |
| 好友验证设置加载                 | 列表内 spinner                                       | FriendVerificationSettings.loading                     |
| 表情组件代码加载                 | @loading 延迟 100ms 展示 spinner                     | @defer 的加载状态                                      |

主列表固定显示“已归档”，好友 tab 还显示“好友请求”历史入口；入口立即可用。首次内容加载时 spinner 位于入口下方。归档数字独立更新，历史数据在进入对应页面时读取。

切换分类时，当前分类的列表查询结束后统一展示内容；固定入口和归档统计不参与等待。首次展示完成后的刷新保留原列表。

对话分页控件使用 Ionic 默认 spinner 的尺寸、颜色和透明度，外层按钮提供固定点击区域。可分页时控件常驻：空闲暂停动画且可点击，加载时播放动画。自动预取在接近边缘时发生，历史消息在触摸与惯性结束后合并；首条可见消息的底部位置是滚动锚点。

## 操作反馈

| 操作                             | 反馈位置           | 等待行为                                                                                                                      |
| -------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 接受/拒绝/归档好友请求           | 被点击的按钮       | 按钮显示 spinner，同条请求的其他操作禁用                                                                                      |
| 列表滑动操作                     | 列表项右侧         | 收起滑动菜单后显示 spinner，pendingAction 标识当前操作                                                                        |
| 点击置顶预览                     | 置顶栏预览右侧     | 等待消息定位；预览和消息列表保持原位                                                                                          |
| 点击引用                         | 引用区域           | 原内容保留尺寸，spinner 叠放，跳转按钮暂时禁用                                                                                |
| 回到最新消息                     | 底部按钮           | 按钮节点常驻，等待导航时显示 spinner                                                                                          |
| 菜单中的收藏/撤回/置顶/表态/复制 | 当前页面 toolbar   | Menu.busy 为真；菜单关闭，操作完成后由菜单显示 Toast                                                                          |
| 取消收藏                         | 对应收藏的取消按钮 | removingSavedId 标识当前行，其他取消按钮禁用；失败由收藏页提示                                                                |
| 话题订阅/归档                    | 话题 toolbar 按钮  | threadBusy 为真时显示 spinner 并禁用重复操作                                                                                  |
| 保存好友验证设置                 | 保存按钮           | 保留文案占位，spinner 叠放；表单暂时禁用                                                                                      |
| 通知订阅                         | 通知设置行右侧     | PushNotifications.busy；开关显示本机通知意图，后台 Push 注册失败单独提示并可重试                                              |
| 检查更新                         | 检查更新行图标位置 | AppUpdates.checking；结果在设置页展示                                                                                         |
| 发送消息                         | 消息时间之后       | 立即上屏；上传 cloud-upload-outline，排队／发送 time-outline，确认 checkmark-outline，失败 alert-circle-outline；失败原位重试 |
| 附件上传                         | 附件自身           | 本地图片、视频、语音或文件显示 Ionic spinner；上传未完成也可发送                                                              |

操作按钮通过 `.action-content` 和 `.action-label` 保留原有尺寸，spinner 绝对定位叠放。`.busy` 控制原内容的隐藏，spinner 显示等待状态。

消息菜单确认框、Toast 与菜单开关属于 MessageMenu；页面读取其 busy 用于 toolbar。页面离开会清理提示并使旧操作的 UI 收尾失效。数据请求时机见[数据流](data-flow.md)，组件边界见[Components](components.md)。

输入区不因消息读取、发送或编辑请求进入忙碌状态。编辑保存后在原消息上显示队列状态，失败原位重试；尚未发出的消息编辑直接更新该行。撤回立即隐藏消息，网络请求由队列继续处理。录音能力不足时显示 mic-off-outline，点击展示 Ionic alert，不使用禁用按钮。

静音时长菜单等待用户选择；确认后由原列表项或资料按钮保持操作反馈，取消菜单不发送请求。静音到期只更新标记和计数，不显示全屏 loading。通知横幅不改变页面加载状态，点击后复用会话页面已有的消息定位反馈。

资料的成员、话题、媒体与聊天搜索使用 IonInfiniteScroll，加载标识与 ChatList 一致，不提供“加载更多”文字按钮；不足一屏时继续补页。Connection.connected 为假时，列表与会话 toolbar 显示 Ionic spinner，不附“连接中”文字。

VoicePlayer 首次播放与缓冲时在圆形按钮内显示 spinner，波形读取失败不阻止可用的音频播放。贴纸上传的等待留在贴纸面板；邀请卡片的加载保持固定高度。私聊关系不可发送时点击提交显示原因，输入内容保持可编辑。

用户资料的 busy 合并本地操作与共享好友关系查询的 loading；打开已有关系的资料不重复请求关系。验证方式仍在组件内读取。

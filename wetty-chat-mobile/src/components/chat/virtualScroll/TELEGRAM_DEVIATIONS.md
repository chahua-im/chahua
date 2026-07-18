# Telegram-tt 偏离记录

记录 wetty-chat PWA 虚拟滚动与 telegram-tt 的架构/实现差异，以及每个偏离的处理决策。
对照源：`/home/yiyan/文档/telegram-tt`。

---

## 1.1 滚动动画：原生 scrollTo vs animateScroll

**Telegram-tt 做法**

- 专门的 `util/animateScroll.ts`，所有滚动（jump / scrollToBottom / restore）集中编排
- WAAPI 动画（非原生 `behavior:'smooth'`），带 `maxDistance` 上限防止过长滚动
- 模块级 `isAnimating` 全局标志 + `cancelScrollBlockingAnimation()`——`focusMessage` 跳转前先取消进行中的动画
- `forceDirection: Static` → `forceDuration=0` 表达"瞬时跳转"，保留可动画路径

**wetty 当前做法**

- `setScrollTop` 用原生 `scrollTo({behavior:'smooth'})` 或直接赋值
- jump 修复时为绕过 ResizeObserver 打断 smooth，直接禁用了 smooth（`scrollToMessageId` 用 `_behavior` 忽略参数，强制瞬时）
- 靠 `isReplacingHistoryRef` 在 rAF 窗口内临时打补丁，粒度粗

**差异本质**
Telegram 用集中函数管所有滚动，"动画进行中"状态全局已知，RO/其他逻辑都能查。wetty 分散调用 `setScrollTop`，靠临时 ref 补丁。

**决策**
**暂不修改**。当前瞬时跳转能用，牺牲了平滑体验但不阻塞。
若后续恢复 smooth jump，正确做法是抽一个 `animateScroll` 工具（带全局 isAnimating 标志），RO 检查该标志而非 `isReplacingHistoryRef`。

---

## 1.2 高亮视觉：行背景脉冲 vs 气泡换色

**Telegram-tt 做法**

- `.Message.focused .message-content { background: var(--color-background-selected) }`——给**气泡本身**换"选中态"背景色
- 瞬时换色（非动画），到 `blurTimeout`（3s）后瞬时清除，无淡入淡出
- `.focused` 与 `.is-forwarding` / `.is-selected` / `.has-menu-open` **共用同一选择器**——focus 视觉 = 选中视觉
- 用主题色（`--color-background-selected`，更深灰），非 warning 黄

**wetty 当前做法**

- **整行** `background-color` 脉冲动画（0→0.18 alpha 淡入→2s 淡出），warning 黄色
- 独立 `.focused` 类，不与选中态共享

**差异**

- (a) 行 vs 气泡——用户确认要"行背景"，有意偏离
- (b) 动画 vs 瞬时换色
- (c) warning 黄 vs 主题选中色
- (d) 独立 `.focused` vs 与选中态共享

**决策**

- (a) **保留**（用户需求）
- (b)(c)(d) **暂不动**，视觉取舍，待真机对比后再定

---

## 1.3 stuck date 检测：内联循环 vs findStuckDate 纯函数

**Telegram-tt 做法**

- `useStickyDates.ts` 里 `findStuckDate(container)` 是独立纯函数——输入 container，遍历 `.sticky-date` 元素，返回当前 stuck 的那个
- 调用方 `updateStickyDates` 用 `useRunDebounced(1000)` 防抖 1 秒后执行 find + toggle `.stuck` 类

**wetty 当前做法**

- stuck 检测内联在 `updateViewportState` 的 for 循环里，与 viewport 状态计算混在一起
- 每次 scroll（rAF 节流）和每次 commit 都跑，同步标记 `data-stuck` 属性
- 无防抖

**差异本质**

- (a) 未抽成纯函数（影响可测性/可读性）
- (b) 连续跑 vs 防抖 1s
- (c) `data-stuck` 属性 vs `.stuck` 类

**决策**

- (b) **无需对齐**——我们的连续标记没问题，淡出已由 `data-scrolling` 属性单独控制，不依赖 stuck 标记时序
- (a) **建议做**——抽成 `findStuckDateRow(container): string | null` 纯函数，低风险重构，提升可测性
- (c) 无所谓，两者等价

---

## 1.4 blur 清除：hook ref vs 全局 blurTimeout

**Telegram-tt 做法**

- `messages.ts` 模块级 `let blurTimeout`，所有 `focusMessage` 共享
- 每次新 focus 清除旧 timeout
- 区分 `FOCUS_DURATION`（高亮跳转）和 `FOCUS_NO_HIGHLIGHT_DURATION`（`noHighlight` 跳转，更短）——支持"跳转但不闪烁"

**wetty 当前做法**

- `highlightTimerRef`（useRef）在 hook 实例内，效果等价（新 focus 清旧 timer）
- 没有 `noHighlight` 变体——所有 jump 都高亮（除非是最新消息，skip）

**差异本质**

- (a) ref（React 范式）vs 全局变量——wetty 的更符合 React
- (b) 缺 `noHighlight` 路径——功能缺口

**决策**

- (a) **不改**（ref 更符合 React）
- (b) **暂不做**——等"静默跳转"功能需求驱动时再在 `jumpToMessage` options 加 `noHighlight`

---

## 总结

| 偏离                     | 严重度 | 决策                                         |
| ------------------------ | ------ | -------------------------------------------- |
| 1.1 animateScroll        | 中     | 暂不修改（瞬时方案能用；恢复 smooth 时再做） |
| 1.2 高亮视觉             | 低     | 暂不动（视觉取舍，真机对比后再定）           |
| 1.3 findStuckDate 抽函数 | 低     | 建议做（纯重构，提升可测性）                 |
| 1.4 noHighlight 变体     | 低     | 暂不做（等功能需求驱动）                     |

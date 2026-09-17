# Last-Seen / 在线状态功能方案（后端）

> 状态：方案已完成第九次评审修订（2026-09-14），**尚未实施**。等用户明确指令后再动手。
> 分支：`crsh/lastseen`（相对 main 无提交）。
> 范围：仅后端；除 auth 缺少 state 时采用明确的宽容策略外，不以现有前端兼容性为约束，
> 其他 REST / WS 契约允许破坏性调整。
> 部署前提：本期只支持单实例。多实例 presence 在真正需要扩容时另行设计，本方案不处理。

## 1. 目标与产品决策

向经过隐私过滤的观看者提供：

- 实时在线状态 `online`；
- 最近一次确认的前台活动时间 `lastSeenAt`（正常下线时精确到离线边界）；
- 好友范围内的实时状态变化事件。

| 决策点 | 结论 |
|---|---|
| 可见级别 | `everyone` / `friends` / `nobody` |
| 默认级别 | `everyone` |
| 隐私方向 | 双向：设置同时控制“谁能看我”和“我能看谁” |
| 实时广播范围 | 只发好友；`everyone` 与 `friends` 的非好友差异只体现在 REST |
| 隐藏呈现 | `lastSeenAt: null, online: false`，不暴露“被隐藏”标记 |
| 拉黑 | 任一方向存在 `blocks` 记录，双方互相隐藏 |
| 在线定义 | uid 至少有一条明确为 `Active` 的前台连接 |
| 断连去抖 | 正常断连延迟确认 45s；prune 确认的离线不叠加 debounce；合法的显式前后台切换不延迟、不合并 |
| 异常切换防护 | 对 appState / ping.state 状态变化按连接和 uid 超频限流；持续超限时拒绝该次输入并关闭肇事 socket。阈值从宽（12/10s），容忍可控滥用换取不误伤真实用户 |
| 心跳契约 | 有效连接的心跳间隔不得超过 30s；默认 90s stale timeout 约容忍连续缺失三次 |
| 沉默掉线 | stale timeout（默认 90s）+ prune interval 内确认下线，不叠加 45s debounce |
| 在线时的时间 | REST 与 WS 统一为 `online: true, lastSeenAt: null` |
| 时间字段 | 复用 `user_extra.last_seen_at`，改由前台 Active presence 独占写入，见 §4–5 |
| DAU 定义 | UTC 当天至少有一次可信的前台 Active 观察；后台 HTTP/Inactive 连接不计入 |

## 2. 现状与已确认缺口

- `user_extra.last_seen_at` 当前是 non-null naive UTC `TIMESTAMP`，由 HTTP 中间件
  `track_client_activity` 按 client_id 每 5 分钟更新，实际语义是“最近 API 活动”。
- `record_activity` 还用 `last_seen_at.date()` 判断当日用户是否已经计入
  `activity_daily_metrics`。本方案会把用户级 DAU/New User 记账移交给 presence；HTTP tracking
  只保留 client 维度指标。
- `token_generation::bump`、好友设置、贴纸顺序等路径会懒创建 `user_extra`；非 presence
  操作不能再用 `now` 伪造 last seen。
- 正常 WS 断开与 `prune_stale` 都不落库；`prune_stale` 还存在扫描与删除分离、删除后 socket
  继续存活的问题。
- `ConnectionRegistry` 当前是 `DashMap<uid, Vec<ConnectionEntry>>`。Entry 的原子字段和
  `update_ping` / `update_app_state` 对 handler 公开，调用方可以绕过 registry 修改状态。
- 新连接当前默认 `Active`；认证消息不带初始 app state。后台建立连接会短暂制造假上线。
- 无 state 的 ping 当前会强制写成 `Active`，会把已经 Inactive 的连接错误切回前台。
- `MemberSummary` 和 `MemberResponse` 尚无 presence 字段；后者有列表、新增成员、修改角色三处
  构造路径，并非单一构造入口。

## 3. 双向隐私规则

设 `level(X) ∈ {everyone, friends, nobody}`：

```text
pair_visible(V, T) = self(V, T)
                  OR (not_blocked(V, T)
                      AND allow(T → V)
                      AND allow(V → T))

allow(X → Y) = everyone → true
             = friends  → X 与 Y 互为好友
             = nobody   → false
```

`self(V,T)` 仅在 `V == T` 时为 true；系统禁止自己拉黑自己。

完整真值表：

| V 设置 | T 设置 | 互为好友 | 非好友 |
|---|---|---|---|
| everyone | everyone | 可见 | 可见 |
| everyone | friends | 可见 | 隐藏 |
| everyone | nobody | 隐藏 | 隐藏 |
| friends | everyone | 可见 | 隐藏 |
| friends | friends | 可见 | 隐藏 |
| friends | nobody | 隐藏 | 隐藏 |
| nobody | everyone | 隐藏 | 隐藏 |
| nobody | friends | 隐藏 | 隐藏 |
| nobody | nobody | 隐藏 | 隐藏 |

补充约束：

- `online` 与 `lastSeenAt` 必须使用同一套可见性规则。
- 搜索结果可能包含 viewer 本人；self 始终返回真实状态。
- viewer 为 `nobody` 时可以跳过好友/拉黑/目标设置查询，但不能整批直接返回隐藏，因为批次中
  可能包含 self；仍需读取 viewer 自己的 presence 数据和在线状态。
- 好友请求等待中的双方不算好友。

## 4. 数据模型与迁移

### 4.1 字段语义

复用现有字段，并把它正式改为前台 presence 的唯一持久化时间：

```text
user_extra.last_seen_at TIMESTAMP NULL
    后端最近一次确认用户处于前台 Active 的时间，或该次前台活动结束的时间；
    NULL 表示从未确认过前台 Active。

user_extra.presence_visibility presence_visibility NOT NULL DEFAULT 'everyone'
    同时控制 online 和 lastSeenAt 的双向可见性。
```

`user_extra` 的两个时间列是 naive `TIMESTAMP`（无时区）。约定：所有写入与读取一律按 UTC 解释，
仅在 DTO 层转换为 `DateTime<Utc>` 并输出带 `Z` 的 ISO 8601；禁止以本地时区构造 naive 时间。

`last_seen_at` 同时承担 DAU 去重，是因为两者现在使用同一事实定义：只有可信的前台 Active 观察
才算用户活跃并推进 last seen。HTTP、Inactive ping 和非 presence 业务操作都不再影响它。

### 4.2 迁移内容

必须通过 `diesel migration generate` 创建迁移：

1. 创建 Postgres 枚举 `presence_visibility`：`everyone` / `friends` / `nobody`。
2. `user_extra.last_seen_at` 去掉 `NOT NULL`。
3. 新增 `presence_visibility ... NOT NULL DEFAULT 'everyone'`。
4. 保留现有 `last_seen_at` 作为上线前的近似历史种子；部署后的写入执行严格的新语义。

部署当天，旧 HTTP tracking 已经写成当天的用户不会被 presence 重复增加 DAU；从下一个 UTC 日期
开始，用户级 DAU 完全采用新的前台 Active 口径。旧数据无法区分某个当天时间究竟来自 HTTP activity
还是 token generation 等非 presence 插入，所以切换当天可能有极少量一次性漏计；接受该迁移误差，
建议尽量在 UTC 日期边界前完成部署。

`first_seen_at` 的口径存在迁移边界：存量行保留首次 HTTP 活动时间且永不改写；新体系创建或修正的
行以第一次可信 Active observation 为准。两种口径共存；该列当前没有读取方（`new_users` 判定依据
是 `last_seen_at` 是否为 NULL，不依赖它），接受这一不一致，不做回填。

历史种子不可清 NULL：`new_users` 的判定是“第一次可信 Active observation 时 `last_seen_at` 仍为
NULL”。若未来为了收紧“上线当天公开全部存量近似时间”而把种子清空，全部老用户都会被误计为
New User，一次性污染当天指标。默认 `everyone` 公开近似历史时间是已显式接受的产品决策；如需收紧
隐私，应调整可见性默认值，而不是清数据。

Diesel 侧同步：

- `schema/primary.rs` 增加 SQL enum/visibility 列，并把 `last_seen_at` 改为 `Nullable<Timestamp>`；
- `models.rs` 增加 Rust `PresenceVisibility`，使用 `DbEnum`、`ExistingTypePath`、
  `Serialize/Deserialize/ToSchema` 和 snake_case 序列化；
- `UserExtra.last_seen_at` / `NewUserExtra.last_seen_at` 改为 `Option<NaiveDateTime>`；
- 增加 `presence_visibility`；
- 更新 `client_tracking`、`social`、`users` 等全部 `NewUserExtra` literal。

down migration 顺序：先把 NULL `last_seen_at` 用 `first_seen_at` 回填，再恢复 NOT NULL；随后删除
visibility 列，最后删除 enum type。回滚会丢失新设置，属于预期。

现有 `idx_user_extra_last_seen_at` 不服务本方案的 uid 主键查询，并会增加更新时间字段的索引维护。
实施时先确认是否有仓库外查询依赖；删除索引属于单独决策，不在本方案中自动执行。

## 5. Presence 时间与 DAU

### 5.1 唯一写入口

所有 `last_seen_at` 写入及用户级 DAU/New User 记账收敛到 service 方法：

```text
record_presence_observation(conn, uid, observed_at, cause) -> stored_last_seen_at
```

`cause` 至少区分 Active checkpoint、显式 Inactive、正常 disconnect 和 prune。事务语义：

```sql
INSERT user_extra skeleton ON CONFLICT DO NOTHING;
SELECT first_seen_at, last_seen_at FROM user_extra WHERE uid = $uid FOR UPDATE;

if observed_at > stored last_seen_at (or stored value is NULL):
    active_user_delta = stored last_seen_at is NULL
                     OR stored last_seen_at UTC date != observed_at UTC date
    new_user_delta = stored last_seen_at is NULL
    UPDATE user_extra
       SET last_seen_at = observed_at,
           first_seen_at = observed_at when new_user_delta else existing value
    if active_user_delta != 0 OR new_user_delta != 0:
        UPSERT activity_daily_metrics for observed_at UTC date with the two deltas

return final stored last_seen_at
```

骨架行明确使用 `first_seen_at=observed_at, last_seen_at=NULL`，其余列使用现有数据库默认值；如果是
非 presence 操作更早创建的 NULL 行，第一次 observation 会把 `first_seen_at` 修正为 observed_at。

所有步骤在同一事务中完成。只处理比已存值更新的 observation；延迟到达的旧 prune/disconnect
candidate 不回退时间，也不为过去日期重复增加 DAU。

约束：

- 首次 Active 立即写一次；持续 Active 时按 uid 节流 checkpoint，默认每 5 分钟最多写一次。
- Active checkpoint 负责跨 UTC 午夜仍在线用户的次日 DAU。
- 显式 Inactive 和已经确认的 disconnect/prune 也写入最后的前台观察边界。
- WS offline 事件必须使用 `RETURNING` 的最终数据库值，不能直接使用候选时间。
- HTTP activity、token revoke、好友设置、贴纸顺序、presence visibility 等路径绝不更新该列。
- 非 presence 路径懒创建行时写 `last_seen_at=NULL`。
- 每个 uid 的 checkpoint 与 Offline observation 进入同一个有序持久化 lane；同一 uid 最多一项 DB
  写入在途，避免较旧 observation 越过较新 observation。
- `activity_daily_metrics` 只有至少一个 delta 非零时才写；复用现有 `DailyMetricDelta::is_zero()` 的
  提前返回。普通 5 分钟 checkpoint 只推进 `user_extra.last_seen_at`，不得以 `+0` 更新当天共享指标行。

### 5.2 DAU 口径变化

用户级指标改为：

```text
DAU = UTC 当天至少存在一次可信的 Active presence observation
New User = 第一次可信 Active observation 时 last_seen_at 仍为 NULL
```

可信 observation 包括：

- auth 携带的初始 Active；
- Active 连接的节流 checkpoint；
- 显式 Active → Inactive 的结束边界；
- 断连确认时的 disconnect time，或 prune 使用的最后 Active ping。

仅有 Inactive 后台连接、后台 HTTP、token revoke 或设置修改都不算 DAU。打开 App 并保持前台即算
Active，不要求发送消息或点击操作。

`ClientTrackingService::record_activity` 仍更新 `clients.last_active`、active/new client、rebind、purge
等 client 维度数据，但不再读取/更新 `user_extra.last_seen_at`，也不再增加 user 维度的
`activity_daily_metrics.active_users/new_users`。现有每日指标 upsert/Prometheus gauge 更新逻辑抽成
可供 presence persistence worker 调用的窄服务。数据库增量写入 observation 自身的 UTC 日期；只有
该日期等于当前 UTC today 时才同步增加“今日”Prometheus gauge，延迟确认的昨日 observation 不得
污染今日 gauge。

### 5.3 写入矩阵

| 路径 | `last_seen_at` | 用户级 DAU/New User |
|---|---|---|
| 首次 Active / 回到前台 | 立即单调写 observed_at | 按 observed_at 的 UTC 日期去重 |
| 持续 Active ping | 每 uid 5 分钟节流 checkpoint | 跨午夜时计入新一天 |
| Active → Inactive | 写切后台时间 | 若跨日且尚未计入则计入 |
| disconnect / prune | disconnect 45s 确认后写断开时刻；prune 确认后立即写最后 Active ping | 按 candidate 日期去重 |
| Inactive ping / 后台连接 | 不写 | 不计入 |
| 任意认证 HTTP 活动 | 不写 | 不计入用户级指标；client 指标照旧 |
| token revoke / 业务设置懒创建 | 缺行时 NULL | 不计入 |

纯 HTTP、从不建立 WS 的客户端不会产生 presence last seen，也不计入用户级 DAU/New User；这是
有意的产品口径。后端无法仅凭 HTTP 判断请求来自前台操作还是后台任务。

## 6. 在线状态机

### 6.1 物理状态与已发布状态分离

```text
physical_online = 至少一条连接明确为 Active
published_online = REST / WS 对外使用的逻辑状态
```

断连观察期内可以出现 `physical_online=false, published_online=true`。所有 Transition 必须针对
`published_online`，不能只比较 Active 连接集合。

每个 uid 使用统一状态槽，并由 presence coordinator 独占修改：

```text
PresenceSlot {
    connections,
    published_online,
    disconnect_debounce { generation, deadline, candidate_time },
    operation_queue: VecDeque<PresenceOperation>,
    in_flight: Option<{ operation_id, attempt_id }>,
    next_operation_id,
    next_attempt_id,
    last_checkpoint_enqueued_at,
}
```

uid 级转换限流器不属于 `PresenceSlot`：coordinator 另行持有
`uid_transition_rate_limiters: TTLMap<Uid, TransitionLimiter>`，按 §6.3 的 TTL 独立清理，确保连接清空、
空 slot 删除或重连都不会立即重置 uid 限流状态。

`PresenceOperation` 分为 Online、Checkpoint、Offline：Online/Offline 带目标 published state 和
changed_at，Checkpoint 只持久化 Active observation、不产生事件；三者都携带 observed_at 并经过
同一个按 uid 有序的持久化 lane。忽略 Checkpoint 后的队尾目标（没有则取 published_online）代表
已经承诺的对外状态。连接、debounce、operation queue 和 published 状态不得拆成多个 DashMap/多把
互不关联的锁。

### 6.2 状态命令、持久化与回执

实现分为三层，不能让同步 DB 或重试阻塞连接状态处理：

1. register、remove、state、prune、timer 到期进入非阻塞的状态 command lane；同一 uid 串行修改
   `PresenceSlot`，不同 uid 可并行。生命周期命令不可静默丢弃；队列满时施加背压，必要时关闭对应
   socket 让客户端重连。§10 的 reconciliation 命令同样不可静默丢弃，其通道保证见 §10。
2. 状态层把 Online、节流 Checkpoint、Offline 按观察顺序追加到该 uid 的 `operation_queue`。
   只有队头可以交给有界持久化 worker；所有类型都调用 §5.1 的 observation 事务，worker 不得占住
   状态 command lane。同一 uid 最多一个 DB operation 在途。交给 worker 时 operation 仍保留在队头，
   coordinator 只记录唯一的 `attempt_id`，不能把唯一副本移动到 worker 内存。
3. worker 成功后把 `(uid, operation_id, attempt_id, stored_last_seen_at)` 回投 coordinator。只有 uid、
   队头 operation id 和当前 attempt id 全部匹配才能提交：Checkpoint 只弹出；Online/Offline 还要更新
   `published_online` 并进入广播序列器；完成后启动下一项。旧 attempt 的迟到回执一律忽略。
4. DB 错误或 worker `JoinError`/panic 同样带回或由 supervisor 合成对应 attempt 的失败回执；coordinator
   仅在 id 匹配时清除 `in_flight`，按 backoff 重新提交仍保留的队头。这样 worker 死亡不会丢 operation，
   也不会让该 uid 永久卡在“在途”状态。

这样即使 Offline 正在等待 DB 时用户又 Active，coordinator 也会在队尾追加 Online；恢复后严格按
Offline → Online 发布，不会让旧 Offline 越过新 Online。只有仍在 45s Debouncing 阶段、尚未进入
operation queue 的断连可以被重连完全吸收。过时 debounce timer 按 generation 丢弃。

`ConnectionEntry` 的状态字段和更新方法改为私有；handler 只持 `conn_id + receiver` 以及能力受限的
`HeartbeatHandle`。handler 在解析到有效 ping/state 帧时立即通过该 handle 记录一个一致的 heartbeat
sample（用于 freshness 的单调时钟接收时间，以及用于离线 candidate 的 UTC 观察时间），再把带
`received_at` 的命令送入 coordinator；handle 不能修改 app state、连接集合或 published state。
app state 变化仍只能经过 coordinator。这样状态队列或 runtime 短暂繁忙不会把已经收到的心跳误判为
stale。无锁实现必须把整个 sample 作为单一版本原子替换和读取（例如 `ArcSwap`、seqlock/versioned
snapshot，或只原子保存单调 tick 并根据进程启动时的 UTC/Instant 锚点推导 UTC）；禁止用两个无版本
关联的 atomic 分别保存单调时间和 UTC 时间，否则 prune 可能读到不同 heartbeat 的混合 sample。

推送抑制不等待 DB observation 或 published 状态提交，但必须保留按连接的 freshness 窗口：沿用现有
语义“存在一条 Active 连接且其 `last_ping_at` 在 freshness 窗口内（当前 30s）”。不能退化为只看
“存在 Active 连接”——网络静默死亡的僵尸连接会错误抑制推送，最长持续 stale timeout + prune
interval（默认约 90–150s），远差于现有约 30s 的恢复时间。用户已真实处于前台时不应因为 presence
持久化延迟而收到冗余 push。

### 6.3 转换规则

- 新连接初始为 `Unknown`，本身不产生 Online。
- 收到首个 `Active`：
  - 若仍处于 disconnect debounce 且队尾目标为 Online，只取消 debounce，不追加重复 Online；
  - 若队尾目标为 Offline（包括 Offline 已经在持久化），追加带当前 observed_at 的 Online operation，
    等待此前 Offline 持久化/发布后再按序发布；
  - 若 published 与队尾目标都已经 Online，不追加重复 Online，但若已达到 checkpoint 间隔则追加
    Checkpoint operation。
- Active ping/state 更新都刷新内存 heartbeat；每 uid 距上次已排队 checkpoint 达到默认 5 分钟时，
  追加最新 observed_at 的 Checkpoint。同一 uid 尚未处理的多个 Checkpoint 可合并为最新一个。
- 收到 `Inactive`：若它使最后一条 Active 消失，作为显式前后台切换，不增加 45s 延迟；先持久化
  当前 UTC 时间。立即追加 Offline operation 并提交 worker，持久化成功后按队列顺序发布；正常 DB
  延迟不等同于 45s debounce。所有通过限流的真实显式转换都立即、完整地进入有序 operation queue，
  正常路径不以时间窗口合并或延迟状态。
- appState / ping.state 超频防护使用可配置的滑动窗口或等价 token bucket。限流对象是“会引发
  状态变化的输入”，不区分帧类型：appState 与 ping.state 携带与当前不同的 state 时计入同一限流器
  ——现有 PWA 每次心跳都携带 state，若只按 appState 帧限流，改用 ping 帧即可原样绕过；缺省
  state 的 ping 只刷新 heartbeat，不计入。默认每连接允许 10s 内 12 次非重复状态变化；每 uid 另允许
  10s 内 20 次会改变 aggregate physical target 的显式转换。阈值有意从宽：限流的目的是封顶滥用成本，
  而非精确区分用户行为，偶发误伤真实用户（连接被踢、断连重连自愈）比多容忍一倍可控的滥用
  fan-out 更糟；收紧阈值是遇到实际滥用后的运维动作。重复发送当前 state 直接忽略且不产生
  operation。超过任一上限时不应用该次输入，记录协议滥用指标，并关闭/移除发出该输入的 socket；
  若被移除连接此前为 Active，按普通 disconnect 的 45s debounce 处理。不能为了限流吞掉、替换或
  撤销已经接受的转换。uid 级限流计数器的生命周期必须长于 `PresenceSlot` 本身，存储确定为独立于
  slot 的 TTL map：末次计数后保留 30–60s 再清除，不随空 slot 删除（§6.5）一起消失。已知未封顶
  的绕过：多连接各自在阈值内翻转且始终保持一条 Active 时 aggregate 不变，uid 限流不触发；但
  aggregate 不变意味着无 DB 写、无广播，成本仅为 command lane 的纯内存处理，且前提（海量并发
  连接）应由连接数上限治理——每 uid 最大并发 WS 连接数上限已确认为独立后续 PR 处理，不在
  本方案范围。
- 正常 disconnect 使最后 Active 消失：保存断开时刻为 candidate，创建 45s debounce，期间
  `published_online` 保持 true。
- debounce 到期：只有 generation 仍匹配且仍无 Active，才把 Offline operation 追加到 operation queue 并
  提交 worker；到期前重连只取消 debounce，不产生事件。到期后才重连则顺序追加 Online。
- prune 确认的离线不叠加 45s debounce：stale 判定已经确认连接沉默超过 stale timeout（远长于
  debounce 的吸收窗口），此时再等 45s 只会让“沉默掉线”的对外下线延迟从 stale timeout + prune
  interval 延长到 + 45s。prune 直接以被删 Active 连接的最大 `last_ping_at` 为 candidate 追加
  Offline operation。重连会按规则顺序追加 Online，不产生额外问题。
- 该条中的“已离线”指具体状态：`已无 Active 连接`且（Offline operation 已入队，或已发布
  Offline）。已无 Active 连接但 Offline 尚未入队（例如仍处于 debounce）时，后台连接断开不改变
  任何状态，不写库、不广播。

每轮 debounce 使用唯一 generation，每个 PresenceOperation 使用唯一 operation id。旧 timer/DB 回执在
“断开 A → 重连 → 断开 B”或队列推进后不得命中新的 operation。

### 6.4 WS 输入契约

WS 输入契约（auth 采用宽容版，其余输入收紧为强类型严格校验）：

- auth 消息应携带初始 `state: active | inactive`；缺省时不拒绝连接，内部注册为 `Unknown`，由
  后续第一条携带 state 的 appState/ping 完成首次转换。除 PWA 外还有各平台 native 前端，严格
  拒绝会让全部旧版客户端实时通道直接不可用。新客户端仍应在 auth 帧直接携带 state 以省一次
  往返。永久 Unknown 是有意的降级而非语义无损：从不表态 state 的连接（现有客户端都会在连接后
  立即发送 appState，正常不存在；只会来自未来有 bug 的客户端）等同后台连接处理——持续续期
  不被 prune、不算 Online、不更新 last seen、不计 DAU、不抑制 push，但实时消息照常收发。
  不加“初始状态超时踢连接”：presence 静默缺失只影响该用户自身 invisible，踢连接会砸掉其实时
  通道并制造重连循环，把轻症治成重症；回归检测交给 §11 的长期 Unknown 指标。
- `appState.state` 必填；缺失/非法时拒绝或忽略，不改变状态。
- `ping.state` 可选；缺省只刷新 heartbeat，保留当前 app state。
- 合法连接必须至少每 30s 发送一次有效 ping；服务端不为更慢心跳提供存活保证。该值与 stale timeout
  一起配置并校验，必须满足 `stale_timeout >= 3 × max_heartbeat_interval`。
- 用按 `type` 区分的强类型反序列化枚举替代共享的 `WsMessage { state: Option<_> }`。
- freshness/debounce 使用单调时钟 `tokio::time::Instant`；UTC 时间只用于数据库与对外事件。

### 6.5 prune 与连接关闭

- stale timeout 从现有 300s 下调为可配置项，默认 90s；配合最多 30s 的合法心跳间隔，约容忍连续
  缺失三次心跳。它直接决定“沉默掉线”的对外下线延迟（stale timeout + prune interval，默认约
  90–150s），prune interval 维持 60s。
- prune 确认的 Offline 不叠加 45s debounce，因此 45s debounce 不是 stale 误判的兜底。连接若因
  网络、runtime 或系统暂停超过 90s 而被判 stale，会立即发布 Offline；稍后重连再发布 Online，接受
  这一抖动。客户端重连只能恢复最终状态，不能撤回已经发布的错误 Offline。
- handler 必须在收到有效帧时先更新受限 `HeartbeatHandle`，prune 在锁内删除前读取并二次确认最新
  heartbeat；不能只依赖可能仍在 command lane 排队的 ping 命令。
- prune 与 heartbeat 的线性化点定义为：prune 在 uid slot 锁域内的二次 freshness 读取。该读取
  之前已写入 HeartbeatHandle 的心跳保证救回连接；之后才写入的心跳不救——其携带的 state/ping
  命令将得到 NotFound，按既定规则关闭 socket 并要求重连，可能产生一次可自愈的 presence 闪断
  （罕见：需客户端恰好沉默超过 stale timeout 后在 prune 判定瞬间恢复）。接受该边界，不为它
  增加每连接锁；两种交错都用 barrier 测试固定为确定结果。
- stale 判定、锁内二次 freshness 校验、删除连接、计算转换必须在同一 uid 状态锁域完成。
- 多个 stale Active 同时导致离线时，candidate 取被删除 Active 连接中最大的 `last_ping_at`；
  Inactive 连接的 ping 不参与。
- 不能沿用“Vec 变空 → 释放 guard → 再 remove key”的模式；使用 occupied entry 原子删除，或保留
  空的 PresenceSlot，避免并发 register 被误删。无论选哪种，删除的都只是连接集合：uid 级限流
  计数器按 §6.3 独立保留，不随空 slot 一起消失。
- registry/coordinator 应是连接 sender 的唯一所有者。prune 删除连接后关闭发送端或发送明确 close，
  让 socket task 退出；后续收到 NotFound 的 state/ping 时同样关闭连接并要求重连。

## 7. REST 查询与 DTO 组装

### 7.1 返回不变量

```text
可见且 online=true  => { online: true,  lastSeenAt: null }
可见且 online=false => { online: false, lastSeenAt: DB value | null }
不可见               => { online: false, lastSeenAt: null }
```

`ConnectionRegistry::online_flags(&[uid])` 返回 `published_online`，而不是临时重新计算 Active；因此
45s debounce 期间仍为 true，REST 与已发布 WS 状态一致。

### 7.2 DTO 范围

- `MemberSummary` 增加 `last_seen_at: Option<DateTime<Utc>>`、`online: bool`。
- `MemberResponse` 增加同样字段。
- `dto::users::User` 用于消息 sender、线程参与者和附件 sender；它是静态身份快照，明确不携带
  易变 presence，避免每条消息响应增加隐私查询与动态字段。

覆盖好友列表、好友请求、用户搜索、聊天列表 DM 对端、DM/group info peer、拉黑列表和群成员响应。

### 7.3 公共组装器

- `build_member_summary_map` 新增显式 `viewer_uid`，所有调用方传 effective/acting uid；service token
  路径必须传 `require_user_action` 返回的 uid，不能使用凭据主体。
- 为 `MemberResponse` 建立单项/批量共用 enrichment，列表、新增成员、修改角色三条路径全部复用。
- `missing_user_summary`、测试构造器等直接 struct literal 同步补字段。
- presence/隐私 DB 查询放 `services/user.rs` 或 `services/social.rs`，handler 只负责传 viewer 上下文。

### 7.4 批量查询

1. 目标 uid 加 viewer uid，一次按 `user_extra.uid` 主键读取 last seen 与 visibility；缺行默认
   `everyone + null`。
2. 好友关系沿用 canonical 两半查询：
   - `uid1 = viewer AND uid2 = ANY(greater_targets)`，走复合主键；
   - `uid2 = viewer AND uid1 = ANY(lesser_targets)`，走 `idx_friendships_uid2`。
3. blocks 也分两个方向，并把对端限制为 `ANY(target_uids)`；分别使用 PK 前导列和
   `idx_blocks_blocked_uid`。
4. 在线状态为纯内存批量读取。

上述 visibility、friendship、blocks 查询任一失败时，整个 REST 请求返回服务错误；绝不能把查询失败
误当成“缺少 user_extra 行”“不是好友”或“没有 block”。只有查询成功且确认没有对应 user_extra 行，
才应用 `everyone + null` 默认值。

最终 SQL 用真实数据执行 `EXPLAIN (ANALYZE, BUFFERS)`；当前索引预期已经足够，不盲目新增反向
复合索引。成员列表 API 当前每页上限 100；性能测试重点还应覆盖未分页好友列表和广播 fan-out。

## 8. 设置端点

端点改用更准确的 presence 命名：

```text
GET /users/me/presence-visibility
PUT /users/me/presence-visibility
body/response: { "visibility": "everyone" | "friends" | "nobody" }
```

鉴权沿用“个人偏好类 me 端点”的既有惯例：`CurrentUid`（JWT 直连，参照
`GET/PUT /friends/me/settings`），本期不开放 service token 代表调用，不新增 authz action。
`GET /external/*` 面不提供 presence 数据，与现状一致。
- GET/PUT 成功均返回 200 和保存后的同一 DTO；PUT 幂等。
- 非法枚举由强类型 serde 枚举拒绝并返回 Axum 默认 422；本期不额外引入全局 JSON error envelope，
  OpenAPI 仍明确枚举取值。
- PUT 使用专用 upsert，插入分支必须显式写入请求值，不能意外使用 DB 默认 everyone。
- 懒创建行时 `last_seen_at=NULL`；只有后续可信 Active presence 才会写时间并计入用户级指标。
- 设置提交成功后必须触发 §10 的可见性重算。

## 9. 实时事件与顺序

新增独立 WS payload：

```json
{
  "type": "presenceChanged",
  "payload": {
    "uid": 123,
    "online": false,
    "lastSeenAt": "2026-09-14T10:00:00Z",
    "changedAt": "2026-09-14T10:00:45Z",
    "sequence": 42
  }
}
```

- debounce generation 和 presence operation id 仅供 coordinator 内部匹配旧 timer/DB 回执，
  不进入外部 payload。
- 所有普通状态事件和 reconciliation 事件都经过同一个 presence broadcast sequencer；由它按发送顺序
  分配当前进程内全局单调的 `sequence`，避免多个 producer 并发调用 `broadcast_to_uids` 造成乱序。
  `sequence` 只用于比较已经收到的事件顺序，因接收者过滤会自然产生缺口，不能仅凭缺号判断丢包。
  WS 重连后的 REST 权威快照是新的基线。
- `changedAt` 是 published 状态真正改变的时间；断连 Offline 的 `lastSeenAt` 仍是断开/最后 ping
  候选经数据库单调合并后的最终值。
- Online 事件固定 `lastSeenAt:null`。
- Offline 先成功持久化并拿到 `RETURNING last_seen_at`，再广播该值。
- `message_type()` 增加 `presenceChanged`，补精确 JSON 序列化测试。

正常状态广播接收者：

- 发起者和接收者必须通过 §3 的 pair visibility；
- 任一方向 block 都排除；
- 仅向发起者好友广播；接收者 `nobody` 不接收；
- 普通 Online/Offline 和“变可见”快照的 `broadcast_to_uids` 仍是尽力而为，REST 是权威数据源；
  “变不可见”的脱敏撤回使用 §10 的 enqueue-or-evict 特殊保证。

广播资格数据源（已定：实时查询，不做缓存）：每次 Online/Offline 转换在发布时实时查询发起者的
好友列表、候选接收者的 visibility 与双向 blocks（复用 §7.4 的批量查询形态，全部走索引），按查询
结果过滤；查询失败按 §11 fail-closed，只跳过本次广播，不影响 published 状态提交。不维护内存
eligibility 缓存：20k 用户规模下每次转换的 3–4 条索引查询成本可忽略（重启后 5k 用户重连风暴约
每秒百余条索引查询），而缓存漏掉一条社交变更刷新事件的后果是持续的隐私泄漏，正是本功能要防的
问题。§10 的“变可见”路径同样直接查询当前状态发送权威快照。若未来规模需要缓存，与多实例
presence（§14）一并重新设计。

为让 WS 丢包可恢复，好友列表和带 presence 的成员/用户 REST 返回均视为权威快照；未来客户端在
WS 重连后重新拉取相关快照。本期不承诺 WS 事件必达。

## 10. 可见关系变化时的重算

presence coordinator 除连接命令外，还接收 visibility/social reconciliation 命令。相关数据库事务
必须捕获并返回旧值、新值和确切受影响 uid；提交成功后把 before/after eligibility 或足以重建它的
mutation facts 随 reconciliation command 一起发送，不能在提交后只查新状态再猜旧状态。触发点：

- presence visibility 变化；
- 好友接受/自动接受；
- 删除好友；
- block/unblock。

reconciliation 命令的通道保证：它是已送达 presence 数据的唯一撤回机制，丢失意味着被 block/改
隐私的对端将永久保留旧的在线状态，属于隐私故障而非可接受的尽力而为。因此其通道**不可沿用**
代码库现有的 `try_send`-drop-on-full 惯例。写路径先用 `reserve_owned`（或等价机制）等待并取得一个
有界通道 permit，再把 permit 和数据库 mutation 一起移交给受监督的 owned job；该 job 不随 HTTP
request future 取消而中断。事务失败时释放 permit，事务提交成功后必须先用该 permit 发送携带
before/after facts 的命令，再向 handler 返回结果。这样不会出现“数据库已提交，但请求被取消或通道
刚好满而丢命令”。等待容量只形成有界背压，不因普通 channel full 退出进程；若 reserve 时已发现
通道关闭，则不开始 mutation 并返回服务错误。若事务提交期间 coordinator 不可恢复地退出，顶层
supervisor 按下述规则终止整个进程，断开全部 socket，由重连后的 REST 权威快照恢复。

规则：

- 从可见变不可见：根据事务捕获的旧 eligibility，向此前有资格接收的对端发送脱敏撤销
  `{ online:false, lastSeenAt:null }`。该撤销只针对关系中的确切双方，可以绕过新 block 过滤，
  因为内容不包含 presence。对每条目标连接采用 enqueue-or-evict：发送队列有容量时入队；队列已满
  或关闭时，不得 drop 后继续保留该连接，而是从 registry 移除并关闭该 socket。连接被逐出后不能
  继续接收 presence，重连必须先取得 REST 权威快照，因新规则得到脱敏状态。
- 从不可见变可见：按当前 `published_online` 和持久化 last seen 向新合格对端发送权威快照。
- 用户自己的可见级别变化同时影响“别人看我”和“我看别人”，所以需要双向处理：必要时也向该用户
  自己的连接发送其好友状态的撤销或恢复快照。
- 撤销事件本身会让接收者知道“某种可见性/关系变化发生了”，但不说明是隐私设置、好友关系还是
  block，也不泄露真实在线状态；这是实时撤销旧状态所必需并明确接受的取舍。
- reconciliation 与普通 Online/Offline 统一进入 broadcast sequencer，使用外部 `sequence`；不得
  复用 subject uid 的 debounce generation 或 presence operation id 做 viewer-specific 去重。
- enqueue 成功只保证消息进入服务端连接队列，不等于客户端已经处理；本期不增加 WS ACK。后端的
  保证边界是“撤回成功排队，否则连接被逐出”，无法删除离线设备已经获知的信息。若未来要求确认
  客户端消费，需要另行设计带 ACK/超时的可靠事件协议。

## 11. 失败、背压与生命周期

- 隐私/好友/拉黑查询失败：fail closed，不广播未过滤事件。
- 任意 presence observation 持久化失败：队头 operation 进入受控重试并记录指标。Online/Offline
  operation 成功前保持最后已发布状态，后续同 uid operation 保留在其后，避免 REST/WS 先发布一个
  尚未成为 DAU/last seen 权威事实的状态。
- 状态 lane 永不等待 DB 重试。持久化 worker 的并发、全局队列和最大 backoff 有界；每个 uid 同时
  只提交一个队头 operation，持续指数退避到成功；停机按崩溃语义放弃在途任务（见下）。不能达到固定次数后静默丢弃并
  让 published 状态永久悬空。
- persistence supervisor 负责每个 attempt 的 `spawn_blocking` JoinHandle。正常 DB 错误和 panic
  产生的 `JoinError` 都必须回投 coordinator；operation 在成功 ACK 前始终留在 slot 队头。失败时仅
  清除匹配 attempt 的 `in_flight` 并重试，旧 attempt 的迟到结果不得提交。attempt 级重试是安全的——
  observation 事务幂等：若该写入实际已成功，重试会因 `observed_at` 不比已存值更新而空转，且零
  delta 不写指标行（§5.1），不会重复计数。supervisor 自身崩溃与 coordinator 同语义：直接终止
  进程，由部署系统拉起。不为它设计“重启后找回 in_flight”的恢复协议——`in_flight` 的事实清单在
  coordinator 的 slot 中，重启的 supervisor 并不知道谁在途，代际握手协议的复杂度远超这个职责
  单一、几乎不可能 panic 的微型任务的失守概率；进程退出与已接受的停机/崩溃语义（见下）一致，
  恢复路径也相同。
- DB 故障期间单 uid operation queue 也必须有硬上限；超限时优先合并/删除中间 Checkpoint，保留正在
  处理的队头，并把尚未发布的状态转换压缩为“到达最新 physical state 所需的最短序列”，记录
  degradation 指标。正常无故障路径不合并显式 Active/Inactive 转换。
- 不能为每次断连无限制裸 `tokio::spawn` 后同时争抢 DB。
- 持久化 worker 不得在 tokio runtime 线程上直接同步执行 diesel 查询（现有 push/background worker
  的做法）：Online/Offline 的发布被 DB observation 成功与否直接 gate，DB 变慢时同步调用会占住
  runtime worker 线程，把局部 DB 延迟放大为整个服务不可用。每个在途 DB operation 用
  `spawn_blocking` 执行（或等价的独立有界并发执行器）。
- 配置统一放 `AppConfig::from_env`，至少包括 Active checkpoint interval（默认 5 分钟）、断连
  debounce、最大合法心跳间隔（默认 30s）、stale timeout（默认 90s，且至少为心跳间隔三倍，见
  §6.4–6.5）、prune interval、appState/ping.state 限流窗口与 per-connection/per-uid 上限、队列容量、
  最大重试 backoff 和长期 Unknown 判定阈值（默认 60s）；给出范围校验和默认值。
- 指标一律增量维护：physical/published online 用户数、debouncing 数等 gauge 在每次状态命令处理时
  +1/−1 更新，禁止沿用现有 `update_metrics` 每次 register/remove/state 变化（包括每次 ping）全量
  遍历 registry 重算的模式——20k 连接 × 30s ping 周期下该模式已是每秒数百次 O(N) 扫描，新增多个
  gauge 会成倍放大。为防增量计数漂移，coordinator 以固定低频（如每 5 分钟）用一次全量遍历核对
  gauge 并在偏差时告警，消除“一次出错一直错”的累积误差。
- 新增指标：physical/published online 用户数、debouncing 数、operation queue 深度、transition 数、
  checkpoint submitted/coalesced、debounce absorbed、persist success/fail/retry、reconciliation 数、
  全局队列深度、广播候选/过滤/丢弃数、appState rate-limit 命中/逐出 socket 数、隐私撤回成功入队/
  逐出连接数、存活超过阈值（如 60s）仍为 Unknown 的连接数（正常应为 0，非零即有客户端不声明
  状态的回归）。
- 长期 Unknown gauge 是时间驱动指标，不能只靠 register/state/remove 命令当场维护。Unknown 注册时
  向 coordinator 共用的 timer heap/`DelayQueue` 添加 `(conn_id, generation, deadline)`；到期时仅当
  generation 仍匹配、连接仍存在且仍为 Unknown 才把 gauge `+1` 并标记该连接已计入。连接随后首次
  表态或被删除时若已计入则 `-1`。过时 timer 丢弃；不得为每条连接单独裸 `tokio::spawn`。低频全量
  指标核对同时覆盖该 gauge。

coordinator 自身的崩溃语义：presence coordinator 持有全部 `PresenceSlot`、operation queue 与
debounce 状态，panic 时内存状态全部丢失。**不允许**按代码库现有 worker 惯例给它套 catch_unwind +
自动重启——重启后的 coordinator 面对仍存活的 WS 连接既无状态也无自愈路径，会得到“进程活着、连接
活着、presence 永久悬空”的最坏状态。coordinator panic 直接让进程退出，与 §11 崩溃条款同语义：
由部署系统拉起，客户端重连后从 REST 权威快照恢复。不能把 coordinator 作为无人 await 的 detached
`tokio::spawn`：main/supervisor 必须持有并监视其 `JoinHandle`，通过 `select!` 或等价顶层监督在异常
结束时触发进程级失败。持久化 attempt 的 panic 监督不受此限；其权威 operation 仍在 slot 中，可按
attempt id 安全重试。

停机与崩溃统一按崩溃语义处理：本期不做优雅停机/drain。进程收到停机信号即退出，在途
observation 任务丢失，last seen 最多回退到最近一次成功的 Active checkpoint（正常情况下约 5 分钟
以内），客户端重连后从 REST 快照恢复。优雅停机留待未来与统一的服务生命周期基建一起设计，本
方案不引入信号处理。

## 12. 边界情况

- 从未确认过 Active：`last_seen_at=NULL`；离线 REST 返回 null。
- 上线前历史：迁移保留旧 HTTP `last_seen_at` 作为近似种子；用户首次 Active observation 后进入
  严格的新语义。
- 网络突然掉线：stale timeout（默认 90s）+ prune interval（60s）内确认下线；落库候选取最后
  Active ping。prune 确认的离线不叠加 45s debounce（见 §6.3）。
- 客户端高频翻转 appState：合法频率内的转换不延迟、不合并；超过 per-connection 或 per-uid 上限时
  拒绝该次输入并关闭肇事 socket，Active 连接的移除走普通 45s disconnect debounce（见 §6.3）。
- 秒级断连重连：Debouncing confirmation 被取消，不落库、不广播重复 Online。
- 多端：任一端 Active 即 Online；最后一条 Active 消失才进入即时或延迟 Offline 流程。
- Active→Inactive→Active：未触发超频限制时，显式切换不增加 45s 延迟；命令按 uid 串行，产生有序
  Offline/Online，不合并已经接受的转换。
- 后台 HTTP：只更新 client 维度 tracking，不改变公开 last seen，也不计入用户级 DAU。
- 后台连接被 prune：此前已离线，不产生新的 presence transition，但必须关闭该 socket。
- malformed appState：不改变状态；无 state ping：只 touch heartbeat。
- DB 短暂不可用：不泄露隐私、不丢失重试任务、不发布尚未持久化的 Online/Offline。

## 13. 验证

基础：

- `cargo build`、`cargo clippy`、`cargo test`；
- migration up/down；确认 nullable、回填、enum 和默认值；
- 最终批量 SQL 的 `EXPLAIN (ANALYZE, BUFFERS)`。

自动化测试必须覆盖：

- 完整 3×3 隐私矩阵 × 好友/非好友、self、缺行默认、任一方向 block；
- REST 三个返回不变量和 WS 精确 JSON；
- 首个 Active、Unknown/Inactive 初始状态、auth 缺 state 时注册 Unknown 并由后续帧补状态（宽容版
  契约，旧客户端连接不被拒绝）、无 state ping、malformed appState；长期 Unknown 的 deadline 到期
  后 gauge 增加，随后首次表态/断开时减少，旧 generation timer 不影响新连接；
- 多连接转换矩阵与最后一条 Active 消失；
- debounce 重连无事件、断连 A→重连→断连 B 的旧 timer 失效；
- deadline 与 register 并发、Inactive/Active 跨连接并发顺序；
- prune 与 ping 并发：线性化点（§6.5）之前的 ping 不被误删；之后的 ping 得到 NotFound 并关闭
  socket 要求重连（确定性验证两种交错）；空 slot 与 register 并发不误删、prune 后 socket 关闭；
  prune 确认离线不叠加 45s debounce；30s 心跳契约、90s stale 边界，以及已被 handler 接收但
  command 尚未处理的 ping 不被误判 stale；
- appState/ping.state 超频限制：阈值内转换全部有序保留；ping 帧携带的状态翻转计入同一限流器，
  不得通过改用 ping 帧绕过；超过 per-connection/per-uid 阈值时不应用该次输入并关闭肇事 socket；
  重连（包括清空全部连接使 slot 变空再重连）不能立即绕过 uid 限制；
- 推送抑制保留 per-connection freshness 窗口，僵尸 Active 连接不抑制推送；
- 指标增量维护与低频全量核对告警（防漂移）；
- coordinator panic/意外返回被顶层 JoinHandle 监督并导致进程退出；持久化 attempt panic 后 operation
  仍留在队头、清除匹配 in-flight 并重试，迟到的旧 attempt 回执不提交；persistence supervisor
  自身崩溃与 coordinator 同语义导致进程退出，不自动重启；
- Active checkpoint、Offline candidate 的有序单调写与 `RETURNING`；
- 普通 checkpoint 的 DAU/New User delta 为零时不写 `activity_daily_metrics`；
- 多连接并发在同一 UTC 日期只增加一次 DAU/New User；
- 跨午夜保持 Active 时由首个 checkpoint 计入次日，Inactive/后台 HTTP 不计入；
- 延迟旧 observation 不回退时间、不重复补记过去日期；
- visibility、friendship、block 变化的双向撤销/恢复快照；reconciliation 命令通道满/失败时不得
  静默丢弃；数据库提交前已取得通道 permit；HTTP 请求取消不取消已接管的 mutation job；撤回事件
  发送队列满/关闭时逐出对应 socket；
- DB/隐私查询失败、重试、队列满。停机/崩溃按统一崩溃语义处理（无 drain），重连后以 REST 快照
  为准。

计时测试使用 `#[tokio::test(start_paused = true)]` 或注入 clock，不真实等待 45s；并发测试使用
barrier 固定交错，避免只靠概率发现竞态。

## 14. 不做的事

- 前端适配与旧前端兼容层。
- 多实例 presence、跨节点 lease/pubsub。
- 优雅停机/drain：停机即崩溃语义，留待未来统一服务生命周期基建（见 §11）。
- 每 uid 最大并发 WS 连接数上限：确认为有价值但属独立基建改动，在单独的后续 PR 中实现。
- “好友但排除某人”的单独黑名单粒度。
- 修改现有 `presenceUpdate`（本人连接数）事件语义。
- presence 历史轨迹、在线时长统计、审计日志。

## 15. 规模预估

原 350–450 行估算不足。考虑数据迁移、presence 驱动 DAU、状态 coordinator、reconciliation、失败重试、
指标与确定性并发测试，预计实现和测试会显著超过 500 行。实施时应按模块拆分并分阶段
验证，不以行数约束正确性。

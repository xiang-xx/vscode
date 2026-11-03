# Chat 模块 Super-Agent 化重设计与编辑区联动方案

> 灵感来源:DeepSeek《Super-agent》技术文。核心论点:
> - 单任务场景,瓶颈在**模型**;多任务场景,瓶颈在**人**。
> - 一个人同时最多盯 3~5 个 Session,再多认知就过载。
> - 解法:Router + Worker 双层架构 + 事件驱动 + 全双工打断 + 外部 Watchdog。
> - Agent 系统的组织形态正在逼近人类组织(前台/PM + 工程师 + 督导)。

本文回答三个问题:

1. 按 Super-Agent 模式,chat 模块整体应该怎么重设计?
2. 多 Session 并发后,chat 与右侧编辑区域如何联动,才能不乱?
3. chat 区域本身怎么重设计,才能承载 1 Router + ≤10 Worker 而不把人炸掉?(§5)

---

## 1. 文章观点 → 工程约束的映射

| 文章概念 | 落到 VS Code chat 模块的工程决策 |
|---|---|
| 一个人最多盯 3~5 个 Session | **执行预算与注意力预算分离**:`DEFAULT_MAX_CONCURRENT_WORKERS = 10`(超出排队,不硬塞);人只盯**一个页面**,注意力靠「完成队列 / 右下角提示」分流(见 §5),而不是切 tab、也不是拒收任务 |
| Router 只管聊天与分派 | Router 是**唯一常驻页面**上的编排层:派发任务、汇总进度、把跑完的 Worker 交互面推到页底 |
| Worker 隔离并发干活 | Worker ≈ 旧架构里的一个 session/tab:隔离的 chat + editing + 工具作用域 + checkpoint;平时**不用盯它的输出** |
| 事件驱动 | 所有 Worker 事件汇入单一事件总线 `ISuperAgentEvent`,UI/编辑区/遥测全部订阅,不轮询 |
| 全双工打断 | 输入通道与输出通道解耦:`queueInput`(随时写)+ `interrupt`(协同式打断标记) |
| 外部 Watchdog | 每 Worker 心跳 + 两级超时;最终形态把看门狗放到 Electron main 进程(渲染进程挂了也能救) |
| 与人类组织相似 | Router UI = 前台/指挥舱;Worker = 工程师工位;Watchdog = 督导;编辑区 = 只有一位工程师上台演示 |

---

## 2. 现状盘点(基于本仓库真实结构)

### 2.1 会话与执行
- `common/chatService/`:单会话请求生命周期(`sendRequest` → progress → done)。
- `common/model/`:ChatModel/ViewModel、会话存储。
- `browser/chatSideChatProvider.ts`、`widgetHosts/`:同一会话可出现在侧栏/编辑器 tab/quick chat 多个宿主。

### 2.2 多会话(云端/沙箱形态)
- `browser/agentSessions/`:`IAgentSessionsModel`、`IChatSessionsService` providers、Agents Window。
- 这已经是"多 Worker"的一种形态(云沙箱跑任务),但它是**远端**的:会话在云端沙箱里改代码,本地只是看板,不存在"多个 Worker 同时改我本地工作区"的问题。

### 2.3 编辑(agent mode 本地编辑)
- `browser/chatEditing/chatEditingSession.ts`:每个 chat 会话一个 `ChatEditingSession`,按 `chatSessionResource` 隔离:
  - working set = `IModifiedFileEntry[]`(mirror model:`chatEditingModified` scheme 虚拟模型,accept 前不动真实文件语义);
  - checkpoint timeline(每次请求/undo stop 快照,可 `restoreSnapshot` 回滚);
  - `show()`:打开该会话专属的 "Suggested Edits" **multi-diff editor**(`getMultiDiffSourceUri` 已把 chatSessionResource 编码进 URI,天然按会话隔离);
  - `chatEditingCodeEditorIntegration.ts`:在真实代码编辑器里渲染 hunk 级 keep/undo 装饰。
- **关键结论:数据模型早已按会话隔离,但 UI 没有"归因"和"焦点"概念** —— 任何会话的 `show()`、任何编辑器装饰都可能抢"全局舞台",这就是"乱"的根源。

### 2.4 问题陈述
今天同时开 3 个本地 agent 会话:
1. 三个会话各自往编辑区塞自己的 multi-diff / diff editor,互相顶替;
2. Explorer/Open Editors 里分不清哪个文件是哪个任务改的;
3. 会话 A 卡死,用户只能干等,没有"督导"帮你发现并处置;
4. 你正跟会话 A 说话,会话 B 的输出把你的注意力拽走(无全双工模型,注意力是被动的)。

---

## 3. 目标架构:Router + Worker + 事件总线 + Watchdog

```
┌─────────────────────────────────────────────────────────────────┐
│ 用户 ◄──全双工──► Router(常驻会话:澄清、拆解、分派、汇总)        │
│                    │ IChatRouterService                          │
│                    │ · 并发预算(≤10)· 焦点管理 · 事件总线       │
│                    ▼                                            │
│   ┌─ Worker 1 ─┐ ┌─ Worker 2 ─┐ ┌─ Worker 3 ─┐ ┌─ Queued… ─┐   │
│   │ chatSession│ │ chatSession│ │ chatSession│ │ 等空槽     │   │
│   │ editSession│ │ editSession│ │ editSession│             │   │
│   │ tools scope│ │ checkpoint │ │ watchdog   │             │   │
│   └─────┬──────┘ └─────┬──────┘ └─────┬──────┘             │   │
│         └────── Event<ISuperAgentEvent> ──────┘              │   │
│                    │                                            │
│      SuperAgentEditorCoordinator(编辑区联动,见 §4)           │
│      SuperAgentPresentationQueue(完成队列,见 §5)             │
│      外部 Watchdog(main 进程,Phase 4)                        │
└─────────────────────────────────────────────────────────────────┘
```

### 3.1 Router(`IChatRouterService`,本次已落地骨架)
职责收窄且纯粹:**不执行任务,只编排**。
- `createWorker({label, chatSessionResource})`:绑定一个 chat 会话派生 Worker,发号(slot 1..10、badge、主题色);
- 并发预算:活跃 Worker ≥ 10 时新任务 `Queued`,有 Worker 终态后自动晋级(`_maybePromoteQueued`);
- 焦点管理:`focusedWorkerId` / `focusWorker()` —— 编辑区所有权的唯一事实源;
- 事件总线:`onDidWorkerEvent` 单流广播(created/stateChanged/activity/inputQueued/interrupted/watchdogTripped/focusChanged/…)。

### 3.2 Worker(状态机)
`Queued → Starting → Running ⇄ AwaitingUser/Idle → Completed/Failed/Cancelled`
外加 `WatchdogTripped`(可被心跳恢复为 Running)。
Worker 不是新进程,而是**既有对象的组合**:chat 会话(对话与工具执行)+ `ChatEditingSession`(working set 与 checkpoint)+ 未来追加的 cwd/工具白名单。它的全部可变面都是 observable,UI 无需命令式轮询。

### 3.3 全双工打断
- 输入永不阻塞:`queueInput` 在 Worker 正在跑 turn 时随时入队,执行层在工具调用间隙 `takeQueuedInputs()` 注入 —— 用户"插话"不需要等,也不需要先停掉任务;
- 打断是协同式的:`interrupt()` 只置 `pendingInterrupt` 标记 + 广播事件,由执行层在安全点取消在飞请求(CancellationToken)并把打断原因写进上下文,避免半写状态;
- Router 会话本身永远是可输入的:你对 Router 说"把 2 号任务停了"是自然语言指令,Router 翻译成 `interrupt(worker2)`。

### 3.4 Watchdog
- 每 Worker 一个 `TimeoutTimer`:任何 activity(token 流、工具调用、checkpoint)都会重置;超时 → `WatchdogTripped` + 事件;后续心跳可恢复;
- 两级处置(设计):第一级 trip = 通知 + 暂停派发;第二级 = 自动 `cancelWorker` 并回滚该 Worker 的 checkpoint(见 §4.5);
- 外部化(Phase 4):看门狗移到 Electron main 进程,通过 IPC 心跳;渲染进程假死也能强制落盘与终止,呼应文章"Watchdog 必须在被监督者之外"。

### 3.5 Router UI(单页指挥面,Phase 2)
- 完整布局与交互见 §5:**一个页面**,不是一排 tab;
- 摘要:人只盯这一页 —— 顶部看有多少 Worker 在跑,中部跟 Router 派发/澄清,底部承接「刚跑完、需要继续交互」的 Worker 内容;
- Worker 平时后台跑,输出不抢注意力;跑完(或需要你)时由 Router **告知并展示**,而不是让人去翻旧 session tab。

---

## 4. 编辑区联动:焦点所有权 + 归因 + 分级隔离

**总原则:编辑区属于焦点 Worker;非焦点 Worker 的改动以"归因标记"存在,不直接登台。**

### 4.1 焦点所有权模型(本次已落地)
- `focusedWorkerId` 是编辑区内容的唯一所有权来源;
- `focusWorker(A)` → `SuperAgentEditorCoordinator` 调 `A` 的 `ChatEditingSession.show()`,把 A 的 "Suggested Edits" multi-diff 换上编辑区(每个会话的 multiDiffSource URI 本来就按 `chatSessionResource` 隔离,零新增隔离机制);
- 背景 Worker 永远不自动 `show()`、不自动打开 diff editor,更不会滚动/抢焦点编辑器;
- 结果:③ 交互承接区展出谁,编辑区就切到谁;不看哪个任务,那个任务的改动就不出现在编辑区。

### 4.2 归因体系(本次已落地文件级)
- 每个 Worker 固定:槽位号 badge("1".."10")+ 主题色(`charts.*` 6 hue 取模轮转);
- `SuperAgentWorkerDecorationsProvider`:背景 Worker 的 working-set 文件在 Explorer / Open Editors / Tabs 上挂 badge + 主题色 + tooltip("Background worker 2 (修复登录超时) edited this file");焦点 Worker 的文件不加标记(它们已在台上,避免噪音);
- 后续(Phase 2)把主题色贯穿到:代码编辑器 gutter/minimap/overview ruler 的 hunk 装饰、multi-diff 标题、终端输出、SCM 视图 —— 所有"这个任务产生的东西"同色系,一眼归因。

### 4.3 分级隔离策略(产品档位,不是二选一)
- **L1 归因共享工作区(默认,已具备)**:所有 Worker 写同一工作区,靠 hunk 级归因 + checkpoint 回滚兜底。优点:所见即所得、无需合并;代价:跨任务同文件冲突需仲裁(见 4.4)。
- **L2 影子工作区(Phase 3)**:Worker 在 shadow worktree / 虚拟 FS overlay 里改(可复用 `chatEditingModified` mirror-model 与 `ChatEditingTextModelContentProvider` 机制,以及 git worktree);编辑区看的是"overlay 合成视图";任务完成走 review gate(现有 accept/reject 流程)才落真实工作区。适合"大改动、不确定要不要"的任务。
- **L3 完全沙箱(已有)**:复用 agent host 云/本地沙箱(`IAgentSessionsService` providers、`browser/remoteAgentHost`),本地只看板 + 拉 PR 式 review。适合"跑长任务、不想让它碰我机器"的场景。
Router 可以按任务特征自动选档:小修 L1、重构 L2、实验/夜间任务 L3。

### 4.4 冲突仲裁(L1 下)
- Router 维护文件→Worker 占用表:Worker B 即将改的文件已在 A 的 working set 里 → 默认**串行化**(B 对该文件的编辑排队直到 A 终态),或降级为向用户提问;
- 同文件已产生双方改动 → 用现有 checkpoint timeline 三方合并 + 分 hunk review;
- 单 Worker 一键整体回滚:`ChatEditingSession.restoreSnapshot`(按该 Worker 的最后一个好 checkpoint),不影响其他 Worker —— 回滚的爆炸半径被会话边界天然限定。

### 4.5 Watchdog 与编辑区
- Worker trip → 状态条提示 + 进入完成队列(与 Completed 同路);指挥舱提供 Resume / Rollback / Kill;
- 用户正跟别的 Worker 交互时 trip 的 Worker 不打扰编辑区,只进队列 + 右下角提示。

### 4.6 为什么这套联动"不乱"了
| 之前的乱源 | 本设计 |
|---|---|
| 多会话抢编辑区 | 编辑区单所有权,焦点切换显式化 |
| 不知道谁改了哪个文件 | badge + 主题色全链路归因 |
| 卡死会话占着注意力 | Watchdog + 后台化,处置动作在指挥舱 |
| 想插话必须先停任务 | 全双工 queueInput / 协同 interrupt |
| 改坏了一起完蛋 | 会话级 checkpoint 回滚,爆炸半径 = 单 Worker |

---

## 5. Chat 区域重设计:单页指挥面

### 5.0 核心范式(相对旧设计的纠正)

旧 chat = **人盯多个 tab/session**,来回切换才能知道谁跑完了、跟谁继续聊。  
新架构要改掉的正是这件事:

> **人只盯一个页面。** Worker ≈ 旧的 session/tab,平时不用看它的输出;有结果时由 Router **告知并在本页底部展示**,方便继续交互。

此前文档里的「钉住 Workers tab / 三层指挥舱 / 切台面」是为了**兼容旧多 session 逻辑**的过渡形态,不是目标形态。目标形态里:

- Chat 区就是**一个页面**(Router 页),不是一排可切换的 session tab;
- 顶部只回答「现在有多少 Worker 在跑 / 谁需要你」——状态条,不是切 tab 的入口;
- 中部永远是 Router:派发、澄清、汇总;
- 底部是**当前可交互的 Worker 面**:某个 Worker 跑完(或需要你)时,把它的关键输出/继续聊的入口推到这里;
- 底层执行对象不变(每 Worker 仍是隔离的 chatSession + editingSession),变的是**人怎么看、怎么接**。

### 5.1 单页布局

```
┌──────────────────────────────────────────────────────────────────┐
│ ① 状态条(常驻)  3/10 运行中 · ⚠1 需要你 · ◷2 排队                 │
├──────────────────────────────────────────────────────────────────┤
│ ② Router 区(常驻)                                                │
│    你跟 Router 的对话:派发任务 / 澄清 / 汇总                      │
│    [输入框:永远发给 Router,回车即派发]                            │
├──────────────────────────────────────────────────────────────────┤
│ ③ 交互承接区(页底,按需出现)                                      │
│    ▎2 · 修登录超时 · 已完成 · 改 3 文件                           │
│    ……该 Worker 的关键输出 / 继续聊……                               │
│    [继续追问] [Review diff] [合并] [关掉]                         │
└──────────────────────────────────────────────────────────────────┘
                                                    ┌────────────┐
                                                    │ ④ 右下角提示│  ← 仅当③正被占用时出现
                                                    │ Worker 4 完成│
                                                    └────────────┘
```

### 5.2 ① 状态条 —— 只报告,不当切换器
- 回答「机器在干什么」,**不是**「点哪行去切 session」;
- 内容:`n/10 运行中 · ⚠ k 需要你 · ◷ q 排队`;可点开轻量列表看标签/时长,但主路径仍是「等它推到③」,而不是让人巡检;
- **布局**:状态条与 chat **上下相邻占位**,展开列表时挤占 chat 区域高度,绝不浮层覆盖 transcript(滚到顶部时第一条也不被挡住);
- Worker 身份色/槽位号仍保留,供编辑区归因(§4)对齐,但状态条不是多 tab 替代品。

### 5.3 ② Router 区 —— 人日常唯一主动开口的地方
- 本页的主舞台。输入**永远发给 Router**(派发新任务 / 问进度 / 叫停某个 Worker);
- 派发路径不变:`SuperAgentRouterDispatcher` 拦截 Router 会话提交 → 建 Worker → 任务进 Worker 会话执行;
- Router 自己不写代码、不应答长 transcript;它负责编排与告知。
- Router 主舞台 = 按 Worker 分区的任务板(需要你 / 进行中 / 已完成)+ 卡内追问链,不再是派发气泡时间线。

### 5.4 ③ 交互承接区 —— 跑完的 Worker 从这里露脸
- **正常路径**:Worker 进入「需要人」(跑完要确认 / `AwaitingUser` / `WatchdogTripped`)时,若③空闲 → **自动把该 Worker 的交互内容展到页底**,用户就地继续聊、Review、合并;
- 平时跑着的 Worker:**不**把输出推到这里,人不需要盯流式 token;
- 展示内容 = 该 Worker 会话里「值得继续交互」的部分(终态摘要 + 可追问的 composer + 编辑动作),不是再开一个 tab;
- 关掉③ / 明确「处理完」后,若完成队列里还有下一项 → 自动接下一项(见 5.5)。

### 5.5 ④ 完成队列 + 右下角提示 —— 冲突时不抢戏
这是注意力预算的守门人,也是相对旧「多 tab 抢注意力」的关键纠偏:

| 场景 | 行为 |
|---|---|
| ③ 空闲,Worker A 跑完/需要你 | 直接把 A 展到③;编辑区 `focusWorker(A)` |
| 用户正在③里跟 A 交互,Worker B 又跑完 | **不**顶掉 A;B 入**完成队列**;右下角出轻提示「Worker B 已完成」(可点,也可忽略) |
| 用户处理完 A(关掉③ / 合并完 / 明确下一项) | 队列头自动升到③;提示消失 |
| 多个后台同时完成 | 按完成时间入队,一次只展一个;右下角提示可显示「还有 n 个待看」 |

规则要硬:
1. **正在交互时绝不自动换③的内容** —— 抢戏比漏消息更糟;
2. 提示只在右下角,**不**模态、不抢输入焦点、不打断打字;
3. 队列先进先出;用户点提示 = 把该项提前到队头并(仅当③空闲或用户确认切换时)展示;
4. `AwaitingUser` / `WatchdogTripped` 与 `Completed` 走同一套队列,优先级可后续微调(需要你 > 已完成),但互斥展示规则相同。

### 5.6 与旧「多 tab / 钉住 tab」的关系
- **旧多 session tab**:每个 tab ≈ 一个要人盯的会话 → 新架构里映射为 Worker,人不再靠切 tab 巡检;
- **钉住 Workers tab**:仅作过渡期入口/兼容壳(让旧 tab 条上还能点进「这一页」);目标态下 Chat 打开即是本页,不必再「先点 Workers tab」;
- Worker 底层仍可有自己的 session URI(执行与编辑隔离需要),但**默认不在 tab 条上暴露成可切换项**。

### 5.7 输入路由

| 输入位置 | 发给谁 | 何时可用 |
|---|---|---|
| ② Router 区 | Router(派发/编排) | 永远 |
| ③ 交互承接区 | 当前展出的 Worker | 仅当③有内容(mid-turn → `queueInput`) |
| ④ 提示上的「查看」 | 把该 Worker 升到③ | ③空闲则立刻;③占用则先入队/确认切换 |

### 5.8 与现有组件的映射
| 设计元素 | 复用 / 新增 |
|---|---|
| ② Router 区 | 现有 zcode Router 会话(`zcode.ensureRouterSession`)+ `SuperAgentRouterDispatcher` |
| ① 状态条 | 演化自现有 `SuperAgentWorkersPanel` 摘要行:保留计数与轻量列表,去掉「点击=切 tab/台面」的主语义 |
| ③ 交互承接区 | 新:页底宿主,绑定「当前展示中的 Worker」会话;编辑区仍走 `focusWorker` |
| ④ 完成队列 + 右下角提示 | 新:`ISuperAgentPresentationQueue`(排队 / 展出 / 关闭 / 延后提示) |
| Worker 执行体 | 不变:chatSession + `ChatEditingSession` + Watchdog |

### 5.9 为什么是「一页」,而不是「三层切台」
1. **瓶颈在人**:人同时盯多个 session 会炸 —— 解法是消灭多台面巡检,不是把 tab 做得更漂亮;
2. **Worker ≈ 旧 session,但默认不可见输出**:执行照旧隔离并发,注意力只在「需要你」时进入本页底部;
3. **冲突用队列,不用抢**:正在交互时新完成的 Worker 进队 + 右下角提示,处理完再自动接上 —— 这才是「一个人盯一个页面」可扩展到 10 并发的原因;
4. **编辑区同致动**:③ 展出谁,`focusWorker` 就指向谁,chat 与编辑区不会各看各的。

---

## 6. 落地路线图与本次代码

### Phase 1(骨架)
| 文件 | 内容 |
|---|---|
| `common/superAgent/chatRouterService.ts` | `IChatRouterService` 接口、Worker 状态机、事件类型、并发预算/看门狗常量、Worker 配色表 |
| `browser/superAgent/chatRouterServiceImpl.ts` | Router 实现:Worker 注册表、槽位/配色、并发预算与排队晋级、每 Worker TimeoutTimer 看门狗(心跳可恢复)、全双工 `queueInput`/`takeQueuedInputs`/`interrupt`、焦点管理与事件总线 |
| `browser/superAgent/superAgentEditorCoordinator.ts` | 编辑区联动:焦点切换 → 换台显示焦点 Worker 的 multi-diff;背景 Worker 文件的 badge/主题色/tooltip 归因装饰 |
| `browser/chat.contribution.ts` | 注册 `IChatRouterService` 单例与 Coordinator contribution |
| `superAgentRedesign.md` | 本文档 |

### Phase 2a(过渡可见切片,已落地 — 兼容旧多 session)
> 当时为兼容旧 tab 条,落了「钉住 Workers tab + 顶部栅条 + 点击切台」。按 §5 纠正后,这些是**过渡壳**,不是目标 UX。保留可用,后续演进为状态条 + 页底承接区。

| 文件 | 内容 | 相对 §5 的定位 |
|---|---|---|
| `browser/superAgent/superAgentWorkersView.ts` | Workers Panel:状态行/列表 | → 演化为①状态条(去掉「点击=切 tab」主语义) |
| `browser/superAgent/superAgentChatPage.ts` | 顶部状态条(与 chat 相邻占位,展开挤高) | → 演化为单页壳(状态条常驻 + ③页底承接) |
| `browser/superAgent/superAgentRouterDispatcher.ts` | Router 派发 | 保留,对应② |
| `browser/zcode/zcodeAuxiliaryBarChrome.ts` | 钉住 Workers tab | **过渡兼容壳**;目标态 Chat 打开即本页 |
| `browser/superAgent/superAgentChatBridge.ts` | 真实信号桥 | 保留 |
| `browser/superAgent/superAgentCommands.ts` | 相关命令 | 随壳演进 |

### Phase 2b(按纠正后的 §5 推进)

**已落地(本轮)**:
| 文件 | 内容 |
|---|---|
| `common/superAgent/superAgentPresentationQueue.ts` | `ISuperAgentPresentationQueue`:presented / pending / toast |
| `browser/superAgent/superAgentPresentationQueueImpl.ts` | 完成队列实现:空闲直接展出、占用则入队;dismiss 自动接下一项;force present 时仅把仍需人工的项(AwaitingUser/Watchdog)泊回队头,已完成项直接丢弃以免「查看」来回切换 |
| `browser/superAgent/superAgentPresentationUi.ts` | ③ 页底 dock + ④ 右下角 toast;展出时打开该 Worker 会话,清空时回到 Router |
| `browser/superAgent/superAgentChatBridge.ts` | 请求结束(`requestInProgress` true→false) → `markIdle` → 触发 offer |
| `browser/superAgent/chatRouterServiceImpl.ts` | 新增 `markIdle`;创建 Worker 不再自动抢编辑区焦点 |
| `browser/superAgent/superAgentChatPage.ts` | Chat 打开即进入单页(状态条+Router),不再依赖先点钉住 tab |
| `browser/superAgent/superAgentWorkersView.ts` | 点击行 → `presentationQueue.present(force)`,不再直接当 tab 切换器 |

**仍待**:
- ③ 与 zcode webview 双宿主(Router 常驻中部 + Worker 内容真的嵌在页底,而不是切换同一 webview);
- Router 派发回执 / 意图解析 / 模型透传;
- 主题色贯穿 gutter/minimap。

### Phase 3(隔离与仲裁)
- 文件占用表与跨 Worker 串行化;单 Worker 一键回滚 UI;
- L2 影子工作区(worktree/virtual FS overlay + review gate)。

### Phase 4(外部督导与窗口整合)
- main 进程 Watchdog(IPC 心跳,渲染进程假死兜底);
- 与 Agents Window / 云端 agent sessions 打通:同一指挥舱管理本地 Worker 与远端 Worker。

### 已知简化(当前边界)
- 心跳与状态已由 `SuperAgentChatBridge` 从真实 chat 事件驱动,但请求完成 → Idle/Completed 仍缺稳定事件源(暂由看门狗/手动 complete 兜底);
- Phase 2a 的钉住 tab / 点击切台仍在跑,与 §5 目标态不一致 —— 正由 2b 纠正;
- 冲突仲裁、L2/L3 档位切换、main 进程看门狗未实现。

---

## 7. 风险与开放问题
- **注意力预算是产品红线**:人只盯一页;同时展出的交互面最多一个(③),其余进完成队列 + 右下角提示。任何「再开一个 tab / 再切一个台面让人巡检」的提议默认拒绝;
- 归因色板 6 hue 轮转(10 槽位复用),槽位 badge 保证唯一性,颜色仅辅助(无障碍场景以 badge/文字为准);必要时 Phase 2 注册专用 `superAgent.*` 主题色;
- L2 影子工作区与扩展生态(格式化、TS server 等)的兼容成本高,必须做成显式 opt-in;
- Router 本身的失败模式:Router 会话自己卡死怎么办 → 由 Watchdog 监督 Router(监督者也要被监督)。

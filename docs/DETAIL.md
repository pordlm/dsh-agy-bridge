# Antigravity 桥（官方 ACP 通道）

本插件把 DeepSeek Harness 与本机 **Antigravity CLI 的官方 `agy acp`** 连接起来。
DSH 会话派发一个 ACP prompt；桥只在对应 prompt 请求成功结束、且得到可交付的
assistant 最终文本时，才把回复交给原 DSH 会话。它不经过桌面应用私有 RPC，不反代
Google 上游模型接口，也不读取登录凭据。

## 数据流

1. **初始化**：`AcpClient` 以配置的 `agyExecutable`/`agyArgs` 启动本地子进程，
   通过 stdio 发送 ACP v1 的 `initialize`。客户端声明不提供 fs/terminal 能力。
2. **会话**：新任务 `session/new({cwd, mcpServers: []})`；续聊优先
   `session/resume`，仅在服务返回 method-not-found 且 `loadSession` 为真时回退
   `session/load`。加载期间回放的旧 user/assistant 消息全部忽略。
3. **模型与强度**：从 `configOptions` 按 `category: "model"` 和
   `category: "thought"` / `"thought_level"` 选择（也接受 id/name 回退；真实
   agy 1.5.14 使用 `thought_level`）。分组 `select` 的选项会展开为“组名 / 项名”，
   仍可用原来的项名选择。先设置 model，再设置 thought；每次都要求返回完整
   `configOptions`，且其中 `currentValue` 与请求值一致。派发前确认值保存在
   `confirmed`，之后服务通过 `config_option_update` 或 prompt 结果报告的实际值
   更新 `effective`；两者不一致时结果会分别显示。任何一步失败都停止派发；已经
   生效的前一步会保留在 job 的 `effective` 与 `configOptions` 快照里。
4. **附件**：`attachments` 是调用者显式给出的绝对文件路径。桥先做路径、类型、
   数量、单件/总字节校验，再按 `initialize` 声明的 `image`/`embeddedContext`
   读取并构造 ACP 内容块。未协商或类型未知时在读取内容前失败。`path_refs` 只
   生成 `[path_reference]` 文本块，不读取内容。
5. **一轮一 job**：job 在写入 prompt 前持久化；同 ACP 会话有 lock，只允许一个在途
   prompt。`session/prompt` 的 JSON-RPC 请求与通知按会话/请求关联；只有
   `agent_message_chunk` 的最终文本进入回复，thought/tool/只读进度不进入。
6. **完成判定**：`stopReason === "end_turn"` 且文本非空才是 `replied`。
   `refusal`、`max_tokens`、`cancelled`、空回复、未知 stopReason 都是失败，不唤醒。
7. **投递**：`replied` 后只通过 job 的固定 owner Agent 调用一次 `followup`。
   `wait` 进行中会抑制自动唤醒；`wait` 超时只返回 `wait_timeout`，不改变 job
   状态，之后仍可用 job_id 读取或再次等待。投递成功/未知不会重复唤醒。同一
   job 的并发等待者按计数抑制唤醒，最后一个等待者退出前不会提前唤醒。
8. **取消**：`antigravity_cancel` 先校验 job owner，再对在途 ACP prompt 发送
   `session/cancel`，短暂等待实际的 `session/prompt` 响应；状态由返回的
   `stopReason` 更新（通常 `cancelled` → `failed/cancelled`），不伪造回复、不重发。
   如果服务在窗口内没有结束，job 保持 `accepted`，记录 `cancelRequested`，之后
   仍可读取或等待。

## 状态与失败语义

- `not_sent`：可证明没有写入 prompt（spawn/initialize/session/config 失败，
  或 prompt 请求在写入前失败），可安全重试。
- `accepted`：prompt 请求已写入子进程，等待对应的 `session/prompt` 结束。
- `acceptance_unknown`：prompt 可能已送达但结果不明（传输中断、旧进程退出、
  插件在 prompt 期间重启）。**不会自动重发**；保留 lock，避免同会话并发覆盖。
- `failed`：请求已结束但没有可交付最终回复；不唤醒。
- `replied`：有最终回复，缓存在 job 上；等待超时也不会消费。

插件重启时：

- `creating`/`resuming`/`configuring` → `not_sent`（prompt 尚未发出）；
- `prompting` 或 `accepted` → `acceptance_unknown`（保留 lock）；
- `wakeState: "delivering"` → `delivery_unknown`，不会再次唤醒；
- 旧版本桌面通道的 job → `failed/legacy_state`，不迁移、不重发。

## 桌面备用通道（显式）

ACP 是唯一缺省通道。`transport: "desktop"` 才进入桌面通道，且必须先在配置里
固定五元组目标（`pid`、`startedAt`、`hwnd`、`uri`）并 `desktop.enabled: true`：

1. **目标校验**：`lib/desktop.js` 起一个 `pwsh -File lib/uia-driver.ps1` 子进程，
   请求体只走 stdin（不拼 shell）。驱动核对进程存在、启动时间差 ≤2s、可执行文件
   路径、顶层 `Chrome_WidgetWin_1` 窗口、当前 Document 完整 URI 与唯一会话链接。
   任一不符即 `desktop_session_unverified` / `desktop_session_ambiguous`。
2. **派发前预检（两次只读）**：连续两次 `inspect`（间隔约 300ms，第二次独立、不带
   基线）都必须可写空闲：显式 `phase === "idle"`，或证据式推断——历史采集完整
   （`history.complete === true`）、无 Stop 控件、无权限卡、会话日志锚点存在。两次
   的回合列表与末条 assistant 文本必须逐字一致，否则 `desktop_not_idle`；采集不完整
   则 `desktop_history_incomplete`。**驱动的根 `complete`（稳定结束）不参与“能否派发”**，
   它只在写后用于回复归属。
3. **Send 前强制落盘**：用第二次预检快照冻结基线，并先把 `targetKey`、
   `desktopConversationId`、`phase: "prompting"` 写入状态文件；`save()` 失败即
   `not_sent / state_write_failed`，不进行任何窗口写入。
4. **一次写入、一次 Send**：`dispatch` 动作确认 composer 唯一且为空、写入后读回
   严格相等、再确认 URI 未漂移，才 Invoke 一次 Send。驱动返回
   `not_sent` / `acceptance_unknown` / `invoked`；`invoked` 只表示“发出过一次”，
   不表示应用已受理。`not_sent` 会落成可安全重试的失败；`acceptance_unknown`
   保留 job、不重发。
5. **归属**：`lib/desktop-attribution.js` 轮询判定——基线之后**第一条**用户气泡必须
   唯一匹配 dispatch 文本（不匹配即 `dispatch_not_observed`，不向更晚气泡搜索；
   同一增量里第二条匹配即 `duplicate_dispatch_turn`）；每次快照复验该锚点仍在原位
   且文本未变（被改写即 `baseline_diverged`）；本轮出现过 `busy`/`permission`；
   连续两次完整空闲快照逐字一致；只取该回合之后、下一条用户气泡之前的 assistant 段。
   旧正文、进度、超时、目标漂移、权限卡都不会唤醒。
6. **权限**：识别到权限卡时 job 保持 `accepted` + `permissionPending: true`，提示
   用户到窗口处理；桥不点任何 Allow/Deny。
7. **取消**：桌面通道没有已验证的 Stop 控件；取消只 abort 本地观察，
   返回 `cancelSent: false`、`stopControl: "unavailable"`。取消标记在每个 await 之后
   复查：取消先于最终页到达时，晚到页面不会被采纳为 `replied`，也不产生唤醒。
8. **提交边界与异常出口**：驱动维护 `none → pre_write → writing → written → invoking →
   invoked` 边界。Invoke 之后任何读数/观察异常（焦点探测失败、根树或文档消失、后置
   扫描抛错）都返回 `acceptance_unknown` + `invokeAttempted: true` + `invokeCount ≥ 1`
   并附 `diagnostics.dispatchBoundary`；只有边界尚未过 `invoking` 的失败才是
   `not_sent`。Bridge 对 `not_sent` 落成可重试失败，对 `acceptance_unknown` 保留 job、
   锁与不重发承诺。
9. **返回时机**：`dispatch` 在唯一 Send 后立即返回 job（`jobId` + `accepted`），观察
  注册为 `activePrompts` 的后台 promise；只有显式 `wait` 按用户 `timeout_sec` 等待，
   超时只影响返回值，job 仍可 `read`/查询。
10. **生命周期**：`Bridge.dispose()` 先置 `closed`，再 `desktop.stop()`（abort 全部在途
    inspect、停止轮询），最后清 timer；`save()`/`maybeWake()` 在 closed 后直接拒绝。
   因此旧实例不会覆盖新实例的状态文件、不会释放新实例的锁、不会唤醒。晚到结果被丢弃。

能力公布：桌面通道 `models: []`、`efforts: []`、`attachments.native: false`，
`modelSelection/effortSelection: "unavailable_on_desktop"`；`conversation_id`、
`model`、`effort`、字节附件在派发前拒绝，只有 `path_refs` 可用。Web 侧
`capabilities` 把 `desktop` 公布为布尔、`target` 为脱敏后的固定目标，并在
`desktopCapabilities` 里给出同一组细节；两处读的是 `DesktopChannel.capabilities()`
的同一份返回，避免“enabled 了却显示 desktop:false”的错配。

证据等级：实现 + 离线替身测试（`scripts/desktop-test.mjs` 的脚本化驱动）已覆盖；其中
一条用例真的启动 `pwsh` 加载本包自带的 `lib/uia-driver.ps1`，用合成 UIA 场景文件走完
“两次预检 → 单次 Send → 超时不交付 → 窗口仍被锁”的跨进程链路。真实 Antigravity 窗口
只验证过只读 `inspect`，真实 Send、权限卡、生成中控件的语义仍未验证，驱动 README 的
“未确认控件语义”清单仍然有效。

## 权限

`permissionPolicy` 默认 `reject`，配置加载时只接受 `reject` 或 `allow_once`。
`reject` 从服务提供的选项中选 `reject_once`/`reject_always`，没有拒绝项时返回
`cancelled`。`allow_once` 仅在该 ACP session 有正在收集的 prompt 时，选择服务提供的
`kind=allow_once` 的 `optionId`；不会选择 `allow_always`，也不会自己构造批准选项。
每次决定记录 `requestId`、`toolCallId`、标题、kind、policy、decision 和 `optionId`，
进入 job 的 permissions/trace，并写入 ACP 日志。没有活跃 prompt 的请求不会自动批准。

`allow_once` 会自动批准 agent 本次请求的原生文件修改或命令，可能作用于项目外部；
工作区绑定决定任务起点，不是原生工具的文件系统沙箱。仅在明确授权这些操作时启用。
已部署验证包的 bundle patch 明确配置了 `allow_once`，因此活动 profile 没有显式配置行
也可出现批准；源码安全默认值仍为 `reject`，部署时需明确保留所需策略。

## 任务桥工作区与客户端文件探针

任务桥 send、Web 面板 dispatch、`antigravity_config` 共用 `lib/workspace.js`：优先读取
已安装 Host API `ctx.workingDirectory.get(agent.session)`，缺少该服务时才使用显式
`cwd` 配置；没有配置时拒绝以 DSH 进程启动目录冒充项目。对结果执行绝对路径、
realpath、目录与可访问性检查；失败返回 `workspace_unconfigured`、`workspace_invalid`
或 `workspace_unavailable`，不会发 `session/prompt`。不使用 `ensure()` 的自动回退。

`session/new.cwd` 使用该规范目录；job/status/list/面板显示 `workspaceRoot`。
ACP session→目录绑定持久化在 state.workspaces；续聊检查同一绑定，换根返回
`workspace_mismatch`，必须新建会话。旧状态中没有绑定的会话返回
`workspace_binding_unknown`，不推测旧目录。

agy 1.5.x 的本轮实测（精确版本 1.5.14）未调用客户端 fs：正常 `fs=false` 已能用原生
工具读写；独立 `fs=true` initialize 加真实安全 handler 后仍无
`fs/read_text_file` / `fs/write_text_file` 请求，原生 `read_file`/`write_file` 成功。
这只是该版本与两次读写任务的观察，不保证所有未来版本或任务行为。
完整协商快照、无请求事件数组、权限和磁盘核验在 `results/round1-live-probe.json`。

正常任务继续声明 `readTextFile=false` / `writeTextFile=false`，不提供生产文件回调。
`AcpClient` 保留显式 `fsProbeHandler` 能力开关和收到 fs 请求的只读 trace；仅传入真实
handler 时声明 true。独立脚本 `scripts/round1-live-probe.mjs` 使用
`scripts/fs-probe-handler.mjs`，校验活动 session、绑定目录、绝对路径、真实路径越界
（含 junction）、只读、UTF-8、64 KiB 上限、行范围；测试不开放该能力给普通任务。
未来版本若真的请求客户端 fs，需先完成生产集成与独立安全审查再启用。

修订后的 `scripts/round1-live-probe.mjs` 仅重复独立 fs=true 观察，保留首轮 Bridge job
证据。默认不传 `--gemini-dir`，由 CLI 使用自身用户目录（空的新目录没有登录态）；
运行它需授权 CLI 用户目录的 session/log 写入。可显式传
`--gemini-dir <绝对路径>` 或 `--gemini-dir=<绝对路径>`，该目录必须已存在且可访问/可写；
缺值、相对路径、不可用目录及共享验证/部署目录均在启动 ACP 前明确拒绝，不静默回退。
本轮默认目录实际不可访问，采用队长授权的 TEMP 登录数据副本完成验证，原件只读。
探针前后递归记录共享验证目录的文件名、大小和修改时间；完整快照、差异、协商、权限、
native 写入磁盘 marker 读回值保存在 `results/round2-live-probe.json`。
脚本不新建 Bridge job 或覆盖首轮 state；native marker 在读回核验后替换为完整证据 JSON。

## Web 面板与附件 receipt

`client/index.js` 是 DSH Web 客户端 bundle，注册在
`conversation.composer.dock`。Host 侧 `lib/web-remote.js` 用
`ctx.reflect.provide('antigravityBridge', service)` 暴露类型化方法
`capabilities`/`dispatch`/`status`/`reply`/`cancel`；这些方法都从 `agent` 取
owner，复用同一个 `Bridge`，因此面板和工具共享 owner、lock、job、附件校验、
取消和唤醒。

面板选择文件后调用 `ctx.fileUpload.upload(sessionId, File, name)`，把 receipt 放进
dispatch 请求。Host 端：

1. `fileUploads.resolve(agent, receiptId)` 校验 receipt 属于当前会话；
2. `attachments.fileHostPath(ref)` 取宿主路径（不是由客户端提供路径）；
3. 把路径作为 `attachments` 传给 `Bridge`，再按 ACP 能力读取并发送原始字节。

上传使用 `upload` 而不是 `uploadImage`，避免图片被重新编码。无效或跨会话 receipt
在 `beginSend` 之前返回 `attachment_receipt_invalid`，不会创建 job 或发送 prompt。
`path_refs` 仍是独立的“只读路径引用”选项，面板与文档都不会把它标成附件。Host
在正文末尾追加 `[path_reference]` 路径块；只包含准确路径，不读取文件内容。

同一 owner 的 `clientRequestId` 在 `dispatch` 首次 await 前登记；重复提交直接返回
同一 job/view（`reused=true`），不创建第二个 prompt。面板把该 ID 存为 `intentId`，
受理不明后重试仍用它，只有用户点“新意图”才清除。面板取消先看返回 view：未结束的
取消保持 `accepted`/`cancel_pending` 和 jobId 轮询；实际 `stopReason=cancelled`
才显示已取消；已 `replied` 则取缓存。状态业务失败保留错误码，历史权限记录不会
覆盖终态错误。

若 Host 未注册 `fileUploads`/`attachments`，面板读取
`capabilities.attachments.uploadReceipt=false`，只提供 Host 路径入口。活动 Web
profile 的启用/重载由队长部署；实现阶段只做构建与离线挂载/调用测试。

## 原生 Gemini provider

`lib/model-catalog.js` 通过独立 metadata 会话发现 `antigravity-agy-acp` 模型目录。递归解析 grouped select，逐模型新建 scratch 会话选择并完整回读 thought；没有静态白名单或四档推测。目录实例缓存五分钟、并发 single-flight；查询零 prompt。`resolveModel` 保留 per-model efforts，省略 `defaultEffort`，避免 DSH 物化默认档位。

- 显式 model 必须是 ACP 原值；`GenerateOptions.model` 是必填项，本实现选择 explicit-only，不提供虚拟 default alias。旧 `config.model` 不覆盖请求。effort 省略时取首次选定模型后 CLI currentValue；显式 low 后省略恢复保存基线。每轮 model → thought setter 的完整响应及最终组合回读必须一致；不可用档位错误含 provider/model/requested/available。
- 同一 DSH session 的 transport 与 ACP session 可复用；native-sessions.json（`stateFile` 同目录）保存 DSH id、canonical cwd、ACP id、model、system hash、稳定消息 id/hash、assistant digest、baseline、pending turnKey 与最终结果。持久 pending 先于 prompt。历史前缀必须精确多出上轮 assistant 与一个新 user，assistant digest 必须与已确认输出相同。重复/编辑/丢失历史、无 id、工作区改变、system 改变均零 prompt 拒绝。无 sessionId 仅允许隔离单轮。
- 重启后按 initialize `sessionCapabilities.resume` 的存在优先 resume，其次 `loadSession`；均无则明确失败，不新建替代。load 的历史回放不计入本轮。受理不明持久为 acceptance_unknown，不自动重发。disposal 关闭自有 transports。
- 恢复失败按真实原因分三类，不再一律伪造成「会话不存在」：`restore_unsupported`（方法未实现 / 能力未声明）、`restore_failed`（连接中断、服务拒绝等其余原因，消息保留原文）、`unknown_session`（服务明确回 -32602 unknown session）。`lib/acp.js` 的 `restoreError()` 负责分类，桥层的空 sessionId 回退同样记为 `restore_failed`。
- 死连接必须可判定地淘汰：`AcpStdioTransport` 暴露 `isClosed`（子进程已退出或已 close），适配器在复用前用 `isDeadTransport()` 判定，失效条目立即从 `liveSessions` 删除，下一轮在新连接上重新 initialize + resume；不会因为一条断掉的连接让同名 key 永久 `AGY_ACP_EXITED`。
- 每轮在 transport 上注册的 notification/request 监听器由 disposer 成对移除（`finally` 中 detach），反复 create/dispose 后监听器数量回到 0 基线。
- 清理阶段自身抛错不再阻断解锁：`finally` 中的落盘与关连接走 `safeSave()`/`safeClose()`，异常经 `onCleanupError({step, error})` 记录（未注入时 `process.emitWarning`），受理状态降级为可重试的 `acceptance_unknown`，不会把后续请求永久卡在 `AGY_ACP_SESSION_BUSY`。
- system 能力存在时 new/resume/load 发送 `systemPrompt:{mode:'append',content:[text]}`；未声明时只在首轮 user 前缀传递（明确语义降级，账本 systemTransport=user-prefix）。不发送未声明 override。developer 明确拒绝。
- 非承重工具目录被丢弃并把 `NO_TOOLS_NOTICE` 追加到 `systemText` 末尾；承重工具（`claim_task`/`update_task`/`send_message`/`create_task`/`reassign_task` 及 `agent_teams_`、`team_task_` 前缀）仍硬拒绝且零 prompt；工具历史与 `tool`/`developer` 角色仍拒绝；非文本内容仍拒绝。原生权限请求取消；fs=false。`NO_RETRY_POLICY.maxRetries=0` 保留。通知只收集绑定 session 在 prompt 与 response 之间的正文；旧 config update 不覆盖之后的完整 setter response。
- 模型聊天与任务面板独立，不共享 job/唤醒。真实 ctx.llm 两轮证据及全部回归见 [round2-impl.md](../../../results/round2-impl.md)。`scripts/round2-test.mjs --live` 现在经真实插件入口 `apply(ctx)` 装配（providers/resolveWorkspace/注册与卸载都由插件的 `ctx.effect` 完成），不再手工 `new AgyAcpAdapter`；`scripts/offline-test.mjs` 场景 30 另用注入的 `llm` 服务覆盖同一装配层，作为离线替代证据。
- 中断轮次语义（实测）：`stopReason=cancelled` 的轮次会把 stopReason 与已收到的正文写入账本并把 `inFlight` 置空，不会留下 pending 卡住后续轮次；若该轮没有产出任何正文，下一轮会在派发前以 `AGY_ACP_UNSUPPORTED_HISTORY` 失败关闭（不重放、不重发），恢复方式是新建 DSH 会话；若取消前 CLI 已流出正文，则同一绑定可继续使用。

## 安装与配置

插件用 `cordis.patch.yml` 的两个 `insert` 行部署：`dsh-agy-bridge`（任务桥 +
Web 服务）和 `dsh-agy-bridge/preset`（零工具
`antigravity-acp-text` 预设）。可用 profile `cordis.patch.yml` 或 bundle 安装，
再由 `dsh --profile <name> --dump-config` 检查合成配置。运行时保存自身配置必须走
`ctx.get('configEditor').edit(entry, ...)`，不能直接改写活动 profile。活动 Web
profile 的启用是部署步骤，不由实现阶段执行。

## Harness 加载约束与部署预检

工具 schema 必须遵守当前 Harness 的 JSON-schema 子集（由
`@deepseek-ai/dsh-tools/lib/types/json-schema.js` 的 `assertSupportedJsonSchema` 校验）：

- 约束关键字只允许 `type`、`oneOf`、`properties`、`required`、`additionalProperties`、
  `items`、`enum`、`const`；注解只允许 `description`、`title`、`default`、`examples`。
- `type` 必须是单个字符串；不要写类型数组。可空字符串用
  `oneOf: [{ type: 'string' }, { type: 'null' }]`；可空对象也用对象分支与 null 分支。
- `minimum` / `maximum` 等其余关键字不在此子集中。需要范围限制时在执行期校验或夹取，
  并在描述中说明默认值与边界，不能只删 schema 约束而遗漏运行时限制。

Round1 部署暴露了两个 schema 来源位置与一组范围关键字问题：

| 位置 | 历史违规 | 热修写法 |
| --- | --- | --- |
| `lib/index.js` 的 `desktop.target` | `type: ['object', 'null']` | `oneOf` 包含完整 object schema 与 `{ type: 'null' }` |
| `lib/web-remote.js` 的 `profile` / `model` / `effort` | `type: ['string', 'null']` | `nullableStringSchema()` 返回 string/null 的 `oneOf` |
| `lib/index.js` 的四处 `timeout_sec` / `limit` schema | `minimum` / `maximum` | 删除不支持的关键字；保留执行期已有 `Math.min` / `Math.max` 夹取 |

错误示例是 `schema.properties.desktop.properties.target.type must be a single type string
(type arrays are not supported)`。工具 schema 不合 Harness 子集会导致整站插件加载失败：
本插件的所有 `antigravity_*` 工具与面板都无法加载。修一处后必须重新跑完整预检，不能
把第一处报错修好就当其余 schema 已通过。

另一个加载约束是服务注入：[lib/index.js](../lib/index.js) 必须声明
`export const inject = ['tools', 'agents', 'workingDirectory']`。
[lib/workspace.js](../lib/workspace.js) 读取 `ctx.workingDirectory.get(agent.session)`；
Cordis Context 会按 inject 检查服务访问，缺少声明会报
`cannot get property "workingDirectory" without inject`，即使工作区服务实际已安装也一样。
`ctx.workingDirectory ?? ctx.get?.('workingDirectory')` 的空值回退不能绕过前一次属性访问
的注入检查。新增服务依赖时，必须同步维护 inject；schema 预检的 stub 不验证这项约束。

在插件根目录执行：

```powershell
node --check lib/index.js
node scripts/schema-check.mjs
node scripts/offline-test.mjs
```

`scripts/schema-check.mjs` 是部署前必跑的 pre-flight：stub ctx 调 `apply()` → 收集
`tools.register(def)` → 用 Harness 自己的 `assertSupportedJsonSchema` 检查
`def.parameters` 与存在的 `def.output.schema`。它不启动真实 ACP；现有 selftest/offline
业务测试不覆盖真实 Host 注册时的 schema 拒绝路径。可用 `--validator <绝对路径>` 或
`DSH_JSON_SCHEMA_VALIDATOR` 指定 validator；否则在本机 DSH 安装中自动发现。

部署后用 `plugin_manager({ action: 'set_bundle', target: 'dsh-agy-bridge',
enabled: false })`，再对同一 target 设置 `enabled: true`，即可在同一 DSH 进程中热重载，
无需重启；确认返回 `application: "applied"`。预检不会自行部署或重载。
两次现场失败、热修和真实验证见 [Round1 部署记录](../../../results/deploy-round1.md)。

## 安全边界

- 仅使用 Antigravity 自带的外部入口 `agy acp`，没有私有桌面 RPC、没有上游代理、
  没有凭据读取。
- 为 ACP agent 不提供 fs/terminal 客户端能力；agent 请求文件或终端时返回
  JSON-RPC method-not-found。
- 只有 `attachments` 列出的路径会被读取；`path_refs` 不读取。
- 状态文件只保存 job 元数据、请求参数和回复文本；不保存附件内容或凭据。
- 不自动修改 DSH 活动配置、Antigravity 安装或真实桌面会话。

## Antigravity CLI 登录入口（Web 面板按需授权）

- **入口位置**：
  - 面板 UI 与控制器：`client/panel.js`（及打包产物 `client/index.js`），多语言文案见 `locale/zh.json`、`locale/en.json`；提供「登录 Antigravity CLI」与「刷新登录状态」按钮。
  - 宿主 Remote 路由：`lib/web-remote.js` 新增 `authStatus`、`login` 两个方法，沿用现有会话级 `AntigravityBridgeService` 鉴权链路；**不**向智能体暴露代授权工具。
  - 宿主桥与 ACP 客户端：`lib/bridge.js`（`cliAuthStatus`、`cliLogin`）与 `lib/acp.js`（`AcpClient.authenticate`）。
- **真实入口查证证据（`agy.exe` 1.5.14 只读核实）**：
  - `agy.exe --help` 无 `login` / `auth` 子命令。
  - `agy.exe help acp` 明确提供 `--login`：`Log in with Google interactively, then exit (ACP terminal auth)`。
  - 2026-11-22 对已知已登录数据的 TEMP 不透明副本与全新空 TEMP 实测：两边 `initialize.authMethods` 都是同一组四种方式（`oauth-personal`、`oauth-business`、`gemini-api-key`、`agent-platform`），两边 `session/new` 都成功。它们均没有登录态判别力，不能据此标记已登录或未登录。
  - `agy.exe` 内置 ACP 协议方法 `authenticate`（参数 `{ methodId }`）及交互终端入口 `agy acp --login`。
- **执行流程**：
  1. 按需执行真实 `--version`。分别报告 `available`（路径与版本）、`missing`（禁用登录按钮并提供 https://antigravity.google/download 与 `agy --version`）或 `unusable`（版本执行或数据目录失败的具体原因）。
  2. 静默检测只做 ACP initialize/session/new，不发 prompt、不定时轮询。当前 1.5.14 无可靠登录态判据，返回 `unknown`；authMethods 为空、非空和 session/new 成功均不视为认证证明。`models` / `agents` 在两种隔离数据上均 exit 1，也无判别力。
  3. 用户点击登录，用 Windows PowerShell `Start-Process -WindowStyle Normal` 真开独立可见控制台；控制台使用参数数组调用官方 CLI。沿用桥 `agyArgs` 的全部数据目录参数，插入 `--login`；缺失/非绝对数据目录时提前报 `cli_data_directory_required`，不会偷偷使用默认账户目录。
  4. 登录输出只留在官方终端，不通过桥捕获、日志、state 或前端。用户完成授权后点刷新；若协议仍无判别力，继续诚实显示未知并解释真实路径。没有增加可能计费的自动验证请求。
- **隐私**：插件不读取凭据文件、不存储/上传凭据。官方 CLI 本身会管理其配置数据，这是官方登录的一部分；插件不会复制登录输出。验收 TEMP 复制为单独授权的不透明测试，非产品运行行为。
- **离线夹具与真实差异**：旧第29组使用可注入 backend 的独立 `authStatus` 模拟可判别后端，只覆盖 UI/路由/认证回查，不作为 agy 1.5.14 真机已登录证据。独立 login-entry 测试强制验证官方当前无此方法时两种 authMethods 均保持 unknown。
- **实测证据**：可见 PowerShell PID 38992、窗口句柄 11210388，子 conhost 73176、agy 81924；仅按自有 PID 树终止。共享 CLI 数据 919→919、元数据零变化，TEMP 已删除。完整对照表与测试见 `results/login-entry.md`（工作区仓库根）。
## 界面文案与技术证据

面板侧栏默认只展示面向用户的结论与下一步动作（如 `cli.unknownReason`、`cli.probeFailed`、`cli.bridgeMessage`、`nativeActivity.localDerivedNote`），不把协议字段、原始错误码或内部探测细节直接暴露在主界面，以减少阅读干扰并避免误导。登录态为何显示「未知（查不到）」的技术依据保留在本文档「Antigravity CLI 登录入口」一节与 `results/login-entry.md`：在 `agy` 1.5.x 的静默检测中，已登录与未登录两种状态的 `initialize.authMethods` 完全一致、`session/new` 均返回成功，且 `agy models` / `agy agents` 均非 0 退出，因此协议层无可靠判据，面板（`cli.unknownReasonProtocol`）绝不代为断言已登录。探测失败、CLI 附加提示与面板错误行均已移除前端 `{detail}` 与原始错误码拼接，完整的原始 detail、错误码及协议返回可在 Host/ACP 日志与对应工具返回值中排查（仅 `cli.dataDirError` 保留路径/权限相关的 `{detail}` 以便定位目录问题）。原生会话活动流中本地派生的 `updatedAt`、`source`、`truncated` 字段语义同样记录在本文档「原生工具事件语义」一节，界面仅作面向用户的人话说明。

## 已知限制

- 真实账户、真实 `agy` ACP 会话与 Antigravity 桌面 UUID 的互通**未验证**。ACP
  sessionId 与桌面 UUID 是两个命名空间；不要把桌面 UUID 传给
  `conversation_id`。
- `agy` 不在 PATH 时需要配置绝对路径；未在本工作区对真实账户做冒烟测试。
- `profile` 没有对应的 ACP 配置项，显式传入会 `unsupported_capability`。
- `title` 只是桥的本地标签，ACP 没有标题字段，不会写入 Antigravity。
- 会话恢复依赖服务实现 `session/resume` 或声明 `session/load`；两者都没有时会
  明确拒绝续聊，而不是偷偷新建会话。
- 附件只接受 png/jpeg/gif/webp 与一组常见文本扩展名；文本必须是严格 UTF-8、
  可解码且不含 NUL 的内容，否则在派发前拒绝。面板上传必须由当前 Host 的
  `fileUploads` 服务解析 receipt；服务缺失时明确退回 Host 路径附件。
- Web 面板和原生 provider 的 Host/Client、类型化 Remote、真实 AgentLoop 已用安装
  版本 DSH 离线验证；活动 Web profile 中的页面实际挂载需在队长部署后验收，本实现
  没有启用或重载活动 profile。
- 原生会话（`antigravity-agy-acp`）的活动链依赖面板本地轮询（默认 2500ms，页面隐藏时降频为 10000ms），非 ACP 推送。
- 桌面通道的“真实窗口 Send”未验证：驱动只在 Antigravity 2.34.0 上做过只读
  `inspect`（目标五元组与唯一会话链接），真实 Send 按钮、UIA 写入回读、权限卡与
  生成中控件语义仍是驱动 README 列出的未确认项。因此桌面通道默认关闭，需要显式
  配置与显式 `transport`，且模型/强度/字节附件在桌面通道不可用。

## 诊断与验证

```powershell
node --check lib/index.js
node --check lib/bridge.js
node scripts/schema-check.mjs   # 部署前必跑：工具 parameters/output.schema 子集校验
node scripts/selftest.mjs       # 只启动本地 mock ACP
node scripts/offline-test.mjs   # 离线回归（固定用例数以脚本输出为准）
node --test scripts/ui-model-integration.test.mjs   # 面板上传/Remote/真实 AgentLoop
node --test scripts/round2-test.mjs                 # ACP 适配器离线用例（含 --live 真实 CLI 分支）
node --test scripts/round3-test.mjs                 # 原生工具事件结构化 / 正文白名单 / 不发 tool-call
node --test scripts/desktop-test.mjs                # 桌面通道：脚本化驱动，不触碰真实窗口
```

## 原生工具事件语义（Round3.a）

agy 在 ACP 会话内**自己执行**原生工具（execute/edit/read 等），并将其结果以 `session/update`
的 `tool_call` / `tool_call_update` 通知回放。插件对这些事件的立场是「只观测、不代执行」：

- `lib/acp.js` 的 `normalizeToolEvent(sessionUpdate, update, kindOf)` 把它们投影成结构化事件
  `{toolCallId, kind, title, status, sessionUpdate}`；`normalizeToolKind()` 把 kind 归一化为
  `execute | edit | read | other`。规则分三种情况：update 带**非空** kind → 归一化（任何未知非空值，
  含将来新增的 kind，折进 `other`）；update **不带** kind → 先按 `content.kind` / `content.type`
  兜底，再按 `toolCallId` 继承该次调用此前出现过的类别；确实没有依据时保持 `unknown`，
  **不伪造成 `other`**（否则同一次 `execute` 调用会被后续只有 status 的 update 降级，
  让按事件流判断「发生过 execute 类操作」的消费方读到假信号）。任何情况下事件都不丢。
  `unknown` 不参与继承。
- 结构化事件与旧的 `[kind:title]` 标签**并存**：旧标签数组
  （`agent_message_chunk` 之外的 `tools` 字段）仍按 `kind:title` 拼接并去重，任务桥回复里的
  「本轮工具：…」继续由它渲染，历史行为不变。
- 正文白名单只放行 `agent_message_chunk` 且 `content.type === 'text'` 的文本。工具标题、
  `agent_thought_chunk`、图片/资源链接等非文本 content 一律不进正文，只计入
  `diagnostics = {toolEvents, thoughtChunks, nonTextMessageChunks, otherUpdates, toolCallbackErrors, lastToolCallbackError}`。
  注入的 `onToolEvent` 回调抛错时只累加 `toolCallbackErrors` 并记下最后一条错误消息，
  绝不让异常中断协议处理、也不静默丢弃。
- 这些事件**绝不**转成 DSH 的 `tool-call` / `tool-call-delta` chunk：工具已被 agy 执行过一次，
  再交给 DSH 会二次执行。模型侧只产生 `block-start{blockType:'text'}`、`text-delta`、
  `block-end{block:{type:'text'}}`、`finish` 四种 chunk；结构化事件仅通过可选的
  `onToolEvents({sessionId, events, diagnostics})` 诊断回调送出，不进入模型上下文。
- 本轮不改账本格式、不改 `planRequest` 的工具/工具历史拒绝策略，也不引入 MCP。
  回归见 `scripts/round3-test.mjs`（9 例，t23 后新增 kind 继承与回调错误计数）与
  [round3a-impl.md](../../../results/round3a-impl.md)。
- 活动流（`data-activity-region`）只保留最近 20 条，超出时丢弃最早的（在途条目也可能被挤出）。
- 活动流 `status` 原样显示 ACP 英文值（`pending` / `in_progress` / `completed` / `failed`），未做中英本地化，属已知限制。
- t2 只读探针只能证明 `tool_call` 与 `tool_call_update` 至少一类存在（落库日志无法区分各自计数，bridge 按 `toolCallId` 合并、`reply.tools` 按 `kind:title` 去重），不声称两类各自都存在。
- 原生会话活动账本中的 `updatedAt`、`source`、`truncated` 均为插件侧本地派生字段，而非 ACP 协议原生字段。

### 思考概况（agent_thought_chunk）

- **数据来源**：ACP `session/update` 的 `agent_thought_chunk` 通知，仅提取 `content.type === 'text'` 的短句 `text`（Gemini 侧不提供完整思维链，只推送简短思考概况）。
- **通道隔离**：`lib/acp.js` 通过独立的 `thoughts` 数组与 `onThought` 回调收集（不进入 `state.text`、不进入 `state.tools`）；`lib/bridge.js` 将其持久化到 `job.thoughts`（最多 20 条、每条 ≤ 200 字符，连续相同文本去重），仅由 `lib/web-remote.js` 的 `activity()` 只读透出到面板一行「思考概况：…」。**永不进入 assistant 正文、不进多轮账本历史、不进模型上下文、`lib/model-adapter.js:1005-1007` 只计数，且不参与 `systemHash`（`lib/model-adapter.js:910`）计算**。
- **配置开关**：插件配置项 `thoughtSummary`（布尔值，**默认 `true`**）。原因：短句概况信息量有限，但能直观说明 CLI 当前在做什么；设为 `false` 时既不注册 `onThought` 回调、也不收集/落盘 `job.thoughts`，面板亦不渲染该行。

### 显式完成触发：投递给 AgentTeams 成员

- **入口与签名**（DSH `@deepseek-ai/dsh-subagent/lib/index.js`）：
  - `ctx.subagents.resolveName(caller, name, signal)`（`:3072-3079`）：传入同一个实例级 `AbortSignal`；`lead` 解析为树根，路径名解析失败抛 `SubagentError('AGENT_NAME_NOT_FOUND')`。
  - `ctx.subagents.sendMessage(sender, targetId, content, { signal })`（`:3102-3104`、`:1692-1760`、`:2239`）：传入同一个实例级 `AbortSignal`；`dispose()` 时调用 `wakeAbort.abort()`，取消时记录 `wake-abandoned reason=signal_aborted`。要求 `sender` 与 `targetId` 属于同一活跃 subagent tree，且 `sender.id !== targetId`；`sender === targetId` 或目标在树外均抛 `UNAUTHORIZED`。
  - `ctx.subagents.namesOf(agent)`（`:3054-3056`）、`ctx.agents.get(id)`（活跃 Agent 注册表）；不使用 `ctx.agentTeams`（任务板服务，不负责成员消息投递）。
- **降级路径**：当 `ctx.subagents` 在运行时不可用，或 `resolveName` / `sendMessage` 抛出白名单错误码（`AGENT_NAME_NOT_FOUND` / `CONTINUATION_UNAVAILABLE` / `ACTIVATION_CLOSING` / `INPUT_CLOSED` / `DRAINING`）时，降级为直接对目标（或 owner）Agent 调用 `followup(createUserMessage(...))` 并记录 `wakeDeliveredVia = 'followup'`。`UNAUTHORIZED` 仅在 `sender.id === targetId` 时降级 `followup`，树外或未知 id 一律拒绝并记录 `wake-forbidden`（置 `delivery_unknown`）。**这是降级路径，边界：不经过 subagent tree 校验、失败只记 trace**。
- **忙碌排队语义**：目标成员正在执行其它任务时不拒绝——DSH inbox 语义为「运行中的成员在下一步收到，空闲成员开启新一轮」；排队上限与丢弃策略由 DSH 负责，本插件不做额外队列、不做拒绝、不做重试。
- **幂等**：同一 job 只能触发一次，复用 `job.wakeState` 单一状态机（`pending → delivering → delivered`）与 `clientRequestId` 账本；`wakeState !== 'pending'` 时拒绝投递并记录 `wake-rejected job=<id> state=<wakeState> reason=already_triggered`。
- **触发方边界**：所有投递逻辑仅在 DSH 内的 `lib/bridge.js` 执行；`lib/acp.js` 只做 ACP 协议解码，零 DSH 工具或 Agent 调用。

## 已知限制：会话允许的 DSH 工具无法交给 Gemini（Round3.b 已关闭）

**能力状态：未实现、未实测、不可用。** Gemini 在 DSH 内只能用自己的原生工具（execute/edit/read，走
agy 权限批准），不能调用当前 DSH 会话注册的工具。

关闭依据（两条实测证伪，证据见 [round3-probe.md](../../../results/round3-probe.md)、
[design-round3.md](../../../results/design-round3.md)）：

1. **协议层没有通道**：ACP 规范里 Agent→Client 只有 `session/update` 的 `tool_call` /
   `tool_call_update` 与 `session/request_permission`，不存在「客户端把工具交给 agent 执行」的方法；
   官方 ACP 服务器实现（`@deepseek-ai/dsh-acp`）同样没有。因此只能绕 MCP。
2. **MCP 两条路都不通**：`session/new.mcpServers` 会被 agy 解析并调度（其日志出现
   `Preloading 1 MCP servers of the session`），但我们的 stdio 服务器在观察窗口内**从未收到**
   `initialize` / `tools/list`（行分帧与 Content-Length 分帧都试过）；`agy mcp add` 不接受
   `--gemini-dir`，默认目录写入被 `Access is denied`，`GEMINI_DIR` 环境变量无效。

因此本插件对「工具调用」只做**观测**：见上一节的工具事件语义（`toolEvents` / `diagnostics`），
生产侧不接线 `onToolEvents`，事件不进模型上下文、也不代执行。需要把任务交给 Gemini 时，走
`antigravity_send` 的 `path_refs` / 附件（任务桥），不要期待它在 DSH 会话里调工具。

### 档二：按会话类型分流工具目录（已实现）

- **判据**：`lib/model-adapter.js` 导出 `LOAD_BEARING_TOOLS`（`claim_task`、`update_task`、`send_message`、`create_task`、`reassign_task`）、`LOAD_BEARING_TOOL_PREFIXES`（`agent_teams_`、`team_task_`）及判定函数 `isLoadBearingTool(name)`。
- **普通会话（只含非承重工具）**：`planRequest` 接受请求并丢弃 `tools` 目录，将逐字稳定的 `NO_TOOLS_NOTICE`（中英双语、零动态内容）追加到 `systemText` 末尾（因此首轮 `session/new` 的 `systemPrompt` 与 `user-prefix` 两条路径均带声明），并返回 `droppedTools` 与 `loadBearingTools: []`。
- **成员会话（含承重工具）**：仍硬拒绝并抛出 `AGY_ACP_UNSUPPORTED_TOOLS`，错误消息列出承重工具名并给出两条指引——切到零工具预设 `antigravity-acp-text`（Agent 预设「Antigravity ACP 纯文本多轮」），或改用 `antigravity_send` 任务桥。
- **既有拒绝逻辑不变**：`toolHistory`、消息角色 `'tool'` / `'developer'` 的拒绝条件与错误码均保持原样。
- **跨轮稳定性**：`NO_TOOLS_NOTICE` 零动态内容（不拼接工具个数或名称），`systemHash`（`lib/model-adapter.js:910`）在工具数量变化时仍跨轮一致，第二轮不会触发 `AGY_ACP_SYSTEM_CHANGED`。
- **能力边界不变**：Gemini 仍然不能执行 DSH 工具调用（Round3.b 结论不变），档二只是「接受纯文本会话」而不是「打通工具执行」。
- **回归入口**：`node scripts/tool-scope-test.mjs`（新增）+ `node scripts/round2-test.mjs`、`node scripts/offline-test.mjs`。
- **已知限制**：`isLoadBearingTool` 判定**大小写敏感**，且只读 `tool?.name`；非标准工具条目（缺 `name`，或 `name` 是大小写变体如 `TEAM_TASK_CREATE`）不会命中承重规则，会按非承重被丢弃。换用其它团队实现时须同步更新前缀列表。

`scripts/mock-agy-acp.mjs` 是本地 ACP v1 替身：支持 `--no-image`、
`--no-embedded`、`--no-resume`、持久会话、权限请求、挂起、写入合成文件等；
所有输出只落在临时目录。`ag_steps.py`/`probe_dump.py` 是旧的桌面 SQLite 排查
脚本，不属于 ACP 通道。
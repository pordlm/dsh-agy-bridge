# dsh-agy-bridge

Connects DeepSeek Harness to the local Antigravity CLI through the official `agy acp` channel (with an opt-in Windows UIA desktop fallback).

## 1. 项目定位与安全边界

`dsh-agy-bridge` 是一个 DeepSeek Harness（DSH）插件，用于将本机已安装的 Antigravity CLI 官方 `agy acp` 通道接入 DSH，并提供显式 opt-in 的 Windows 桌面备用通道。

安全与集成边界：

- 仅通过本机子进程调用官方 `agy acp` 协议接口（桌面通道仅在显式开启时通过 `lib/uia-driver.ps1` 只读/受控操作已固定窗口）。
- 不反代 Google 上游模型接口。
- 不调用 Antigravity 桌面应用的私有 RPC。
- 不读取、不缓存、不上传用户的登录凭据。

## 2. 三条入口

本插件提供三条面向不同使用方式的入口：

1. **任务工具（持久 job）**：通过 9 个 `antigravity_*` 工具向本机 ACP 子进程（或显式选择的桌面备用通道）派发任务，以持久 job 形式追踪状态、等待回复、读取结果或取消执行。
2. **Web 面板（侧栏）**：挂载在 DSH Web 侧栏，与任务工具共用同一套 job、owner、附件校验、取消与自动唤醒实现。
3. **原生 Gemini provider**：向 DSH 模型选择器注册原生 provider，直接使用 `agy acp` 的纯文本多轮能力；其会话状态与任务工具的 job 分开管理。

### 原生 provider 的两个硬边界

使用原生 Gemini provider 时，需注意以下两条硬边界：

1. **普通会话丢弃工具并明确告知**：ACP 协议本身没有客户端工具通道，无法由客户端把工具目录交给模型执行。普通会话中传入的 `tools` 会被丢弃，并在上下文中明确告知模型当前无可用工具，不会静默忽略。
2. **成员会话的承重工具默认硬拒**：对于成员会话中包含的承重工具——`claim_task`、`update_task`、`send_message`、`create_task`、`reassign_task` 以及 `agent_teams_*`、`team_task_*` 前缀工具——默认直接硬拒（抛出 `AGY_ACP_UNSUPPORTED_TOOLS`）并给出切换预设或改用任务工具的指引。
   - 仅当显式开启 `acpToolBridge: true` 时，才对 `claim_task` 与 `update_task` 两个调用做桥接翻译，其余工具不向模型渲染。
   - 仅当显式配置 `acpPermissionPolicy: 'allow_once'` 时，才会自动批准 ACP 发出的权限请求；默认 `'reject'` 会拒绝权限请求。

## 3. 安装与启用

1. 确保本机已安装 Antigravity CLI，且 `agy` 可在 `PATH` 中直接执行，或在插件配置中将 `agyExecutable` 设为 `agy` 的绝对路径。
2. 作为 DSH bundle 安装后，插件会通过 `cordis.patch.yml` 注入两个条目：
   - `antigravity-bridge`：主插件，提供任务工具、Web 面板服务与原生 Gemini provider。
   - `antigravity-bridge-preset`：配套预设条目。
3. 打包说明：自 `0.5.1` 起，`package.json` 的 `files` 字段必须包含 `lib/uia-driver.ps1`，否则发布包会缺少桌面 UIA 驱动（触发 `desktop_driver_missing`）。
4. 启用或更新 bundle 后，需要执行一次热重载：先关闭一次该 bundle，再重新开启，使最新配置与代码生效。
5. 宿主兼容：**兼容 DSH 0.2.x（含 0.2.x 预发布，如 `0.2.2-rc.5`）**；`0.3.0-rc.x` 也落在兼容带内，但**未验证、不代表支持 0.3 正式版**。`engines.dsh` 与 `peerDependencies["@deepseek-ai/dsh-llm"]` 保持**同范围**：`engines.dsh` 供市场/清单展示兼容性，`peerDependencies` 供安装校验。

`cordis.patch.yml` 注入结构示例（含可选 `desktop` 段）：

```yaml
- insert:
    - id: antigravity-bridge
      name: 'dsh-agy-bridge'
      config:
        agyExecutable: 'agy'
        agyArgs:
          - 'acp'
        cwd: ''
        pollMs: 4000
        waitPollMs: 900
        defaultModel: ''
        defaultEffort: ''
        autoWake: true
        maxReplyChars: 20000
        maxAttachments: 10
        maxAttachmentBytes: 10485760
        maxTotalAttachmentBytes: 20971520
        permissionPolicy: 'reject'
        stateFile: ''
        modelProvider: true
        model: ''
        models: []
        efforts: []
        acpToolBridge: false
        acpPermissionPolicy: 'reject'
        inlineThought: true
        nativeActivityEnabled: true
        thoughtSummary: true
        desktop:
          enabled: false
          target: null
    - id: antigravity-bridge-preset
      name: 'dsh-agy-bridge/preset'
      config: {}
```

`desktop.enabled` 默认为 `false`（opt-in）。部署时如需允许桌面备用通道，可在 `cordis.patch.yml` 设为 `enabled: true`、`target: null`（再通过运行期 pin 固定目标窗口）。

## 4. 工具清单（9 个）

插件向 DSH 注册以下 9 个工具：

| 工具名 | 作用 |
| --- | --- |
| `antigravity_send` | 向本机 `agy acp`（或显式 `transport="desktop"`）派发任务并创建持久 job；ACP 支持新建/续聊、模型、推理强度与附件。 |
| `antigravity_wait` | 按 job ID 阻塞等待最终回复；等待超时不会丢失状态或消费回复，后续仍可读取或继续等待。 |
| `antigravity_read` | 非阻塞读取指定 job 的当前状态、权限记录与已缓存的最终回复。 |
| `antigravity_list` | 列出当前 DSH 会话归属的 bridge job 元数据，不暴露其他会话记录。 |
| `antigravity_cancel` | 校验 job owner 后向在途 ACP 请求发送取消指令；对于已无活动观察的 `acceptance_unknown`/`accepted`/`prompting` 桌面 job，可解除桥侧窗口锁（`desktop_released_by_user`）。 |
| `antigravity_config` | 查询 ACP 可用的模型、推理强度选项与能力信息，不发送 prompt。 |
| `antigravity_relay_brief` | 面向中继角色的静态口径查询（`role=implement` 或 `role=review`），不创建 job、不发起任何网络或子进程请求。 |
| `antigravity_reset_session` | 重置调用方当前 DSH 会话的原生 ACP 绑定并写重基线墓碑，下一轮以末尾用户输入重建 ACP 会话；不删用户会话、不重启 `agy`、不动 job 列表；只清调用方自身 `session.id`；会话活跃或 `inFlight` 时拒绝（`AGY_ACP_RESET_BUSY`，本轮不可重发同一 prompt）。 |
| `antigravity_desktop_pin` | 支持 `action=pin\|clear\|status`；只读 UIA 探测（不抢焦点、不点控件，`status` 不写盘）；`config.desktop.enabled=false` 时也可用，但桌面派发仍需 opt-in。 |

## 5. 桌面备用通道 v1

- **定位与优先级**：ACP 仍是唯一默认通道，失败的 ACP 任务绝不自动切换到桌面；`desktop` 必须显式传 `transport="desktop"`。未配置时默认 `config.desktop.enabled=false`（opt-in）；部署配置可写 `enabled: true`、`target: null`。运行期 pin（`stateFile` 同目录 `desktop-target.json`，原子写）优先级高于静态 `config.desktop.target`。
- **面板三态**：
  - `enabled=false`：显示「桌面备用（未启用）」且禁用；
  - `enabled=true` 且无 pin/target：显示「桌面备用（未配置窗口）」（`desktop_target_not_configured`），禁止派发；
  - 已固定目标后：可选「桌面（备用，仅显式选择）」。
- **机器身份隔离与面板探测**：`state.json`、`native-sessions.json`、`desktop-target.json` 均绑定 `<stateDir>/machine.json` 本机 UUID，外来机器文件只改名隔离（`*.foreign-*`）绝不删除；CLI 状态卡按钮行提供只读「识别本地 Antigravity」按钮（`desktopDetect`），不写盘、不抢焦点。
- **身份校验链**：`pid` → 进程启动时间（`±2s`）→ 可执行文件白名单 → `hwnd` 顶层窗口 → 唯一 `http(s)` Document URI → 唯一侧栏/窗口 session link（忽略 query/fragment 对比）。多候选且未指定 `hwnd` 时拒绝猜测，返回 `desktop_target_ambiguous` 与候选列表。
- **能力边界**：不支持切换模型与思考强度（使用窗口当前设置，回执 `effective.source='desktop_window_current'`）；不支持原生附件，仅接受 `path_refs` 绝对路径引用块；不接受 `conversation_id`。在 `transport="desktop"` 下传入 `model`、`effort`、`conversation_id` 或原生 `attachments` 时，在 `inspect` 与 `dispatch` 之前即返回 `unsupported_capability`（驱动调用 0 次）。
- **错误码归一**：统一使用 `desktop_disabled`、`desktop_target_changed`（含 `detail.driftField`）、`desktop_target_unverified`、`desktop_permission_pending`；保留 `desktop_target_ambiguous`、`desktop_driver_missing`、`state_write_failed`。
- **真机验证状态**：
  - **已验证（单轮）**：pin / 键盘注入写入 / 读回 / 点击 Send / 归属交付（2026-11-25 真机，应用回复「好的」）；以及 `antigravity_cancel` 解除 `acceptance_unknown` 锁后立即再发（回复「已解锁」）。
  - **未验证**：多轮连续对话、权限卡人工确认、多窗口选择与模型切换。
- **窗口锁解除与风险**：`acceptance_unknown` 的桌面 job 会继续占用窗口锁 `state.locks[desktopLockKey]` 以防并发重发。调用 `antigravity_cancel` 可解除桥侧锁（置 `status='cancelled'`、`code='desktop_released_by_user'`、`released: true`），但**只解除桥侧占用，不代表应用侧没收到该轮，请人工确认**；仍有活动观察的在途桌面 job 不走此释放路径，仍保持既有在途取消/不可取消语义。

## 6. 模型目录与刷新

- **实时发现与降级**：`lib/model-catalog.js` 通过单次 `session/new` 返回的 `configOptions` 获取模型清单，并在同一 scratch 会话内轮询 `set_config_option` 补齐 `effort`（单模型超时默认 `6000ms`）。单模型超时或失败仅将其标记为 `degraded`（保留 `reason`/`timedOut`/`elapsedMs`/`message`），不拖垮整个目录。
- **TTL 与缓存边界**：全成功 TTL 为 `300s`，存在 `degraded` 条目时走 `30s` 短退避；`entries.length === 0` 绝不写盘；磁盘快照仅作失败 fallback；`resolveModel` 未命中且已过冷却窗时触发重探。
- **面板刷新与宿主缓存边界**：Web 面板顶部 CLI 状态卡片按钮行（`.antigravity-cli-status__actions`）提供「刷新模型目录」按钮，调用只读 `refreshModels` 端点（单飞 + 频控，不触发 `session/prompt`，不改当前会话/模型/effort）；成功显示模型数与耗时，失败保留上次列表并标注「上次可用 HH:mm:ss」与错误码。注意：宿主前端模型选择器（`dsh-client-ui-model-selection`）按会话持有 `ModelDirectory` 内存快照，刷新只保证 bridge 侧与本面板即时新鲜，主聊天模型选择器若未更新需重开面板或刷新页面。

## 7. 多轮语义与绑定账本

原生 Gemini provider 通过持久账本维护 DSH 会话与 ACP 会话的绑定关系，并严格执行增量发送规则：

- **只发增量，绝不重放历史**：续聊时只发送最后一条 assistant 消息之后的连续 user 段，不会把整段历史重新发给 ACP。
- **五类失配拆码与真重放硬拒**：历史校验将不匹配拆分为 `AGY_ACP_HISTORY_REPLAYED`（真重放/重复历史，清洁态零 prompt 硬拒）、`AGY_ACP_HISTORY_MULTI_ASSISTANT`（多 assistant 段）、`AGY_ACP_HISTORY_TOOL_ORDER`（工具顺序或未完成轮次）、`AGY_ACP_HISTORY_HASH_MISMATCH`（历史摘要失配）、`AGY_ACP_HISTORY_SHAPE`（历史形状不符）；既无绑定也无墓碑的多轮导入直接拒绝（`AGY_ACP_BINDING_UNKNOWN`）。
- **重基线墓碑与上限**：当 `system` 提示词变化或历史失配且末尾存在新增 `user` 输入时（以及调用 `antigravity_reset_session` 后），会写入墓碑 `{ rebaseline, resetAt, reasonCode, ... }` 并执行原子重基线（关闭并删除 `liveSessions` → `previous = null` → 重读 `baselineEffort` → 清空 `bridgeCalls`/`nativeActivity` → 通过 `session/new` 只发末尾连续 `user` 段，**前文不进入新会话**）。连续重基线上限 `MAX_CONSECUTIVE_REBASELINES = 3`，超限抛出 `AGY_ACP_REBASELINE_LIMIT_EXCEEDED`。

## 8. 活动链与思考链

原生会话运行期间，ACP 推送的工具操作事件与思考摘要会经过隔离处理：

- **侧栏活动链**：开启 `nativeActivityEnabled` 后，侧栏会按 `sessionId` 展示该原生会话的操作链与思考摘要，便于观测 `agy` 内部执行进度。
- **内联思考与上下文隔离**：`inlineThought` 控制是否将思考摘要作为 `reasoning` 块内联显示在对话流中。思考内容**绝不回灌到模型上下文**，也不会进入多轮账本历史；离线回归中包含跨轮 `SECRET` 探针验证该隔离性。
- **正文脱敏不落库**：ACP 事件中的 `params.update.content`（文件正文）一律不写入持久化状态文件或活动记录，防止将文件内容落盘。

## 9. 错误码

| 错误码 | 触发条件 | 处置方式 |
| --- | --- | --- |
| `AGY_ACP_UNSUPPORTED_TOOLS` | 成员会话包含承重工具且未通过 `acpToolBridge` 放行，或出现不支持的工具历史/角色。 | 切换到零工具预设、改用 `antigravity_send` 任务工具，或按需开启 `acpToolBridge`。 |
| `AGY_ACP_ACCEPTANCE_UNKNOWN` | prompt 已写入子进程后发生传输中断、子进程退出或插件重启，无法确认对端是否已受理。 | **禁止自动重发**。先确认对端会话实际状态，再由用户决定是否新建会话。 |
| `AGY_ACP_SESSION_BUSY` | 同一 DSH 会话已有原生请求在途。 | 等待当前请求完成，勿并发发送。 |
| `AGY_ACP_BINDING_UNKNOWN` | 既无有效绑定也无重基线墓碑的多轮历史导入。 | 新建 DSH 会话。 |
| `AGY_ACP_SYSTEM_CHANGED` | 同一绑定的多轮会话中，system 提示词内容与首轮记录的摘要不一致。 | 可自愈：末尾有新增 `user` 输入时自动重基线（前文不进入新会话）；末尾非 `user` 或连续重基线超 3 次才报错。 |
| `AGY_ACP_WORKSPACE_MISMATCH` | 绑定的工作区路径发生变化。 | 新建 DSH 会话，不跨项目沿用 ACP 上下文。 |
| `AGY_ACP_RESET_BUSY` | 调用 `antigravity_reset_session` 时会话仍活跃或处于 `inFlight`。 | 等待当前轮次结束后再重置，本轮不可重发同一 prompt。 |
| `AGY_ACP_HISTORY_REPLAYED` / `AGY_ACP_HISTORY_MULTI_ASSISTANT` / `AGY_ACP_HISTORY_TOOL_ORDER` / `AGY_ACP_HISTORY_HASH_MISMATCH` / `AGY_ACP_HISTORY_SHAPE` | 五类多轮历史失配（真重放、多 assistant、工具顺序、hash 失配、形状不符）；清洁态零 prompt 硬拒。 | 勿重放或篡改历史；必要时调用 `antigravity_reset_session` 或新建会话。 |
| `AGY_ACP_REBASELINE_LIMIT_EXCEEDED` | 连续重基线次数超过 `MAX_CONSECUTIVE_REBASELINES`（`3`）。 | 新建 DSH 会话。 |
| `AGY_ACP_PERMISSION_REQUIRED` | ACP 发出权限请求但当前策略拒绝批准（默认 `'reject'`）。 | 评估风险后按需调整 `acpPermissionPolicy` 或改走其他方式。 |
| `desktop_disabled` / `desktop_target_changed` / `desktop_target_unverified` / `desktop_target_ambiguous` / `desktop_permission_pending` / `desktop_driver_missing` / `desktop_released_by_user` | 桌面通道未启用、目标漂移（含 `driftField`）、校验未通过、多候选歧义、权限等待、缺驱动或已人工释放锁。 | 按提示启用配置、重新 `pin`、在桌面窗口处理权限或人工确认后重试。 |

## 10. 已知限制

1. **工具桥覆盖范围有限**：开启 `acpToolBridge` 后只翻译 `claim_task` 与 `update_task` 两个调用，其余 DSH 工具不提供给 Gemini。
2. **思考内容仅为摘要**：`agy` 推送的思考事件只有简短摘要句子，不是完整推理过程。
3. **桌面通道仅单轮真机验证**：多轮连续对话、权限卡、多窗口选择与模型切换尚未经过真机验证。
4. **`ui-gate` 存在 1 条既有失败**：`scripts/ui-model-integration.test.mjs:872` 的 slot 断言存在 1 条既有失败，与插件功能无关。
5. **成员会话开局失败无法自愈**：成员会话一旦在开局阶段失败，不会在原会话内自动恢复，需新建会话重新开始。

## 11. 测试与验证

本仓库的自动化验证均**离线可复现**，使用本地假 ACP 对端 `scripts/mock-agy-acp.mjs` 与 `AGUIA_FAKE_SCENARIO` 替身驱动，不需要连接外网。

在插件根目录执行：

```powershell
node scripts/offline-test.mjs
node scripts/schema-check.mjs
node scripts/tool-call-bridge-test.mjs
node scripts/desktop-test.mjs
node scripts/catalog-test.mjs
node scripts/round2-test.mjs
node scripts/thought-test.mjs
node scripts/wake-member-test.mjs
node scripts/ui-gate.mjs
```

各脚本职责与当前基线：

- `scripts/offline-test.mjs`：262 例离线回归测试，覆盖协议交互、多轮语义、权限策略、附件校验、思考隔离与状态恢复。
- `scripts/schema-check.mjs`：DSH 工具 JSON Schema 子集预检，校验全部 9 个已注册工具的参数与输出 schema。
- `scripts/tool-call-bridge-test.mjs`：63 例工具桥专项测试，覆盖 `claim_task` 与 `update_task` 的翻译、拒绝对照与边界行为。
- `scripts/desktop-test.mjs`：61 例桌面备用通道离线测试，覆盖 ACP 默认路径、opt-in、`pin`/`discover`、键盘注入与读回、无 `busy` 归属交付及 `cancel` 解锁。
- `scripts/catalog-test.mjs`：模型目录容错、只读 `refreshModels` 端点与面板刷新按钮专项测试。
- `scripts/round2-test.mjs`：原生 Gemini provider 多轮装配、恢复分类、清理容错与纠偏行为回归测试。
- `scripts/thought-test.mjs`：思考摘要收集、隔离与防泄漏专项测试。
- `scripts/wake-member-test.mjs`：成员会话唤醒投递与隔离专项测试。
- `scripts/ui-gate.mjs`：Web 客户端 bundle 挂载与集成测试门禁（10 pass / 1 既有 slot 断言）。
- `scripts/mock-agy-acp.mjs`：离线测试使用的假 ACP 对端，模拟标准 ACP 响应、事件推送与异常场景。

## 12. 版本与变更

当前版本：**`0.5.6`**。完整变更历史见 [CHANGELOG.md](CHANGELOG.md)。

## 13. License

MIT License

Copyright (c) 2026 pordlm

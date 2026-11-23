# dsh-agy-bridge

Connects DeepSeek Harness to the local Antigravity CLI through the official agy acp channel.

## 项目定位

`dsh-agy-bridge` 是一个 DeepSeek Harness（DSH）插件，用于将本机已安装的 Antigravity CLI 官方 `agy acp` 通道接入 DSH。

安全与集成边界：

- 仅通过本机子进程调用官方 `agy acp` 协议接口。
- 不反代 Google 上游模型接口。
- 不调用 Antigravity 桌面应用的私有 RPC。
- 不读取、不缓存、不上传用户的登录凭据。

## 三条入口

本插件提供三条面向不同使用方式的入口：

1. **任务工具（持久 job）**：通过 7 个 `antigravity_*` 工具向本机 ACP 子进程派发任务，以持久 job 形式追踪状态、等待回复、读取结果或取消执行。
2. **Web 面板（侧栏）**：挂载在 DSH Web 侧栏，与任务工具共用同一套 job、owner、附件校验、取消与自动唤醒实现。
3. **原生 Gemini provider**：向 DSH 模型选择器注册原生 provider，直接使用 `agy acp` 的纯文本多轮能力；其会话状态与任务工具的 job 分开管理。

### 原生 provider 的两个硬边界

使用原生 Gemini provider 时，需注意以下两条硬边界：

1. **普通会话丢弃工具并明确告知**：ACP 协议本身没有客户端工具通道，无法由客户端把工具目录交给模型执行。普通会话中传入的 `tools` 会被丢弃，并在上下文中明确告知模型当前无可用工具，不会静默忽略。
2. **成员会话的承重工具默认硬拒**：对于成员会话中包含的承重工具——`claim_task`、`update_task`、`send_message`、`create_task`、`reassign_task` 以及 `agent_teams_*`、`team_task_*` 前缀工具——默认直接硬拒（抛出 `AGY_ACP_UNSUPPORTED_TOOLS`）并给出切换预设或改用任务工具的指引。
   - 仅当显式开启 `acpToolBridge: true` 时，才对 `claim_task` 与 `update_task` 两个调用做桥接翻译，其余工具不向模型渲染。
   - 仅当显式配置 `acpPermissionPolicy: 'allow_once'` 时，才会自动批准 ACP 发出的权限请求；默认 `'reject'` 会拒绝权限请求。

## 工具（7 个）

插件向 DSH 注册以下 7 个工具：

| 工具名 | 作用 |
| --- | --- |
| `antigravity_send` | 向本机 `agy acp` 派发任务并创建持久 job；可新建会话或续聊，支持指定模型、推理强度与附件。 |
| `antigravity_wait` | 按 job ID 阻塞等待最终回复；等待超时不会丢失状态或消费回复，后续仍可读取或继续等待。 |
| `antigravity_read` | 非阻塞读取指定 job 的当前状态、权限记录与已缓存的最终回复。 |
| `antigravity_list` | 列出当前 DSH 会话归属的 bridge job 元数据，不暴露其他会话记录。 |
| `antigravity_cancel` | 校验 job owner 后向在途请求发送 ACP 取消指令，并根据返回的终止状态更新 job。 |
| `antigravity_config` | 查询 ACP 可用的模型、推理强度选项与能力信息，不发送 prompt。 |
| `antigravity_relay_brief` | 面向中继角色的静态口径查询（`role=implement` 或 `role=review`），不创建 job、不发起任何网络或子进程请求。 |

## 安装与启用

1. 确保本机已安装 Antigravity CLI，且 `agy` 可在 `PATH` 中直接执行，或在插件配置中将 `agyExecutable` 设为 `agy` 的绝对路径。
2. 作为 DSH bundle 安装后，插件会通过 `cordis.patch.yml` 注入两个条目：
   - `antigravity-bridge`：主插件，提供任务工具、Web 面板服务与原生 Gemini provider。
   - `antigravity-bridge-preset`：配套预设条目。
3. 启用或更新 bundle 后，需要执行一次热重载：先关闭一次该 bundle，再重新开启，使最新配置与代码生效。

`cordis.patch.yml` 注入结构示例：

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
    - id: antigravity-bridge-preset
      name: 'dsh-agy-bridge/preset'
      config: {}
```

## 配置

以下列出 `cordis.patch.yml` 中 `antigravity-bridge` 的全部关键配置键。

### 基础与任务桥配置

| 配置键 | 默认值 | 说明 |
| --- | --- | --- |
| `agyExecutable` | `'agy'` | `agy` 可执行文件名或绝对路径。 |
| `agyArgs` | `['acp']` | 启动 `agy` 子进程时传入的参数数组。 |
| `cwd` | `''` | ACP 子进程工作目录；未由宿主提供工作区时作为显式工作目录使用。 |
| `pollMs` | `4000` | 后台唤醒与状态轮询间隔（毫秒）。 |
| `waitPollMs` | `900` | `antigravity_wait` 等待期间的轮询间隔（毫秒）。 |
| `defaultModel` | `''` | 任务桥新建会话时使用的默认模型；续聊不自动套用。 |
| `defaultEffort` | `''` | 任务桥新建会话时使用的默认推理强度；续聊不自动套用。 |
| `autoWake` | `true` | 任务 job 收到最终回复后是否自动唤醒原 DSH 会话。 |
| `maxReplyChars` | `20000` | 唤醒消息中回复正文的截断上限字符数。 |
| `maxAttachments` | `10` | 单次请求允许的最大附件数量。 |
| `maxAttachmentBytes` | `10485760` | 单个附件允许的最大字节数。 |
| `maxTotalAttachmentBytes` | `20971520` | 单次请求所有附件累计允许的最大字节数。 |
| `permissionPolicy` | `'reject'` | 任务桥的 ACP 权限处理策略，可选 `'reject'` 或 `'allow_once'`。 |
| `stateFile` | `''` | job 与会话绑定状态文件路径；留空时使用默认路径。 |
| `modelProvider` | `true` | 是否注册原生 Gemini provider。 |
| `model` | `''` | 兼容保留字段，不覆盖原生请求显式指定的模型。 |
| `models` | `[]` | 面板可选模型列表；留空时使用 ACP 发现的目录。 |
| `efforts` | `[]` | 面板可选推理强度列表；留空时使用 ACP 发现的目录。 |

### 原生会话与可观测性开关

| 配置键 | 默认值 | 说明 |
| --- | --- | --- |
| `acpToolBridge` | `false` | 是否开启成员会话工具桥；开启后仅翻译 `claim_task` 与 `update_task` 两个调用。 |
| `acpPermissionPolicy` | `'reject'` | 原生 provider 的 ACP 权限处理策略；仅设为 `'allow_once'` 时自动批准权限请求。 |
| `inlineThought` | `true` | 是否将 ACP 返回的思考摘要作为 reasoning 块内联输出到对话流中。 |
| `nativeActivityEnabled` | `true` | 是否在侧栏按 `sessionId` 记录并展示原生会话的操作链与活动状态。 |
| `thoughtSummary` | `true` | 是否收集并展示来自 ACP 的思考摘要短句。 |

## 多轮语义

原生 Gemini provider 通过持久账本维护 DSH 会话与 ACP 会话的绑定关系，并严格执行增量发送规则：

- **只发增量，绝不重放历史**：续聊时只发送「最后一条 assistant 消息之后的连续 user 段」，不会把整段历史消息重新发给 ACP。
- **严格历史形状校验**：如果待发送的历史不满足预期形状——包括末尾不是 user 消息、后缀中缺少上一轮 assistant 消息、后缀中包含 tool 消息——或者在清洁态下检测到重复发送、历史被缩短，会在发出任何 prompt 之前直接抛出 `AGY_ACP_UNSUPPORTED_HISTORY`（零 prompt）。
- **中断后的 dirty 状态与重定基线**：当某一轮因取消或中断提前结束时，会话绑定会进入 `dirty` 状态；下一轮请求到达时将重新标定历史基线，避免误判或重复回放。

## 活动链与思考链

原生会话运行期间，ACP 推送的工具操作事件与思考摘要会经过隔离处理：

- **侧栏活动链**：开启 `nativeActivityEnabled` 后，侧栏会按 `sessionId` 展示该原生会话的操作链与思考摘要，便于观测 `agy` 内部执行进度。
- **内联思考与上下文隔离**：`inlineThought` 控制是否将思考摘要作为 `reasoning` 块内联显示在对话流中。思考内容**绝不回灌到模型上下文**，也不会进入多轮账本历史；离线回归中包含跨轮 `SECRET` 探针验证该隔离性。
- **正文脱敏不落库**：ACP 事件中的 `params.update.content`（文件正文）一律不写入持久化状态文件或活动记录，防止将文件内容落盘。

## 错误码

| 错误码 | 触发条件 | 处置方式 |
| --- | --- | --- |
| `AGY_ACP_UNSUPPORTED_TOOLS` | 成员会话包含承重工具且未通过 `acpToolBridge` 放行，或出现不支持的工具历史/角色。 | 切换到零工具预设、改用 `antigravity_send` 任务工具，或按需开启 `acpToolBridge`（仅支持 `claim_task` / `update_task`）。 |
| `AGY_ACP_ACCEPTANCE_UNKNOWN` | prompt 已写入子进程后发生传输中断、子进程退出或插件重启，无法确认对端是否已受理。 | **禁止自动重发**。先确认对端会话实际状态，再由用户决定是否新建会话重试。 |
| `AGY_ACP_BINDING_UNKNOWN` | 历史账本缺失或现有会话无法对应到有效的 ACP 会话绑定。 | 无法在旧会话上恢复，需新建 DSH 会话。 |
| `AGY_ACP_SYSTEM_CHANGED` | 同一绑定的多轮会话中，system 提示词内容与首轮记录的摘要不一致。 | 保持同一会话内 system 提示词不变，或新建 DSH 会话。 |
| `AGY_ACP_PERMISSION_REQUIRED` | ACP 发出权限请求但当前策略拒绝批准（例如 `acpPermissionPolicy` 为默认的 `'reject'`）。 | 检查所需操作风险；确认授权后再将 `acpPermissionPolicy` 设为 `'allow_once'` 或改走其他方式。 |
| `AGY_ACP_UNSUPPORTED_HISTORY` | 历史形状不符（末尾非 user、后缀无 assistant、后缀带 tool），或清洁态下出现重复/缩短历史；触发时零 prompt。 | 不要重放或篡改历史消息；若当前会话状态已不可恢复，需新建 DSH 会话。 |

## 已知限制

1. **工具桥覆盖范围有限**：开启 `acpToolBridge` 后只翻译 `claim_task` 与 `update_task` 两个调用，其余 DSH 工具不提供给 Gemini。
2. **思考内容仅为摘要**：`agy` 推送的思考事件只有简短摘要句子，不是完整推理过程。
3. **桌面通道未实测 Send**：代码中包含桌面备用通道（`transport: 'desktop'`），但**从未经过真实 Send 验收**。
4. **`ui-gate` 存在 1 条既有失败**：`scripts/ui-model-integration.test.mjs:872` 的 slot 断言存在 1 条既有失败，与插件功能无关。
5. **成员会话开局失败无法自愈**：成员会话一旦在开局阶段失败，不会在原会话内自动恢复，需新建会话重新开始。

## 测试与验证

本仓库的自动化验证均**离线可复现**，使用本地假 ACP 对端 `scripts/mock-agy-acp.mjs` 驱动，不需要安装真实 Antigravity CLI，也不需要登录账户或访问外网。

在插件根目录执行：

```powershell
node scripts/offline-test.mjs
node scripts/schema-check.mjs
node scripts/tool-call-bridge-test.mjs
```

各脚本职责：

- `node scripts/offline-test.mjs`：229 例离线回归测试，覆盖协议交互、多轮语义、权限策略、附件校验、思考隔离与状态恢复，完全离线运行。
- `node scripts/schema-check.mjs`：DSH 工具 JSON Schema 子集预检，校验所有已注册工具的参数与输出 schema。
- `node scripts/tool-call-bridge-test.mjs`：51 例工具桥专项测试，覆盖 `claim_task` 与 `update_task` 的翻译、拒绝对照与边界行为。
- `scripts/mock-agy-acp.mjs`：离线测试使用的假 ACP 对端，模拟标准 ACP 响应、事件推送与异常场景。

## License

MIT License

Copyright (c) 2026 pordlm
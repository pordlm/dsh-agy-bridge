# Antigravity 中继使用手册（RELAY GUIDE，0.5.4）

这是一份**自包含**的手册：给新会话里的操作者（人或 AI）直接照做，不必先读源码。
实现细节见 [DETAIL.md](DETAIL.md)，精简派单口径见 [RELAY-PLAYBOOK.md](RELAY-PLAYBOOK.md)（内容与本手册第 3～6 节一致）。

---

## 1. 它是什么

DSH 插件 `dsh-agy-bridge` 把任务派给**本机 Antigravity（agy）**执行体，再把原文结果带回 DSH。

三条链路，按优先级：

| 链路 | 说明 | 何时用 |
|---|---|---|
| 中继（默认） | `antigravity_send` → 本机 `agy acp` 子进程 → 结果回传 | 默认都用这条 |
| ACP 直连成员 | AgentTeams 成员 provider 直接选 `antigravity-agy-acp` | 需要团队成员直接当执行体/审查体 |
| 原生 provider | 走 agy 自带的模型供应商 | 与本插件无关，仅说明模型来源 |

中继本身**不产生内容**：不总结、不改写、不替执行体跑测试。

---

## 2. 前置条件

- Windows（非 Windows 直接报 `cli_terminal_unsupported`；桌面通道还依赖 PowerShell UIA + `SendInput`）。
- DSH 已装、bundle 已启用（`plugin_manager` 里条目 id 为 `include:antigravity-bridge`）。
- 本机已安装官方 Antigravity CLI 并**登录**（面板「打开登录终端」；未登录时状态显示「未知（查不到）」）。
- 首次使用核对：`antigravity_config()`、`antigravity_list()` 都能正常返回。

---

## 3. 九个工具

| 工具 | 作用 | 关键点 |
|---|---|---|
| `antigravity_relay_brief` | 取结构化派单口径 | `role=implement\|review`，只读、不发网络 |
| `antigravity_send` | 派单 | `wait:true`；`timeout_sec` 300～600（上限 600）；只要 `path_refs`，不贴正文 |
| `antigravity_wait` | 等终态 | 用返回的 `job_id`；`mode:"progress"` 只看不阻塞 |
| `antigravity_read` | 查看 job | **超时后第一步**；读取不消费回复 |
| `antigravity_cancel` | 取消/解除占用 | 在途 ACP job 发送 `session/cancel`；已结束观察的 desktop job 只解除桥侧占用 |
| `antigravity_list` | 列本会话 job | 只列自己的，不暴露 Antigravity 历史 |
| `antigravity_config` | 看模型/强度/能力 | `transport:"desktop"` 查桌面通道；`conversation_id` 可续会话 |
| `antigravity_reset_session` | 手动重基线 | 不用重建对话即可清掉绑定；忙时 `AGY_ACP_RESET_BUSY` |
| `antigravity_desktop_pin` | 固定桌面窗口 | `pin` / `clear` / `status`；只读探测，不抢焦点 |

---

## 4. 标准派单流程

1. **取口径**：`antigravity_relay_brief({ role: 'implement' })`（审查用 `'review'`）。
2. **发送**：`antigravity_send({ message, path_refs:[绝对路径...], wait:true, timeout_sec:600, model, effort })`。
3. **等待**：未到终态就用 `job_id` 调 `antigravity_wait`。
4. **超时**：**绝不重发同一 prompt**。先 `antigravity_read({ job_id })` 看状态与已落盘内容，再决定继续等。
5. **回传**：原文搬运执行体输出，并标注**「执行体自报」**；测试数、退出码、文件变更一律原文，不代改。

### 四条硬纪律

1. 只搬运不代跑：不替执行体跑测试、不替它下结论、不替审查体改写 findings。
2. 超时先 read，绝不重发（重发＝重复 job、重复计费）。
3. 结果原文回传 + 「执行体自报」标注。
4. 不写正文：活动条目只放元数据，不放工具结果正文或文件内容；正文走 `path_refs`。

---

## 5. 模型与推理强度

- 角色默认（与 `antigravity_relay_brief` 完全一致）：

| role | model | effort |
|---|---|---|
| implement | `gemini-4-hydrogen` | `medium` |
| review | `gemini-4-neon` | `medium` |

- 可选模型以 `antigravity_config()` 的实时目录为准（如 `gemini-4-neon/carbon/argon/hydrogen`、`gemini-3.8-flash`、`claude-opus-5-5` 等，随账号变化）。
- 目录不会自动刷新：面板「刷新模型目录」或 `antigravity_config()` 重探；解析失败保留上次可用列表并标时间戳/错误码。
- 模型与强度**按会话保存**；中途换模型会报 `AGY_ACP_MODEL_CHANGED`（设计如此，新建会话再换）。

---

## 6. 绑定账本与自愈

中继把「DSH 会话 ↔ agy ACP 会话」记在 `native-sessions.json`，并校验每轮历史的 `role + id` 前缀。

**自动自愈（原子重基线）**：下列五码不再硬拒，而是关闭旧 ACP 会话、写墓碑、开新会话，**只发末尾连续 user 段**（前文不进入新会话）：

- `AGY_ACP_HISTORY_REPLAYED`（真重放，仍零派发硬拒）
- `AGY_ACP_HISTORY_MULTI_ASSISTANT`
- `AGY_ACP_HISTORY_TOOL_ORDER`
- `AGY_ACP_HISTORY_HASH_MISMATCH`
- `AGY_ACP_HISTORY_SHAPE`
- `AGY_ACP_SYSTEM_CHANGED`（system 提示词变化，0.5.3 起同样自愈）

约束：
- 只有**末尾是连续 user 消息**才重基线；末尾是工具回复轮则硬拒且零 prompt，提示发新消息或手动 `antigravity_reset_session`。
- 连续 3 次（`MAX_CONSECUTIVE_REBASELINES=3`）报 `AGY_ACP_REBASELINE_LIMIT_EXCEEDED`，需人工介入。
- 墓碑写在状态里（`rebaseline/resetAt/reasonCode/previousAcpSessionId/cwd/lastCommittedUserId/consecutiveRebaselines`），可用 `antigravity_config()`/`capabilities` 观察。

---

## 7. 错误码速查

| 码 | 含义 | 处置 |
|---|---|---|
| `AGY_ACP_ACCEPTANCE_UNKNOWN` | 上轮是否被受理未确认 | **禁止自动重发**；`antigravity_read` 查证或新建会话 |
| `AGY_ACP_BINDING_UNKNOWN` | 历史没有原生会话绑定 | 不重放历史；重基线或新建会话 |
| `AGY_ACP_UNSUPPORTED_HISTORY` | 历史形状不可发送 | 看自愈是否可用；否则手动 reset |
| `AGY_ACP_REBASELINE_LIMIT_EXCEEDED` | 连续重基线超限 | 停手，人工排查（模型/工作区/system 是否反复变） |
| `AGY_ACP_RESET_BUSY` | 手动重置时正忙 | **本轮不可重发**，等当前轮结束再试 |
| `AGY_ACP_SESSION_BUSY` | 同名会话正被占用 | 等当前 job 结束 |
| `AGY_ACP_MODEL_CHANGED` | 中途换模型 | 新建会话 |
| `AGY_ACP_WORKSPACE_MISMATCH` | 工作区与绑定不一致 | 新建会话/重基线；确认 `cwd` |
| `AGY_ACP_MESSAGE_ID_REQUIRED` | 增量消息缺 id 锚点 | 补 id 或新建会话 |
| `AGY_ACP_EMPTY_PROMPT` | 没有可发送的新增内容 | 补一条 user 消息 |
| `AGY_ACP_TIMEOUT` | 轮次超时 | read 后决定继续等，不重发 |
| `AGY_ACP_UNSUPPORTED_TOOLS` | 纯文本通道不允许工具调用 | 换零工具预设 |
| `desktop_disabled` | 桌面通道未启用 | 打开 `cordis.patch.yml` 的 desktop 段 |
| `desktop_target_not_configured` | 还没 pin 窗口 | `antigravity_desktop_pin({action:'pin'})` |
| `desktop_target_changed` / `desktop_target_unverified` | 窗口变了/校验不过 | 重新 pin；核对 pid/启动时间/URI |
| `desktop_reply_timeout` | 发出后没等到归属回复 | 到 Antigravity 里看，别重发 |
| `desktop_released_by_user` | 已解除桥侧占用 | 只代表桥侧释放，**不代表应用侧没收到** |

---

## 8. 桌面备用通道

默认 `desktop: { enabled: true, target: null }`——通道存在，但没固定窗口前不写任何东西。

```text
antigravity_desktop_pin({ action: 'status' })   # 看候选/当前 pin
antigravity_desktop_pin({ action: 'pin' })      # 校验后固定（pid→启动时间→exe→hwnd→URI→侧栏唯一）
antigravity_send({ transport: 'desktop', message: '...', path_refs: [...] })
```

限制（0.5.4 现状）：
- 不支持 `model`/`effort`、不支持原生附件；只认 `path_refs`。
- 真机**只验证了单轮**：pin → 键盘注入 → 读回 → 点 Send → 归属交付（回复「好的」）；多轮、权限卡、多窗口、模型切换未验证。
- busy 状态应用不暴露，归属靠「新 user 回合锚点 + 其后 assistant 回合 + 两次空闲快照一致」的启发式。
- 不能程序化启动 Antigravity（`exit 9`、无日志），必须由用户先打开窗口。
- `antigravity_cancel` 对已结束观察的 desktop job 只能解除桥侧占用（清锁），不会撤回应用侧已发生的操作。
- 面板「Antigravity CLI 状态」卡片里有「识别本地 Antigravity」按钮（只读探测，不写 `desktop-target.json`）。

---

## 9. 状态文件、机器身份与隐私

目录：`<DSH_HOME>/antigravity-bridge/`（本机为 `D:\dsh-home\antigravity-bridge`）。

| 文件 | 内容 | 说明 |
|---|---|---|
| `machine.json` | `machineId`（uuid v4） | 首次启动生成；损坏会改名 `.corrupt-<ts>` 后重建 |
| `state.json` | job/锁/墓碑 | 带 `machineId`；**异机文件整份隔离**为 `state.foreign-<id>-<ts>.json`，内存从空开始 |
| `native-sessions.json` | 会话绑定账本 | 同样按 machineId 隔离；无 machineId 的旧文件按 legacy 采用并补写 id |
| `desktop-target.json` | 运行期窗口 pin | 校验失败/异机→隔离，发送报 `desktop_target_not_configured` |
| `state.json.log` | 调试日志 | 会持续增长（本机已 ~1 GB），需要时自行轮转 |

隐私规则：
- **便携包不含任何个人数据**：打包器有白名单 + 黑名单（`machine.json`/`state.json`/`native-sessions.json`/`desktop-target.json`/`*.bak`/`*.tmp`/`*.foreign-*`/`*.corrupt-*` 一律不得入包）；`--verify-only` 会点名违规文件并非 0 退出。
- 换机时旧数据只会被隔离（rename），不会被删除；删不删由人决定。
- 状态隔离是「不误用别人数据」，不是加密：文件仍是明文，注意目录权限。

---

## 10. 部署与验证（改完代码后）

1. 备份现网包：`package.backup-<ts>`。
2. 同步 `lib/ client/ locale/ docs/ preset/ package.json` 到加载目录（本机为 junction `D:\dsh-home\profiles\web\node_modules\dsh-agy-bridge` → `desktop-staging\verification\releases\web-local-0.3.0\package`）。
3. 逐文件 SHA256 对比，必须全 MATCH（`cordis.patch.yml` 属部署 patch，差异保留）。
4. `plugin_manager` 关闭再开启 `include:antigravity-bridge`（会热重载两次 applied）。
5. 便宜工具验证：`antigravity_relay_brief` / `antigravity_config`。
6. 请用户刷新面板再验 UI。

十条门禁（全 EXIT=0 才算绿）：

```powershell
node scripts/machine-identity-test.mjs      # 11
node scripts/offline-test.mjs               # 262
node scripts/round2-test.mjs                # 21  （加 --live 才连真机）
node scripts/tool-call-bridge-test.mjs      # 63
node scripts/desktop-test.mjs               # 61
node scripts/catalog-test.mjs               # PASS
node scripts/wake-member-test.mjs           # 12
node scripts/thought-test.mjs               # 8
node scripts/schema-test.mjs                # 9
node scripts/build-portable.mjs --verify-only  # ENTRIES=28 VERSION=0.5.4
```

打包：`node scripts/build-portable.mjs` → `dist/dsh-agy-bridge-0.5.4.zip`（28 条目，含 LICENSE / `lib/uia-driver.ps1` / CHANGELOG）。

---

## 11. 常见故障

| 现象 | 原因 | 处置 |
|---|---|---|
| `EBUSY ... conversation_summaries.db` | agy 子进程未真正退出就删临时目录 | 0.5.4 已修（等 exit→SIGKILL→`taskkill /PID /T /F`→重试）；仍复现时按日志里的 PID 精确处理，**禁止按进程名杀** |
| job 卡 `acceptance_unknown` 且占锁 | 上一轮受理未确认 | 0.5.4 起 `antigravity_cancel` 可解除桥侧占用 |
| 面板模型目录消失/报错 | 探测失败 | 重试「刷新模型目录」；解析失败会保留上次列表 |
| 桌面发送一直 `desktop_target_unverified` | 窗口重建/URI 带 query 差异 | 重新 `pin`；确认会话页与侧栏 URI 归一后一致 |
| `state.json.log` 过大 | 未轮转 | 停插件后改名/删除旧日志 |

---

## 12. 版本与索引

- 当前版本 **0.5.4**；commit `761db7a`；tag `v0.5.4`（tag 对象 `a24ad09`）。
- Release：https://github.com/pordlm/dsh-agy-bridge/releases/tag/v0.5.4
- 便携包：`dsh-agy-bridge-0.5.4.zip`（255,692 B，SHA256 `9b9b4bf996ac72586551579d8be9110960ecfab6f0310bdae49759c0fb1a5ab0`）

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 工具定义与装配 |
| `lib/bridge.js` | job 生命周期、锁、状态持久化 |
| `lib/acp.js` | ACP 传输与协议事件 |
| `lib/model-adapter.js` | 绑定账本、自愈重基线、子进程生命周期 |
| `lib/model-catalog.js` | 模型目录探测与缓存 |
| `lib/desktop.js` / `lib/desktop-attribution.js` / `lib/uia-driver.ps1` | 桌面通道与归属 |
| `lib/web-remote.js` / `client/panel.js` | 面板与只读 RPC |
| `scripts/*-test.mjs` | 十条门禁 |
| `scripts/build-portable.mjs` | 便携包白名单打包/校验 |
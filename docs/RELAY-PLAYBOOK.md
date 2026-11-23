# Antigravity 中继操作手册（RELAY PLAYBOOK）

本手册供人类操作者与 DeepSeek 中继共同使用。中继可通过调用只读工具 `antigravity_relay_brief`（参数 `role`: `'implement'` 或 `'review'`）一次性获取与本手册完全一致的结构化口径。

---

## 1. 标准派单流程

1. **派单前取口径**：按任务性质选择角色（`implement` 或 `review`），调用 `antigravity_relay_brief({ role })` 获取对应 `model`、`effort`、`send` 规则、`promptTemplate` 与 `mustNot`。
2. **发送（`antigravity_send`）**：
   - 必须使用 `path_refs` 传入**绝对路径**数组（只传路径引用，不在正文贴大段文件）。
   - 设置 `wait: true`，`timeout_sec` 给足（建议 `300`～`600`，上限 `600`）。
   - `model` 与 `effort` 严格按下方「角色 → 模型表」传入。
3. **等待（`antigravity_wait`）**：若 `antigravity_send` 返回未到终态，继续用返回的 `job_id` 调用 `antigravity_wait`。
4. **超时处置**：
   - 无论 `antigravity_send(wait=true)` 还是 `antigravity_wait` 超时，**绝不重发同一 prompt**（重发会产生重复 job 与重复计费）。
   - 必须先调用 `antigravity_read({ job_id })` 查询当前状态与已落盘内容，再决定是否继续 `antigravity_wait`。
5. **原样回传**：收到终态回复后，原文搬运执行体输出给上游/用户，并在结果中明确标注**「执行体自报」**。

---

## 2. 角色 → 模型表（与 `antigravity_relay_brief` 工具完全一致）

| `role` | `model` | `effort` | 适用场景 |
|---|---|---|---|
| `implement` | `gemini-4-hydrogen` | `medium` | 代码实现、缺陷修复、补全测试与自测回归 |
| `review` | `gemini-4-neon` | `medium` | 独立只读审查、findings 核查、变异/门禁复核 |

---

## 3. 重点错误码处置表

| 错误码 | 含义 | 处置建议 |
|---|---|---|
| `AGY_ACP_UNSUPPORTED_TOOLS` | 纯文本 ACP 通道不允许携带协作/任务工具 | 改用零工具预设或移除不兼容工具后再新建请求 |
| `AGY_ACP_ACCEPTANCE_UNKNOWN` | 上轮受理状态未确认（`inFlight` 未落盘确认） | **禁止自动重发**；先排查会话状态或新建会话 |
| `AGY_ACP_BINDING_UNKNOWN` | 多轮历史没有原生 ACP 会话绑定 | 不重放历史，请新建会话 |
| `AGY_ACP_SYSTEM_CHANGED` | `system` 提示词相对已绑定会话发生变化 | 需新建会话，不要在旧会话继续派发 |

---

## 4. 三条硬纪律

1. **只搬运不代跑**：中继不许代跑测试、不许替执行体补跑命令、不许替执行体下结论、不许替审查体补充或改写 findings、不许把工具结果正文或文件内容写进活动条目（只保留元数据）。
2. **超时先 `antigravity_read`，绝不重发**：遇到超时或受理不明时，先用 `antigravity_read` 查状态，绝不直接重发同一 prompt。
3. **结果原文回传（含「执行体自报」标注）**：所有测试数、退出码、文件变更与结论必须原文搬运，并显式标注「执行体自报」。

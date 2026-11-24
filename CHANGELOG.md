# Changelog

All notable changes to `dsh-agy-bridge` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.2] - 2026-11-25

### Added
- **绑定账本与重基线重置**：新增 `antigravity_reset_session` 工具（活跃/inFlight 时返回 `AGY_ACP_RESET_BUSY`），写入重基线墓碑并支持原子重基线；设置 `MAX_CONSECUTIVE_REBASELINES = 3` 上限。
- **五类历史失配拆码**：将历史校验拆分为 `AGY_ACP_HISTORY_REPLAYED`、`AGY_ACP_HISTORY_MULTI_ASSISTANT`、`AGY_ACP_HISTORY_TOOL_ORDER`、`AGY_ACP_HISTORY_HASH_MISMATCH`、`AGY_ACP_HISTORY_SHAPE`，无绑定无墓碑多轮导入拒绝为 `AGY_ACP_BINDING_UNKNOWN`。
- **模型目录容错与刷新**：单次 `session/new` + scratch 会话补齐 effort（单模型超时默认 `6000ms`），单模型失败仅标 `degraded`；全成功 TTL `300s`、存在降级走 `30s` 退避；Web 面板 CLI 卡片按钮行新增「刷新模型目录」按钮与只读 `refreshModels` 端点。
- **桌面备用通道 v1**：新增 `antigravity_desktop_pin` 工具（`action=pin|clear|status`）与 `desktopStatus`/`desktopPin` Remote 方法；支持面板三态、运行期 `desktop-target.json` 原子写、六步只读身份校验、`effective.source='desktop_window_current'`、键盘注入与轮询读回、无 `busy` 归属交付及 `antigravity_cancel` 解除 `acceptance_unknown` 窗口锁（`desktop_released_by_user`）。
- **真机验证里程碑**：2026-11-25 完成桌面通道单轮真机验证（pin / 键盘注入 / 读回 / 点击 Send / 归属交付，回复「好的」；cancel 解锁后立即再发回复「已解锁」）。

### Changed
- 工具面扩展至 **9 个**（全部通过 DSH JSON Schema 子集预检）。
- 桌面错误码全仓归一为 `desktop_disabled`、`desktop_target_changed`、`desktop_target_unverified`、`desktop_permission_pending`。
- 校准 `lib/desktop.js` `capabilities().evidence` 与 `docs/DETAIL.md` 真机披露口径。

### Fixed
- 修复面板「刷新模型目录」失败时误清空旧列表与挤动三列布局的问题，改为保留旧列表并标注上次可用时间。
- 修复桌面驱动会话链接对比对 query 敏感及 `pid-only` 选窗未过滤无 Document 窗口的问题。
- 修复 `ValuePattern.SetValue` 在 Electron 富文本框静默无效及写后重扫竞态导致的 `readback_mismatch` / 未清空问题。
- 修复桌面 `acceptance_unknown` job 长期占用窗口锁导致无法再发的问题。

## [0.5.1] - 未发布（内部版本，随 0.5.2 一并发布）

### Fixed
- 修复 `package.json` 的 `files` 打包清单遗漏 `lib/uia-driver.ps1` 的问题（避免打包发布时触发 `desktop_driver_missing`）。

## [0.5.0] - 未发布（内部版本起点，随 0.5.2 一并发布）

### Added
- 0.5.x 内部版本起点（工作树版本号，未单独发布、无独立 tag/Release），开启绑定账本与模型目录改造。

### Fixed
- 修复重放时跳过 assistant reasoning 块、内联思考隔离及面板文案与样式打磨（来自未打 tag 提交 `6a9bb56`）。

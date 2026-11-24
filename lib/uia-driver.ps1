#requires -Version 7.0
<#
.SYNOPSIS
    Antigravity 桌面窗口 Windows UI Automation 驱动（只读观察 + 受控派发）。

.DESCRIPTION
    从 stdin 读入单个 JSON 对象，向 stdout 写出单个 JSON 对象。
    支持 action = 'inspect' | 'dispatch'。

    安全边界（硬约束）：
      * 不使用全局键鼠、不使用剪贴板、不发送快捷键、不抢焦点、不恢复最小化窗口。
      * 不自动批准任何权限请求，不点击 Agent permissions 选择器。
      * 派发只做：ValuePattern.SetValue 写入 -> 精确读回 -> 单次 InvokePattern.Invoke。
      * 每个目标项只 Invoke 一次，任何异常都不重试。
      * 不访问私有 RPC、数据库、账户凭据或任何上游模型接口。

    本文件同时是接口说明的实现主体；接口文档见同目录 README.md。

.PARAMETER ImportOnly
    仅供测试脚本 dot-source 使用：只加载函数，不读 stdin、不写 stdout。

.NOTES
    驱动版本：见 $script:AguiaDriverVersion。
    运行：pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File uia-driver.ps1
#>
param(
    [switch]$ImportOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'

$script:AguiaDriverVersion = '1.0.0'
$script:AguiaMaxMessageChars = 100000
$script:AguiaStartToleranceMs = 2000
$script:AguiaMinUsefulNodes = 20
$script:AguiaMaxNodes = 6000
$script:AguiaMaxDepth = 64
$script:AguiaScanTimeBudgetMs = 7000
$script:AguiaComposerContainerAid = 'antigravity.agentSidePanelInputBox'
$script:AguiaComposerInputName = 'Message input'
$script:AguiaRoleLabelUser = 'You said'
$script:AguiaRoleLabelAssistant = 'Agent said'
$script:AguiaLogAnchorName = 'Conversation Log'
$script:AguiaEndActionsName = 'Response actions'
$script:AguiaTimestampPattern = '^(just now|\d+\s*(s|m|h|d)\s*ago|\d{1,2}:\d{2}(:\d{2})?)$'
$script:AguiaHistoryPattern = 'showing\s+(\d+)\s+of\s+(\d+)'
$script:AguiaSendNames = @('Send', 'Send message', 'Send prompt', 'Submit', '发送', '发送消息', '提交')
$script:AguiaStopNames = @('Stop', 'Stop generating', 'Stop response', 'Stop agent', 'Cancel response', '停止', '停止生成', '终止')
$script:AguiaAllowNames = @('Allow', 'Allow once', 'Allow always', 'Approve', 'Approve once', 'Accept', 'Yes', 'Run', '允许', '允许一次', '批准', '同意')
$script:AguiaDenyNames = @('Deny', 'Reject', 'Cancel', 'Deny once', '拒绝', '取消')
$script:AguiaPermissionKeyword = 'permission|approv|authoriz|consent|allow\s.{0,24}(access|run|use|execute)|权限|批准|授权|允许'

# ============================================================================
# 0. 错误对象
# ============================================================================

function New-AguiaException {
    param([string]$Code, [string]$Message, $Detail)
    $ex = [System.Exception]::new($Message)
    $ex.Data['aguiaCode'] = $Code
    if ($null -ne $Detail) { $ex.Data['aguiaDetail'] = $Detail }
    return $ex
}

function Throw-Aguia {
    param([string]$Code, [string]$Message, $Detail)
    throw (New-AguiaException -Code $Code -Message $Message -Detail $Detail)
}

function Get-AguiaErrorInfo {
    param($ErrorRecord)
    $ex = $null
    if ($ErrorRecord -is [System.Management.Automation.ErrorRecord]) {
        $ex = $ErrorRecord.Exception
    } elseif ($ErrorRecord -is [System.Exception]) {
        $ex = $ErrorRecord
    }
    $code = $null
    $detail = $null
    $message = ''
    if ($ex) {
        $message = [string]$ex.Message
        if ($ex.Data.Contains('aguiaCode')) { $code = [string]$ex.Data['aguiaCode'] }
        if ($ex.Data.Contains('aguiaDetail')) { $detail = $ex.Data['aguiaDetail'] }
        if (-not $code -and $ex.InnerException -and $ex.InnerException.Data.Contains('aguiaCode')) {
            $code = [string]$ex.InnerException.Data['aguiaCode']
            if ($ex.InnerException.Data.Contains('aguiaDetail')) { $detail = $ex.InnerException.Data['aguiaDetail'] }
        }
    }
    [ordered]@{
        code    = if ($code) { $code } else { 'internal_error' }
        message = $message
        detail  = $detail
    }
}

# ============================================================================
# 1. 原生窗口 / 进程身份（只读）
# ============================================================================

$script:AguiaNativeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace Aguia
{
    public static class Native
    {
        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
        [DllImport("dwmapi.dll")]
        public static extern int DwmGetWindowAttribute(IntPtr hWnd, int dwAttribute, out int pvAttribute, int cbAttribute);

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT
        {
            public uint type;
            public INPUTUNION U;
        }
        [StructLayout(LayoutKind.Explicit)]
        public struct INPUTUNION
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
        [DllImport("user32.dll")]
        public static extern bool SetCursorPos(int X, int Y);
        [DllImport("user32.dll")]
        public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

        private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        private const uint MOUSEEVENTF_LEFTUP = 0x0004;

        public static void ClickAt(int x, int y)
        {
            SetCursorPos(x, y);
            mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
            mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
        }

        private const uint INPUT_KEYBOARD = 1;
        private const uint KEYEVENTF_KEYUP = 0x0002;
        private const uint KEYEVENTF_UNICODE = 0x0004;
        private const ushort VK_CONTROL = 0x11;
        private const ushort VK_A = 0x41;
        private const ushort VK_DELETE = 0x2E;

        private static INPUT MakeKeyVk(ushort vk, bool keyUp)
        {
            var inp = new INPUT();
            inp.type = INPUT_KEYBOARD;
            inp.U.ki = new KEYBDINPUT
            {
                wVk = vk,
                wScan = 0,
                dwFlags = keyUp ? KEYEVENTF_KEYUP : 0u,
                time = 0,
                dwExtraInfo = IntPtr.Zero
            };
            return inp;
        }

        private static INPUT MakeUnicodeKey(ushort ch, bool keyUp)
        {
            var inp = new INPUT();
            inp.type = INPUT_KEYBOARD;
            inp.U.ki = new KEYBDINPUT
            {
                wVk = 0,
                wScan = ch,
                dwFlags = keyUp ? (KEYEVENTF_UNICODE | KEYEVENTF_KEYUP) : KEYEVENTF_UNICODE,
                time = 0,
                dwExtraInfo = IntPtr.Zero
            };
            return inp;
        }

        public static uint SendCtrlAAndDelete()
        {
            var inputs = new INPUT[]
            {
                MakeKeyVk(VK_CONTROL, false),
                MakeKeyVk(VK_A, false),
                MakeKeyVk(VK_A, true),
                MakeKeyVk(VK_CONTROL, true),
                MakeKeyVk(VK_DELETE, false),
                MakeKeyVk(VK_DELETE, true)
            };
            return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        }

        public static uint SendUnicodeText(string text)
        {
            if (string.IsNullOrEmpty(text)) return 0;
            var list = new List<INPUT>(text.Length * 2);
            foreach (char ch in text)
            {
                // 绝不发送 Enter / CR / LF（VK_RETURN），防止触发意外提交。
                if (ch == '\r' || ch == '\n') continue;
                list.Add(MakeUnicodeKey((ushort)ch, false));
                list.Add(MakeUnicodeKey((ushort)ch, true));
            }
            if (list.Count == 0) return 0;
            return SendInput((uint)list.Count, list.ToArray(), Marshal.SizeOf(typeof(INPUT)));
        }

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        public static List<IntPtr> TopLevelWindows()
        {
            var result = new List<IntPtr>();
            EnumWindows((h, l) => { result.Add(h); return true; }, IntPtr.Zero);
            return result;
        }
    }
}
'@

function Initialize-AguiaNative {
    if (-not ('Aguia.Native' -as [type])) {
        Add-Type -TypeDefinition $script:AguiaNativeSource -ErrorAction Stop
    }
}

function Get-AguiaProcessIdentity {
    param([int]$ProcessId)
    try {
        $p = Get-Process -Id $ProcessId -ErrorAction Stop
    } catch {
        return $null
    }
    $exePath = $null
    $productName = $null
    $fileVersion = $null
    $companyName = $null
    try {
        $exePath = $p.Path
    } catch { }
    try {
        $vi = $p.MainModule.FileVersionInfo
        $productName = $vi.ProductName
        $fileVersion = $vi.FileVersion
        $companyName = $vi.CompanyName
    } catch { }
    $startedAtUtc = $null
    try { $startedAtUtc = $p.StartTime.ToUniversalTime().ToString('o') } catch { }
    [ordered]@{
        id           = $p.Id
        exePath      = $exePath
        startedAtUtc = $startedAtUtc
        productName  = $productName
        fileVersion  = $fileVersion
        companyName  = $companyName
    }
}

function Get-AguiaWindowIdentity {
    param([long]$Hwnd)
    if ($Hwnd -le 0) { return $null }
    $h = [IntPtr]$Hwnd
    if (-not [Aguia.Native]::IsWindow($h)) { return $null }
    $cls = [System.Text.StringBuilder]::new(256)
    [void][Aguia.Native]::GetClassName($h, $cls, 256)
    [uint32]$ownerProcess = 0
    [void][Aguia.Native]::GetWindowThreadProcessId($h, [ref]$ownerProcess)
    $cloaked = 0
    $hr = [Aguia.Native]::DwmGetWindowAttribute($h, 14, [ref]$cloaked, 4)
    [ordered]@{
        hwnd       = $Hwnd
        hwndHex    = ('0x{0:X}' -f $Hwnd)
        pid        = [int]$ownerProcess
        class      = $cls.ToString()
        visible    = [Aguia.Native]::IsWindowVisible($h)
        minimized  = [Aguia.Native]::IsIconic($h)
        cloaked    = if ($hr -eq 0) { $cloaked } else { -1 }
        isTopLevel = ([Aguia.Native]::GetAncestor($h, 2) -eq $h)
    }
}

function Get-AguiaForegroundHwnd {
    [Aguia.Native]::GetForegroundWindow().ToInt64()
}

function Test-AguiaAllowedExecutable {
    param([string]$ExePath)
    if ([string]::IsNullOrWhiteSpace($ExePath)) { return $false }
    if ([System.IO.Path]::GetFileName($ExePath) -ine 'Antigravity.exe') { return $false }
    $full = $null
    try { $full = [System.IO.Path]::GetFullPath($ExePath) } catch { return $false }
    $roots = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\antigravity'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Antigravity'),
        (Join-Path $env:ProgramFiles 'Antigravity'),
        (Join-Path $env:ProgramFiles 'Google\Antigravity')
    )
    foreach ($root in $roots) {
        if (-not $root) { continue }
        try {
            $rootFull = [System.IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
        } catch { continue }
        if ($full.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

function Select-AguiaEligibleCandidates {
    param($Provider, $Rows)
    $eligible = @()
    foreach ($row in @($Rows)) {
        if ($null -eq $row) { continue }
        $win = Get-FieldValue $row 'window'
        if ($null -eq $win) { continue }
        if (-not [bool](Get-FieldValue $win 'visible')) { continue }
        if ([bool](Get-FieldValue $win 'minimized')) { continue }
        if ([int](Get-FieldValue $win 'cloaked') -ne 0) { continue }
        $hwndVal = ConvertTo-AguiaHwnd (Get-FieldValue $row 'hwnd')
        if ($null -eq $hwndVal) { continue }
        $uris = @()
        try {
            $tree = Get-UiaTree -Provider $Provider -Hwnd $hwndVal
            $uris = @(Get-AguiaHttpDocumentUris -Nodes $tree.nodes)
        } catch {
            continue
        }
        if ($uris.Count -ne 1) { continue }
        $copy = [ordered]@{}
        foreach ($k in $row.Keys) { $copy[$k] = $row[$k] }
        $copy['documentUriCount'] = $uris.Count
        $copy['documentUris'] = @($uris)
        $copy['uri'] = [string]$uris[0]
        $eligible += $copy
    }
    return $eligible
}

function Get-AguiaCandidates {
    param($Provider = $null)
    Initialize-AguiaNative
    $processes = @(Get-Process -Name Antigravity -ErrorAction SilentlyContinue)
    $pids = @($processes | ForEach-Object { $_.Id })
    if ($pids.Count -eq 0) { return @() }
    $foreground = Get-AguiaForegroundHwnd
    $rows = @()
    foreach ($h in [Aguia.Native]::TopLevelWindows()) {
        $w = Get-AguiaWindowIdentity -Hwnd ($h.ToInt64())
        if ($null -eq $w) { continue }
        if ($pids -notcontains $w.pid) { continue }
        if ($w.class -ne 'Chrome_WidgetWin_1') { continue }
        $proc = Get-AguiaProcessIdentity -ProcessId $w.pid
        $rows += [ordered]@{
            pid       = $w.pid
            startedAt = if ($proc) { $proc.startedAtUtc } else { $null }
            hwnd      = $w.hwndHex
            exe       = [ordered]@{
                path        = if ($proc) { $proc.exePath } else { $null }
                productName = if ($proc) { $proc.productName } else { $null }
                fileVersion = if ($proc) { $proc.fileVersion } else { $null }
                allowed     = if ($proc) { (Test-AguiaAllowedExecutable -ExePath $proc.exePath) } else { $false }
            }
            window    = [ordered]@{
                visible      = $w.visible
                minimized    = $w.minimized
                cloaked      = $w.cloaked
                isTopLevel   = $w.isTopLevel
                isForeground = ($w.hwnd -eq $foreground)
            }
        }
    }
    if ($null -eq $Provider) { return $rows }
    return @(Select-AguiaEligibleCandidates -Provider $Provider -Rows $rows)
}

# ============================================================================
# 2. Provider：真实 UIA 实现 + 本地替身实现（接口完全一致）
#    方法均为 scriptblock，接收原始元素；所有状态放在 $script: 作用域，
#    避免闭包捕获问题。
# ============================================================================

function New-RealUiaProvider {
    Initialize-AguiaNative
    try {
        Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
        Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
    } catch {
        Throw-Aguia 'uia_unavailable' ('Windows UIAutomation 程序集不可用: ' + $_.Exception.Message)
    }
    if (-not ('System.Windows.Automation.AutomationElement' -as [type])) {
        Throw-Aguia 'uia_unavailable' 'System.Windows.Automation.AutomationElement 未加载'
    }
    $script:AguiaWalker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    @{
        kind        = 'real'
        root        = {
            param([long]$Hwnd)
            $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$Hwnd)
            if (-not $el) { throw 'AutomationElement.FromHandle returned null' }
            $el
        }
        children    = {
            param($El)
            $out = @()
            $child = $null
            try { $child = $script:AguiaWalker.GetFirstChild($El) } catch { $child = $null }
            while ($child) {
                $out += $child
                $next = $null
                try { $next = $script:AguiaWalker.GetNextSibling($child) } catch { $next = $null }
                $child = $next
            }
            $out
        }
        info        = {
            param($El)
            $type = 'Unknown'
            $name = ''
            $aid = ''
            $cls = ''
            $enabled = $false
            $offscreen = $true
            $patterns = @()
            $readOnly = $null
            try {
                $c = $El.Current
                try { $type = [string]($c.ControlType.ProgrammaticName -replace '^ControlType\.', '') } catch { }
                try { $name = [string]$c.Name } catch { }
                try { $aid = [string]$c.AutomationId } catch { }
                try { $cls = [string]$c.ClassName } catch { }
                try { $enabled = [bool]$c.IsEnabled } catch { }
                try { $offscreen = [bool]$c.IsOffscreen } catch { }
                $patternList = @(
                    @('Value', [System.Windows.Automation.ValuePattern]::Pattern),
                    @('Invoke', [System.Windows.Automation.InvokePattern]::Pattern),
                    @('Text', [System.Windows.Automation.TextPattern]::Pattern),
                    @('Scroll', [System.Windows.Automation.ScrollPattern]::Pattern),
                    @('ExpandCollapse', [System.Windows.Automation.ExpandCollapsePattern]::Pattern),
                    @('SelectionItem', [System.Windows.Automation.SelectionItemPattern]::Pattern),
                    @('Toggle', [System.Windows.Automation.TogglePattern]::Pattern)
                )
                foreach ($pair in $patternList) {
                    try {
                        $p = $null
                        if ($El.TryGetCurrentPattern($pair[1], [ref]$p) -and $p) {
                            $patterns += $pair[0]
                            if ($pair[0] -eq 'Value') {
                                try { $readOnly = [bool]$p.Current.IsReadOnly } catch { }
                            }
                        }
                    } catch { }
                }
            } catch {
                $type = 'Stale'
            }
            [ordered]@{
                type         = $type
                name         = $name
                automationId = $aid
                className    = $cls
                enabled      = $enabled
                offscreen    = $offscreen
                patterns     = $patterns
                valueReadOnly = $readOnly
            }
        }
        value       = {
            param($El)
            $p = $null
            if ($El.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p) -and $p) {
                return [string]$p.Current.Value
            }
            return $null
        }
        setValue    = {
            param($El, [string]$Text)
            $p = $null
            if (-not ($El.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p) -and $p)) {
                throw 'value_pattern_missing'
            }
            $p.SetValue($Text)
        }
        invoke      = {
            param($El)
            $p = $null
            if (-not ($El.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p) -and $p)) {
                throw 'invoke_pattern_missing'
            }
            $p.Invoke()
        }
        windowInfo    = { param([long]$Hwnd) Get-AguiaWindowIdentity -Hwnd $Hwnd }
        processInfo   = { param([int]$ProcessId) Get-AguiaProcessIdentity -ProcessId $ProcessId }
        foreground    = { Get-AguiaForegroundHwnd }
        setForeground = { param([long]$Hwnd) [Aguia.Native]::SetForegroundWindow([IntPtr]$Hwnd) }
        restoreWindow = { param([long]$Hwnd) [Aguia.Native]::ShowWindow([IntPtr]$Hwnd, 9) }
        focus         = { param($El) $El.SetFocus() }
        hasFocus      = { param($El) try { [bool]$El.Current.HasKeyboardFocus } catch { $false } }
        clickFocus    = {
            param($El)
            try {
                $pt = [System.Windows.Point]::new(0, 0)
                if ($El.TryGetClickablePoint([ref]$pt)) {
                    [Aguia.Native]::ClickAt([int]$pt.X, [int]$pt.Y)
                    return $true
                }
            } catch { }
            try {
                $rect = $El.Current.BoundingRectangle
                if (-not $rect.IsEmpty -and $rect.Width -gt 0 -and $rect.Height -gt 0) {
                    [Aguia.Native]::ClickAt([int]($rect.Left + $rect.Width / 2), [int]($rect.Top + $rect.Height / 2))
                    return $true
                }
            } catch { }
            return $false
        }
        clearInput    = { param($El = $null) [void][Aguia.Native]::SendCtrlAAndDelete() }
        typeText      = { param([string]$Text, $El = $null) [void][Aguia.Native]::SendUnicodeText($Text) }
        candidates    = { param($SelfProvider) Get-AguiaCandidates -Provider $SelfProvider }
    }
}

function Find-AguiaFakeWindowEntry {
    param($Scenario, [long]$Hwnd)
    $wins = Get-FieldValue $Scenario 'windows'
    if ($null -eq $wins) { return $null }
    foreach ($entry in @($wins)) {
        $eh = ConvertTo-AguiaHwnd (Get-FieldValue $entry 'hwnd')
        if ($null -ne $eh -and $eh -eq $Hwnd) { return $entry }
    }
    return $null
}

function New-FakeUiaProvider {
    param($Scenario)
    $script:AguiaFakeScenario = $Scenario
    $script:AguiaFakeState = @{
        invokes           = 0
        invoked           = $false
        foregroundCalls   = 0
        foregroundReads   = 0
        foregroundHwnd    = $null
        keyCalls          = 0
        clears            = 0
        hasFocus          = $false
        clickFocusCalls   = 0
        valueReads        = 0
        clearedAfterWrite = $false
        freshScans        = 0
        writes            = [System.Collections.Generic.List[object]]::new()
    }
    $script:AguiaFakeDispatchPhase = 'none'
    $script:AguiaFakeFocusedElement = $null
    $script:AguiaFakeRoot = New-AguiaFakeElement -Node (Get-FieldValue $Scenario 'tree') -Parent $null
    @{
        kind        = 'fake'
        root        = {
            param([long]$Hwnd)
            $entry = Find-AguiaFakeWindowEntry -Scenario $script:AguiaFakeScenario -Hwnd $Hwnd
            if ($null -ne $entry) {
                $t = Get-FieldValue $entry 'tree'
                if ($null -ne $t) { return (New-AguiaFakeElement -Node $t -Parent $null) }
            }
            $script:AguiaFakeRoot
        }
        children    = {
            param($El)
            if ((Get-FieldValue $script:AguiaFakeScenario 'failAfterInvoke') -eq 'tree' -and $script:AguiaFakeState.invoked -eq $true) {
                throw 'fake_tree_failure_after_invoke'
            }
            @($El.Children)
        }
        info        = { param($El) Get-AguiaFakeInfo -Element $El }
        value       = {
            param($El)
            if ($script:AguiaFakeState.writes.Count -gt 0 -and -not $script:AguiaFakeState.clearedAfterWrite) {
                if ($script:AguiaFakeDispatchPhase -eq 'fresh_scan' -and (Get-FieldValue $script:AguiaFakeScenario 'freshStaleOnce') -eq $true -and $script:AguiaFakeState.freshScans -le 1) {
                    if ([string](Get-FieldValue $El.Node 'type') -eq 'ComboBox' -and [string](Get-FieldValue $El.Node 'name') -eq $script:AguiaComposerInputName) {
                        return ''
                    }
                }
                $delayReads = Get-FieldValue $script:AguiaFakeScenario 'readbackDelayReads'
                if ($null -ne $delayReads -and [int]$delayReads -gt 0) {
                    $script:AguiaFakeState.valueReads++
                    if ($script:AguiaFakeState.valueReads -le [int]$delayReads) {
                        return ''
                    }
                }
            }
            $El.Value
        }
        setValue    = { param($El, [string]$Text) Invoke-AguiaFakeSetValue -Element $El -Text $Text }
        invoke      = { param($El) Invoke-AguiaFakeInvoke -Element $El }
        windowInfo  = {
            param([long]$Hwnd)
            $entry = Find-AguiaFakeWindowEntry -Scenario $script:AguiaFakeScenario -Hwnd $Hwnd
            if ($null -ne $entry) {
                $info = Get-AguiaFakeWindowInfo -Scenario $entry -Hwnd $Hwnd
                if ($null -ne $info -and [int]$info.pid -le 0) {
                    $proc = Get-FieldValue $script:AguiaFakeScenario 'process'
                    if ($null -ne $proc) { $info.pid = [int](Get-FieldValue $proc 'pid') }
                }
                return $info
            }
            Get-AguiaFakeWindowInfo -Scenario $script:AguiaFakeScenario -Hwnd $Hwnd
        }
        processInfo = { param([int]$ProcessId) Get-AguiaFakeProcessInfo -Scenario $script:AguiaFakeScenario -ProcessId $ProcessId }
        foreground  = {
            $script:AguiaFakeState.foregroundReads++
            $w = Get-FieldValue $script:AguiaFakeScenario 'window'
            if ((Get-FieldValue $w 'foregroundThrows') -eq $true) { throw 'fake_foreground_failure' }
            if ((Get-FieldValue $w 'foregroundThrowsAfterInvoke') -eq $true -and $script:AguiaFakeState.invoked -eq $true) {
                throw 'fake_foreground_failure_after_invoke'
            }
            $fgMode = [string](Get-FieldValue $script:AguiaFakeScenario 'foregroundMode')
            $targetHwnd = ConvertTo-AguiaHwnd (Get-FieldValue $w 'hwnd')
            if ($null -eq $targetHwnd) { $targetHwnd = $script:AguiaFakeState.foregroundHwnd }
            if ($null -eq $targetHwnd) { $targetHwnd = [long]0x8B11EA }
            if ($fgMode -eq 'mismatch') { return [long]0x1 }
            if ($fgMode -eq 'mismatchOnce') {
                if ($script:AguiaFakeState.foregroundCalls -le 1) { return [long]0x1 }
                return $targetHwnd
            }
            if ($null -ne $script:AguiaFakeState.foregroundHwnd) { return [long]$script:AguiaFakeState.foregroundHwnd }
            if ($fgMode -eq 'match') { return $targetHwnd }
            if ((Get-FieldValue $w 'foreground') -eq $true) { [long]0x8B11EA } else { [long]0x1 }
        }
        setForeground = {
            param([long]$Hwnd)
            $script:AguiaFakeState.foregroundCalls++
            $script:AguiaFakeState.foregroundHwnd = $Hwnd
            $true
        }
        restoreWindow = {
            param([long]$Hwnd)
            $true
        }
        focus = {
            param($El)
            $script:AguiaFakeFocusedElement = $El
            $fMode = [string](Get-FieldValue $script:AguiaFakeScenario 'focusMode')
            if ($fMode -eq 'clickWorks' -or $fMode -eq 'noFocus') {
                $script:AguiaFakeState.hasFocus = $false
            } else {
                $script:AguiaFakeState.hasFocus = $true
            }
        }
        hasFocus = {
            param($El = $null)
            [bool]$script:AguiaFakeState.hasFocus
        }
        clickFocus = {
            param($El = $null)
            $script:AguiaFakeState.clickFocusCalls++
            $fMode = [string](Get-FieldValue $script:AguiaFakeScenario 'focusMode')
            if ($fMode -ne 'noFocus') {
                $script:AguiaFakeState.hasFocus = $true
                return $true
            }
            $false
        }
        clearInput = {
            param($El = $null)
            $targetEl = if ($null -ne $El) { $El } else { $script:AguiaFakeFocusedElement }
            $script:AguiaFakeState.clears++
            $script:AguiaFakeState.keyCalls++
            if ($script:AguiaFakeState.writes.Count -gt 0) { $script:AguiaFakeState.clearedAfterWrite = $true }
            $baseline = Get-FieldValue $script:AguiaFakeScenario 'emptyBaseline'
            if ($null -ne $targetEl) {
                $targetEl.Value = if ($null -ne $baseline) { [string]$baseline } else { '' }
            }
        }
        typeText = {
            param([string]$Text, $El = $null)
            $targetEl = if ($null -ne $El) { $El } else { $script:AguiaFakeFocusedElement }
            $script:AguiaFakeState.keyCalls++
            $script:AguiaFakeState.clearedAfterWrite = $false
            $kb = [string](Get-FieldValue $script:AguiaFakeScenario 'keyboard')
            $readback = [string](Get-FieldValue $script:AguiaFakeScenario 'readback')
            $never = (Get-FieldValue $script:AguiaFakeScenario 'readbackNever') -eq $true
            if ($kb -eq 'throw' -or $readback -eq 'throw') { throw 'fake_keyboard_failure' }
            if ($never -or $kb -eq 'drop') {
                $applied = ''
            } elseif ($kb -eq 'truncate' -or ([string]::IsNullOrEmpty($kb) -and $readback -eq 'truncate')) {
                $applied = if ($Text.Length -gt 4) { $Text.Substring(0, 4) } else { $Text }
            } else {
                $applied = $Text
            }
            if ($null -ne $targetEl) { $targetEl.Value = $applied }
            $script:AguiaFakeState.writes.Add([ordered]@{ text = $Text; applied = $applied; mode = 'keyboard' })
        }
        candidates  = {
            param($SelfProvider)
            $wins = Get-FieldValue $script:AguiaFakeScenario 'windows'
            if ($null -ne $wins) {
                $proc = Get-FieldValue $script:AguiaFakeScenario 'process'
                $rawRows = @()
                foreach ($entry in @($wins)) {
                    $w = Get-FieldValue $entry 'window'
                    if ($null -eq $w) { continue }
                    $winClass = [string](Get-FieldValue $w 'class')
                    if ($winClass -ne '' -and $winClass -ne 'Chrome_WidgetWin_1') { continue }
                    $hwndRaw = Get-FieldValue $entry 'hwnd'
                    $hwndNum = ConvertTo-AguiaHwnd $hwndRaw
                    if ($null -eq $hwndNum) { continue }
                    $winPid = Get-FieldValue $w 'pid'
                    if ($null -eq $winPid) { $winPid = Get-FieldValue $entry 'pid' }
                    if ($null -eq $winPid) { $winPid = Get-FieldValue $proc 'pid' }
                    $rawRows += [ordered]@{
                        pid       = [int]$winPid
                        startedAt = ConvertTo-AguiaIsoText (Get-FieldValue $proc 'startedAtUs')
                        hwnd      = ('0x{0:X}' -f $hwndNum)
                        exe       = [ordered]@{
                            path        = [string](Get-FieldValue $proc 'exePath')
                            productName = [string](Get-FieldValue $proc 'productName')
                            fileVersion = [string](Get-FieldValue $proc 'fileVersion')
                            allowed     = (Test-AguiaAllowedExecutable -ExePath ([string](Get-FieldValue $proc 'exePath')))
                        }
                        window    = [ordered]@{
                            visible      = [bool](Get-FieldValue $w 'visible')
                            minimized    = [bool](Get-FieldValue $w 'minimized')
                            cloaked      = [int](Get-FieldValue $w 'cloaked')
                            isTopLevel   = [bool](Get-FieldValue $w 'isTopLevel')
                            isForeground = [bool](Get-FieldValue $w 'foreground')
                        }
                    }
                }
                return @(Select-AguiaEligibleCandidates -Provider $SelfProvider -Rows $rawRows)
            }
            $c = Get-FieldValue $script:AguiaFakeScenario 'candidates'
            if ($null -eq $c) { @() } else { @($c) }
        }
    }
}

function New-AguiaFakeElement {
    param($Node, $Parent)
    if ($null -eq $Node) { return $null }
    $el = [ordered]@{
        Node     = $Node
        Parent   = $Parent
        Children = [System.Collections.Generic.List[object]]::new()
        Value    = $null
    }
    $v = Get-FieldValue $Node 'value'
    if ($null -ne $v) { $el.Value = [string]$v }
    foreach ($childNode in @(Get-FieldValue $Node 'children')) {
        if ($null -eq $childNode) { continue }
        $child = New-AguiaFakeElement -Node $childNode -Parent $el
        if ($child) { $el.Children.Add($child) }
    }
    return $el
}

function Get-AguiaFakePatterns {
    param($Element)
    $declared = Get-FieldValue $Element.Node 'patterns'
    if ($null -ne $declared) { return @($declared) }
    $type = [string](Get-FieldValue $Element.Node 'type')
    switch ($type) {
        'Button' { return @('Invoke') }
        'ComboBox' { return @('Value') }
        'Text' { return @('Text') }
        'Hyperlink' { return @('Value', 'Invoke') }
        'Document' { return @('Value') }
        default { return @() }
    }
}

function Get-AguiaFakeInfo {
    param($Element)
    $n = $Element.Node
    $patterns = @(Get-AguiaFakePatterns -Element $Element)
    [ordered]@{
        type          = [string](Get-FieldValue $n 'type')
        name          = [string](Get-FieldValue $n 'name')
        automationId  = [string](Get-FieldValue $n 'automationId')
        className     = ''
        enabled       = if ($null -ne (Get-FieldValue $n 'enabled')) { [bool](Get-FieldValue $n 'enabled') } else { $true }
        offscreen     = if ($null -ne (Get-FieldValue $n 'offscreen')) { [bool](Get-FieldValue $n 'offscreen') } else { $false }
        patterns      = $patterns
        valueReadOnly = if ($patterns -contains 'Value') { [bool](Get-FieldValue $n 'readOnly') } else { $null }
    }
}

function Invoke-AguiaFakeSetValue {
    param($Element, [string]$Text)
    $patterns = @(Get-AguiaFakePatterns -Element $Element)
    if ($patterns -notcontains 'Value') { throw 'value_pattern_missing' }
    if ((Get-AguiaFakePatterns -Element $Element) -contains 'ReadOnly') { throw 'value_pattern_readonly' }
    if ((Get-FieldValue $script:AguiaFakeScenario 'setValueNoop') -eq $true) {
        # 模拟 Electron 富文本框：ValuePattern.SetValue 静默无效。
        return
    }
    $readback = [string](Get-FieldValue $script:AguiaFakeScenario 'readback')
    if ($readback -eq 'throw') { throw 'fake_setvalue_failure' }
    if ($readback -eq 'truncate') {
        $applied = if ($Text.Length -gt 4) { $Text.Substring(0, 4) } else { $Text }
    } else {
        $applied = $Text
    }
    $Element.Value = $applied
    $script:AguiaFakeState.writes.Add([ordered]@{ text = $Text; applied = $applied })
}

function Invoke-AguiaFakeInvoke {
    param($Element)
    $script:AguiaFakeState.invokes++
    $behavior = [string](Get-FieldValue $script:AguiaFakeScenario 'invokeBehavior')
    if ($behavior -eq 'throw') { throw 'fake_invoke_failure' }
    if ($behavior -eq 'noop') { return }
    $all = Get-AguiaFakeElements -Root $script:AguiaFakeRoot
    foreach ($e in $all) {
        if ([string](Get-FieldValue $e.Node 'name') -eq $script:AguiaComposerInputName) { $e.Value = '' }
    }
    if ((Get-FieldValue $script:AguiaFakeScenario 'appendTurnOnInvoke') -eq $true) {
        $log = $all | Where-Object { [string](Get-FieldValue $_.Node 'name') -eq $script:AguiaLogAnchorName } | Select-Object -First 1
        if ($log) {
            $message = ''
            if ($script:AguiaFakeState.writes.Count -gt 0) {
                $message = [string]$script:AguiaFakeState.writes[$script:AguiaFakeState.writes.Count - 1].text
            }
            $label = New-AguiaFakeElement -Node ([pscustomobject]@{ type = 'Text'; name = $script:AguiaRoleLabelUser; patterns = @('Text', 'Scroll') }) -Parent $log
            $bubble = New-AguiaFakeElement -Node ([pscustomobject]@{ type = 'Text'; name = $message; patterns = @('Text') }) -Parent $log
            $log.Children.Add($label)
            $log.Children.Add($bubble)
        }
    }
    $script:AguiaFakeState.invoked = $true
}

function Get-AguiaFakeElements {
    param($Root)
    $out = [System.Collections.Generic.List[object]]::new()
    if ($null -eq $Root) { return $out }
    $stack = [System.Collections.Generic.Stack[object]]::new()
    $stack.Push($Root)
    while ($stack.Count -gt 0) {
        $e = $stack.Pop()
        $out.Add($e)
        for ($i = $e.Children.Count - 1; $i -ge 0; $i--) { $stack.Push($e.Children[$i]) }
    }
    return $out
}

function Get-AguiaFakeWindowInfo {
    param($Scenario, [long]$Hwnd)
    $w = Get-FieldValue $Scenario 'window'
    if ($null -eq $w) { return $null }
    $proc = Get-FieldValue $Scenario 'process'
    $winPid = Get-FieldValue $w 'pid'
    if ($null -eq $winPid) { $winPid = Get-FieldValue $proc 'pid' }
    [ordered]@{
        hwnd       = $Hwnd
        hwndHex    = ('0x{0:X}' -f $Hwnd)
        pid        = [int]$winPid
        class      = [string](Get-FieldValue $w 'class')
        visible    = [bool](Get-FieldValue $w 'visible')
        minimized  = [bool](Get-FieldValue $w 'minimized')
        cloaked    = [int](Get-FieldValue $w 'cloaked')
        isTopLevel = [bool](Get-FieldValue $w 'isTopLevel')
    }
}

function Get-AguiaFakeProcessInfo {
    param($Scenario, [int]$ProcessId)
    $p = Get-FieldValue $Scenario 'process'
    if ($null -eq $p) { return $null }
    if ([int](Get-FieldValue $p 'pid') -ne $ProcessId) { return $null }
    [ordered]@{
        id           = $ProcessId
        exePath      = [string](Get-FieldValue $p 'exePath')
        startedAtUtc = ConvertTo-AguiaIsoText (Get-FieldValue $p 'startedAtUs')
        productName  = [string](Get-FieldValue $p 'productName')
        fileVersion  = [string](Get-FieldValue $p 'fileVersion')
        companyName  = [string](Get-FieldValue $p 'companyName')
    }
}

# ============================================================================
# 3. 通用小工具
# ============================================================================

function Get-FieldValue {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $null
    }
    $prop = $Object.PSObject.Properties[$Name]
    if ($prop) { return $prop.Value }
    return $null
}

function ConvertTo-AguiaHwnd {
    param($Value)
    if ($null -eq $Value) { return $null }
    $n = 0L
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [double]) {
        $n = [long]$Value
    } elseif ($Value -is [string]) {
        $s = $Value.Trim()
        if ($s -match '^0[xX]([0-9a-fA-F]+)$') {
            $n = [Convert]::ToInt64($matches[1], 16)
        } elseif ($s -match '^\d+$') {
            $n = [long]$s
        } else {
            return $null
        }
    } else {
        return $null
    }
    if ($n -le 0) { return $null }
    return $n
}

function Get-NormalizedUri {
    param([string]$Raw)
    if ([string]::IsNullOrWhiteSpace($Raw)) { return $null }
    $uri = $null
    if (-not [System.Uri]::TryCreate($Raw.Trim(), [System.UriKind]::Absolute, [ref]$uri)) { return $null }
    if ($uri.Scheme -notin @('http', 'https')) { return $null }
    if ([string]::IsNullOrEmpty($uri.Host)) { return $null }
    $scheme = $uri.Scheme.ToLowerInvariant()
    $hostName = $uri.Host.ToLowerInvariant()
    if ($hostName.Contains(':')) { $hostName = '[' + $hostName + ']' }
    $port = if ($uri.IsDefaultPort) { '' } else { ':' + $uri.Port }
    $path = $uri.AbsolutePath
    if ([string]::IsNullOrEmpty($path)) { $path = '/' }
    # 片段（#...）不参与比较：同一会话页的锚点差异不应视为不同目标。
    return ('{0}://{1}{2}{3}{4}' -f $scheme, $hostName, $port, $path, $uri.Query)
}

function Get-UriIdentityKey {
    param([string]$Raw)
    if ([string]::IsNullOrWhiteSpace($Raw)) { return $null }
    $uri = $null
    if (-not [System.Uri]::TryCreate($Raw.Trim(), [System.UriKind]::Absolute, [ref]$uri)) { return $null }
    if ($uri.Scheme -notin @('http', 'https')) { return $null }
    if ([string]::IsNullOrEmpty($uri.Host)) { return $null }
    $scheme = $uri.Scheme.ToLowerInvariant()
    $hostName = $uri.Host.ToLowerInvariant()
    if ($hostName.Contains(':')) { $hostName = '[' + $hostName + ']' }
    $port = if ($uri.IsDefaultPort) { '' } else { ':' + $uri.Port }
    $path = $uri.AbsolutePath
    if ([string]::IsNullOrEmpty($path)) { $path = '/' }
    # 会话链接对比只取 scheme+host+port+path（不含 query 与 fragment）。
    return ('{0}://{1}{2}{3}' -f $scheme, $hostName, $port, $path)
}

function Test-AguiaNodeDescendsFrom {
    param($Nodes, [int]$Index, [int]$AncestorIndex)
    if ($AncestorIndex -lt 0) { return $false }
    $current = $Index
    $guard = 0
    while ($current -ge 0 -and $guard -lt 200) {
        if ($current -eq $AncestorIndex) { return $true }
        $current = [int]$Nodes[$current].parent
        $guard++
    }
    return $false
}

function Test-AguiaNodeHasAncestorName {
    param($Nodes, [int]$Index, [string[]]$Names)
    $current = [int]$Nodes[$Index].parent
    $guard = 0
    while ($current -ge 0 -and $guard -lt 200) {
        $n = $Nodes[$current]
        if ($Names -contains $n.name) { return $true }
        $current = [int]$n.parent
        $guard++
    }
    return $false
}

function Test-AguiaNodeHasAncestorType {
    param($Nodes, [int]$Index, [string[]]$Types)
    $current = [int]$Nodes[$Index].parent
    $guard = 0
    while ($current -ge 0 -and $guard -lt 200) {
        $n = $Nodes[$current]
        if ($Types -contains $n.type) { return $true }
        $current = [int]$n.parent
        $guard++
    }
    return $false
}

# ============================================================================
# 4. UIA 树采集（有限深度 / 节点数 / 时间预算）
# ============================================================================

function Get-UiaTree {
    param(
        $Provider,
        [long]$Hwnd,
        [int]$MaxNodes = $script:AguiaMaxNodes,
        [int]$MaxDepth = $script:AguiaMaxDepth,
        [int]$TimeBudgetMs = $script:AguiaScanTimeBudgetMs
    )
    $root = $null
    try {
        $root = & $Provider.root $Hwnd
    } catch {
        Throw-Aguia 'uia_root_failed' ('无法从 HWND 取得 UIA 根元素: ' + $_.Exception.Message)
    }
    if ($null -eq $root) { Throw-Aguia 'uia_root_failed' 'UIA 根元素为空' }

    $nodes = [System.Collections.Generic.List[object]]::new()
    $stack = [System.Collections.Generic.Stack[object]]::new()
    $stack.Push(@{ element = $root; depth = 0; parent = -1 })
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $truncated = $false
    while ($stack.Count -gt 0) {
        if ($nodes.Count -ge $MaxNodes) { $truncated = $true; break }
        if ($stopwatch.ElapsedMilliseconds -gt $TimeBudgetMs) { $truncated = $true; break }
        $item = $stack.Pop()
        if ($item.depth -gt $MaxDepth) { $truncated = $true; continue }
        $index = $nodes.Count
        $info = $null
        try { $info = & $Provider.info $item.element } catch { $info = $null }
        if ($null -eq $info) { continue }
        $value = $null
        if (@($info.patterns) -contains 'Value') {
            try { $value = & $Provider.value $item.element } catch { $value = $null }
        }
        $nodes.Add([ordered]@{
            i            = $index
            depth        = $item.depth
            parent       = $item.parent
            element      = $item.element
            type         = [string]$info.type
            name         = [string]$info.name
            automationId = [string]$info.automationId
            className    = [string]$info.className
            enabled      = [bool]$info.enabled
            offscreen    = [bool]$info.offscreen
            patterns     = @($info.patterns)
            valueReadOnly = $info.valueReadOnly
            value        = $value
        })
        $children = @()
        try { $children = @(& $Provider.children $item.element) } catch { $children = @() }
        for ($c = $children.Count - 1; $c -ge 0; $c--) {
            $stack.Push(@{ element = $children[$c]; depth = $item.depth + 1; parent = $index })
        }
    }
    [ordered]@{
        nodes      = $nodes
        truncated  = $truncated
        elapsedMs  = $stopwatch.ElapsedMilliseconds
        nodeCount  = $nodes.Count
    }
}

function Find-AguiaDocumentIndexes {
    param($Nodes, [string]$NormalizedUri)
    $matched = @()
    for ($i = 0; $i -lt $Nodes.Count; $i++) {
        $n = $Nodes[$i]
        if ($n.type -ne 'Document') { continue }
        if ($null -eq $n.value) { continue }
        $norm = Get-NormalizedUri -Raw ([string]$n.value)
        if ($null -eq $norm) { continue }
        if ($norm -ceq $NormalizedUri) { $matched += $i }
    }
    return $matched
}

function Get-AguiaHttpDocumentUris {
    param($Nodes)
    $out = [System.Collections.Generic.List[string]]::new()
    for ($i = 0; $i -lt $Nodes.Count; $i++) {
        $n = $Nodes[$i]
        if ($n.type -ne 'Document') { continue }
        if ($null -eq $n.value) { continue }
        $norm = Get-NormalizedUri -Raw ([string]$n.value)
        if ($norm -and -not $out.Contains($norm)) { $out.Add($norm) }
    }
    return $out
}

function Get-AguiaTargetTree {
    param($Provider, [long]$Hwnd, [string]$NormalizedUri, [int]$Attempts = 6, [int]$DelayMs = 250)
    $last = $null
    $ambiguous = $false
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        $tree = Get-UiaTree -Provider $Provider -Hwnd $Hwnd
        $last = $tree
        $indexes = @(Find-AguiaDocumentIndexes -Nodes $tree.nodes -NormalizedUri $NormalizedUri)
        if ($indexes.Count -eq 1) {
            return [ordered]@{ tree = $tree; documentIndex = $indexes[0]; attempts = $attempt; ambiguous = $false }
        }
        if ($indexes.Count -gt 1) {
            $ambiguous = $true
            break
        }
        if ($attempt -lt $Attempts) { Start-Sleep -Milliseconds $DelayMs }
    }
    [ordered]@{ tree = $last; documentIndex = -1; attempts = $Attempts; ambiguous = $ambiguous }
}

# ============================================================================
# 5. 目标身份校验：进程 / 启动时间 / exe / HWND / Document URI / 唯一会话链接
# ============================================================================

function ConvertTo-AguiaIsoText {
    param($Value)
    if ($null -eq $Value) { return $null }
    $inv = [System.Globalization.CultureInfo]::InvariantCulture
    if ($Value -is [DateTimeOffset]) { return $Value.ToString('o', $inv) }
    if ($Value -is [DateTime]) {
        # ConvertFrom-Json 会把 ISO-8601 字符串自动转成 DateTime（Kind 保留 UTC/Local）；
        # 若调用方没给时区（Unspecified）则视为不合法，不能猜。
        if ($Value.Kind -eq [System.DateTimeKind]::Unspecified) { return $null }
        return $Value.ToString('o', $inv)
    }
    return [string]$Value
}

function ConvertTo-AguiaTargetSpec {
    param($Target, [string]$Action)
    if ($null -eq $Target) {
        Throw-Aguia 'bad_request' 'target 为必填对象（inspect 可省略 target 以仅列候选身份）'
    }
    $rawPid = Get-FieldValue $Target 'pid'
    $processId = 0
    if ($null -eq $rawPid -or -not [int]::TryParse([string]$rawPid, [ref]$processId) -or $processId -le 0) {
        Throw-Aguia 'bad_request' 'target.pid 必须是正整数' @{ field = 'pid' }
    }
    $hwnd = ConvertTo-AguiaHwnd (Get-FieldValue $Target 'hwnd')
    if ($null -eq $hwnd) {
        Throw-Aguia 'bad_request' 'target.hwnd 必须是正整数或 0x 十六进制字符串' @{ field = 'hwnd' }
    }
    $startedRaw = ConvertTo-AguiaIsoText (Get-FieldValue $Target 'startedAt')
    $started = [DateTimeOffset]::MinValue
    $style = [System.Globalization.DateTimeStyles]::RoundtripKind
    $culture = [System.Globalization.CultureInfo]::InvariantCulture
    if ([string]::IsNullOrWhiteSpace($startedRaw) -or -not [DateTimeOffset]::TryParse($startedRaw, $culture, $style, [ref]$started)) {
        Throw-Aguia 'bad_request' 'target.startedAt 必须是带时区的 ISO-8601 时间' @{ field = 'startedAt' }
    }
    $uriRaw = [string](Get-FieldValue $Target 'uri')
    $normalizedUri = Get-NormalizedUri -Raw $uriRaw
    if (-not $normalizedUri) {
        Throw-Aguia 'bad_request' 'target.uri 必须是绝对 http(s) URI' @{ field = 'uri' }
    }
    [ordered]@{
        pid          = $processId
        hwnd         = [long]$hwnd
        hwndHex      = ('0x{0:X}' -f $hwnd)
        startedAt    = $started.ToUniversalTime().ToString('o')
        uriRaw       = $uriRaw
        uri          = $normalizedUri
    }
}

function Get-AguiaTargetKey {
    param($TargetSpec)
    $canonical = 'aguia1|{0}|{1}|{2}|{3}' -f $TargetSpec.pid, $TargetSpec.startedAt, $TargetSpec.hwnd, $TargetSpec.uri
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($canonical)
        $hash = $sha.ComputeHash($bytes)
    } finally {
        $sha.Dispose()
    }
    $hex = -join ($hash[0..7] | ForEach-Object { $_.ToString('x2') })
    return 'aguia1:' + $hex
}

function Test-AguiaProcessIdentity {
    param($Provider, $TargetSpec, $ToleranceMs = $script:AguiaStartToleranceMs)
    $proc = $null
    try { $proc = & $Provider.processInfo $TargetSpec.pid } catch { $proc = $null }
    if ($null -eq $proc) {
        Throw-Aguia 'process_not_found' ('进程不存在或无法读取: pid=' + $TargetSpec.pid) @{ field = 'pid'; pid = $TargetSpec.pid }
    }
    $procStartedText = ConvertTo-AguiaIsoText $proc.startedAtUtc
    if ([string]::IsNullOrWhiteSpace([string]$procStartedText)) {
        Throw-Aguia 'target_mismatch' '无法读取进程启动时间，不能确认目标' @{ field = 'startedAt'; hint = 'process_start_time_unreadable' }
    }
    $actual = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse([string]$procStartedText, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind, [ref]$actual)) {
        Throw-Aguia 'target_mismatch' '进程启动时间格式不可解析' @{ field = 'startedAt'; actual = [string]$proc.startedAtUtc }
    }
    $declared = [DateTimeOffset]::Parse($TargetSpec.startedAt, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)
    $deltaMs = [math]::Abs(($actual.ToUniversalTime() - $declared.ToUniversalTime()).TotalMilliseconds)
    if ($deltaMs -gt $ToleranceMs) {
        Throw-Aguia 'target_mismatch' '进程启动时间与 target.startedAt 不一致（疑似 PID 复用）' @{
            field = 'startedAt'
            expected = $TargetSpec.startedAt
            actual = $actual.ToUniversalTime().ToString('o')
            deltaMs = [int][math]::Round($deltaMs)
        }
    }
    if (-not (Test-AguiaAllowedExecutable -ExePath ([string]$proc.exePath))) {
        Throw-Aguia 'unexpected_executable' '目标进程不是允许路径下的 Antigravity.exe' @{
            field = 'exePath'
            actual = [string]$proc.exePath
        }
    }
    return $proc
}

function Test-AguiaWindowIdentity {
    param($Provider, $TargetSpec)
    $w = $null
    try { $w = & $Provider.windowInfo $TargetSpec.hwnd } catch { $w = $null }
    if ($null -eq $w) {
        Throw-Aguia 'window_not_found' ('HWND 不存在或不可读: ' + $TargetSpec.hwndHex) @{ field = 'hwnd'; hwnd = $TargetSpec.hwndHex }
    }
    if ([int]$w.pid -ne $TargetSpec.pid) {
        Throw-Aguia 'target_mismatch' 'HWND 不属于 target.pid' @{
            field = 'hwnd.pid'
            expected = $TargetSpec.pid
            actual = [int]$w.pid
        }
    }
    if ([string]$w.class -ne 'Chrome_WidgetWin_1') {
        Throw-Aguia 'target_mismatch' 'HWND 窗口类不是 Chrome_WidgetWin_1' @{ field = 'hwnd.class'; actual = [string]$w.class }
    }
    if (-not $w.isTopLevel) {
        Throw-Aguia 'target_mismatch' 'HWND 不是顶层窗口' @{ field = 'hwnd.isTopLevel' }
    }
    if ($w.cloaked -ne 0) {
        Throw-Aguia 'window_cloaked' '目标窗口被系统 cloaked（可能在其它虚拟桌面或不可见状态）' @{ field = 'hwnd.cloaked'; actual = [int]$w.cloaked }
    }
    if (-not $w.visible) {
        Throw-Aguia 'window_not_visible' '目标窗口不可见' @{ field = 'hwnd.visible' }
    }
    return $w
}

function Find-AguiaSessionLink {
    param($Nodes, [string]$NormalizedUri, [ValidateSet('sidebar', 'window')][string]$Scope = 'sidebar')
    $sidebarIndex = -1
    if ($Scope -eq 'sidebar') {
        for ($i = 0; $i -lt $Nodes.Count; $i++) {
            if ($Nodes[$i].name -eq 'Sidebar' -and $Nodes[$i].type -eq 'Group') { $sidebarIndex = $i; break }
        }
        if ($sidebarIndex -lt 0) {
            for ($i = 0; $i -lt $Nodes.Count; $i++) {
                if ($Nodes[$i].name -eq 'Sidebar') { $sidebarIndex = $i; break }
            }
        }
        if ($sidebarIndex -lt 0) { return [ordered]@{ indexes = @(); scoped = $false } }
    }
    $targetKey = Get-UriIdentityKey -Raw $NormalizedUri
    if ([string]::IsNullOrEmpty($targetKey)) { return [ordered]@{ indexes = @(); scoped = ($Scope -eq 'sidebar') } }
    $matches = @()
    for ($i = 0; $i -lt $Nodes.Count; $i++) {
        $n = $Nodes[$i]
        if ($n.type -ne 'Hyperlink') { continue }
        if (-not $n.enabled -or $n.offscreen) { continue }
        if ($null -eq $n.value) { continue }
        if ($Scope -eq 'sidebar' -and -not (Test-AguiaNodeDescendsFrom -Nodes $Nodes -Index $i -AncestorIndex $sidebarIndex)) { continue }
        $key = Get-UriIdentityKey -Raw ([string]$n.value)
        if ($key -ceq $targetKey) { $matches += $i }
    }
    [ordered]@{ indexes = $matches; scoped = ($Scope -eq 'sidebar') }
}

function Get-AguiaTargetView {
    param($Provider, $TargetSpec)
    $diagnostics = [ordered]@{
        scanAttempts = 0
        nodeCount    = 0
        truncated    = $false
        elapsedMs    = 0
    }
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $proc = Test-AguiaProcessIdentity -Provider $Provider -TargetSpec $TargetSpec
    $window = Test-AguiaWindowIdentity -Provider $Provider -TargetSpec $TargetSpec
    $scan = Get-AguiaTargetTree -Provider $Provider -Hwnd $TargetSpec.hwnd -NormalizedUri $TargetSpec.uri
    $diagnostics.scanAttempts = $scan.attempts
    if ($scan.tree) {
        $diagnostics.nodeCount = $scan.tree.nodeCount
        $diagnostics.truncated = $scan.tree.truncated
    }
    if ($scan.documentIndex -lt 0) {
        $actuals = @()
        if ($scan.tree) { $actuals = @(Get-AguiaHttpDocumentUris -Nodes $scan.tree.nodes) }
        if ($scan.ambiguous) {
            Throw-Aguia 'uri_mismatch' '窗口内出现多个匹配同一 URI 的 Document，无法确定目标' @{ field = 'uri'; actualCount = $actuals.Count }
        }
        if ($scan.tree.nodeCount -lt $script:AguiaMinUsefulNodes) {
            Throw-Aguia 'tree_not_ready' '目标窗口的 UIA 树尚未提供文档与控件（可能仍在加载）' @{
                field = 'tree'
                nodeCount = $scan.tree.nodeCount
                hint = 'retry_after_delay'
            }
        }
        $detail = @{ field = 'uri'; expected = $TargetSpec.uri; documentCount = $actuals.Count }
        if ($actuals.Count -eq 1) { $detail.actual = $actuals[0] }
        Throw-Aguia 'uri_mismatch' '当前 Document 的 URI 与 target.uri 不一致（目标会话可能已切换）' $detail
    }
    $linkResult = Find-AguiaSessionLink -Nodes $scan.tree.nodes -NormalizedUri $TargetSpec.uri -Scope 'sidebar'
    $linkEvidence = 'sidebar'
    $links = @($linkResult.indexes)
    if ($links.Count -eq 0 -and $linkEvidence -eq 'sidebar') {
        $linkResult = Find-AguiaSessionLink -Nodes $scan.tree.nodes -NormalizedUri $TargetSpec.uri -Scope 'window'
        $linkEvidence = 'window'
        $links = @($linkResult.indexes)
    }
    if ($links.Count -eq 0) {
        Throw-Aguia 'session_link_not_found' '未找到指向 target.uri 的可见会话链接（侧栏可能被折叠）' @{ field = 'sessionLink' }
    }
    if ($links.Count -gt 1) {
        Throw-Aguia 'session_link_ambiguous' '存在多个指向 target.uri 的可见会话链接' @{ field = 'sessionLink'; count = $links.Count }
    }
    $stopwatch.Stop()
    $diagnostics.elapsedMs = $stopwatch.ElapsedMilliseconds
    [ordered]@{
        target       = $TargetSpec
        targetKey    = Get-AguiaTargetKey -TargetSpec $TargetSpec
        process      = $proc
        window       = $window
        nodes        = $scan.tree.nodes
        documentIndex = $scan.documentIndex
        linkIndex    = [int]$links[0]
        linkEvidence = $linkEvidence
        diagnostics  = $diagnostics
    }
}

# ============================================================================
# 6. 归一化观察快照
# ============================================================================

function Find-AguiaLogAnchor {
    param($Nodes)
    for ($i = 0; $i -lt $Nodes.Count; $i++) {
        $n = $Nodes[$i]
        if ($n.name -ne $script:AguiaLogAnchorName) { continue }
        if ($n.type -ne 'Text' -and $n.type -ne 'Group') { continue }
        if (-not (@($n.patterns) -contains 'Scroll')) { continue }
        if ($n.offscreen) { continue }
        return $i
    }
    for ($i = 0; $i -lt $Nodes.Count; $i++) {
        if ($Nodes[$i].name -eq $script:AguiaLogAnchorName) { return $i }
    }
    return -1
}

function Get-AguiaLogScope {
    # 真实窗口里 'Conversation Log' 只是历史滚动区的可访问名，回合标签与正文是它的兄弟节点
    # （t8 探测：Text 'Conversation Log' [Scroll] 与 Text 'You said' 同级）。因此历史范围取
    # “日志锚点 + 首/末角色标签”的最低公共祖先；拿不到标签时退回锚点子树。
    param($Nodes)
    $anchor = Find-AguiaLogAnchor -Nodes $Nodes
    $labelIndexes = @()
    for ($i = 0; $i -lt $Nodes.Count; $i++) {
        $n = $Nodes[$i]
        if ($n.type -ne 'Text') { continue }
        if ($n.name -ne $script:AguiaRoleLabelUser -and $n.name -ne $script:AguiaRoleLabelAssistant) { continue }
        $labelIndexes += $i
    }
    if ($labelIndexes.Count -eq 0) { return $anchor }
    $scope = if ($anchor -ge 0) { $anchor } else { [int]$labelIndexes[0] }
    foreach ($idx in @($labelIndexes[0], $labelIndexes[$labelIndexes.Count - 1])) {
        $a = $scope
        while ($a -ge 0) {
            $b = [int]$idx
            while ($b -ge 0) {
                if ($a -eq $b) { break }
                $b = [int]$Nodes[$b].parent
            }
            if ($b -ge 0) { break }
            $a = [int]$Nodes[$a].parent
        }
        if ($a -ge 0) { $scope = $a }
    }
    return $scope
}

function Test-AguiaMessageTextNode {
    param($Node)
    if ($Node.type -ne 'Text') { return $false }
    if (@($Node.patterns) -notcontains 'Text') { return $false }
    if (@($Node.patterns) -contains 'Scroll') { return $false }
    if ([string]::IsNullOrWhiteSpace($Node.name)) { return $false }
    $name = $Node.name.Trim()
    if ($name -in @($script:AguiaLogAnchorName, $script:AguiaRoleLabelUser, $script:AguiaRoleLabelAssistant)) { return $false }
    if ($name -match $script:AguiaTimestampPattern) { return $false }
    if ($name -match '^No more older messages') { return $false }
    if ($name -eq 'Ask anything, @ to mention, / for actions') { return $false }
    return $true
}

function Get-AguiaTurns {
    param($Nodes, [int]$LogIndex)
    $turns = [System.Collections.Generic.List[object]]::new()
    $labelCount = 0
    if ($LogIndex -lt 0) {
        return [ordered]@{ turns = $turns; roleLabels = 0; logFound = $false; skippedUnlabeled = 0 }
    }
    $role = $null
    $texts = [System.Collections.Generic.List[string]]::new()
    $skipped = 0
    for ($i = 0; $i -lt $Nodes.Count; $i++) {
        if (-not (Test-AguiaNodeDescendsFrom -Nodes $Nodes -Index $i -AncestorIndex $LogIndex)) { continue }
        $n = $Nodes[$i]
        if ($n.type -eq 'Text' -and $n.name -in @($script:AguiaRoleLabelUser, $script:AguiaRoleLabelAssistant)) {
            $newRole = if ($n.name -eq $script:AguiaRoleLabelUser) { 'user' } else { 'assistant' }
            if ($role -eq $newRole -and $texts.Count -eq 0) { continue }
            if ($null -ne $role) {
                $turns.Add([ordered]@{ role = $role; text = ($texts -join "`n") })
            }
            $role = $newRole
            $texts = [System.Collections.Generic.List[string]]::new()
            $labelCount++
            continue
        }
        if ($null -eq $role) {
            if (Test-AguiaMessageTextNode -Node $n) { $skipped++ }
            continue
        }
        if (-not (Test-AguiaMessageTextNode -Node $n)) { continue }
        if (Test-AguiaNodeHasAncestorName -Nodes $Nodes -Index $i -Names @($script:AguiaEndActionsName)) { continue }
        if (Test-AguiaNodeHasAncestorName -Nodes $Nodes -Index $i -Names @('Notifications', 'Typeahead menu')) { continue }
        if (Test-AguiaNodeHasAncestorType -Nodes $Nodes -Index $i -Types @('Button', 'Hyperlink')) { continue }
        if ([string]::IsNullOrWhiteSpace($n.name)) { continue }
        $text = $n.name.Trim()
        if ($texts.Count -gt 0 -and $texts[$texts.Count - 1] -eq $text) { continue }
        $texts.Add($text)
    }
    if ($null -ne $role) {
        $turns.Add([ordered]@{ role = $role; text = ($texts -join "`n") })
    }
    [ordered]@{ turns = $turns; roleLabels = $labelCount; logFound = $true; skippedUnlabeled = $skipped }
}

function Find-AguiaComposer {
    param($Nodes)
    $containerIndex = -1
    $inputIndexes = @()
    for ($i = 0; $i -lt $Nodes.Count; $i++) {
        if ($Nodes[$i].automationId -eq $script:AguiaComposerContainerAid) { $containerIndex = $i; break }
    }
    for ($i = 0; $i -lt $Nodes.Count; $i++) {
        $n = $Nodes[$i]
        if ($n.type -ne 'ComboBox') { continue }
        if ($n.name -ne $script:AguiaComposerInputName) { continue }
        if (@($n.patterns) -notcontains 'Value') { continue }
        if ($containerIndex -ge 0 -and -not (Test-AguiaNodeDescendsFrom -Nodes $Nodes -Index $i -AncestorIndex $containerIndex)) { continue }
        $inputIndexes += $i
    }
    $inputIndex = if ($inputIndexes.Count -eq 1) { [int]$inputIndexes[0] } else { -1 }
    $value = $null
    $editable = $null
    if ($inputIndex -ge 0) {
        $value = [string]$Nodes[$inputIndex].value
        $editable = if ($null -eq $Nodes[$inputIndex].valueReadOnly) { $null } else { -not [bool]$Nodes[$inputIndex].valueReadOnly }
    }
    $empty = if ($null -ne $value) { $value.Length -eq 0 -or ($value -match '^[ \t\r]*\n$') } else { $null }
    [ordered]@{
        containerIndex = $containerIndex
        inputIndexes   = $inputIndexes
        inputIndex     = $inputIndex
        present        = ($inputIndexes.Count -ge 1)
        unique         = ($inputIndexes.Count -eq 1)
        value          = $value
        valueLength    = if ($null -ne $value) { $value.Length } else { $null }
        empty          = $empty
        editable       = $editable
    }
}

function Find-AguiaSendControl {
    param($Nodes, [int]$ContainerIndex)
    $candidates = @()
    for ($i = 0; $i -lt $Nodes.Count; $i++) {
        $n = $Nodes[$i]
        if ($n.type -ne 'Button') { continue }
        if (-not $n.enabled -or $n.offscreen) { continue }
        if (@($n.patterns) -notcontains 'Invoke') { continue }
        $name = ([string]$n.name).Trim()
        if (-not ($script:AguiaSendNames | Where-Object { $_ -ieq $name })) { continue }
        if ($ContainerIndex -ge 0 -and -not (Test-AguiaNodeDescendsFrom -Nodes $Nodes -Index $i -AncestorIndex $ContainerIndex)) { continue }
        $candidates += $i
    }
    [ordered]@{
        indexes = $candidates
        index   = if ($candidates.Count -eq 1) { [int]$candidates[0] } else { -1 }
    }
}

function Find-AguiaBusyControl {
    param($Nodes)
    for ($i = 0; $i -lt $Nodes.Count; $i++) {
        $n = $Nodes[$i]
        if ($n.type -ne 'Button') { continue }
        if (-not $n.enabled -or $n.offscreen) { continue }
        if (@($n.patterns) -notcontains 'Invoke') { continue }
        $name = ([string]$n.name).Trim()
        if ($script:AguiaStopNames | Where-Object { $_ -ieq $name }) {
            return [ordered]@{ found = $true; index = $i; name = $name; evidence = 'stop_control' }
        }
    }
    [ordered]@{ found = $false; index = -1; name = $null; evidence = 'no_stop_control' }
}

function Find-AguiaPermissionCard {
    param($Nodes)
    $allowIndexes = @()
    for ($i = 0; $i -lt $Nodes.Count; $i++) {
        $n = $Nodes[$i]
        if ($n.type -ne 'Button' -or -not $n.enabled -or $n.offscreen) { continue }
        if (@($n.patterns) -notcontains 'Invoke') { continue }
        $name = ([string]$n.name).Trim()
        if ($script:AguiaAllowNames | Where-Object { $_ -ieq $name }) { $allowIndexes += $i }
    }
    foreach ($allowIndex in $allowIndexes) {
        $ancestor = [int]$Nodes[$allowIndex].parent
        $guard = 0
        while ($ancestor -ge 0 -and $guard -lt 10) {
            $denyName = $null
            $keyword = $null
            $allowName = [string]$Nodes[$allowIndex].name
            for ($j = 0; $j -lt $Nodes.Count; $j++) {
                if (-not (Test-AguiaNodeDescendsFrom -Nodes $Nodes -Index $j -AncestorIndex $ancestor)) { continue }
                $n = $Nodes[$j]
                if ($n.type -eq 'Button' -and $n.enabled -and -not $n.offscreen) {
                    $bn = ([string]$n.name).Trim()
                    if (-not $denyName -and ($script:AguiaDenyNames | Where-Object { $_ -ieq $bn })) { $denyName = $bn }
                }
                if ($n.type -eq 'Text' -and -not $keyword -and $n.name -match $script:AguiaPermissionKeyword) {
                    $keyword = ([string]$n.name).Trim()
                }
            }
            if ($denyName -and $keyword) {
                return [ordered]@{
                    found          = $true
                    containerIndex = $ancestor
                    allowName      = $allowName
                    denyName       = $denyName
                    keyword        = $keyword
                    evidence       = 'allow_deny_buttons_and_permission_text'
                }
            }
            $ancestor = [int]$Nodes[$ancestor].parent
            $guard++
        }
    }
    [ordered]@{ found = $false; containerIndex = -1; evidence = 'no_permission_card' }
}

function Get-AguiaEndActions {
    param($Nodes, [int]$LogIndex)
    $lastAssistantLabel = -1
    if ($LogIndex -lt 0) { return [ordered]@{ found = $false; index = -1 } }
    for ($i = 0; $i -lt $Nodes.Count; $i++) {
        if (-not (Test-AguiaNodeDescendsFrom -Nodes $Nodes -Index $i -AncestorIndex $LogIndex)) { continue }
        if ($Nodes[$i].name -eq $script:AguiaRoleLabelAssistant) { $lastAssistantLabel = $i }
    }
    if ($lastAssistantLabel -lt 0) { return [ordered]@{ found = $false; index = -1 } }
    for ($i = $lastAssistantLabel + 1; $i -lt $Nodes.Count; $i++) {
        if (-not (Test-AguiaNodeDescendsFrom -Nodes $Nodes -Index $i -AncestorIndex $LogIndex)) { continue }
        if ($Nodes[$i].name -ne $script:AguiaEndActionsName) { continue }
        $buttonNames = @()
        for ($j = 0; $j -lt $Nodes.Count; $j++) {
            if (-not (Test-AguiaNodeDescendsFrom -Nodes $Nodes -Index $j -AncestorIndex $i)) { continue }
            if ($Nodes[$j].type -eq 'Button') { $buttonNames += ([string]$Nodes[$j].name).Trim() }
        }
        $hasCopy = [bool]($buttonNames | Where-Object { $_ -ieq 'Copy' })
        $hasFeedback = [bool]($buttonNames | Where-Object { $_ -ieq 'Good response' -or $_ -ieq 'Bad response' })
        if ($hasCopy -and $hasFeedback) {
            return [ordered]@{ found = $true; index = $i; buttons = $buttonNames }
        }
    }
    return [ordered]@{ found = $false; index = -1 }
}

function Get-AguiaHistoryWindow {
    param($Nodes)
    for ($i = 0; $i -lt $Nodes.Count; $i++) {
        $name = [string]$Nodes[$i].name
        if ($name -match $script:AguiaHistoryPattern) {
            return [ordered]@{
                loaded   = [int]$matches[1]
                total    = [int]$matches[2]
                complete = ([int]$matches[1] -eq [int]$matches[2])
                text     = $name
            }
        }
    }
    return $null
}

function Get-AguiaBaselineInfo {
    param($Baseline, [DateTimeOffset]$Now)
    $info = [ordered]@{
        present            = $false
        valid              = $false
        reason             = $null
        ageMs              = $null
        lastAssistantText  = $null
        userTurnCount      = $null
    }
    if ($null -eq $Baseline) {
        $info.reason = 'baseline_missing'
        return $info
    }
    $info.present = $true
    $observedRaw = ConvertTo-AguiaIsoText (Get-FieldValue $Baseline 'observedAt')
    $observed = [DateTimeOffset]::MinValue
    if ([string]::IsNullOrWhiteSpace($observedRaw) -or -not [DateTimeOffset]::TryParse($observedRaw, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind, [ref]$observed)) {
        $info.reason = 'baseline_invalid_observedAt'
        return $info
    }
    $age = ($Now - $observed.ToUniversalTime()).TotalMilliseconds
    if ($age -lt -2000) { $info.reason = 'baseline_in_future'; return $info }
    if ($age -gt 300000) { $info.reason = 'baseline_too_old'; return $info }
    $info.ageMs = [int][math]::Round($age)
    $lastText = Get-FieldValue $Baseline 'lastAssistantText'
    if ($null -ne $lastText) { $info.lastAssistantText = [string]$lastText }
    $userTurns = Get-FieldValue $Baseline 'userTurnCount'
    $parsedUserTurns = 0
    if ($null -ne $userTurns -and [int]::TryParse([string]$userTurns, [ref]$parsedUserTurns) -and $parsedUserTurns -ge 0) {
        $info.userTurnCount = $parsedUserTurns
    }
    $info.valid = $true
    return $info
}

function Get-AguiaSnapshot {
    param($Nodes, $TargetSpec, $Baseline)
    $now = [DateTimeOffset]::UtcNow
    $logIndex = Get-AguiaLogScope -Nodes $Nodes
    $turnInfo = Get-AguiaTurns -Nodes $Nodes -LogIndex $logIndex
    $composer = Find-AguiaComposer -Nodes $Nodes
    $busy = Find-AguiaBusyControl -Nodes $Nodes
    $permission = Find-AguiaPermissionCard -Nodes $Nodes
    $endActions = Get-AguiaEndActions -Nodes $Nodes -LogIndex $logIndex
    $history = Get-AguiaHistoryWindow -Nodes $Nodes
    $baselineInfo = Get-AguiaBaselineInfo -Baseline $Baseline -Now $now

    $turns = @($turnInfo.turns)
    $lastTurn = if ($turns.Count -gt 0) { $turns[$turns.Count - 1] } else { $null }
    $lastAssistantText = $null
    $assistantTurnCount = 0
    $userTurnCount = 0
    foreach ($t in $turns) {
        if ($t.role -eq 'assistant') { $assistantTurnCount++; $lastAssistantText = $t.text }
        if ($t.role -eq 'user') { $userTurnCount++ }
    }
    $textStable = $false
    if ($baselineInfo.valid -and $lastTurn -and $lastTurn.role -eq 'assistant' -and $null -ne $baselineInfo.lastAssistantText) {
        $textStable = ($baselineInfo.lastAssistantText -ceq $lastTurn.text)
    }
    $stableForMs = 1200
    $stable = $textStable -and ($null -ne $baselineInfo.ageMs) -and ($baselineInfo.ageMs -ge $stableForMs)
    $complete = ($stable -and $endActions.found -and -not $busy.found -and -not $permission.found -and $null -ne $lastTurn -and $lastTurn.role -eq 'assistant' -and -not [string]::IsNullOrWhiteSpace($lastTurn.text))

    $phase = 'unknown'
    if ($permission.found) { $phase = 'permission' }
    elseif ($busy.found) { $phase = 'busy' }
    elseif ($complete) { $phase = 'idle' }

    $unreadable = [System.Collections.Generic.List[string]]::new()
    if (-not $turnInfo.logFound) { $unreadable.Add('conversation_log_not_found') }
    if ($turnInfo.skippedUnlabeled -gt 0) { $unreadable.Add('unlabeled_text_skipped:' + $turnInfo.skippedUnlabeled) }
    if (-not $endActions.found) { $unreadable.Add('end_actions_missing') }
    if (-not $baselineInfo.present) { $unreadable.Add('baseline_missing_for_completion') }
    elseif (-not $baselineInfo.valid) { $unreadable.Add('baseline_invalid:' + $baselineInfo.reason) }
    elseif (-not $textStable) { $unreadable.Add('assistant_text_changed_since_baseline') }
    elseif ($baselineInfo.ageMs -lt $stableForMs) { $unreadable.Add('baseline_too_recent_for_stability') }
    if ($null -eq $history) { $unreadable.Add('history_window_unknown') }
    elseif (-not $history.complete) { $unreadable.Add('history_windowed:' + $history.text) }
    if (-not $composer.unique) { $unreadable.Add('composer_not_unique') }
    if ($null -eq $composer.editable) { $unreadable.Add('composer_editability_unknown') }
    $unreadable.Add('live_send_control_semantics_unverified')

    $key = if ($TargetSpec) { Get-AguiaTargetKey -TargetSpec $TargetSpec } else { $null }
    [ordered]@{
        targetKey     = $key
        observedAt    = $now.ToString('o')
        documentUri   = if ($TargetSpec) { $TargetSpec.uri } else { $null }
        turns         = $turns
        turnCount     = $turns.Count
        userTurnCount = $userTurnCount
        assistantTurnCount = $assistantTurnCount
        phase         = $phase
        complete      = [bool]$complete
        composer      = [ordered]@{
            present     = $composer.present
            unique      = $composer.unique
            empty       = $composer.empty
            editable    = $composer.editable
            valueLength = $composer.valueLength
        }
        history       = $history
        evidence      = [ordered]@{
            roleSource        = if ($turnInfo.roleLabels -gt 0) { 'explicit_labels' } else { 'none' }
            roleLabels        = $turnInfo.roleLabels
            endActions        = [bool]$endActions.found
            endActionButtons  = if ($endActions.found) { @($endActions.buttons) } else { @() }
            stopControl       = [bool]$busy.found
            stopControlName   = $busy.name
            permissionCard    = [bool]$permission.found
            permissionKeyword = if ($permission.found) { $permission.keyword } else { $null }
            baselineAgeMs     = $baselineInfo.ageMs
            baselineTextStable = [bool]$textStable
            completionRule    = 'stable_baseline+assistant_text+end_actions+no_stop+no_permission'
        }
        unreadable    = @($unreadable)
    }
}

# ============================================================================
# 7. dispatch：唯一空 composer -> 精确写入与读回 -> 单次 Invoke
# ============================================================================

function ConvertFrom-AguiaComposerReadback {
    param($Raw)
    if ($null -eq $Raw) { return $null }
    $s = [string]$Raw
    if ($s -match '^[ \t\r]*\n$') { return '' }
    return ($s -replace '\r?\n$', '')
}

function Set-AguiaComposerValue {
    param($Provider, $Element, [string]$Text)
    if ($null -ne $Provider.focus) { & $Provider.focus $Element }
    if ($null -ne $Provider.clearInput) { & $Provider.clearInput $Element }
    if ($null -ne $Provider.typeText) {
        & $Provider.typeText $Text $Element
        return
    }
    & $Provider.setValue $Element $Text
}

function Restore-AguiaComposer {
    param($Provider, $Element)
    $result = [ordered]@{ attempted = $false; ok = $false; reason = $null }
    if ($null -eq $Element) { $result.reason = 'composer_missing'; return $result }
    $current = $null
    try { $current = ConvertFrom-AguiaComposerReadback (& $Provider.value $Element) } catch { $current = $null }
    if ($null -ne $current -and $current.Length -eq 0) {
        $result.ok = $true
        $result.reason = 'already_empty'
        return $result
    }
    $result.attempted = $true
    try {
        if ($null -ne $Provider.focus) { & $Provider.focus $Element }
        if ($null -ne $Provider.clearInput) {
            & $Provider.clearInput $Element
        } else {
            & $Provider.setValue $Element ''
        }
        $after = ConvertFrom-AguiaComposerReadback (& $Provider.value $Element)
        $result.ok = ($null -ne $after -and $after.Length -eq 0)
        if (-not $result.ok) { $result.reason = 'restore_readback_mismatch' }
    } catch {
        $result.reason = 'restore_failed'
    }
    return $result
}

# 提交边界：如实记录“是否已写入 composer / 是否已 Invoke”，供所有异常出口使用。
$script:AguiaDispatchBoundary = 'none'

function Invoke-AguiaDispatch {
    param($Provider, $Request)
    $message = Get-FieldValue $Request 'message'
    if ($null -eq $message -or $message -isnot [string]) {
        Throw-Aguia 'bad_request' 'dispatch 需要字符串 message' @{ field = 'message' }
    }
    if ($message.Length -eq 0 -or [string]::IsNullOrWhiteSpace($message)) {
        Throw-Aguia 'bad_request' 'message 不能为空或全空白' @{ field = 'message' }
    }
    if ($message.Length -gt $script:AguiaMaxMessageChars) {
        Throw-Aguia 'bad_request' ('message 超过长度上限 ' + $script:AguiaMaxMessageChars) @{ field = 'message'; length = $message.Length }
    }
    if ($message.Contains([char]0)) {
        Throw-Aguia 'bad_request' 'message 不允许包含 NUL 字符' @{ field = 'message' }
    }
    if ($message.Contains("`r") -or $message.Contains("`n")) {
        Throw-Aguia 'bad_request' 'message 不允许包含换行（Enter 会触发发送）' @{ field = 'message' }
    }

    $target = Get-FieldValue $Request 'target'
    $targetSpec = ConvertTo-AguiaTargetSpec -Target $target -Action 'dispatch'
    $view = Get-AguiaTargetView -Provider $Provider -TargetSpec $targetSpec
    $snapshot = Get-AguiaSnapshot -Nodes $view.nodes -TargetSpec $targetSpec -Baseline (Get-FieldValue $Request 'baseline')
    # 焦点读数只用于诊断：读失败不得阻止派发，更不得被误判成“已经写入”。
    $foregroundBefore = $null
    try {
        $foregroundBefore = & $Provider.foreground
    } catch {
        # recorded below on $result.diagnostics once it exists
    }

    $result = [ordered]@{
        ok               = $true
        action           = 'dispatch'
        driverVersion    = $script:AguiaDriverVersion
        targetKey        = $view.targetKey
        status           = 'not_sent'
        reason           = $null
        code             = $null
        invokeAttempted  = $false
        invokeCount      = 0
        messageLength    = $message.Length
        composer         = $null
        observed         = $null
        diagnostics      = [ordered]@{
            nodeCount    = $view.diagnostics.nodeCount
            scanAttempts = $view.diagnostics.scanAttempts
            foregroundChangedBeforeWrite = $false
            foregroundChangedAfterInvoke = $false
            windowMinimized = [bool]$view.window.minimized
        }
    }

    $result.composer = $snapshot.composer
    $script:AguiaDispatchBoundary = 'pre_write'

    $refuse = {
        param([string]$Reason, [string]$Code = 'not_sent')
        $result.status = 'not_sent'
        $result.reason = $Reason
        $result.code = $Code
        $result
    }

    if ($view.window.minimized) {
        return (& $refuse 'window_minimized' 'window_minimized')
    }
    if ($snapshot.evidence.permissionCard) {
        return (& $refuse 'permission_pending' 'permission_pending')
    }
    if ($snapshot.evidence.stopControl) {
        return (& $refuse ('chat_busy:' + $snapshot.evidence.stopControlName) 'chat_busy')
    }
    if (-not $snapshot.composer.present) {
        return (& $refuse 'composer_not_found' 'composer_not_found')
    }
    if (-not $snapshot.composer.unique) {
        return (& $refuse 'composer_ambiguous' 'composer_ambiguous')
    }
    if ($snapshot.composer.empty -ne $true) {
        return (& $refuse 'composer_not_empty' 'composer_not_empty')
    }
    if ($snapshot.composer.editable -eq $false) {
        return (& $refuse 'composer_readonly' 'composer_readonly')
    }

    # 重新定位 composer 元素（快照只提供状态，不携带元素引用）。
    $composer = Find-AguiaComposer -Nodes $view.nodes
    if (-not $composer.present -or -not $composer.unique) {
        return (& $refuse 'composer_changed_before_write' 'composer_ambiguous')
    }
    $inputIndex = [int]$composer.inputIndex
    $inputElement = $view.nodes[$inputIndex].element

    # 键盘注入前必须把目标窗口置前并复核；不一致则恢复+置前重试一次，仍不一致直接 not_sent（零字符写入）。
    if ($null -ne $Provider.setForeground) {
        [void](& $Provider.setForeground $targetSpec.hwnd)
        $fg = $null
        try { $fg = & $Provider.foreground } catch { $fg = $null }
        if ($fg -ne $targetSpec.hwnd) {
            if ($null -ne $Provider.restoreWindow) { [void](& $Provider.restoreWindow $targetSpec.hwnd) }
            [void](& $Provider.setForeground $targetSpec.hwnd)
            try { $fg = & $Provider.foreground } catch { $fg = $null }
            if ($fg -ne $targetSpec.hwnd) {
                return (& $refuse 'foreground_unavailable' 'foreground_unavailable')
            }
        }
    }

    $result.diagnostics.foregroundChangedBeforeWrite = $null
    try {
        if ($null -ne $foregroundBefore) {
            $result.diagnostics.foregroundChangedBeforeWrite = ((& $Provider.foreground) -ne $foregroundBefore)
        }
    } catch {
        $result.diagnostics.focusProbeErrorBeforeWrite = (Get-AguiaErrorInfo -ErrorRecord $_).message
    }

    $script:AguiaDispatchBoundary = 'writing'
    if ($null -ne $Provider.focus) { & $Provider.focus $inputElement }
    if ($null -ne $Provider.hasFocus) {
        if (-not (& $Provider.hasFocus $inputElement)) {
            if ($null -ne $Provider.clickFocus) { [void](& $Provider.clickFocus $inputElement) }
            if (-not (& $Provider.hasFocus $inputElement)) {
                return (& $refuse 'foreground_unavailable' 'foreground_unavailable')
            }
        }
    }
    try {
        Set-AguiaComposerValue -Provider $Provider -Element $inputElement -Text $message
    } catch {
        $errorInfo = Get-AguiaErrorInfo -ErrorRecord $_
        $result.status = 'not_sent'
        $result.reason = 'write_failed'
        $result.code = 'write_failed'
        $result.detail = $errorInfo.message
        return $result
    }

    $readback = $null
    $pollWatch = [System.Diagnostics.Stopwatch]::StartNew()
    $pollCount = 0
    while ($true) {
        $pollCount++
        $readbackRaw = $null
        try { $readbackRaw = & $Provider.value $inputElement } catch { $readbackRaw = $null }
        $readback = ConvertFrom-AguiaComposerReadback $readbackRaw
        if ($null -ne $readback -and $readback -ceq $message) { break }
        if ($pollWatch.ElapsedMilliseconds -ge 2000) { break }
        Start-Sleep -Milliseconds 100
    }
    $result.diagnostics['readbackPolls'] = $pollCount
    if ($null -eq $readback -or $readback -cne $message) {
        $restore = Restore-AguiaComposer -Provider $Provider -Element $inputElement
        $result.status = 'not_sent'
        $result.reason = 'readback_mismatch'
        $result.code = 'readback_mismatch'
        $result.detail = [ordered]@{
            expectedLength   = $message.Length
            actualLength     = if ($null -ne $readback) { $readback.Length } else { $null }
            composerRestored = $restore.ok
        }
        return $result
    }

    $script:AguiaDispatchBoundary = 'written'

    # 写入后重新校验：目标未漂移、仍空权限卡、composer 未被替换、Send 唯一。
    $script:AguiaFakeDispatchPhase = 'fresh_scan'
    if ($null -ne $script:AguiaFakeState) { $script:AguiaFakeState.freshScans++ }
    $freshScan = Get-AguiaTargetTree -Provider $Provider -Hwnd $targetSpec.hwnd -NormalizedUri $targetSpec.uri -Attempts 2 -DelayMs 150
    if ($freshScan.documentIndex -lt 0) {
        $script:AguiaFakeDispatchPhase = 'none'
        $restore = Restore-AguiaComposer -Provider $Provider -Element $inputElement
        $result.status = 'not_sent'
        $result.reason = 'target_drift_before_invoke'
        $result.code = 'target_drift'
        $result.detail = [ordered]@{ composerRestored = $restore.ok }
        return $result
    }
    $freshNodes = $freshScan.tree.nodes
    $freshPermission = Find-AguiaPermissionCard -Nodes $freshNodes
    if ($freshPermission.found) {
        $script:AguiaFakeDispatchPhase = 'none'
        $restore = Restore-AguiaComposer -Provider $Provider -Element $inputElement
        $result.status = 'not_sent'
        $result.reason = 'permission_pending'
        $result.code = 'permission_pending'
        $result.detail = [ordered]@{ composerRestored = $restore.ok }
        return $result
    }
    $freshComposer = Find-AguiaComposer -Nodes $freshNodes
    if (-not $freshComposer.unique) {
        $script:AguiaFakeDispatchPhase = 'none'
        $restore = Restore-AguiaComposer -Provider $Provider -Element $inputElement
        $result.status = 'not_sent'
        $result.reason = 'composer_changed_before_invoke'
        $result.code = 'composer_changed'
        $result.detail = [ordered]@{ composerRestored = $restore.ok }
        return $result
    }
    $freshValue = ConvertFrom-AguiaComposerReadback $freshComposer.value
    if ($null -eq $freshValue -or $freshValue -cne $message) {
        Start-Sleep -Milliseconds 250
        if ($null -ne $script:AguiaFakeState) { $script:AguiaFakeState.freshScans++ }
        $result.diagnostics['freshScanRetries'] = 1
        $freshScan = Get-AguiaTargetTree -Provider $Provider -Hwnd $targetSpec.hwnd -NormalizedUri $targetSpec.uri -Attempts 1 -DelayMs 0
        if ($freshScan.documentIndex -lt 0) {
            $script:AguiaFakeDispatchPhase = 'none'
            $restore = Restore-AguiaComposer -Provider $Provider -Element $inputElement
            $result.status = 'not_sent'
            $result.reason = 'target_drift_before_invoke'
            $result.code = 'target_drift'
            $result.detail = [ordered]@{ composerRestored = $restore.ok }
            return $result
        }
        $freshNodes = $freshScan.tree.nodes
        $freshPermission = Find-AguiaPermissionCard -Nodes $freshNodes
        if ($freshPermission.found) {
            $script:AguiaFakeDispatchPhase = 'none'
            $restore = Restore-AguiaComposer -Provider $Provider -Element $inputElement
            $result.status = 'not_sent'
            $result.reason = 'permission_pending'
            $result.code = 'permission_pending'
            $result.detail = [ordered]@{ composerRestored = $restore.ok }
            return $result
        }
        $freshComposer = Find-AguiaComposer -Nodes $freshNodes
        if (-not $freshComposer.unique) {
            $script:AguiaFakeDispatchPhase = 'none'
            $restore = Restore-AguiaComposer -Provider $Provider -Element $inputElement
            $result.status = 'not_sent'
            $result.reason = 'composer_changed_before_invoke'
            $result.code = 'composer_changed'
            $result.detail = [ordered]@{ composerRestored = $restore.ok }
            return $result
        }
        $freshValue = ConvertFrom-AguiaComposerReadback $freshComposer.value
        if ($null -eq $freshValue -or $freshValue -cne $message) {
            $script:AguiaFakeDispatchPhase = 'none'
            $restore = Restore-AguiaComposer -Provider $Provider -Element $inputElement
            $result.status = 'not_sent'
            $result.reason = 'composer_value_changed_before_invoke'
            $result.code = 'readback_mismatch'
            $result.detail = [ordered]@{ composerRestored = $restore.ok }
            return $result
        }
    }
    $script:AguiaFakeDispatchPhase = 'none'
    $send = Find-AguiaSendControl -Nodes $freshNodes -ContainerIndex $freshComposer.containerIndex
    if ($send.indexes.Count -eq 0) {
        $restore = Restore-AguiaComposer -Provider $Provider -Element $inputElement
        $result.status = 'not_sent'
        $result.reason = 'send_control_not_found'
        $result.code = 'send_not_found'
        $result.detail = [ordered]@{
            composerRestored = $restore.ok
            hint = '当前 UI 在空/写后 composer 上未出现与白名单精确同名的唯一 Send 按钮；真实 Send 语义尚未验证。'
        }
        return $result
    }
    if ($send.indexes.Count -gt 1) {
        $restore = Restore-AguiaComposer -Provider $Provider -Element $inputElement
        $result.status = 'not_sent'
        $result.reason = 'send_control_ambiguous'
        $result.code = 'send_ambiguous'
        $result.detail = [ordered]@{
            count = $send.indexes.Count
            names = @($send.indexes | ForEach-Object { [string]$freshNodes[$_].name })
            composerRestored = $restore.ok
        }
        return $result
    }

    $sendElement = $freshNodes[[int]$send.index].element
    $script:AguiaDispatchBoundary = 'invoking'
    $result.invokeAttempted = $true
    $invokeError = $null
    try {
        & $Provider.invoke $sendElement
        $result.invokeCount = 1
    } catch {
        $result.invokeCount = 1
        $invokeError = Get-AguiaErrorInfo -ErrorRecord $_
    }

    $script:AguiaDispatchBoundary = 'invoked'
    $result.diagnostics.foregroundChangedAfterInvoke = $null
    try {
        $result.diagnostics.foregroundChangedAfterInvoke = ((& $Provider.foreground) -ne $foregroundBefore)
    } catch {
        $focusError = Get-AguiaErrorInfo -ErrorRecord $_
        $result.diagnostics.focusProbeError = $focusError.message
        # Invoke 已进入边界：焦点读数失败也是“结果不明”，不能再声称 not_sent。
        $result.status = 'acceptance_unknown'
        $result.reason = 'post_invoke_focus_probe_failed'
        $result.code = $focusError.code
        $result.detail = $focusError.message
        $result.invokeAttempted = $true
        if ($result.invokeCount -lt 1) { $result.invokeCount = 1 }
        $result.observed = [ordered]@{
            composerEmpty = $null
            newUserTurn   = $null
            phase         = 'unknown'
            error         = $focusError.message
            note          = 'Invoke 已发出；焦点读数失败，受理与完成均无法确认，禁止自动重发。'
        }
        return $result
    }

    if ($null -ne $invokeError) {
        $result.status = 'acceptance_unknown'
        $result.reason = 'invoke_exception'
        $result.code = 'invoke_exception'
        $result.detail = $invokeError.message
        return $result
    }

    # 短时后置观察：composer 是否被清空 / 是否新增用户回合。仅作观察，不宣称受理。
    # Invoke 已经发生：此后的任何异常都必须落成 acceptance_unknown + invokeAttempted，
    # 绝不能因为观察失败而谎报 not_sent（那会诱发重复派发）。
    $postDeadline = [DateTimeOffset]::UtcNow.AddMilliseconds(2400)
    $postComposerEmpty = $null
    $postUserTurnAdded = $null
    $postPhase = 'unknown'
    try {
        do {
            $postScan = Get-AguiaTargetTree -Provider $Provider -Hwnd $targetSpec.hwnd -NormalizedUri $targetSpec.uri -Attempts 1 -DelayMs 0
            if ($postScan.documentIndex -lt 0) {
                # Invoke 之后根树/文档读不到也是结果不明，不得谎报“composer 未清空”。
                throw 'post_invoke_target_tree_lost'
            }
            $postSnapshot = Get-AguiaSnapshot -Nodes $postScan.tree.nodes -TargetSpec $targetSpec -Baseline (Get-FieldValue $Request 'baseline')
            $postComposerEmpty = $postSnapshot.composer.empty
            $postPhase = $postSnapshot.phase
            if ($null -ne $postSnapshot.userTurnCount) {
                $baselineInfo = Get-AguiaBaselineInfo -Baseline (Get-FieldValue $Request 'baseline') -Now ([DateTimeOffset]::UtcNow)
                if ($null -ne $baselineInfo.userTurnCount) {
                    $postUserTurnAdded = ($postSnapshot.userTurnCount -gt $baselineInfo.userTurnCount)
                }
            }
            if ($postComposerEmpty -eq $true -or $postUserTurnAdded -eq $true) { break }
            Start-Sleep -Milliseconds 300
        } while ([DateTimeOffset]::UtcNow -lt $postDeadline)
    } catch {
        $postError = Get-AguiaErrorInfo -ErrorRecord $_
        $result.status = 'acceptance_unknown'
        $result.reason = 'post_invoke_observation_failed'
        $result.code = $postError.code
        $result.detail = $postError.message
        $result.invokeAttempted = $true
        if ($result.invokeCount -lt 1) { $result.invokeCount = 1 }
        $result.observed = [ordered]@{
            composerEmpty = $postComposerEmpty
            newUserTurn   = $postUserTurnAdded
            phase         = $postPhase
            error         = $postError.message
            note          = 'Invoke 已发出；后置观察失败，受理与完成均无法确认，禁止自动重发。'
        }
        return $result
    }

    $result.observed = [ordered]@{
        composerEmpty   = $postComposerEmpty
        newUserTurn     = $postUserTurnAdded
        phase           = $postPhase
        note            = 'Invoke 返回仅代表控件动作已发出，不代表 Antigravity 已受理或本轮已完成。'
    }
    if ($postComposerEmpty -eq $true -or $postUserTurnAdded -eq $true) {
        $result.status = 'invoked'
        $result.reason = $null
    } else {
        $result.status = 'acceptance_unknown'
        $result.reason = 'composer_not_cleared'
        $result.code = 'composer_not_cleared'
    }
    return $result
}

# ============================================================================
# 8. 入口：解析请求、inspect / dispatch、错误封装
# ============================================================================

function Invoke-AguiaProbeWindow {
    param($Provider, $Request)
    $rawTarget = Get-FieldValue $Request 'target'
    if ($null -eq $rawTarget) { $rawTarget = $Request }
    $rawPid = Get-FieldValue $rawTarget 'pid'
    $processId = 0
    if ($null -eq $rawPid -or -not [int]::TryParse([string]$rawPid, [ref]$processId) -or $processId -le 0) {
        Throw-Aguia 'bad_request' 'pid 必须是正整数' @{ field = 'pid' }
    }
    $hwnd = ConvertTo-AguiaHwnd (Get-FieldValue $rawTarget 'hwnd')
    if ($null -eq $hwnd) {
        Throw-Aguia 'bad_request' 'hwnd 必须是正整数或 0x 十六进制字符串' @{ field = 'hwnd' }
    }
    $startedRaw = ConvertTo-AguiaIsoText (Get-FieldValue $rawTarget 'startedAt')
    $started = [DateTimeOffset]::MinValue
    $style = [System.Globalization.DateTimeStyles]::RoundtripKind
    $culture = [System.Globalization.CultureInfo]::InvariantCulture
    if ([string]::IsNullOrWhiteSpace($startedRaw) -or -not [DateTimeOffset]::TryParse($startedRaw, $culture, $style, [ref]$started)) {
        Throw-Aguia 'bad_request' 'startedAt 必须是带时区的 ISO-8601 时间' @{ field = 'startedAt' }
    }
    $probeSpec = [ordered]@{
        pid       = $processId
        hwnd      = [long]$hwnd
        hwndHex   = ('0x{0:X}' -f $hwnd)
        startedAt = $started.ToUniversalTime().ToString('o')
    }

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $foregroundBefore = & $Provider.foreground
    $proc = Test-AguiaProcessIdentity -Provider $Provider -TargetSpec $probeSpec
    $window = Test-AguiaWindowIdentity -Provider $Provider -TargetSpec $probeSpec
    $tree = Get-UiaTree -Provider $Provider -Hwnd $probeSpec.hwnd
    $uris = @(Get-AguiaHttpDocumentUris -Nodes $tree.nodes)
    if ($uris.Count -eq 0) {
        Throw-Aguia 'uri_mismatch' '窗口内未找到 http(s) Document URI' @{ field = 'uri'; documentUriCount = 0 }
    }
    if ($uris.Count -gt 1) {
        Throw-Aguia 'uri_mismatch' '窗口内存在多个 http(s) Document URI，无法唯一确定' @{ field = 'uri'; documentUriCount = $uris.Count }
    }
    $docUri = [string]$uris[0]
    $linkResult = Find-AguiaSessionLink -Nodes $tree.nodes -NormalizedUri $docUri -Scope 'sidebar'
    $linkEvidence = 'sidebar'
    $links = @($linkResult.indexes)
    if ($links.Count -eq 0) {
        $linkResult = Find-AguiaSessionLink -Nodes $tree.nodes -NormalizedUri $docUri -Scope 'window'
        $linkEvidence = 'window'
        $links = @($linkResult.indexes)
    }
    if ($links.Count -eq 0) {
        Throw-Aguia 'session_link_not_found' '未找到指向 Document URI 的可见会话链接' @{ field = 'sessionLink'; documentUriCount = 1 }
    }
    if ($links.Count -gt 1) {
        Throw-Aguia 'session_link_ambiguous' '存在多个指向 Document URI 的可见会话链接' @{ field = 'sessionLink'; count = $links.Count; documentUriCount = 1 }
    }
    $foregroundAfter = & $Provider.foreground
    $stopwatch.Stop()

    $fullSpec = [ordered]@{
        pid       = $probeSpec.pid
        startedAt = $probeSpec.startedAt
        hwnd      = $probeSpec.hwnd
        uri       = $docUri
    }
    $targetKey = Get-AguiaTargetKey -TargetSpec $fullSpec
    [ordered]@{
        ok            = $true
        action        = 'probe_window'
        driverVersion = $script:AguiaDriverVersion
        targetKey     = $targetKey
        target        = [ordered]@{
            pid       = $probeSpec.pid
            startedAt = $probeSpec.startedAt
            hwnd      = $probeSpec.hwndHex
            uri       = $docUri
        }
        verified      = [ordered]@{
            process      = $true
            startTime    = $true
            executable   = $true
            window       = $true
            documentUri  = $true
            sessionLink  = 'unique'
            linkEvidence = $linkEvidence
        }
        diagnostics   = [ordered]@{
            documentUriCount = $uris.Count
            elapsedMs        = $stopwatch.ElapsedMilliseconds
            foreground       = [ordered]@{
                before  = ('0x{0:X}' -f [long]$foregroundBefore)
                after   = ('0x{0:X}' -f [long]$foregroundAfter)
                changed = ([long]$foregroundBefore -ne [long]$foregroundAfter)
            }
        }
    }
}

function Invoke-AguiaInspect {
    param($Provider, $Request)
    $target = Get-FieldValue $Request 'target'
    if ($null -eq $target) {
        $candidates = @(& $Provider.candidates $Provider)
        return [ordered]@{
            ok            = $true
            action        = 'inspect'
            driverVersion = $script:AguiaDriverVersion
            candidates    = $candidates
            count         = $candidates.Count
            note          = '未提供 target：仅列出候选窗口身份（pid/startedAt/hwnd/exe/window 标志），不读取会话标题、正文或 URI。'
        }
    }
    $targetSpec = ConvertTo-AguiaTargetSpec -Target $target -Action 'inspect'
    # 只读观察不得有焦点副作用：比较观察前后的前台窗口句柄（不修改、不激活）。
    $foregroundBefore = & $Provider.foreground
    $view = Get-AguiaTargetView -Provider $Provider -TargetSpec $targetSpec
    $snapshot = Get-AguiaSnapshot -Nodes $view.nodes -TargetSpec $targetSpec -Baseline (Get-FieldValue $Request 'baseline')
    $foregroundAfter = & $Provider.foreground
    [ordered]@{
        ok            = $true
        action        = 'inspect'
        driverVersion = $script:AguiaDriverVersion
        targetKey     = $view.targetKey
        target        = [ordered]@{
            pid       = $targetSpec.pid
            startedAt = $targetSpec.startedAt
            hwnd      = $targetSpec.hwndHex
            uri       = $targetSpec.uri
        }
        verified      = [ordered]@{
            process     = $true
            startTime   = $true
            executable  = $true
            window      = $true
            documentUri = $true
            sessionLink = 'unique'
            linkEvidence = $view.linkEvidence
        }
        snapshot      = $snapshot
        diagnostics   = [ordered]@{
            nodeCount    = $view.diagnostics.nodeCount
            scanAttempts = $view.diagnostics.scanAttempts
            truncated    = $view.diagnostics.truncated
            elapsedMs    = $view.diagnostics.elapsedMs
            window       = [ordered]@{
                minimized = [bool]$view.window.minimized
                visible   = [bool]$view.window.visible
                cloaked   = [int]$view.window.cloaked
            }
            focus        = [ordered]@{
                before  = ('0x{0:X}' -f [long]$foregroundBefore)
                after   = ('0x{0:X}' -f [long]$foregroundAfter)
                changed = ([long]$foregroundBefore -ne [long]$foregroundAfter)
            }
        }
    }
}

function Invoke-AguiaDriver {
    param([string]$InputJson, $Provider = $null)
    $action = 'unknown'
    # 每次调用都从“尚未写入”开始：进程内多次调用时，上一次 dispatch 的边界
    # 不得让本次 bad_request 误报成“Invoke 已发出”。
    $script:AguiaDispatchBoundary = 'none'
    try {
        if ([string]::IsNullOrWhiteSpace($InputJson)) {
            Throw-Aguia 'bad_json' 'stdin 为空：需要一个 JSON 对象'
        }
        $request = $null
        try {
            $request = $InputJson | ConvertFrom-Json -AsHashtable -ErrorAction Stop
        } catch {
            Throw-Aguia 'bad_json' ('stdin 不是合法 JSON 对象: ' + $_.Exception.Message)
        }
        if ($null -eq $request -or $request -isnot [System.Collections.IDictionary]) {
            Throw-Aguia 'bad_json' 'stdin JSON 必须是对象'
        }
        $action = [string](Get-FieldValue $request 'action')
        if ([string]::IsNullOrWhiteSpace($action)) {
            Throw-Aguia 'bad_request' "缺少 action（'inspect'、'dispatch' 或 'probe_window'）"
        }
        if ($action -notin @('inspect', 'dispatch', 'probe_window')) {
            Throw-Aguia 'bad_request' ("不支持的 action: " + $action)
        }
        $activeProvider = $Provider
        if ($null -eq $activeProvider) {
            $activeProvider = New-RealUiaProvider
        }
        if ($action -eq 'inspect') {
            return Invoke-AguiaInspect -Provider $activeProvider -Request $request
        }
        if ($action -eq 'probe_window') {
            return Invoke-AguiaProbeWindow -Provider $activeProvider -Request $request
        }
        $out = Invoke-AguiaDispatch -Provider $activeProvider -Request $request
        if ($activeProvider.kind -eq 'fake' -and $null -ne $script:AguiaFakeState) {
            if ($null -eq $out.diagnostics) { $out.diagnostics = [ordered]@{} }
            $out.diagnostics['fakeWrites'] = @($script:AguiaFakeState.writes)
            $out.diagnostics['fakeKeyCalls'] = [int]$script:AguiaFakeState.keyCalls
            $out.diagnostics['fakeInvokes'] = [int]$script:AguiaFakeState.invokes
            $out.diagnostics['fakeClickFocusCalls'] = [int]$script:AguiaFakeState.clickFocusCalls
            $out.diagnostics['fakeFreshScans'] = [int]$script:AguiaFakeState.freshScans
        }
        return $out
    } catch {
        $info = Get-AguiaErrorInfo -ErrorRecord $_
        $errorResult = [ordered]@{
            ok            = $false
            action        = $action
            driverVersion = $script:AguiaDriverVersion
            code          = $info.code
            message       = $info.message
            detail        = $info.detail
        }
        if ($action -eq 'dispatch') {
            # 异常出口必须继承提交边界：写入或 Invoke 已经开始时，绝不能谎报 not_sent。
            $boundary = [string]$script:AguiaDispatchBoundary
            $invokeStarted = ($boundary -eq 'invoking' -or $boundary -eq 'invoked')
            $writeStarted = ($boundary -eq 'writing' -or $boundary -eq 'written' -or $invokeStarted)
            $errorResult.status = if ($invokeStarted) { 'acceptance_unknown' } else { 'not_sent' }
            $errorResult.reason = if ($invokeStarted) { 'post_invoke_error' } else { $info.code }
            $errorResult.invokeAttempted = $invokeStarted
            $errorResult.invokeCount = if ($invokeStarted) { 1 } else { 0 }
            $errorResult.diagnostics = [ordered]@{
                dispatchBoundary = $boundary
                writeAttempted   = $writeStarted
                error            = $info.message
            }
        }
        return $errorResult
    }
}

# ============================================================================
# 9. 主入口（-ImportOnly 时跳过）
# ============================================================================

if (-not $ImportOnly) {
    try {
        [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
        [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    } catch { }
    $rawInput = ''
    try {
        $rawInput = [Console]::In.ReadToEnd()
    } catch {
        $rawInput = ''
    }
    $provider = $null
    $scenarioPath = $env:AGUIA_FAKE_SCENARIO
    if (-not [string]::IsNullOrWhiteSpace($scenarioPath)) {
        try {
            $scenario = Get-Content -LiteralPath $scenarioPath -Raw -ErrorAction Stop | ConvertFrom-Json -AsHashtable
            $provider = New-FakeUiaProvider -Scenario $scenario
        } catch {
            $provider = $null
            $fatal = [ordered]@{
                ok            = $false
                action        = 'unknown'
                driverVersion = $script:AguiaDriverVersion
                code          = 'fake_scenario_invalid'
                message       = ('测试替身场景文件不可用: ' + $_.Exception.Message)
            }
            [Console]::Out.Write(($fatal | ConvertTo-Json -Compress -Depth 24))
            exit 0
        }
    }
    $result = Invoke-AguiaDriver -InputJson $rawInput -Provider $provider
    $json = $result | ConvertTo-Json -Compress -Depth 24
    [Console]::Out.Write($json)
    [Console]::Out.Flush()
}









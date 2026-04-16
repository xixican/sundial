# Sundial — Design Document

> 项目整体实现流程与技术原理

## 1. 概述

Sundial 是一个基于 Electron 的桌面工具，核心功能是：**选中屏幕上的时间戳文本 → 按快捷键 → 在光标旁弹窗显示可读时间**。

整个应用运行在系统托盘，无主窗口，体积极轻。

## 2. 架构总览

```
┌─────────────────────────────────────────────────────────┐
│                    Electron Main Process                │
│                        (main.js)                        │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────────┐│
│  │   Tray   │  │ Global   │  │  Persistent PowerShell ││
│  │  Icon    │  │ Shortcut │  │  (Windows only)        ││
│  └────┬─────┘  └────┬─────┘  └───────────┬────────────┘│
│       │              │                    │             │
│       │         onHotkeyPressed()         │             │
│       │              │                    │             │
│       │              ▼                    │             │
│       │      simulateCopy() ──────────────┘             │
│       │              │                                  │
│       │              ▼                                  │
│       │     clipboard.readText()                        │
│       │              │                                  │
│       │              ▼                                  │
│       │     parseTimestamp()  ◄── timestamp-parser.js   │
│       │              │                                  │
│       │              ▼                                  │
│       │        showPopup()                              │
│       │              │                                  │
│  ┌────┴──────────────┴──────────────────────────┐       │
│  │           BrowserWindow Pool                 │       │
│  │                                              │       │
│  │  ┌─────────────┐  ┌─────────────┐           │       │
│  │  │ singlePopup │  │ multiPopup  │           │       │
│  │  │ (popup.html)│  │ (popup.html)│           │       │
│  │  └─────────────┘  └─────────────┘           │       │
│  │  ┌─────────────┐  ┌─────────────┐           │       │
│  │  │ trayMenuWin │  │ settingsWin │           │       │
│  │  │(tray-menu)  │  │(settings)   │           │       │
│  │  └─────────────┘  └─────────────┘           │       │
│  │  ┌─────────────┐  ┌─────────────┐           │       │
│  │  │  helpWin    │  │ keepAliveWin│           │       │
│  │  │ (help.html) │  │ (hidden)    │           │       │
│  │  └─────────────┘  └─────────────┘           │       │
│  └──────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────┘
```

## 3. 核心流程

### 3.1 热键触发 → 时间戳转换（主流程）

```
用户选中时间戳文字
        │
        ▼
  按下 F9（全局热键）
        │
        ▼
  onHotkeyPressed()
        │
        ├─ 1. 保存当前剪贴板内容（savedClip）
        ├─ 2. 记录当前鼠标位置（cursorPos）
        │
        ▼
  simulateCopy()
        │
        ├─ Windows: 通过常驻 PowerShell 发送 Ctrl+C
        │           $s = New-Object -ComObject WScript.Shell
        │           $s.SendKeys('^c')
        │
        └─ macOS:   通过 osascript 发送 Cmd+C
                    tell application "System Events" to keystroke "c" using command down
        │
        ▼
  轮询剪贴板变化（每 30ms，最长 400ms）
        │
        ▼
  clipboard.readText() → text
        │
        ▼
  parseTimestamp(text, tzOffset)
        │
        ├─ 正则提取 9~13 位数字: /(\d{9,13})/
        ├─ 判断秒（≤10位）或毫秒（11~13位）
        ├─ 转为 Date 对象
        ├─ 按目标时区偏移格式化
        └─ 返回 { datetime, original, type, tzLabel, ... }
        │
        ▼
  showPopup(result, cursorPos.x, cursorPos.y)
        │
        ├─ Single 模式: 显示 singlePopupWin
        └─ Multi 模式:  显示 multiPopupWin，追加记录
        │
        ▼
  500ms 后恢复原始剪贴板内容
```

### 3.2 时间戳解析引擎 (timestamp-parser.js)

```javascript
输入: "log: ts=1713153600123 end"
                    │
                    ▼
         正则匹配: /(\d{9,13})/
         提取: "1713153600123"
                    │
                    ▼
         parseInt → 1713153600123
                    │
                    ▼
         阈值判断:
         ├─ > 10^13  → 无效，返回 null
         ├─ > 10^10  → 毫秒级 (isMs=true)
         └─ > 0      → 秒级 (isMs=false, ×1000)
                    │
                    ▼
         new Date(tsMs) → 有效性校验（1970~2100）
                    │
                    ▼
         formatWithTimezone():
         ├─ 目标时区偏移: tzOffset × 3600000
         ├─ 本地化日期: new Date(utc + tzMs + localOffset)
         ├─ 格式化: YYYY-MM-DD HH:mm:ss[.SSS]
         │                              ↑ 仅 isMs 时追加
         └─ 返回: { datetime, date, time, iso, unix, unixMs, type, tzLabel }
```

### 3.3 剪贴板模拟复制（关键性能优化）

Windows 上模拟 Ctrl+C 是这个工具的性能瓶颈。

#### 问题

每次热键触发都启动一个新 PowerShell 进程来执行 `SendKeys('^c')`，进程启动开销约 **400ms**，严重影响体验。

#### 解决方案：常驻 PowerShell 进程

```
应用启动
    │
    ▼
startPowerShell()
    │
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive',
                             '-NoLogo', '-NoExit', '-Command', '-'])
    │
    ▼
psProc (stdin/stdout 管道保持开启)
    │
    │  ◄── 每次热键触发时 ──►
    │
    ▼
psProc.stdin.write(
  "$s = New-Object -ComObject WScript.Shell; $s.SendKeys('^c')\n"
)
    │
    ▼
响应时间: ~5ms（vs 之前的 ~400ms）
```

- 进程异常退出时自动重启（2秒延迟）
- 应用退出时 `psProc.kill()` 清理

#### macOS 路径

macOS 使用 `osascript` 命令，每次启动开销很小（~50ms），不需要常驻进程。

## 4. 窗口管理策略

### 4.1 预创建 + 隐藏/显示（核心设计）

Electron 创建 BrowserWindow 的开销约 100~300ms，如果每次都 `new BrowserWindow()` → `loadFile()` → `show()`，用户会感到明显延迟。

**Sundial 的策略：应用启动时预创建所有窗口（隐藏状态），需要时只做 show/hide。**

```
app.whenReady()
    │
    ├─ createTrayMenuWin()    → trayMenuWin  (hidden, x=-9999)
    ├─ createSettingsWin()    → settingsWin  (hidden)
    │
    │  首次热键触发时:
    ├─ ensureSinglePopup()    → singlePopupWin (hidden, x=-9999)
    └─ ensureMultiPopup()     → multiPopupWin  (hidden, x=-9999)
```

窗口创建后通过 IPC 发送数据刷新内容，位置通过 `setPosition()` 调整后 `show()`。

### 4.2 Popup 双窗口架构

Single 和 Multi 模式使用 **两个独立的 BrowserWindow**，共享同一个 `popup.html`：

```
                    popup.html
                        │
            ┌───────────┴───────────┐
            │                       │
     singlePopupWin          multiPopupWin
     250×116 固定大小         320×动态高度
            │                       │
     init-mode:{              init-mode:{
       mode:'single',           mode:'multi',
       data: result             data: result,
     }                          maxRecords: 5
                                }
```

**为什么不用一个窗口？**

Electron 的 `resizable: false` BrowserWindow 有个已知 bug：`setSize()` 只能增大不能缩小。Multi 模式删除记录需要缩小窗口，所以必须销毁重建（`recreateMultiAtSize()`）。

### 4.3 窗口尺寸计算

Multi 模式的高度公式：

```
height = MULTI_BASE_H + min(recordCount, MULTI_MAX_VISIBLE) × MULTI_ROW_H

其中:
  MULTI_BASE_H   = 72px   (drag-bar:6 + header:30 + footer:24 + padding:12)
  MULTI_ROW_H    = 44px   (每条记录的高度)
  MULTI_MAX_VISIBLE = 5   (超过 5 条启用滚动)
```

### 4.4 Settings 面板的向上扩展

Settings 面板开启 Multi 选项时内容变长，面板需要增大。为了不遮挡屏幕底部内容，采用**保持底边固定、向上扩展**的策略：

```
settings-resize IPC:
    newY = oldY - (newH - oldH)    // 底边不动，顶部上移
    clamp: newY >= workArea.y      // 不超出屏幕上边界
    setBounds({ x, newY, w, newH })  // 一次性更新，避免闪烁
```

## 5. IPC 通信

### 5.1 通道一览

| 通道 | 方向 | 用途 |
|------|------|------|
| `get-settings` | Renderer → Main (handle) | 获取当前设置（含版本号、时区列表） |
| `save-settings` | Renderer → Main | 保存设置 |
| `settings-saved` | Main → Renderer | 保存结果回调（含 hotkey 冲突降级信息） |
| `settings-resize` | Renderer → Main | Settings 面板请求调整高度 |
| `refresh-settings` | Main → Renderer | 通知 Settings 重新加载数据 |
| `close-settings` | Renderer → Main | 关闭 Settings |
| `init-mode` | Main → Renderer | 初始化 popup 窗口（模式 + 数据） |
| `append-record` | Main → Renderer | Multi 模式追加一条记录 |
| `restore-records` | Main → Renderer | Multi 窗口重建后恢复 |
| `popup-resize` | Renderer → Main | Multi popup 请求调整高度 |
| `popup-mode-changed` | Renderer → Main | 用户切换 Single/Multi |
| `close-popup` | Renderer → Main | 关闭 popup |
| `tray-settings` | Renderer → Main | 托盘菜单点"Settings" |
| `tray-help` | Renderer → Main | 托盘菜单点"Help" |
| `tray-quit` | Renderer → Main | 托盘菜单点"Quit" |
| `tray-close` | Renderer → Main | 关闭托盘菜单 |
| `tray-change-timezone` | Renderer → Main | 托盘快速切换时区 |
| `tray-menu-resize` | Renderer → Main | 时区下拉展开时调整菜单高度 |
| `refresh-info` | Main → Renderer | 通知托盘菜单刷新信息 |
| `close-help` | Renderer → Main | 关闭帮助窗口 |
| `set-max-records` | Main → Renderer | 更新最大记录数 |

### 5.2 数据流向图

```
       Main Process                     Renderer (popup.html)
       ────────────                     ─────────────────────
            │                                    │
  onHotkeyPressed()                              │
            │                                    │
  parseTimestamp() ──►  result                   │
            │                                    │
            ├──── init-mode {mode, data} ───────►│
            │                                    │ renderSingle(data)
            │                                    │  or addRecord(data)
            │                                    │
            │◄──── popup-resize {w, h} ─────────┤
            │                                    │
  setSize() / recreateMultiAtSize()              │
            │                                    │
            │◄──── popup-mode-changed ──────────┤
            │                                    │
  hide old → show new                            │
            │                                    │
            │◄──── close-popup ─────────────────┤
            │                                    │
  hide both popups                               │
```

## 6. 热键注册与降级

```
registerHotkey(requestedKey)
        │
        ▼
  globalShortcut.unregisterAll()
        │
        ▼
  尝试注册 requestedKey
        │
    ┌───┴───┐
   成功     失败
    │        │
    │        ▼
    │   遍历候选列表: ['Ctrl+Shift+T', 'F9', 'F8', 'F7']
    │        │
    │        ├─ 跳过已失败的 key
    │        ├─ 尝试注册每个候选
    │        └─ 第一个成功的作为 fallback
    │        │
    │   ┌────┴────┐
    │  成功       全部失败
    │   │            │
    ▼   ▼            ▼
  返回 {ok, key,   返回 {ok: false}
        fallback}
```

Settings 页面会展示降级结果（如 "F9 is in use, switched to F8"）。

## 7. 鼠标追踪与自动关闭（Single 模式）

Single 模式的 popup 有两种关闭机制：

```
popup 显示
    │
    ├─ 启动 autoTimer: 6秒后自动关闭
    │
    └─ 启动 mousePoller (每 150ms 检测):
           │
           ├─ 前 500ms: 宽限期，不检测
           │
           └─ 之后:
                │
                ├─ 鼠标在 popup 区域内（含 15px margin）
                │   └─ 清除 leaveTimer
                │
                └─ 鼠标在 popup 区域外
                    └─ 启动 leaveTimer: 500ms 后关闭
```

Multi 模式没有自动关闭，只能点 ✕ 或按 Esc。

## 8. 单实例保护

```javascript
if (!app.requestSingleInstanceLock()) {
  app.quit();  // 第二个实例直接退出
} else {
  app.on('second-instance', () => {
    // 如果有可见的 popup，聚焦它
    var win = getActivePopup();
    if (win) win.show();
  });
}
```

## 9. Keep-Alive 窗口

Electron 默认行为：当所有窗口关闭时退出应用。Sundial 的所有窗口都是隐藏的，所以需要一个隐藏的 keep-alive 窗口阻止应用退出：

```javascript
keepAliveWin = new BrowserWindow({ show: false });
keepAliveWin.loadURL('about:blank');
keepAliveWin.on('close', (e) => { if (!isQuitting) e.preventDefault(); });
```

配合 `window-all-closed` 事件拦截：
```javascript
app.on('window-all-closed', (e) => { e.preventDefault(); });
```

## 10. 应用生命周期

```
app.whenReady()
    │
    ├─ createKeepalive()       // 隐藏窗口防止退出
    ├─ startPowerShell()       // 常驻 PS 进程 (Win only)
    ├─ registerHotkey()        // 注册全局快捷键
    ├─ createTray()            // 创建系统托盘图标
    ├─ createTrayMenuWin()     // 预创建托盘菜单窗口
    └─ createSettingsWin()     // 预创建设置窗口
        │
        ▼
    [应用运行中 — 等待热键 / 托盘交互]
        │
        ▼
    doQuit() (用户点击 Quit)
        │
        ├─ isQuitting = true
        ├─ unregisterHotkey()
        ├─ psProc.kill()
        ├─ 销毁所有窗口
        └─ app.quit()
```

## 11. UI 设计规范

| 属性 | 值 |
|------|-----|
| 主题色 | `#2ecc71` (Emerald Green) |
| 背景色 | `#0e0e12` / `#0c0c10` (Near Black) |
| 字体 | `-apple-system, 'Segoe UI', sans-serif` |
| 等宽字体 | `'SF Mono', Consolas, monospace` |
| 边框 | `1px solid rgba(255,255,255,.08)` |
| 阴影 | 原生窗口阴影 (`hasShadow: true`) |
| 动画 | 淡入 + 缩放 (`scale(.94) → scale(1)`, 140~200ms) |

## 12. 构建配置

```json
{
  "build": {
    "appId": "com.sundial.timestamp",
    "productName": "Sundial",
    "win": {
      "target": ["nsis", "portable"]
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "perMachine": false,
      "installerLanguages": ["zh_CN", "en_US"],
      "language": "2052"
    },
    "mac": {
      "target": ["dmg", "zip"]
    }
  }
}
```

Windows 产物：
- `Sundial Setup 1.0.0.exe` — NSIS 安装包（支持自定义安装路径）
- `Sundial 1.0.0.exe` — 便携版（单文件直接运行）

## 13. 已知限制与设计权衡

| 决策 | 原因 |
|------|------|
| **不使用圆角窗口** | Windows Electron `transparent:true` 存在 DWM 渲染问题（灰色遮罩、边角异常），多轮尝试后放弃，改用实底矩形窗口 |
| **Multi 缩小时重建窗口** | Electron `resizable:false` 的 `setSize()` 无法缩小窗口（已知 bug），只能销毁重建 |
| **常驻 PowerShell** | 每次新建 PS 进程开销 ~400ms 不可接受，常驻后降至 ~5ms |
| **剪贴板轮询而非固定等待** | SendKeys 到剪贴板更新的延迟不固定，轮询（30ms 间隔）比固定 300ms 等待更快更可靠 |
| **预创建窗口池** | 避免每次显示时的 100~300ms 窗口创建开销 |
| **keep-alive 隐藏窗口** | Electron 需要至少一个窗口存在来保持进程运行 |

---

*Last updated: 2026-04-16*

const { app, clipboard, BrowserWindow, Tray, nativeImage, screen, globalShortcut, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { parseTimestamp } = require('./timestamp-parser');

// Single source of truth for version
var APP_VERSION = require('../package.json').version;

// --- State ---
var tray = null;
var keepAliveWin = null;
var settingsWin = null;
var trayMenuWin = null;
var isQuitting = false;
var psProc = null; // Persistent PowerShell process

// --- Settings ---
var settings = {
  hotkey: 'F9',
  timezone: 'Asia/Shanghai',
  multiMode: false,
  maxRecords: 5
};

// Timezone offset map
var TIMEZONE_MAP = {
  'UTC':             { offset: 0,   label: 'UTC' },
  'Europe/London':   { offset: 0,   label: 'London (UTC+0/UTC+1)' },
  'Europe/Berlin':   { offset: 1,   label: 'Berlin (UTC+1/UTC+2)' },
  'Europe/Moscow':   { offset: 3,   label: 'Moscow (UTC+3)' },
  'Asia/Dubai':      { offset: 4,   label: 'Dubai (UTC+4)' },
  'Asia/Kolkata':    { offset: 5.5, label: 'Mumbai (UTC+5:30)' },
  'Asia/Bangkok':    { offset: 7,   label: 'Bangkok (UTC+7)' },
  'Asia/Shanghai':   { offset: 8,   label: 'Beijing (UTC+8)' },
  'Asia/Hong_Kong':  { offset: 8,   label: 'Hong Kong (UTC+8)' },
  'Asia/Singapore':  { offset: 8,   label: 'Singapore (UTC+8)' },
  'Asia/Tokyo':      { offset: 9,   label: 'Tokyo (UTC+9)' },
  'Asia/Seoul':      { offset: 9,   label: 'Seoul (UTC+9)' },
  'Australia/Sydney':{ offset: 10,  label: 'Sydney (UTC+10/UTC+11)' },
  'Pacific/Auckland':{ offset: 12,  label: 'Auckland (UTC+12/UTC+13)' },
  'America/Los_Angeles':{ offset: -8, label: 'Los Angeles (UTC-8/UTC-7)' },
  'America/Chicago':    { offset: -6, label: 'Chicago (UTC-6/UTC-5)' },
  'America/New_York':   { offset: -5, label: 'New York (UTC-5/UTC-4)' },
  'America/Sao_Paulo':  { offset: -3, label: 'Sao Paulo (UTC-3)' },
};

var HOTKEY_OPTIONS = ['F7', 'F8', 'F9', 'Ctrl+Shift+T'];

function getTzOffset() {
  var tz = TIMEZONE_MAP[settings.timezone];
  return tz ? tz.offset : 8;
}

function log(m) { console.log('[sundial] ' + m); }

// --- Single Instance ---
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    var win = getActivePopup();
    if (win) win.show();
  });
}

// ===================== PERSISTENT POWERSHELL (key optimization!) =====================
// Instead of launching a new PowerShell process on every hotkey press (~400ms),
// we keep one running and pipe commands to it (~5ms per command).

function startPowerShell() {
  if (process.platform !== 'win32') return; // macOS uses osascript

  log('starting persistent PowerShell...');
  psProc = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-NoLogo', '-NoExit', '-Command', '-'
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  psProc.stdin.setEncoding('utf8');

  psProc.on('error', function(err) {
    log('PowerShell error: ' + err.message);
    psProc = null;
  });

  psProc.on('exit', function(code) {
    log('PowerShell exited with code ' + code);
    psProc = null;
    // Auto-restart after 2s
    if (!isQuitting) {
      setTimeout(startPowerShell, 2000);
    }
  });

  log('PowerShell ready (persistent)');
}

// Send Ctrl+C via the persistent PowerShell process
function simulateCopy(callback) {
  if (process.platform === 'darwin') {
    // macOS: use osascript (fast enough, no persistence needed)
    var osa = spawn('osascript', ['-e', 'tell application "System Events" to keystroke "c" using command down']);
    osa.on('close', function() { setTimeout(callback, 120); });
    return;
  }

  // Windows: send command to persistent PowerShell
  if (!psProc || psProc.exitCode !== null) {
    // PowerShell not running, start it and retry
    log('PowerShell not ready, starting...');
    startPowerShell();
    setTimeout(function() { simulateCopy(callback); }, 1000);
    return;
  }

  // Send the Ctrl+C keystroke command
  try {
    // Use a unique marker so we know when the command completed
    var marker = '__SUNDIAL_DONE_' + Date.now() + '__';
    psProc.stdin.write('$s = New-Object -ComObject WScript.Shell; $s.SendKeys(\'^c\'); Write-Output \'' + marker + '\'\n');
  } catch(e) {
    log('PowerShell write error: ' + e.message);
    // Fallback: wait and try callback anyway
    setTimeout(callback, 300);
  }

  // Poll clipboard for changes (faster than fixed wait)
  var savedClip = '';
  try { savedClip = clipboard.readText() || ''; } catch(e) {}
  var startTime = Date.now();
  var maxWait = 400; // max 400ms

  var pollInterval = setInterval(function() {
    var currentClip = '';
    try { currentClip = clipboard.readText() || ''; } catch(e) {}

    if (currentClip !== savedClip || Date.now() - startTime > maxWait) {
      clearInterval(pollInterval);
      callback();
    }
  }, 30); // Poll every 30ms
}

// ===================== HOTKEY =====================
// Candidate keys in priority order for auto-selection
var HOTKEY_CANDIDATES = ['Ctrl+Shift+T', 'F9', 'F8', 'F7'];

function registerHotkey(requestedKey) {
  try { globalShortcut.unregisterAll(); } catch(e) {}

  var key = requestedKey || settings.hotkey || 'F9';
  var ok = false;
  try { ok = globalShortcut.register(key, function() { onHotkeyPressed(); }); } catch(e) { log('HOTKEY register error: ' + e.message); }

  if (ok) {
    settings.hotkey = key;
    log('HOTKEY OK: ' + key);
    return { ok: true, key: key, fallback: false };
  }

  log('HOTKEY FAIL: ' + key + ', trying candidates...');

  // Try each candidate until one works
  for (var i = 0; i < HOTKEY_CANDIDATES.length; i++) {
    var candidate = HOTKEY_CANDIDATES[i];
    if (candidate === key) continue; // already tried
    try {
      ok = globalShortcut.register(candidate, function() { onHotkeyPressed(); });
      if (ok) {
        settings.hotkey = candidate;
        log('HOTKEY fallback: ' + candidate);
        return { ok: true, key: candidate, fallback: true, requested: key };
      }
    } catch(e) { log('HOTKEY candidate ' + candidate + ' failed: ' + e.message); }
  }

  log('HOTKEY: all candidates failed!');
  return { ok: false, key: key };
}

function unregisterHotkey() {
  try { globalShortcut.unregisterAll(); } catch(e) {}
}

function onHotkeyPressed() {
  var t0 = Date.now();
  log('HOTKEY pressed');

  // Save current clipboard & cursor position upfront (avoid delay in callback)
  var savedClip = '';
  try { savedClip = clipboard.readText() || ''; } catch(e) {}
  var cursorPos = screen.getCursorScreenPoint();

  simulateCopy(function() {
    var t1 = Date.now();
    var text = '';
    try { text = (clipboard.readText() || '').trim(); } catch(e) {}

    if (!text) {
      log('no text in clipboard (' + (t1 - t0) + 'ms)');
      if (savedClip) { try { clipboard.writeText(savedClip); } catch(e) {} }
      return;
    }

    log('clip="' + text.substring(0, 40) + '" (' + (t1 - t0) + 'ms)');

    var tzOffset = getTzOffset();
    var result = parseTimestamp(text, tzOffset);
    if (!result) {
      log('not a timestamp');
      if (savedClip) {
        try { clipboard.writeText(savedClip); } catch(e) {}
      }
      return;
    }

    var tzInfo = TIMEZONE_MAP[settings.timezone];
    result.timezone = settings.timezone;
    result.tzLabel = tzInfo ? tzInfo.label : 'UTC+' + tzOffset;

    var t2 = Date.now();
    log('PARSE OK: ' + result.datetime + ' ' + result.tzLabel + ' (parse ' + (t2 - t1) + 'ms, total ' + (t2 - t0) + 'ms)');

    showPopup(result, cursorPos.x, cursorPos.y);

    var t3 = Date.now();
    log('popup shown (render ' + (t3 - t2) + 'ms, TOTAL ' + (t3 - t0) + 'ms)');

    // Auto-restore clipboard
    if (savedClip) {
      setTimeout(function() {
        try { clipboard.writeText(savedClip); } catch(e) {}
      }, 500);
    }
  });
}

// ===================== TRAY =====================
function createTray() {
  var iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  var icon = nativeImage.createFromPath(iconPath);
  if (!icon || icon.isEmpty()) {
    icon = nativeImage.createFromBuffer(
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABGElEQVQ4T6WTzUrDQBCGn7P+KELwZyMGdMkYiNjGxMJmZTQbCwsJqYWJgYGxkZGxkJCwsLc0MDAwODgwMjIyMjAyMjI+QX+BgaGhob+/38DAwPCfgYSFhb+//wwMDAf5AxMTEw8B8P//AwPDfwISExP//38DAwN/AhITE///f8DAw38CEhMT//9/wMDAfwITEz8B8P//AwMB/AgTPwHw//8DAwH/CBM/AfD//wMDAf8IEz8B8P//AwMB/wsTPAHw//8DAwH/CBM/AfD//wMBAP8IExAB8P//AwEA/wgREAHw//8DAQD/CCQAfP//AMBA/8IAAP//', 'base64')
    );
  }
  try { icon = icon.resize({ width: 16, height: 16 }); } catch(e) {}

  tray = new Tray(icon);
  tray.setToolTip('Sundial v' + APP_VERSION + ' - Select text, press ' + settings.hotkey);

  // Right-click only: show custom menu window
  tray.on('right-click', showTrayMenu);
}

var MENU_W = 220, MENU_H = 260;

// Pre-create the tray menu window (hidden) so right-click is instant
function createTrayMenuWin() {
  if (trayMenuWin && !trayMenuWin.isDestroyed()) return;

  trayMenuWin = new BrowserWindow({
    width: MENU_W, height: MENU_H, x: -9999, y: -9999,
    show: false,
    frame: false, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, hasShadow: true,
    focusable: true,
    backgroundColor: '#0e0e12',
    webPreferences: { contextIsolation: false, nodeIntegration: true }
  });

  trayMenuWin.loadFile(path.join(__dirname, 'tray-menu.html'));

  // Hide instead of destroy on blur (click outside)
  trayMenuWin.on('blur', function() {
    if (trayMenuWin && !trayMenuWin.isDestroyed()) trayMenuWin.hide();
  });

  trayMenuWin.on('closed', function() { trayMenuWin = null; });
}

function showTrayMenu() {
  // Ensure window exists
  if (!trayMenuWin || trayMenuWin.isDestroyed()) {
    createTrayMenuWin();
  }

  // Tell renderer to refresh displayed info
  if (trayMenuWin.webContents) {
    trayMenuWin.webContents.send('refresh-info');
  }

  var trayBounds = tray.getBounds();
  var display = screen.getPrimaryDisplay();
  var workArea = display.workArea;

  var mx = Math.round(trayBounds.x + trayBounds.width / 2 - MENU_W / 2);
  var my;
  if (trayBounds.y < workArea.height / 2) {
    my = trayBounds.y + trayBounds.height + 4;
  } else {
    my = trayBounds.y - MENU_H - 4;
  }
  mx = Math.max(workArea.x + 4, Math.min(mx, workArea.x + workArea.width - MENU_W - 4));
  my = Math.max(workArea.y + 4, Math.min(my, workArea.y + workArea.height - MENU_H - 4));

  trayMenuWin.setPosition(mx, my);
  trayMenuWin.show();
  trayMenuWin.focus();
}

function closeTrayMenu() {
  if (trayMenuWin && !trayMenuWin.isDestroyed()) {
    trayMenuWin.hide();
  }
}

// IPC handlers for tray menu actions
ipcMain.on('tray-settings', function() { closeTrayMenu(); showSettings(); });
ipcMain.on('tray-help', function() { closeTrayMenu(); showHelp(); });
ipcMain.on('tray-quit', function() { closeTrayMenu(); doQuit(); });
ipcMain.on('tray-close', function() { closeTrayMenu(); });
ipcMain.on('tray-open-settings', function() { closeTrayMenu(); showSettings(); });

// Quick timezone change from tray dropdown
ipcMain.on('tray-change-timezone', function(event, tz) {
  if (tz && TIMEZONE_MAP[tz]) {
    settings.timezone = tz;
    log('TIMEZONE quick-change: ' + tz);
  }
});

// Resize tray menu window (e.g. when timezone dropdown opens)
ipcMain.on('tray-menu-resize', function(event, size) {
  if (trayMenuWin && !trayMenuWin.isDestroyed() && size && size.h) {
    trayMenuWin.setSize(MENU_W, Math.round(size.h));
  }
});

function doQuit() {
  isQuitting = true;
  unregisterHotkey();
  if (psProc) { try { psProc.kill(); } catch(e) {} psProc = null; }
  try { if (keepAliveWin && !keepAliveWin.isDestroyed()) keepAliveWin.destroy(); } catch(e) {}
  try { destroyAllPopups(); } catch(e) {}
  try { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.destroy(); } catch(e) {}
  try { if (trayMenuWin && !trayMenuWin.isDestroyed()) trayMenuWin.destroy(); } catch(e) {}
  try { if (helpWin && !helpWin.isDestroyed()) helpWin.destroy(); } catch(e) {}
  app.quit();
}

// ===================== KEEP-ALIVE =====================
function createKeepalive() {
  keepAliveWin = new BrowserWindow({ show: false });
  keepAliveWin.loadURL('about:blank');
  keepAliveWin.on('close', function(e) { if (!isQuitting) e.preventDefault(); });
}

// ===================== SETTINGS =====================
// Pre-create settings window for instant open (same pattern as trayMenuWin)
function createSettingsWin() {
  if (settingsWin && !settingsWin.isDestroyed()) return;

  settingsWin = new BrowserWindow({
    width: 420, height: 600,
    show: false,
    frame: false, alwaysOnTop: true,
    resizable: false, skipTaskbar: true, focusable: true, movable: true,
    hasShadow: true,
    backgroundColor: '#0e0e12',
    webPreferences: { contextIsolation: false, nodeIntegration: true }
  });

  settingsWin.loadFile(path.join(__dirname, 'settings.html'));

  // Click outside to close (hide instead of destroy for reuse)
  settingsWin.on('blur', function() {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.hide();
  });

  settingsWin.on('closed', function() { settingsWin = null; });
}

function showSettings() {
  // Close tray menu if open
  closeTrayMenu();

  if (!settingsWin || settingsWin.isDestroyed()) {
    createSettingsWin();
  }

  // Tell renderer to reload settings data
  if (settingsWin.webContents) {
    settingsWin.webContents.send('refresh-settings');
  }

  // Position near tray icon (like tray menu)
  var curSize = settingsWin.getSize();
  var sw = curSize[0], sh = curSize[1];
  var display = screen.getPrimaryDisplay();
  var workArea = display.workArea;
  var sx, sy;

  if (tray) {
    var trayBounds = tray.getBounds();
    sx = Math.round(trayBounds.x + trayBounds.width / 2 - sw / 2);
    if (trayBounds.y < workArea.height / 2) {
      sy = trayBounds.y + trayBounds.height + 4;
    } else {
      sy = trayBounds.y - sh - 4;
    }
  } else {
    sx = Math.round(workArea.x + (workArea.width - sw) / 2);
    sy = Math.round(workArea.y + (workArea.height - sh) / 2);
  }

  // Clamp to screen edges with margin
  var edgeMargin = 8;
  sx = Math.max(workArea.x + edgeMargin, Math.min(sx, workArea.x + workArea.width - sw - edgeMargin));
  sy = Math.max(workArea.y + edgeMargin, Math.min(sy, workArea.y + workArea.height - sh - edgeMargin));

  settingsWin.setPosition(sx, sy);
  settingsWin.show();
  settingsWin.focus();
}

ipcMain.on('close-settings', function() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.hide();
  }
});

// IPC: settings window requests resize to fit content
ipcMain.on('settings-resize', function(event, size) {
  if (settingsWin && !settingsWin.isDestroyed() && size && size.h) {
    var newH = Math.max(200, Math.min(Math.round(size.h), 800));
    var curSize = settingsWin.getSize();
    var oldH = curSize[1];
    if (newH === oldH) return;

    // Keep bottom edge fixed: move y up by the height difference
    var pos = settingsWin.getPosition();
    var newY = pos[1] - (newH - oldH);

    // Clamp so it doesn't go above work area
    var display = screen.getPrimaryDisplay();
    var workArea = display.workArea;
    if (newY < workArea.y) newY = workArea.y;

    settingsWin.setBounds({ x: pos[0], y: newY, width: 420, height: newH });
  }
});

ipcMain.handle('get-settings', function() {
  return {
    version: APP_VERSION,
    hotkey: settings.hotkey,
    timezone: settings.timezone,
    multiMode: settings.multiMode,
    maxRecords: settings.maxRecords,
    hotkeyOptions: HOTKEY_OPTIONS,
    timezoneOptions: Object.keys(TIMEZONE_MAP).map(function(k) {
      return { value: k, label: TIMEZONE_MAP[k].label };
    })
  };
});

ipcMain.on('save-settings', function(event, newSettings) {
  var hotkeyChanged = newSettings.hotkey !== settings.hotkey;
  settings.timezone = newSettings.timezone || 'Asia/Shanghai';
  settings.multiMode = newSettings.multiMode === true;
  settings.maxRecords = parseInt(newSettings.maxRecords) || 5;
  if (settings.maxRecords < 2) settings.maxRecords = 2;
  if (settings.maxRecords > 20) settings.maxRecords = 20;

  var result = { ok: true, key: settings.hotkey, fallback: false };
  if (hotkeyChanged) {
    result = registerHotkey(newSettings.hotkey);
  }

  log('SETTINGS: hotkey=' + settings.hotkey + ' tz=' + settings.timezone + ' reg=' + JSON.stringify(result));

  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('settings-saved', result);
  }
});

// ===================== HELP =====================
var helpWin = null;

function showHelp() {
  if (helpWin && !helpWin.isDestroyed()) { helpWin.focus(); return; }

  helpWin = new BrowserWindow({
    width: 500, height: 440,
    frame: false, alwaysOnTop: true,
    resizable: false, skipTaskbar: true, focusable: true,
    hasShadow: true,
    backgroundColor: '#0e0e12',
    webPreferences: { contextIsolation: false, nodeIntegration: true }
  });

  helpWin.loadFile(path.join(__dirname, 'help.html'));
  helpWin.on('closed', function() { helpWin = null; });

  // Click outside to close
  helpWin.on('blur', function() {
    if (helpWin && !helpWin.isDestroyed()) {
      try { helpWin.destroy(); } catch(e) {}
    }
    helpWin = null;
  });

  // Ensure focus so blur fires
  setTimeout(function() {
    if (helpWin && !helpWin.isDestroyed()) helpWin.focus();
  }, 100);
}

ipcMain.on('close-help', function() {
  if (helpWin && !helpWin.isDestroyed()) {
    try { helpWin.destroy(); } catch(e) {}
  }
  helpWin = null;
});

// ===================== POPUP (pre-created dual-window) =====================
// Electron bug: resizable:false prevents setSize() from shrinking.
// Strategy: pre-create both hidden windows on first hotkey; mode switch = hide/show (instant).
// Multi only grows (addRecord); if delete shrinks, recreate the window.

var PW_SINGLE = 250, PH_SINGLE = 116;
var PW_MULTI = 320;
var MULTI_BASE_H = 72;   // drag-bar(6) + header(30) + footer(24) + padding(12)
var MULTI_ROW_H  = 44;   // per-record row height
var MULTI_MAX_VISIBLE = 5;

var singlePopupWin = null;
var multiPopupWin  = null;
var autoTimer = null;
var mousePoller = null;
var popupBounds = null;
var leaveTimer = null;
var currentPopupMode = 'single';
var lastPopupData = null;
var multiRecordCount = 0; // track record count in main process for resize decisions
var lastMultiH = 0;       // last height set on multi window (only grows)

function getActivePopup() {
  if (currentPopupMode === 'multi' && multiPopupWin && !multiPopupWin.isDestroyed()) return multiPopupWin;
  if (currentPopupMode === 'single' && singlePopupWin && !singlePopupWin.isDestroyed()) return singlePopupWin;
  return null;
}

function clearSingleTimers() {
  if (autoTimer)   { clearTimeout(autoTimer);   autoTimer   = null; }
  if (mousePoller) { clearInterval(mousePoller); mousePoller = null; }
  if (leaveTimer)  { clearTimeout(leaveTimer);  leaveTimer  = null; }
}

function hideSinglePopup() {
  clearSingleTimers();
  if (singlePopupWin && !singlePopupWin.isDestroyed()) singlePopupWin.hide();
}

function hideMultiPopup() {
  if (multiPopupWin && !multiPopupWin.isDestroyed()) multiPopupWin.hide();
}

function destroyAllPopups() {
  clearSingleTimers();
  if (singlePopupWin && !singlePopupWin.isDestroyed()) { try { singlePopupWin.destroy(); } catch(e) {} }
  singlePopupWin = null;
  if (multiPopupWin && !multiPopupWin.isDestroyed()) { try { multiPopupWin.destroy(); } catch(e) {} }
  multiPopupWin = null;
  popupBounds = null;
  multiRecordCount = 0;
  lastMultiH = 0;
}

function calcMultiH(count) {
  var rows = Math.min(count, MULTI_MAX_VISIBLE);
  return MULTI_BASE_H + Math.max(1, rows) * MULTI_ROW_H;
}

function isInsidePopup(point) {
  if (!popupBounds) return false;
  var b = popupBounds, margin = 15;
  return point.x >= b.x - margin && point.x <= b.x + b.w + margin &&
         point.y >= b.y - margin && point.y <= b.y + b.h + margin;
}

function startMousePoller() {
  if (mousePoller) clearInterval(mousePoller);
  if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
  var graceUntil = Date.now() + 500;
  mousePoller = setInterval(function() {
    if (!singlePopupWin || singlePopupWin.isDestroyed() || !popupBounds) {
      if (mousePoller) { clearInterval(mousePoller); mousePoller = null; }
      return;
    }
    if (Date.now() < graceUntil) return;
    var cur = screen.getCursorScreenPoint();
    if (isInsidePopup(cur)) {
      if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
    } else if (!leaveTimer) {
      leaveTimer = setTimeout(function() {
        log('mouse outside 500ms -> hide single');
        hideSinglePopup();
        popupBounds = null;
      }, 500);
    }
  }, 150);
}

function calcPopupPos(mx, my, pw, ph) {
  var d = screen.getPrimaryDisplay(), pad = 10;
  var px = mx + pad, py = my + pad;
  if (px + pw > d.workArea.x + d.workArea.width)  px = mx - pw - pad;
  if (py + ph > d.workArea.y + d.workArea.height) py = my - ph - pad;
  px = Math.max(d.workArea.x, px);
  py = Math.max(d.workArea.y, py);
  return { x: px, y: py };
}

// Ensure single popup window exists (create once, reuse)
function ensureSinglePopup() {
  if (singlePopupWin && !singlePopupWin.isDestroyed()) return;
  singlePopupWin = new BrowserWindow({
    width: PW_SINGLE, height: PH_SINGLE, x: -9999, y: -9999,
    show: false,
    frame: false, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, movable: true, hasShadow: true,
    backgroundColor: '#0e0e12',
    webPreferences: { contextIsolation: false, nodeIntegration: true }
  });
  singlePopupWin.loadFile(path.join(__dirname, 'popup.html'));
  singlePopupWin.on('move', function() {
    if (!singlePopupWin || singlePopupWin.isDestroyed()) return;
    var pos = singlePopupWin.getPosition();
    var sz = singlePopupWin.getSize();
    popupBounds = { x: pos[0], y: pos[1], w: sz[0], h: sz[1] };
  });
  singlePopupWin.on('closed', function() { singlePopupWin = null; });
  log('ensureSinglePopup created');
}

// Ensure multi popup window exists (create once, reuse)
function ensureMultiPopup(initH) {
  if (multiPopupWin && !multiPopupWin.isDestroyed()) return;
  var h = initH || calcMultiH(1);
  multiPopupWin = new BrowserWindow({
    width: PW_MULTI, height: h, x: -9999, y: -9999,
    show: false,
    frame: false, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, movable: true, hasShadow: true,
    backgroundColor: '#0e0e12',
    webPreferences: { contextIsolation: false, nodeIntegration: true }
  });
  multiPopupWin.loadFile(path.join(__dirname, 'popup.html'));
  multiPopupWin.on('move', function() {
    if (!multiPopupWin || multiPopupWin.isDestroyed()) return;
    var pos = multiPopupWin.getPosition();
    var sz = multiPopupWin.getSize();
    popupBounds = { x: pos[0], y: pos[1], w: sz[0], h: sz[1] };
  });
  multiPopupWin.on('closed', function() { multiPopupWin = null; });
  lastMultiH = h;
  log('ensureMultiPopup created h=' + h);
}

function showPopup(data, mx, my) {
  if (!data) return false;
  lastPopupData = data;

  var isMulti = settings.multiMode || currentPopupMode === 'multi';

  if (isMulti) {
    currentPopupMode = 'multi';
    hideSinglePopup(); // hide single if visible
    ensureMultiPopup();

    if (multiPopupWin.isVisible()) {
      // Already showing — just append
      try { multiPopupWin.webContents.send('append-record', data); } catch(e) { log('append err: ' + e.message); }
      multiPopupWin.focus();
    } else {
      // First show — send init data after load
      var mh = calcMultiH(1);
      var mpos = calcPopupPos(mx, my, PW_MULTI, mh);

      if (multiPopupWin.webContents.isLoading()) {
        multiPopupWin.webContents.once('did-finish-load', function() {
          if (!multiPopupWin || multiPopupWin.isDestroyed()) return;
          multiPopupWin.webContents.send('init-mode', {
            mode: 'multi', maxRecords: settings.maxRecords, data: data
          });
          multiPopupWin.setPosition(mpos.x, mpos.y);
          multiPopupWin.show();
          multiPopupWin.focus();
          popupBounds = { x: mpos.x, y: mpos.y, w: PW_MULTI, h: mh };
        });
      } else {
        multiPopupWin.webContents.send('init-mode', {
          mode: 'multi', maxRecords: settings.maxRecords, data: data
        });
        multiPopupWin.setPosition(mpos.x, mpos.y);
        multiPopupWin.show();
        multiPopupWin.focus();
        popupBounds = { x: mpos.x, y: mpos.y, w: PW_MULTI, h: mh };
      }
      multiRecordCount = 1;
      lastMultiH = mh;
    }
  } else {
    currentPopupMode = 'single';
    hideMultiPopup(); // hide multi if visible
    ensureSinglePopup();

    var spos = calcPopupPos(mx, my, PW_SINGLE, PH_SINGLE);

    var doShow = function() {
      if (!singlePopupWin || singlePopupWin.isDestroyed()) return;
      singlePopupWin.webContents.send('init-mode', {
        mode: 'single', maxRecords: settings.maxRecords, data: data
      });
      singlePopupWin.setPosition(spos.x, spos.y);
      singlePopupWin.show();
      singlePopupWin.focus();
      popupBounds = { x: spos.x, y: spos.y, w: PW_SINGLE, h: PH_SINGLE };
      startMousePoller();
      if (autoTimer) clearTimeout(autoTimer);
      autoTimer = setTimeout(function() { hideSinglePopup(); popupBounds = null; }, 6000);
    };

    if (singlePopupWin.webContents.isLoading()) {
      singlePopupWin.webContents.once('did-finish-load', doShow);
    } else {
      doShow();
    }
  }
  return true;
}

// IPC: close popup from renderer (click X / ESC)
ipcMain.on('close-popup', function() {
  log('close-popup via IPC');
  hideSinglePopup();
  hideMultiPopup();
  popupBounds = null;
  // Reset multi state so next show starts fresh
  multiRecordCount = 0;
  lastMultiH = 0;
});

// IPC: popup wants to resize (multi mode — records added/deleted)
ipcMain.on('popup-resize', function(event, size) {
  if (!multiPopupWin || multiPopupWin.isDestroyed()) return;
  if (!size || !size.h) return;

  var newH = Math.round(size.h);
  var count = size.count || 0;
  multiRecordCount = count;
  log('popup-resize: h=' + newH + ' count=' + count + ' lastH=' + lastMultiH);

  if (newH >= lastMultiH) {
    // Growing or same — setSize works fine with resizable:false
    multiPopupWin.setSize(PW_MULTI, newH);
    lastMultiH = newH;
    var pos = multiPopupWin.getPosition();
    popupBounds = { x: pos[0], y: pos[1], w: PW_MULTI, h: newH };
  } else {
    // Shrinking — must recreate window (Electron bug workaround)
    var oldPos = multiPopupWin.getPosition();
    recreateMultiAtSize(newH, oldPos[0], oldPos[1], count);
  }
});

function recreateMultiAtSize(newH, px, py, count) {
  // Destroy and recreate multi popup at smaller size
  if (multiPopupWin && !multiPopupWin.isDestroyed()) {
    try { multiPopupWin.destroy(); } catch(e) {}
  }
  multiPopupWin = null;

  multiPopupWin = new BrowserWindow({
    width: PW_MULTI, height: newH, x: px, y: py,
    show: false,
    frame: false, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, movable: true, hasShadow: true,
    backgroundColor: '#0e0e12',
    webPreferences: { contextIsolation: false, nodeIntegration: true }
  });
  multiPopupWin.loadFile(path.join(__dirname, 'popup.html'));
  multiPopupWin.on('move', function() {
    if (!multiPopupWin || multiPopupWin.isDestroyed()) return;
    var mpos = multiPopupWin.getPosition();
    var msz = multiPopupWin.getSize();
    popupBounds = { x: mpos[0], y: mpos[1], w: msz[0], h: msz[1] };
  });
  multiPopupWin.on('closed', function() { multiPopupWin = null; });
  lastMultiH = newH;

  multiPopupWin.webContents.once('did-finish-load', function() {
    if (!multiPopupWin || multiPopupWin.isDestroyed()) return;
    // Tell renderer to restore records
    multiPopupWin.webContents.send('restore-records', { count: count });
    multiPopupWin.show();
    multiPopupWin.focus();
    popupBounds = { x: px, y: py, w: PW_MULTI, h: newH };
  });
  log('recreateMultiAtSize h=' + newH);
}

// IPC: popup mode changed by user clicking SINGLE/MULTI toggle
// Just hide one and show the other — no destroy/create (instant!)
ipcMain.on('popup-mode-changed', function(event, newMode) {
  log('popup-mode-changed: ' + newMode);

  // IMPORTANT: get position from the OLD window BEFORE updating currentPopupMode
  var px, py;
  var oldMode = currentPopupMode;
  var oldWin = (oldMode === 'multi') ? multiPopupWin : singlePopupWin;
  if (oldWin && !oldWin.isDestroyed() && oldWin.isVisible()) {
    // Use getContentPosition to avoid transparent window frame offsets
    var pos = oldWin.getPosition();
    px = pos[0]; py = pos[1];
    log('popup-mode-changed: got pos from ' + oldMode + ' win: ' + px + ',' + py);
  } else {
    var cur = screen.getCursorScreenPoint();
    px = cur.x; py = cur.y;
    log('popup-mode-changed: fallback to cursor: ' + px + ',' + py);
  }

  // NOW update mode
  currentPopupMode = newMode;
  settings.multiMode = (newMode === 'multi');

  if (newMode === 'single') {
    hideMultiPopup();
    multiRecordCount = 0;
    lastMultiH = 0;
    ensureSinglePopup();

    var doShowSingle = function() {
      if (!singlePopupWin || singlePopupWin.isDestroyed()) return;
      singlePopupWin.webContents.send('init-mode', {
        mode: 'single', maxRecords: settings.maxRecords, data: lastPopupData
      });
      singlePopupWin.setPosition(px, py);
      singlePopupWin.show();
      singlePopupWin.focus();
      popupBounds = { x: px, y: py, w: PW_SINGLE, h: PH_SINGLE };
      startMousePoller();
      if (autoTimer) clearTimeout(autoTimer);
      autoTimer = setTimeout(function() { hideSinglePopup(); popupBounds = null; }, 6000);
    };

    if (singlePopupWin.webContents.isLoading()) {
      singlePopupWin.webContents.once('did-finish-load', doShowSingle);
    } else {
      doShowSingle();
    }
  } else {
    hideSinglePopup();
    ensureMultiPopup();

    var mh = calcMultiH(1);
    var doShowMulti = function() {
      if (!multiPopupWin || multiPopupWin.isDestroyed()) return;
      multiPopupWin.webContents.send('init-mode', {
        mode: 'multi', maxRecords: settings.maxRecords, data: lastPopupData
      });
      multiPopupWin.setPosition(px, py);
      multiPopupWin.show();
      multiPopupWin.focus();
      popupBounds = { x: px, y: py, w: PW_MULTI, h: mh };
      multiRecordCount = 1;
      lastMultiH = mh;
    };

    if (multiPopupWin.webContents.isLoading()) {
      multiPopupWin.webContents.once('did-finish-load', doShowMulti);
    } else {
      doShowMulti();
    }
  }
});

// ===================== APP LIFECYCLE =====================
app.on('window-all-closed', function(e) { e.preventDefault(); });
app.on('before-quit', function() {
  isQuitting = true;
  unregisterHotkey();
  if (psProc) { try { psProc.kill(); } catch(e) {} psProc = null; }
});

app.whenReady().then(function() {
  isQuitting = false;
  log('v' + APP_VERSION + ' platform=' + process.platform);
  log('Hotkey: ' + settings.hotkey + ' | Timezone: ' + settings.timezone);

  createKeepalive();
  startPowerShell();  // Pre-start PowerShell on launch
  registerHotkey();
  createTray();
  createTrayMenuWin(); // Pre-create tray menu for instant right-click
  createSettingsWin(); // Pre-create settings window for instant open

  app.on('activate', function() {});
});

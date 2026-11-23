import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { WorkspaceError } from './workspace.mjs';
import { findTrustedExecutable } from './trusted-executable.mjs';

const READY = '@@DSH_DESKTOP_READY@@';
const RESULT = '@@DSH_DESKTOP_RESULT@@';
const ERROR = '@@DSH_DESKTOP_ERROR@@';
const REQUEST_TIMEOUT = 30000;
const START_TIMEOUT = 20000;
const IDLE_MS = 5 * 60 * 1000;
const MAX_SHOTS = 40;

export const DESKTOP_TOOL = Object.freeze({
  name: 'strong_desktop',
  description: 'Windows 桌面全局操作：真实鼠标移动/点击/拖拽/滚轮、Unicode 键盘输入与快捷键、窗口枚举/激活/最小化/最大化/恢复/关闭、全屏截图。需在设置中显式开启；先 screenshot 或 windows 定位，操作后再 screenshot 验证。',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['screenshot', 'windows', 'cursor', 'move', 'click', 'drag', 'scroll', 'type', 'press', 'activate', 'minimize', 'maximize', 'restore', 'close', 'launch', 'wait'] },
      x: { type: 'number', minimum: -100000, maximum: 100000, description: '屏幕物理像素 X' },
      y: { type: 'number', minimum: -100000, maximum: 100000, description: '屏幕物理像素 Y' },
      toX: { type: 'number', minimum: -100000, maximum: 100000 },
      toY: { type: 'number', minimum: -100000, maximum: 100000 },
      button: { type: 'string', enum: ['left', 'right', 'middle'] },
      clickCount: { type: 'integer', minimum: 1, maximum: 3 },
      delta: { type: 'integer', minimum: -100, maximum: 100, description: '滚轮格数，正数向上' },
      text: { type: 'string', maxLength: 4000 },
      key: { type: 'string', maxLength: 100, description: '例如 enter、ctrl+shift+s、alt+tab' },
      target: { type: 'string', maxLength: 200, description: '窗口标题或进程名' },
      hwnd: { type: 'integer', minimum: 1, maximum: 4294967295 },
      path: { type: 'string', maxLength: 1000, description: '仅 launch：可执行文件绝对路径' },
      args: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 500 } },
      ms: { type: 'integer', minimum: 0, maximum: 30000 },
      quality: { type: 'integer', minimum: 30, maximum: 95 },
    },
    required: ['action'],
    additionalProperties: false,
  },
});

let session = null;
let sessionPromise = null;
let idleTimer = null;
let shotDir = '';
let requestChain = Promise.resolve();

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new WorkspaceError('ABORTED', 'Operation cancelled.')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, Math.max(0, ms));
    const abort = () => { clearTimeout(timer); reject(new WorkspaceError('ABORTED', 'Operation cancelled.')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function powershellPath(root) {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const known = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (existsSync(known)) return known;
  return findTrustedExecutable('powershell', {
    workspaceRoot: root,
    extraDirectories: [path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')],
  });
}

function serverScript() {
  return String.raw`$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public class DshPoint {
  public int X { get; set; }
  public int Y { get; set; }
}

public class DshShot {
  public string Path { get; set; }
  public int Width { get; set; }
  public int Height { get; set; }
}

public class DshWindow {
  public long Handle { get; set; }
  public int Pid { get; set; }
  public string Process { get; set; }
  public string Title { get; set; }
  public int X { get; set; }
  public int Y { get; set; }
  public int Width { get; set; }
  public int Height { get; set; }
  public bool Active { get; set; }
}

public static class DshDesktop {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }

  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool join);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);

  const uint INPUT_MOUSE = 0;
  const uint INPUT_KEYBOARD = 1;
  const uint KEYUP = 0x0002;
  const uint UNICODE = 0x0004;
  const uint EXTENDED = 0x0001;
  const uint LEFTDOWN = 0x0002;
  const uint LEFTUP = 0x0004;
  const uint RIGHTDOWN = 0x0008;
  const uint RIGHTUP = 0x0010;
  const uint MIDDLEDOWN = 0x0020;
  const uint MIDDLEUP = 0x0040;
  const uint WHEEL = 0x0800;

  static DshDesktop() { try { SetProcessDPIAware(); } catch (Exception) { } }

  static void SendMouse(uint flags, uint data) {
    INPUT input = new INPUT();
    input.type = INPUT_MOUSE;
    input.u.mi.dwFlags = flags;
    input.u.mi.mouseData = data;
    INPUT[] inputs = new INPUT[1];
    inputs[0] = input;
    uint sent = SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent == 0) throw new Exception("SendInput mouse failed: " + Marshal.GetLastWin32Error());
  }

  static void SendKey(ushort key, bool up, bool extended) {
    INPUT input = new INPUT();
    input.type = INPUT_KEYBOARD;
    input.u.ki.wVk = key;
    input.u.ki.wScan = 0;
    input.u.ki.dwFlags = (up ? KEYUP : 0) | (extended ? EXTENDED : 0);
    INPUT[] inputs = new INPUT[1];
    inputs[0] = input;
    uint sent = SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent == 0) throw new Exception("SendInput failed: " + Marshal.GetLastWin32Error());
  }

  static void SendUnicode(char value, bool up) {
    INPUT input = new INPUT();
    input.type = INPUT_KEYBOARD;
    input.u.ki.wVk = 0;
    input.u.ki.wScan = value;
    input.u.ki.dwFlags = UNICODE | (up ? KEYUP : 0);
    INPUT[] inputs = new INPUT[1];
    inputs[0] = input;
    uint sent = SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent == 0) throw new Exception("SendInput failed: " + Marshal.GetLastWin32Error());
  }

  static bool IsExtended(ushort key) {
    return key == 0x21 || key == 0x22 || key == 0x23 || key == 0x24 || key == 0x25 || key == 0x26 || key == 0x27 || key == 0x28 ||
      key == 0x2D || key == 0x2E || key == 0x2C || key == 0x5B || key == 0x5C || key == 0x5D || key == 0x90;
  }

  static void Tap(ushort key) {
    SendKey(key, false, IsExtended(key));
    SendKey(key, true, IsExtended(key));
    Thread.Sleep(12);
  }

  static ushort KeyCode(string name) {
    string key = (name == null ? "" : name.Trim().ToLowerInvariant());
    if (key.Length == 1) {
      char ch = key[0];
      if (ch >= 'a' && ch <= 'z') return (ushort)(0x41 + (ch - 'a'));
      if (ch >= '0' && ch <= '9') return (ushort)(0x30 + (ch - '0'));
      if (ch == ';') return 0xBA;
      if (ch == '=') return 0xBB;
      if (ch == ',') return 0xBC;
      if (ch == '-') return 0xBD;
      if (ch == '.') return 0xBE;
      if (ch == '/') return 0xBF;
      if (ch == '[' ) return 0xDB;
      if (ch == '\\') return 0xDC;
      if (ch == ']') return 0xDD;
      if (ch == '\'') return 0xDE;
      if (ch == ' ') return 0x20;
    }
    if (key == "enter" || key == "return") return 0x0D;
    if (key == "tab") return 0x09;
    if (key == "esc" || key == "escape") return 0x1B;
    if (key == "space") return 0x20;
    if (key == "backspace" || key == "bs") return 0x08;
    if (key == "delete" || key == "del") return 0x2E;
    if (key == "insert" || key == "ins") return 0x2D;
    if (key == "home") return 0x24;
    if (key == "end") return 0x23;
    if (key == "pageup" || key == "pgup") return 0x21;
    if (key == "pagedown" || key == "pgdn") return 0x22;
    if (key == "up") return 0x26;
    if (key == "down") return 0x28;
    if (key == "left") return 0x25;
    if (key == "right") return 0x27;
    if (key == "printscreen" || key == "prtsc") return 0x2C;
    if (key == "capslock") return 0x14;
    if (key == "numlock") return 0x90;
    if (key == "scrolllock") return 0x91;
    if (key == "pause") return 0x13;
    if (key == "apps" || key == "menu") return 0x5D;
    if (key == "ctrl" || key == "control") return 0x11;
    if (key == "shift") return 0x10;
    if (key == "alt") return 0x12;
    if (key == "win" || key == "meta" || key == "cmd") return 0x5B;
    if (key == "plus") return 0xBB;
    if (key == "minus") return 0xBD;
    if (key == "slash") return 0xBF;
    if (key == "backslash") return 0xDC;
    if (key == "comma") return 0xBC;
    if (key == "period" || key == "dot") return 0xBE;
    if (key == "semicolon") return 0xBA;
    if (key == "quote") return 0xDE;
    if (key == "tilde") return 0xC0;
    if (key.Length >= 2 && key[0] == 'f') {
      int number;
      if (int.TryParse(key.Substring(1), out number) && number >= 1 && number <= 24) return (ushort)(0x70 + number - 1);
    }
    throw new Exception("Unknown key: " + name);
  }

  static bool IsModifier(ushort key) {
    return key == 0x11 || key == 0x10 || key == 0x12 || key == 0x5B;
  }

  public static DshPoint Cursor() {
    POINT point;
    GetCursorPos(out point);
    DshPoint result = new DshPoint();
    result.X = point.X;
    result.Y = point.Y;
    return result;
  }

  public static DshPoint Move(double x, double y) {
    if (!SetCursorPos((int)Math.Round(x), (int)Math.Round(y))) throw new Exception("SetCursorPos failed");
    Thread.Sleep(20);
    return Cursor();
  }

  public static DshPoint Click(double x, double y, bool hasPoint, string button, int count) {
    if (hasPoint) Move(x, y);
    string name = (button == null ? "left" : button.ToLowerInvariant());
    uint down = LEFTDOWN;
    uint up = LEFTUP;
    if (name == "right") { down = RIGHTDOWN; up = RIGHTUP; }
    else if (name == "middle") { down = MIDDLEDOWN; up = MIDDLEUP; }
    int clicks = Math.Max(1, Math.Min(3, count));
    for (int i = 0; i < clicks; i++) {
      SendMouse(down, 0);
      SendMouse(up, 0);
      Thread.Sleep(i + 1 < clicks ? 100 : 30);
    }
    return Cursor();
  }

  public static DshPoint Drag(double x, double y, double toX, double toY, string button, int steps) {
    Move(x, y);
    string name = (button == null ? "left" : button.ToLowerInvariant());
    uint down = LEFTDOWN;
    uint up = LEFTUP;
    if (name == "right") { down = RIGHTDOWN; up = RIGHTUP; }
    else if (name == "middle") { down = MIDDLEDOWN; up = MIDDLEUP; }
    int total = Math.Max(1, Math.Min(100, steps));
    SendMouse(down, 0);
    for (int i = 1; i <= total; i++) {
      double t = (double)i / (double)total;
      SetCursorPos((int)Math.Round(x + (toX - x) * t), (int)Math.Round(y + (toY - y) * t));
      Thread.Sleep(16);
    }
    SendMouse(up, 0);
    return Cursor();
  }

  public static DshPoint Scroll(double x, double y, bool hasPoint, int delta) {
    if (hasPoint) Move(x, y);
    SendMouse(WHEEL, unchecked((uint)(delta * 120)));
    Thread.Sleep(20);
    return Cursor();
  }

  public static DshPoint TypeText(string text) {
    string value = text == null ? "" : text;
    for (int i = 0; i < value.Length; i++) {
      char ch = value[i];
      if (ch == '\r') {
        if (i + 1 < value.Length && value[i + 1] == '\n') continue;
        Tap(0x0D);
      } else if (ch == '\n') {
        Tap(0x0D);
      } else if (ch == '\t') {
        Tap(0x09);
      } else {
        SendUnicode(ch, false);
        SendUnicode(ch, true);
        Thread.Sleep(2);
      }
    }
    return Cursor();
  }

  public static DshPoint Press(string combo) {
    string value = combo == null ? "" : combo.Trim();
    if (value.Length == 0) throw new Exception("Empty key combination");
    string[] parts = value.Split(new char[] { '+' });
    List<ushort> modifiers = new List<ushort>();
    for (int i = 0; i < parts.Length - 1; i++) {
      ushort modifier = KeyCode(parts[i]);
      if (!IsModifier(modifier)) throw new Exception("Not a modifier: " + parts[i]);
      modifiers.Add(modifier);
    }
    ushort key = KeyCode(parts[parts.Length - 1]);
    List<ushort> pressed = new List<ushort>();
    try {
      foreach (ushort modifier in modifiers) {
        SendKey(modifier, false, IsExtended(modifier));
        pressed.Add(modifier);
      }
      SendKey(key, false, IsExtended(key));
      SendKey(key, true, IsExtended(key));
    } finally {
      for (int i = modifiers.Count - 1; i >= 0; i--) SendKey(modifiers[i], true, IsExtended(modifiers[i]));
    }
    Thread.Sleep(20);
    return Cursor();
  }

  static DshWindow Info(IntPtr handle) {
    DshWindow result = new DshWindow();
    result.Handle = handle.ToInt64();
    StringBuilder title = new StringBuilder(1024);
    GetWindowText(handle, title, 1024);
    result.Title = title.ToString();
    uint pid;
    GetWindowThreadProcessId(handle, out pid);
    result.Pid = (int)pid;
    try { result.Process = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { result.Process = ""; }
    RECT rect;
    if (GetWindowRect(handle, out rect)) {
      result.X = rect.Left;
      result.Y = rect.Top;
      result.Width = rect.Right - rect.Left;
      result.Height = rect.Bottom - rect.Top;
    }
    result.Active = handle == GetForegroundWindow();
    return result;
  }

  public static DshWindow[] Windows() {
    List<DshWindow> result = new List<DshWindow>();
    IntPtr foreground = GetForegroundWindow();
    Process[] processes = Process.GetProcesses();
    foreach (Process process in processes) {
      try {
        IntPtr handle = process.MainWindowHandle;
        if (handle == IntPtr.Zero || !IsWindowVisible(handle)) continue;
        DshWindow window = Info(handle);
        if (window.Title == null || window.Title.Trim().Length == 0) continue;
        result.Add(window);
        if (result.Count >= 120) break;
      } catch (Exception) { }
    }
    result.Sort(delegate(DshWindow a, DshWindow b) { return b.Active.CompareTo(a.Active); });
    return result.ToArray();
  }

  static IntPtr FindWindow(string target, long hwnd) {
    if (hwnd != 0) {
      IntPtr direct = new IntPtr(hwnd);
      if (IsWindow(direct)) return direct;
      return IntPtr.Zero;
    }
    string wanted = (target == null ? "" : target.Trim().ToLowerInvariant());
    if (wanted.Length == 0) return IntPtr.Zero;
    DshWindow[] all = Windows();
    IntPtr partial = IntPtr.Zero;
    foreach (DshWindow window in all) {
      string title = window.Title == null ? "" : window.Title.ToLowerInvariant();
      string name = window.Process == null ? "" : window.Process.ToLowerInvariant();
      if (title == wanted || name == wanted) return new IntPtr(window.Handle);
      if (partial == IntPtr.Zero && (title.IndexOf(wanted) >= 0 || name.IndexOf(wanted) >= 0)) partial = new IntPtr(window.Handle);
    }
    return partial;
  }

  public static DshWindow WindowAction(string action, string target, long hwnd) {
    IntPtr handle = FindWindow(target, hwnd);
    if (handle == IntPtr.Zero) throw new Exception("Window not found: " + (target == null ? hwnd.ToString() : target));
    string name = (action == null ? "" : action.ToLowerInvariant());
    DshWindow info = Info(handle);
    if (name == "activate") {
      ShowWindow(handle, 9);
      uint pid;
      uint targetThread = GetWindowThreadProcessId(handle, out pid);
      uint foregroundPid;
      uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out foregroundPid);
      bool attached = false;
      if (targetThread != 0 && foregroundThread != 0 && targetThread != foregroundThread) {
        attached = AttachThreadInput(foregroundThread, targetThread, true);
      }
      try {
        BringWindowToTop(handle);
        SetForegroundWindow(handle);
        SetFocus(handle);
      } finally {
        if (attached) AttachThreadInput(foregroundThread, targetThread, false);
      }
    } else if (name == "minimize") {
      ShowWindow(handle, 6);
    } else if (name == "maximize") {
      ShowWindow(handle, 3);
    } else if (name == "restore") {
      ShowWindow(handle, 9);
    } else if (name == "close") {
      PostMessage(handle, 0x0010, IntPtr.Zero, IntPtr.Zero);
    } else {
      throw new Exception("Unknown window action: " + action);
    }
    Thread.Sleep(120);
    return info;
  }

  public static DshShot Screenshot(string file, int quality) {
    Rectangle bounds = SystemInformation.VirtualScreen;
    if (bounds.Width <= 0 || bounds.Height <= 0) throw new Exception("No interactive desktop available");
    Bitmap bitmap = new Bitmap(bounds.Width, bounds.Height);
    try {
      using (Graphics graphics = Graphics.FromImage(bitmap)) {
        graphics.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, new Size(bounds.Width, bounds.Height));
      }
      ImageCodecInfo codec = null;
      ImageCodecInfo[] codecs = ImageCodecInfo.GetImageEncoders();
      foreach (ImageCodecInfo item in codecs) {
        if (item.FormatID == ImageFormat.Jpeg.Guid) { codec = item; break; }
      }
      if (codec == null) throw new Exception("JPEG encoder unavailable");
      EncoderParameters parameters = new EncoderParameters(1);
      parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)Math.Max(30, Math.Min(95, quality)));
      try { bitmap.Save(file, codec, parameters); } finally { parameters.Dispose(); }
      DshShot result = new DshShot();
      result.Path = file;
      result.Width = bounds.Width;
      result.Height = bounds.Height;
      return result;
    } finally {
      bitmap.Dispose();
    }
  }
}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies @('System.Drawing.dll', 'System.Windows.Forms.dll')
function Send-Line([string]$line) {
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
}
Send-Line '@@DSH_DESKTOP_READY@@'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  try {
    $request = $line | ConvertFrom-Json
    $action = [string]$request.action
    switch ($action) {
      'screenshot' { $result = [DshDesktop]::Screenshot([string]$request.path, [int]$request.quality) }
      'windows' { $result = [DshDesktop]::Windows() }
      'cursor' { $result = [DshDesktop]::Cursor() }
      'move' { $result = [DshDesktop]::Move([double]$request.x, [double]$request.y) }
      'click' { $result = [DshDesktop]::Click([double]$request.x, [double]$request.y, [bool]$request.usePoint, [string]$request.button, [int]$request.clickCount) }
      'drag' { $result = [DshDesktop]::Drag([double]$request.x, [double]$request.y, [double]$request.toX, [double]$request.toY, [string]$request.button, [int]$request.steps) }
      'scroll' { $result = [DshDesktop]::Scroll([double]$request.x, [double]$request.y, [bool]$request.usePoint, [int]$request.delta) }
      'type' { $result = [DshDesktop]::TypeText([string]$request.text) }
      'press' { $result = [DshDesktop]::Press([string]$request.key) }
      'activate' { $result = [DshDesktop]::WindowAction('activate', [string]$request.target, [long]$request.hwnd) }
      'minimize' { $result = [DshDesktop]::WindowAction('minimize', [string]$request.target, [long]$request.hwnd) }
      'maximize' { $result = [DshDesktop]::WindowAction('maximize', [string]$request.target, [long]$request.hwnd) }
      'restore' { $result = [DshDesktop]::WindowAction('restore', [string]$request.target, [long]$request.hwnd) }
      'close' { $result = [DshDesktop]::WindowAction('close', [string]$request.target, [long]$request.hwnd) }
      default { throw "Unknown desktop action: $action" }
    }
    Send-Line ('@@DSH_DESKTOP_RESULT@@' + ($result | ConvertTo-Json -Compress -Depth 8))
  } catch {
    $message = $_.Exception.Message
    $json = @{ error = $message } | ConvertTo-Json -Compress
    Send-Line ('@@DSH_DESKTOP_ERROR@@' + $json)
  }
}
`;
}

async function stopSession(instance) {
  if (!instance) return;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (session === instance) session = null;
  try { instance.child.stdin.end(); } catch {}
  try { instance.child.kill(); } catch {}
  instance.closed = true;
  if (instance.dir) {
    try { await fs.rm(instance.dir, { recursive: true, force: true }); } catch {}
  }
}

function failSession(instance, error) {
  if (instance?.closed) return;
  instance.closed = true;
  if (session === instance) session = null;
  if (instance.pending) {
    const pending = instance.pending;
    instance.pending = null;
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener('abort', pending.abort);
    pending.reject(error);
  }
  try { instance.child.kill(); } catch {}
}

async function createSession(root) {
  if (process.platform !== 'win32') throw new WorkspaceError('DESKTOP_UNSUPPORTED', 'strong_desktop 只支持 Windows。');
  const executable = powershellPath(root);
  if (!executable) throw new WorkspaceError('DESKTOP_UNAVAILABLE', '未找到 Windows PowerShell。');
  if (!shotDir) {
    shotDir = path.join(os.tmpdir(), 'dsh-strong-desktop-shots-' + process.pid);
    await fs.mkdir(shotDir, { recursive: true });
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-strong-desktop-'));
  const script = path.join(dir, 'host.ps1');
  await fs.writeFile(script, serverScript(), 'utf8');
  const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    cwd: os.tmpdir(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const instance = { child, dir, closed: false, pending: null, stderr: '' };
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const timer = setTimeout(() => readyReject(new WorkspaceError('DESKTOP_UNAVAILABLE', '启动 Windows 桌面自动化主机超时。' + (instance.stderr ? ' ' + instance.stderr.slice(-500) : ''))), START_TIMEOUT);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { instance.stderr = (instance.stderr + chunk).slice(-8000); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    if (!instance.ready) {
      if (line === READY) {
        instance.ready = true;
        clearTimeout(timer);
        readyResolve(instance);
      }
      return;
    }
    if (line.startsWith(RESULT)) {
      const pending = instance.pending;
      if (!pending) return;
      instance.pending = null;
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener('abort', pending.abort);
      let value;
      try { value = JSON.parse(line.slice(RESULT.length)); } catch { pending.reject(new WorkspaceError('DESKTOP_ACTION_FAILED', '桌面自动化返回了无效结果。')); return; }
      pending.resolve(value);
    } else if (line.startsWith(ERROR)) {
      const pending = instance.pending;
      if (!pending) return;
      instance.pending = null;
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener('abort', pending.abort);
      let message = '桌面操作失败。';
      try { message = JSON.parse(line.slice(ERROR.length)).error || message; } catch {}
      pending.reject(new WorkspaceError('DESKTOP_ACTION_FAILED', String(message).slice(0, 1000)));
    }
  });
  child.once('error', cause => {
    clearTimeout(timer);
    const error = new WorkspaceError('DESKTOP_UNAVAILABLE', '无法启动 Windows PowerShell：' + cause.message);
    readyReject(error);
    failSession(instance, error);
  });
  child.once('exit', (code, signalName) => {
    clearTimeout(timer);
    const detail = instance.stderr.trim();
    const error = new WorkspaceError('DESKTOP_UNAVAILABLE', 'Windows 桌面自动化主机已退出（' + (signalName || code) + '）。' + (detail ? ' ' + detail.slice(-8000) : ''));
    if (!instance.ready) readyReject(error);
    failSession(instance, error);
    if (session === instance) session = null;
    fs.rm(instance.dir, { recursive: true, force: true }).catch(() => {});
  });
  try {
    await ready;
    return instance;
  } catch (cause) {
    failSession(instance, cause);
    try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
    throw cause;
  }
}

async function getSession(root) {
  if (session && !session.closed) return session;
  if (!sessionPromise) sessionPromise = createSession(root).then(instance => { session = instance; return instance; }).finally(() => { sessionPromise = null; });
  return sessionPromise;
}

function serialize(task) {
  const run = requestChain.then(task, task);
  requestChain = run.catch(() => {});
  return run;
}

async function request(root, payload, signal) {
  return serialize(async () => {
    const instance = await getSession(root);
    if (signal?.aborted) throw new WorkspaceError('ABORTED', 'Operation cancelled.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new WorkspaceError('DESKTOP_TIMEOUT', '桌面操作超时；已重启自动化主机。');
        failSession(instance, error);
        reject(error);
      }, REQUEST_TIMEOUT);
      const abort = () => {
        const error = new WorkspaceError('ABORTED', 'Operation cancelled.');
        failSession(instance, error);
        reject(error);
      };
      const pending = { resolve, reject, timer, abort, signal };
      instance.pending = pending;
      signal?.addEventListener('abort', abort, { once: true });
      try {
        instance.child.stdin.write(JSON.stringify(payload) + '\n');
      } catch (cause) {
        clearTimeout(timer);
        instance.pending = null;
        signal?.removeEventListener('abort', abort);
        reject(new WorkspaceError('DESKTOP_UNAVAILABLE', '无法写入 Windows 桌面自动化主机：' + cause.message));
      }
    });
  }).then(value => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (session) void stopSession(session); }, IDLE_MS);
    idleTimer.unref?.();
    return value;
  });
}

function hasPoint(args) {
  const x = Number.isFinite(args.x);
  const y = Number.isFinite(args.y);
  if (x !== y) throw new WorkspaceError('INVALID_ARGUMENTS', 'x 和 y 必须同时提供。');
  return x;
}

function normalizePoint(value) {
  const point = value && typeof value === 'object' ? value : {};
  return { x: Number(point.X ?? point.x ?? 0), y: Number(point.Y ?? point.y ?? 0) };
}

function normalizeWindow(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    handle: String(value.Handle ?? value.handle ?? 0),
    pid: Number(value.Pid ?? value.pid ?? 0),
    process: String(value.Process ?? value.process ?? ''),
    title: String(value.Title ?? value.title ?? ''),
    x: Number(value.X ?? value.x ?? 0), y: Number(value.Y ?? value.y ?? 0),
    width: Number(value.Width ?? value.width ?? 0), height: Number(value.Height ?? value.height ?? 0),
    active: Boolean(value.Active ?? value.active),
  };
}

/** Keep the screenshot directory bounded for long-lived DSH sessions. */
async function pruneShots() {
  if (!shotDir) return;
  try {
    const names = await fs.readdir(shotDir);
    const files = [];
    for (const name of names) {
      if (!/^shot-.*\.jpg$/.test(name)) continue;
      const file = path.join(shotDir, name);
      try { const info = await fs.stat(file); if (info.isFile()) files.push({ file, mtimeMs: info.mtimeMs }); } catch {}
    }
    if (files.length < MAX_SHOTS) return;
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    await Promise.all(files.slice(MAX_SHOTS - 1).map(entry => fs.rm(entry.file, { force: true }).catch(() => {})));
  } catch {}
}

async function launch(args) {
  const file = args.path;
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new WorkspaceError('INVALID_ARGUMENTS', 'launch 需要可执行文件的绝对路径。');
  let info;
  try { info = await fs.stat(file); } catch { throw new WorkspaceError('INVALID_ARGUMENTS', 'launch 文件不存在：' + file); }
  if (!info.isFile()) throw new WorkspaceError('INVALID_ARGUMENTS', 'launch 路径不是文件：' + file);
  if (!['.exe', '.com'].includes(path.extname(file).toLowerCase())) throw new WorkspaceError('INVALID_ARGUMENTS', 'launch 只接受 .exe 或 .com 可执行文件。');
  const argv = Array.isArray(args.args) ? args.args.map(String) : [];
  const child = spawn(file, argv, { cwd: path.dirname(file), detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return { action: 'launch', path: file, args: argv, pid: child.pid };
}

export async function runDesktopTool(args, { root = process.cwd(), signal } = {}) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32') throw new WorkspaceError('DESKTOP_UNSUPPORTED', 'strong_desktop 只支持 Windows。');
  const action = args.action;
  if (action === 'wait') { const waitedMs = Math.max(0, args.ms || 0); await delay(waitedMs, signal); return { action, waitedMs }; }
  if (action === 'launch') return launch(args);
  if (action === 'screenshot') {
    if (!shotDir) {
      shotDir = path.join(os.tmpdir(), 'dsh-strong-desktop-shots-' + process.pid);
      await fs.mkdir(shotDir, { recursive: true });
    }
    await pruneShots();
    const file = path.join(shotDir, 'shot-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.jpg');
    const value = await request(root, { action: 'screenshot', path: file, quality: args.quality ?? 78 }, signal);
    const size = await fs.stat(file);
    return { action, screenshot: { path: file, mediaType: 'image/jpeg', width: value.Width, height: value.Height, bytes: size.size } };
  }
  if (action === 'windows') {
    const windows = await request(root, { action: 'windows' }, signal);
    const list = (Array.isArray(windows) ? windows : []).map(normalizeWindow).filter(Boolean);
    return { action, active: list.find(window => window.active) || null, windows: list.slice(0, 80) };
  }
  if (action === 'cursor') {
    return { action, cursor: normalizePoint(await request(root, { action: 'cursor' }, signal)) };
  }
  if (action === 'move') {
    if (!hasPoint(args)) throw new WorkspaceError('INVALID_ARGUMENTS', 'move 需要 x 和 y。');
    return { action, cursor: normalizePoint(await request(root, { action: 'move', x: args.x, y: args.y }, signal)) };
  }
  if (action === 'click') {
    const has = hasPoint(args);
    const cursor = await request(root, { action: 'click', x: has ? args.x : 0, y: has ? args.y : 0, usePoint: has, button: args.button ?? 'left', clickCount: args.clickCount ?? 1 }, signal);
    return { action, cursor: normalizePoint(cursor), button: args.button ?? 'left', clickCount: args.clickCount ?? 1 };
  }
  if (action === 'drag') {
    if (!Number.isFinite(args.x) || !Number.isFinite(args.y) || !Number.isFinite(args.toX) || !Number.isFinite(args.toY)) throw new WorkspaceError('INVALID_ARGUMENTS', 'drag 需要 x、y、toX、toY。');
    const cursor = await request(root, { action: 'drag', x: args.x, y: args.y, toX: args.toX, toY: args.toY, button: args.button ?? 'left', steps: 12 }, signal);
    return { action, cursor: normalizePoint(cursor), from: { x: args.x, y: args.y }, to: { x: args.toX, y: args.toY } };
  }
  if (action === 'scroll') {
    const has = hasPoint(args);
    const cursor = await request(root, { action: 'scroll', x: has ? args.x : 0, y: has ? args.y : 0, usePoint: has, delta: args.delta ?? -3 }, signal);
    return { action, cursor: normalizePoint(cursor), delta: args.delta ?? -3 };
  }
  if (action === 'type') {
    const text = args.text ?? '';
    const cursor = await request(root, { action: 'type', text }, signal);
    return { action, characters: text.length, cursor: normalizePoint(cursor) };
  }
  if (action === 'press') {
    if (!args.key) throw new WorkspaceError('INVALID_ARGUMENTS', 'press 需要 key。');
    const cursor = await request(root, { action: 'press', key: args.key }, signal);
    return { action, key: args.key, cursor: normalizePoint(cursor) };
  }
  if (['activate', 'minimize', 'maximize', 'restore', 'close'].includes(action)) {
    if (!args.target && !args.hwnd) throw new WorkspaceError('INVALID_ARGUMENTS', action + ' 需要 target 或 hwnd。');
    const window = await request(root, { action, target: args.target ?? '', hwnd: args.hwnd ?? 0 }, signal);
    return { action, window: normalizeWindow(window) };
  }
  throw new WorkspaceError('INVALID_ARGUMENTS', '未知桌面操作：' + action);
}

export async function closeDesktopSession() {
  if (session) await stopSession(session);
  sessionPromise = null;
  requestChain = Promise.resolve();
}

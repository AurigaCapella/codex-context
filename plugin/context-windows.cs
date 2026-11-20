using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public sealed class ContextWindows : IDisposable
{
    public const int ChangeMessage = 0x83B2;
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect
    {
        public int Left, Top, Right, Bottom;
        public int Width => Right - Left;
        public int Height => Bottom - Top;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo
    {
        public int Size;
        public Rect Bounds, WorkArea;
        public uint Flags;
    }

    private delegate bool WindowCallback(IntPtr hwnd, IntPtr parameter);
    private delegate void WinEventCallback(IntPtr hook, uint type, IntPtr hwnd, int objectId, int childId, uint thread, uint time);
    private readonly WinEventCallback onEvent;
    private readonly IntPtr foregroundHook;
    private readonly IntPtr focusHook;
    private readonly IntPtr widget;
    private IntPtr chatWindow;
    private bool dirty = true;

    public ContextWindows(IntPtr widget)
    {
        this.widget = widget;
        onEvent = OnEvent;
        foregroundHook = SetWinEventHook(3, 3, IntPtr.Zero, onEvent, 0, 0, 0);
        focusHook = SetWinEventHook(0x8005, 0x8005, IntPtr.Zero, onEvent, 0, 0, 2);
    }

    public void Invalidate()
    {
        if (dirty) return;
        dirty = true;
        PostMessageW(widget, ChangeMessage, IntPtr.Zero, IntPtr.Zero);
    }
    public bool TakeChange()
    {
        bool changed = dirty;
        dirty = false;
        return changed;
    }

    private void OnEvent(IntPtr hook, uint type, IntPtr hwnd, int objectId, int childId, uint thread, uint time)
    {
        if (type == 3 || (chatWindow != IntPtr.Zero && GetAncestor(hwnd, 2) == chatWindow)) Invalidate();
    }

    public IntPtr SelectMainWindow(IntPtr previous)
    {
        IntPtr foreground = GetAncestor(GetForegroundWindow(), 2);
        IntPtr selected = IntPtr.Zero;
        if (IsCodexMainWindow(foreground))
        {
            selected = foreground;
        }
        else if (IsCodexMainWindow(previous))
        {
            selected = previous;
        }
        else
        {
            EnumWindows((hwnd, _) =>
            {
                if (!IsCodexMainWindow(hwnd)) return true;
                selected = hwnd;
                return false;
            }, IntPtr.Zero);
        }
        chatWindow = selected;
        return selected;
    }

    private static bool IsCodexMainWindow(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !IsWindowVisible(hwnd) || GetWindow(hwnd, 4) != IntPtr.Zero) return false;
        int style = GetWindowLongW(hwnd, -20);
        if ((style & (0x80 | 0x08000000)) != 0) return false; // TOOLWINDOW, NOACTIVATE
        if (DwmGetWindowAttribute(hwnd, 14, out int cloaked, 4) == 0 && cloaked != 0) return false;
        var name = new StringBuilder(40);
        if (GetClassNameW(hwnd, name, name.Capacity) == 0 || name.ToString() != "Chrome_WidgetWin_1") return false;
        try
        {
            using (var process = Process.GetProcessById((int)ProcessId(hwnd)))
            {
                string path = process.MainModule?.FileName ?? "";
                return (process.ProcessName.Equals("ChatGPT", StringComparison.OrdinalIgnoreCase) ||
                        process.ProcessName.Equals("Codex", StringComparison.OrdinalIgnoreCase)) &&
                       (path.IndexOf(@"\OpenAI.Codex_", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        path.IndexOf(@"\OpenAI\Codex\", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        path.IndexOf(@"\Programs\Codex\", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        process.ProcessName.Equals("Codex", StringComparison.OrdinalIgnoreCase));
            }
        }
        catch (ArgumentException) { return false; }
        catch (InvalidOperationException) { return false; }
        catch (System.ComponentModel.Win32Exception) { return false; }
    }

    public static uint ProcessId(IntPtr hwnd)
    {
        GetWindowThreadProcessId(hwnd, out uint pid);
        return pid;
    }

    public static bool ReadBounds(IntPtr hwnd, out Rect bounds)
    {
        if (DwmGetWindowAttribute(hwnd, 9, out bounds, Marshal.SizeOf<Rect>()) == 0) return true;
        IntPtr before = SetThreadDpiAwarenessContext(new IntPtr(-4));
        try { return GetWindowRect(hwnd, out bounds); }
        finally { if (before != IntPtr.Zero) SetThreadDpiAwarenessContext(before); }
    }

    public static bool ReadWorkArea(IntPtr hwnd, out Rect area)
    {
        var monitor = hwnd == IntPtr.Zero ? MonitorFromPoint(new Point(), 1) : MonitorFromWindow(hwnd, 2);
        var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        bool found = GetMonitorInfoW(monitor, ref info);
        area = info.WorkArea;
        return found;
    }

    public static void Move(IntPtr hwnd, int x, int y)
    {
        IntPtr before = SetThreadDpiAwarenessContext(new IntPtr(-4));
        try { SetWindowPos(hwnd, IntPtr.Zero, x, y, 0, 0, 0x15); }
        finally { if (before != IntPtr.Zero) SetThreadDpiAwarenessContext(before); }
    }

    public static void HideFromTaskbar(IntPtr hwnd)
    {
        int style = GetWindowLongW(hwnd, -20);
        int flags = (style & ~0x00040000) | 0x80;
        if (flags == style) return;
        SetWindowLongW(hwnd, -20, flags);
        SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, 0x37);
    }

    public static void SetTopmost(IntPtr hwnd, bool enabled)
    {
        bool current = (GetWindowLongW(hwnd, -20) & 0x00000008) != 0;
        if (current == enabled) return;
        SetWindowPos(hwnd, new IntPtr(enabled ? -1 : -2), 0, 0, 0, 0, 0x13);
    }

    public void Dispose()
    {
        if (foregroundHook != IntPtr.Zero) UnhookWinEvent(foregroundHook);
        if (focusHook != IntPtr.Zero) UnhookWinEvent(focusHook);
    }

    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr hwnd, StringBuilder name, int size);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out Rect bounds);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromPoint(Point point, uint flags);
    [DllImport("user32.dll")] private static extern bool GetMonitorInfoW(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] private static extern int GetWindowLongW(IntPtr hwnd, int index);
    [DllImport("user32.dll")] private static extern int SetWindowLongW(IntPtr hwnd, int index, int value);
    [DllImport("user32.dll")] private static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventCallback callback, uint pid, uint thread, uint flags);
    [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] private static extern bool PostMessageW(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, uint attribute, out int value, int size);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, uint attribute, out Rect value, int size);
}

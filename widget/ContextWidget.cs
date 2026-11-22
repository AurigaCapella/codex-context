using System.Diagnostics;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Threading;

namespace CodexContext;

internal sealed partial class ContextWidget : IDisposable
{
    [Flags]
    private enum RefreshWork { None = 0, Metrics = 1, Threads = 2, Appearance = 4, All = 7 }

    private readonly LaunchOptions options;
    private readonly Window window;
    private readonly ContextClient client;
    private readonly DispatcherTimer fallback = new();
    private readonly DispatcherTimer chatProbe = new() { Interval = TimeSpan.FromSeconds(8) };
    private ContextWindows? windows;
    private WidgetMailbox? mailbox;
    private TrayIcon? tray;
    private nint handle, codexWindow;
    private bool locked, followChat = true, probingChat, listening, running, refreshing;
    private bool loaded;
    private string? selected, detected, metricRevision;
    private RefreshWork pending;
    private long lastMetrics, lastChatProbe;
    private DateTime noticeUntil;
    private CancellationTokenSource? viewLife, eventLife;
    private ThreadChoice[] threads = [];
    private Dictionary<string, string> titles = new(StringComparer.Ordinal);
    private JsonElement appearance;
    private Inspector? inspector;

    private sealed record ThreadChoice(string Id, string Label);

    internal ContextWidget(Window window, LaunchOptions options)
    {
        this.window = window;
        this.options = options;
        client = new ContextClient(options.Port);
        locked = !options.Detached;
        selected = options.ThreadId;
        fallback.Tick += (_, _) => Queue(RefreshWork.Metrics | RefreshWork.Appearance |
            (NeedsThreads() ? RefreshWork.Threads : RefreshWork.None));
        chatProbe.Tick += async (_, _) => await IdentifyChat();
        Find<Button>("Dock").Click += (_, _) => SetLock(!locked);
        Find<Button>("Expand").Click += (_, _) => ToggleInspector();
        Find<Button>("Hide").Click += (_, _) => Hide();
        Find<Button>("CloseWindow").Click += (_, _) => window.Close();
        Find<FrameworkElement>("DragArea").MouseLeftButtonDown += (_, _) =>
        {
            if (locked) SetLock(false);
            try { window.DragMove(); }
            catch (InvalidOperationException) { }
        };
        window.SourceInitialized += (_, _) =>
        {
            handle = new WindowInteropHelper(window).Handle;
            ContextWindows.HideFromTaskbar(handle);
            windows = new ContextWindows(handle);
            windows.TakeChange();
            HwndSource.FromHwnd(handle)?.AddHook(WndProc);
            var area = SystemParameters.WorkArea;
            Layout(area.Width, area.Height);
            window.Left = area.Left + (area.Width - window.Width) / 2;
            window.Top = area.Top + 8;
        };
        window.SizeChanged += (_, _) => { if (locked) windows?.Invalidate(); };
        window.Loaded += (_, _) =>
        {
            if (loaded) return;
            loaded = true;
            SetLock(locked);
            ApplyAppearance(appearance);
            Resume();
            tray = new TrayIcon(() => window.IsVisible, Show, Hide, window.Close);
            if (options.ReadyEvent is not null)
            {
                using var ready = EventWaitHandle.OpenExisting(options.ReadyEvent);
                ready.Set();
            }
        };
        window.Closed += (_, _) => Pause();
        if (!options.Probe && options.MailboxName is not null)
            mailbox = new WidgetMailbox(options.MailboxName, Environment.ProcessId,
                command => Post(() => OnMailbox(command)));
    }

    private T Find<T>(string name) where T : class => (T)window.FindName(name);
    private ContentControl InspectorHost => Find<ContentControl>("Inspector");
    private TextBlock Caption => Find<TextBlock>("ThreadCaption");
    private TextBlock Status => Find<TextBlock>("Status");

    internal void Probe()
    {
        using var pane = new Inspector(this, (FrameworkElement)((DataTemplate)window.FindResource("InspectorTemplate")).LoadContent());
        Console.WriteLine("WPF 状态栏与检查面板已加载");
    }

    private void Post(Action action)
    {
        if (!window.Dispatcher.HasShutdownStarted) window.Dispatcher.BeginInvoke(action);
    }

    private nint WndProc(nint hwnd, int message, nint wParam, nint lParam, ref bool handled)
    {
        if (message == ContextWindows.ChangeMessage && windows?.TakeChange() == true && window.IsVisible)
        {
            PlaceLocked();
            UpdateForeground();
        }
        else if (message is 0x007E or 0x001A or 0x02E0)
        {
            windows?.Invalidate();
            if (message == 0x001A && viewLife is not null) ApplyAppearance(appearance);
        }
        return 0;
    }

    private void Layout(double width, double height)
    {
        bool expanded = inspector is not null;
        window.Width = Math.Clamp(width - 14, window.MinWidth, expanded ? 545 : 1024);
        var ribbon = Find<WrapPanel>("Metrics");
        bool stacked = expanded || window.Width < 820;
        Grid.SetRow(ribbon, stacked ? 1 : 0);
        Grid.SetColumn(ribbon, stacked ? 0 : 1);
        Grid.SetColumnSpan(ribbon, stacked ? 3 : 1);
        ribbon.HorizontalAlignment = stacked ? HorizontalAlignment.Left : HorizontalAlignment.Center;
        window.SizeToContent = expanded ? SizeToContent.Manual : SizeToContent.Height;
        if (expanded) window.Height = Math.Clamp(height - 16, 200, 585);
    }

    private void PlaceLocked()
    {
        if (!locked || !window.IsVisible || handle == 0) return;
        ContextWindows.SetTopmost(handle, true);
        if (!ContextWindows.ReadWorkArea(0, out var area)) return;
        double scale = Math.Max(1, ContextWindows.GetDpiForWindow(handle) / 96.0);
        Layout(area.Width / scale, area.Height / scale);
        if (!ContextWindows.ReadBounds(handle, out var frame)) return;
        int left = Math.Max(area.Left, (area.Left + area.Right - frame.Width) / 2);
        int top = area.Top + (int)Math.Round(scale * 8);
        if (left != frame.Left || top != frame.Top) ContextWindows.Move(handle, left, top);
    }

    private void SetLock(bool enabled)
    {
        locked = enabled;
        window.Topmost = enabled && window.IsVisible;
        if (handle != 0) ContextWindows.SetTopmost(handle, window.Topmost);
        Find<Button>("Dock").Content = enabled ? "已锁定" : "锁定";
        PlaceLocked();
    }

    private void Hide()
    {
        CloseInspector();
        Pause();
        window.Topmost = false;
        ContextWindows.SetTopmost(handle, false);
        window.Hide();
    }

    private void OnMailbox(string command)
    {
        if (command[0] == 'D') SetLock(false);
        if (command.Length > 1) SelectThread(command[1..].ToLowerInvariant());
        Show();
    }

    private void Show()
    {
        if (window.IsVisible) return;
        window.Show();
        SetLock(locked);
        Resume();
    }

    private void Resume()
    {
        if (viewLife is not null) return;
        viewLife = new CancellationTokenSource();
        SetFallback();
        fallback.Start();
        Subscribe();
        UpdateForeground();
        Queue(RefreshWork.All);
    }

    private void Pause()
    {
        fallback.Stop();
        chatProbe.Stop();
        Cancel(ref eventLife);
        Cancel(ref viewLife);
        listening = false;
        pending = RefreshWork.None;
    }

    private static void Cancel(ref CancellationTokenSource? source)
    {
        source?.Cancel();
        source?.Dispose();
        source = null;
    }

    private void SetFallback() => fallback.Interval = TimeSpan.FromSeconds(listening ? (running ? 8 : 20) : (running ? 1 : 3));

    private void Subscribe()
    {
        Cancel(ref eventLife);
        if (viewLife is null) return;
        eventLife = CancellationTokenSource.CreateLinkedTokenSource(viewLife.Token);
        var token = eventLife.Token;
        _ = client.Listen(selected, topics => Post(() =>
        {
            if (token.IsCancellationRequested) return;
            var work = RefreshWork.None;
            foreach (string topic in topics)
                work |= topic switch
                {
                    "metrics" => RefreshWork.Metrics,
                    "threads" => NeedsThreads() ? RefreshWork.Threads | RefreshWork.Metrics : RefreshWork.Metrics,
                    "appearance" => RefreshWork.Appearance,
                    "refresh" => RefreshWork.Metrics | RefreshWork.Appearance |
                        (NeedsThreads() ? RefreshWork.Threads : RefreshWork.None),
                    _ => RefreshWork.None
                };
            Queue(work);
        }), connected => Post(() =>
        {
            if (token.IsCancellationRequested) return;
            listening = connected;
            SetFallback();
            if (!connected) Queue(RefreshWork.Metrics);
        }), token);
    }

    private bool NeedsThreads() => selected is null || inspector is not null || FollowingForeground();
    private bool FollowingForeground() => followChat && codexWindow != 0 && ContextWindows.GetForegroundWindow() == codexWindow;

    private void UpdateForeground()
    {
        if (windows is null || viewLife is null || !followChat) return;
        var owner = windows.SelectMainWindow(codexWindow);
        if (owner != codexWindow)
        {
            codexWindow = owner;
            detected = null;
            lastChatProbe = 0;
            UpdateHint();
        }
        if (!FollowingForeground()) { chatProbe.Stop(); return; }
        if (!chatProbe.IsEnabled)
        {
            chatProbe.Start();
            Queue(RefreshWork.Threads);
        }
        _ = IdentifyChat();
    }

    private async Task IdentifyChat()
    {
        if (probingChat || viewLife is null || !FollowingForeground() || titles.Count == 0 ||
            (lastChatProbe != 0 && Stopwatch.GetElapsedTime(lastChatProbe) < TimeSpan.FromMilliseconds(700))) return;
        var owner = codexWindow;
        var token = viewLife.Token;
        probingChat = true;
        lastChatProbe = Stopwatch.GetTimestamp();
        try
        {
            string? id = await ComposerAnchor.ReadThreadAsync(owner, titles);
            if (token.IsCancellationRequested || owner != codexWindow || !FollowingForeground()) return;
            detected = id;
            if (id is not null) SelectThread(id);
            UpdateHint();
        }
        catch (Exception error) when (error is InvalidOperationException or UnauthorizedAccessException or
            System.Runtime.InteropServices.COMException or System.Windows.Automation.ElementNotAvailableException) { }
        finally { probingChat = false; }
    }

    private void SelectThread(string id)
    {
        if (selected == id) return;
        selected = id;
        metricRevision = null;
        lastMetrics = 0;
        Caption.Text = "正在切换会话";
        RenderMetrics(default);
        inspector?.ChangeThread(id);
        Subscribe();
        Queue(RefreshWork.Metrics);
    }

    private void UpdateHint()
    {
        string hint = !followChat ? "手动选择" : selected is not null && detected == selected ? "跟随聊天" : "尚未确认桌面当前聊天";
        Caption.ToolTip = $"{Caption.Text} · {hint}";
    }

    private void Notice(string message, bool explicitNotice = false)
    {
        if (explicitNotice) noticeUntil = DateTime.UtcNow.AddSeconds(5);
        if (explicitNotice || DateTime.UtcNow >= noticeUntil) Status.Text = message;
    }

    private void Queue(RefreshWork work)
    {
        if (viewLife is null || work == RefreshWork.None) return;
        pending |= work;
        if (!refreshing) _ = Drain();
    }

    private async Task Drain()
    {
        refreshing = true;
        try
        {
            while (pending != RefreshWork.None && viewLife is { } life)
            {
                var task = pending;
                pending = RefreshWork.None;
                var token = life.Token;
                await Task.WhenAll(
                    task.HasFlag(RefreshWork.Metrics) ? RefreshMetrics(token) : Task.CompletedTask,
                    task.HasFlag(RefreshWork.Threads) ? RefreshThreads(token) : Task.CompletedTask,
                    task.HasFlag(RefreshWork.Appearance) ? RefreshAppearance(token) : Task.CompletedTask);
            }
        }
        finally
        {
            refreshing = false;
            if (pending != RefreshWork.None && viewLife is not null) _ = Drain();
        }
    }

    private async Task RefreshMetrics(CancellationToken token)
    {
        if (selected is not { } id) return;
        try
        {
            if (lastMetrics != 0)
            {
                var wait = TimeSpan.FromMilliseconds(750) - Stopwatch.GetElapsedTime(lastMetrics);
                if (wait > TimeSpan.Zero) await Task.Delay(wait, token);
            }
            if (id != selected) return;
            lastMetrics = Stopwatch.GetTimestamp();
            var data = await client.Read(ContextClient.Query("thread-metrics", id), token);
            if (token.IsCancellationRequested || id != selected) return;
            bool generating = data.Str("latestState") == "running";
            if (running != generating)
            {
                running = generating;
                SetFallback();
            }
            string? revision = data.Str("revision");
            if (metricRevision != revision)
            {
                metricRevision = revision;
                Caption.Text = data.Get("thread").Str("title") ?? id;
                UpdateHint();
                RenderMetrics(data);
            }
            Notice(listening ? "本地日志 · 变更时刷新" : "本地日志 · 定时刷新");
            inspector?.RequestSummary(id, revision);
        }
        catch (Exception error) { Report(error, token); }
    }

    private async Task RefreshThreads(CancellationToken token)
    {
        try
        {
            var data = await client.Read("/api/threads", token);
            if (token.IsCancellationRequested) return;
            var items = new List<ThreadChoice>();
            var catalog = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var item in data.Items())
            {
                if (item.Str("id") is not { } id) continue;
                var title = item.Str("title");
                if (title is not null && !catalog.TryAdd(title, id)) catalog[title] = "";
                items.Add(new ThreadChoice(id, (title ?? id[..8]) + (item.Flag("archived") ? " · 已归档" : "")));
            }
            titles = catalog;
            if (!threads.SequenceEqual(items)) threads = [.. items];
            if (selected is null && threads.Length > 0) SelectThread(threads[0].Id);
            inspector?.UpdateThreads(threads, selected);
            _ = IdentifyChat();
        }
        catch (Exception error) { Report(error, token); }
    }

    private async Task RefreshAppearance(CancellationToken token)
    {
        try
        {
            var data = await client.Read("/api/appearance", token);
            if (token.IsCancellationRequested) return;
            appearance = data;
            ApplyAppearance(data);
        }
        catch (Exception error) { Report(error, token); }
    }

    private void Report(Exception error, CancellationToken token)
    {
        if (!token.IsCancellationRequested)
            Notice(error is OperationCanceledException ? "读取本地服务超时" : error.Message);
    }

    private void ToggleInspector()
    {
        if (inspector is not null) { CloseInspector(); return; }
        var view = (FrameworkElement)((DataTemplate)window.FindResource("InspectorTemplate")).LoadContent();
        inspector = new Inspector(this, view);
        InspectorHost.Content = view;
        InspectorHost.Visibility = Visibility.Visible;
        inspector.UpdateThreads(threads, selected);
        if (selected is not null) inspector.RequestSummary(selected, metricRevision);
        Queue(RefreshWork.Threads);
        RenderInspectorLayout();
    }

    private void CloseInspector()
    {
        if (inspector is null) return;
        inspector.Dispose();
        inspector = null;
        InspectorHost.Content = null;
        InspectorHost.Visibility = Visibility.Collapsed;
        RenderInspectorLayout();
    }

    private void RenderInspectorLayout()
    {
        bool expanded = inspector is not null;
        Find<Button>("Expand").Content = expanded ? "收起" : "展开";
        Find<Border>("Shell").SetResourceReference(Border.BackgroundProperty, expanded ? "InspectorBackground" : "RibbonBackground");
        if (ContextWindows.ReadWorkArea(locked ? 0 : handle, out var area))
        {
            double scale = Math.Max(1, ContextWindows.GetDpiForWindow(handle) / 96.0);
            Layout(area.Width / scale, area.Height / scale);
        }
        PlaceLocked();
    }

    public void Dispose()
    {
        Pause();
        tray?.Dispose();
        inspector?.Dispose();
        windows?.Dispose();
        mailbox?.Dispose();
        client.Dispose();
    }
}

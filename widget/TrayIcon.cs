using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace CodexContext;

internal sealed class TrayIcon : IDisposable
{
    private readonly Icon artwork;
    private readonly ContextMenuStrip menu = new();
    private readonly NotifyIcon icon;

    internal TrayIcon(Func<bool> visible, Action show, Action hide, Action exit)
    {
        using var stream = typeof(TrayIcon).Assembly.GetManifestResourceStream("ContextWidget.Tray.ico")
            ?? throw new InvalidDataException("找不到状态栏托盘图标");
        using var embedded = new Icon(stream);
        artwork = (Icon)embedded.Clone();

        var showItem = menu.Items.Add("显示状态栏");
        var hideItem = menu.Items.Add("隐藏状态栏");
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出状态栏", null, (_, _) => exit());
        showItem.Click += (_, _) => show();
        hideItem.Click += (_, _) => hide();
        menu.Opening += (_, _) =>
        {
            bool shown = visible();
            showItem.Enabled = !shown;
            hideItem.Enabled = shown;
        };
        icon = new NotifyIcon
        {
            Icon = artwork,
            Text = $"Codex Context · PID {Environment.ProcessId}",
            ContextMenuStrip = menu,
        };
        icon.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) show(); };
        icon.Visible = true;
    }

    public void Dispose()
    {
        icon.Dispose();
        menu.Dispose();
        artwork.Dispose();
    }
}

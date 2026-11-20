using System.IO;
using System.Windows;
using System.Windows.Markup;

namespace CodexContext;

internal sealed record LaunchOptions(int Port, string? ThreadId, bool Detached, string? ReadyEvent, string? MailboxName, bool Probe)
{
    internal static LaunchOptions Parse(string[] args)
    {
        int port = 47371;
        string? thread = null, ready = null, mailbox = null;
        bool detached = false, probe = false;
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "-Port": port = int.Parse(args[++i]); break;
                case "-ThreadId": thread = Guid.ParseExact(args[++i], "D").ToString(); break;
                case "-ReadyEvent": ready = args[++i]; break;
                case "-MailboxName": mailbox = args[++i]; break;
                case "-Detached": detached = true; break;
                case "-Probe": probe = true; break;
                default: throw new ArgumentException($"无法识别的启动选项 {args[i]}");
            }
        }
        if (port is < 1024 or > 65535) throw new ArgumentOutOfRangeException(nameof(port));
        return new LaunchOptions(port, thread, detached, ready, mailbox, probe);
    }
}

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            var options = LaunchOptions.Parse(args);
            using var layout = typeof(Program).Assembly.GetManifestResourceStream("ContextWidget.Layout.xaml")
                ?? throw new InvalidDataException("找不到状态栏布局");
            var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
            var window = (Window)XamlReader.Load(layout);
            using var widget = new ContextWidget(window, options);
            if (options.Probe)
            {
                widget.Probe();
                return 0;
            }
            return app.Run(window);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
    }
}

using System.Globalization;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Microsoft.Win32;

namespace CodexContext;

internal sealed partial class ContextWidget
{
    private const string Empty = "—";
    private static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;
    private string? paletteKey;

    private static string Token(double? value) => value?.ToString("N0", Invariant) ?? Empty;
    private static string Compact(double? value) => value switch
    {
        >= 1_000_000 => (value.Value / 1_000_000).ToString("0.##", Invariant) + "M",
        >= 10_000 => (value.Value / 1000).ToString("0", Invariant) + "K",
        >= 1_000 => (value.Value / 1000).ToString("0.#", Invariant) + "K",
        _ => Token(value)
    };
    private static string Usage(JsonElement usage) => usage.Exists()
        ? $"输入 {Token(usage.Num("input"))}  ·  输出 {Token(usage.Num("output"))}  ·  缓存 {Token(usage.Num("cached"))}"
        : "暂无单轮用量";
    private static string Cost(double? usd) => usd is double price ? "$" + price.ToString("0.0000", Invariant) : Empty;
    private static string State(string? status) => status switch
    {
        "complete" => "已完成", "running" => "进行中", "interrupted" => "已中断", _ => Empty
    };

    private void RenderMetrics(JsonElement data)
    {
        var price = data.Get("apiEstimate");
        var rounds = Find<TextBlock>("Rounds");
        rounds.Text = data.Exists() ? $"{data.Num("roundCount")}/{price.Num("total")}" : Empty;
        var speed = Find<TextBlock>("Speed");
        var first = Find<TextBlock>("FirstToken");
        var firstLabel = Find<TextBlock>("FirstTokenLabel");
        speed.Text = first.Text = Empty;
        speed.ToolTip = first.ToolTip = null;
        firstLabel.Text = "TTFT";
        var timing = data.Get("timing");
        if (timing.Exists())
        {
            string when = timing.Str("id") == data.Str("latestTurnId") ? "本轮" : "最近有计时的轮次";
            double? delay = timing.Num("ttft") ?? timing.Num("firstTextDelayMs");
            if (delay is double ms)
            {
                first.Text = (timing.Num("ttft") is null ? "≈" : "") + FormattableString.Invariant($"{ms / 1000:F2}s");
                first.ToolTip = $"{when}的 TTFT。≈ 为首段文本日志推算。";
            }
            if (timing.Num("outputWindowMs") is > 0 and double span && timing.Num("output") is double output)
            {
                speed.Text = FormattableString.Invariant($"≈{output * 1000 / span:F1}");
                speed.ToolTip = $"{when}的有效 TPS。生成中按最近已记账请求，包含工具等待。";
            }
        }
        var live = data.Get("providerLive");
        if (live.Num("ttftMs") is double gatewayMs)
        {
            firstLabel.Text = "首文";
            first.Text = FormattableString.Invariant($"{gatewayMs / 1000:F2}s");
            first.ToolTip = "当前请求从转发到第一个可见文本增量的时间";
        }
        if (live.Num("textTps") is double liveSpeed)
        {
            speed.Text = FormattableString.Invariant($"≈{liveSpeed:F1}");
            speed.ToolTip = "根据上游已返回的可见文本 Token 和接收时间估计";
        }
        Find<TextBlock>("RunState").Text = State(data.Str("latestState"));
        var usage = data.Get("cumulative");
        var tokens = Find<TextBlock>("Tokens");
        tokens.Text = Compact(usage.Num("total"));
        tokens.ToolTip = Usage(usage);
        Find<TextBlock>("Cache").Text = usage.Num("input") is > 0 and double input && usage.Num("cached") is double cached
            ? (cached / input).ToString("P1", CultureInfo.CurrentCulture) : Empty;
        var estimate = Find<TextBlock>("Cost");
        estimate.Text = Cost(price.Num("usd"));
        estimate.ToolTip = $"API Standard · USD · 已估算 {price.Num("priced")} / {price.Num("total")} 个请求步";
        Find<TextBlock>("CostLabel").Text = price.Num("usd") is not null && price.Num("priced") < price.Num("total") ? "估费*" : "估费";
        double? used = data.Num("contextSize"), capacity = data.Num("windowSize");
        double? ratio = capacity > 0 ? used / capacity : null;
        var context = Find<TextBlock>("ContextSize");
        context.Text = ratio is double portion ? $"{portion:P1} {Compact(used)}" : Compact(used);
        context.ToolTip = $"{Token(used)} / {Token(capacity)} Token";
        Find<ProgressBar>("ContextProgress").Value = Math.Clamp(100 * (ratio ?? 0), 0, 100);
    }

    private static Color Mix(Color from, Color to, double amount, byte alpha = 255) =>
        Color.FromArgb(alpha,
            (byte)Math.Round(from.R + (to.R - from.R) * amount),
            (byte)Math.Round(from.G + (to.G - from.G) * amount),
            (byte)Math.Round(from.B + (to.B - from.B) * amount));

    private static double Luminance(Color color) => 0.2126 * color.ScR + 0.7152 * color.ScG + 0.0722 * color.ScB;

    private static Color Readable(Color candidate, Color surface, Color fallback)
    {
        double light = Luminance(surface);
        for (double amount = 0; amount < 1; amount += 0.25)
        {
            var color = Mix(candidate, fallback, amount);
            double current = Luminance(color);
            if ((Math.Max(light, current) + 0.05) / (Math.Min(light, current) + 0.05) >= 4.5) return color;
        }
        return fallback;
    }

    private void ApplyAppearance(JsonElement data)
    {
        string mode = data.Str("mode") ?? "system";
        if (mode is not ("light" or "dark"))
        {
            object? system = Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", 1);
            mode = system is 0 ? "dark" : "light";
        }
        var palette = data.Get(mode);
        var preferred = (palette.Str("surface"), palette.Str("ink"), palette.Str("accent"));
        string key = $"{mode}/{preferred}";
        if (key == paletteKey) return;
        var defaults = mode == "light" ? ("#FFFFFF", "#1A1C1F", "#2464BD") : ("#212121", "#F1F1F1", "#8CB9FF");
        Color surface = (Color)ColorConverter.ConvertFromString(preferred.Item1 ?? defaults.Item1);
        Color ink = Readable((Color)ColorConverter.ConvertFromString(preferred.Item2 ?? defaults.Item2), surface,
            Luminance(surface) < 0.179 ? Colors.White : Colors.Black);
        Color accent = (Color)ColorConverter.ConvertFromString(preferred.Item3 ?? defaults.Item3);
        Dictionary<string, Color> colors = new()
        {
            ["RibbonBackground"] = Mix(surface, ink, 0, 222),
            ["InspectorBackground"] = Mix(surface, ink, 0, 246),
            ["ThemeText"] = ink,
            ["ThemeMuted"] = Readable(Mix(surface, ink, 0.7), surface, ink),
            ["ThemeMetric"] = Readable(Mix(ink, accent, 0.24), surface, ink),
            ["ThemeAccent"] = accent,
            ["ThemeAccentText"] = Readable(accent, surface, ink),
            ["ThemeBorder"] = Mix(surface, ink, 0.24),
            ["ThemePanel"] = Mix(surface, ink, 0.025),
            ["ThemeControl"] = Mix(surface, ink, 0.065),
            ["ThemeHover"] = Mix(surface, accent, 0.16),
            ["ThemeSelected"] = Mix(surface, accent, 0.13),
            ["ThemeTrack"] = Mix(surface, accent, 0.32)
        };
        foreach (var (name, color) in colors)
        {
            var brush = new SolidColorBrush(color);
            brush.Freeze();
            window.Resources[name] = brush;
        }
        window.Resources[SystemColors.WindowBrushKey] = window.Resources["ThemeControl"];
        window.Resources[SystemColors.WindowTextBrushKey] = window.Resources["ThemeText"];
        window.Resources[SystemColors.HighlightBrushKey] = window.Resources["ThemeSelected"];
        window.Resources[SystemColors.HighlightTextBrushKey] = window.Resources["ThemeText"];
        paletteKey = key;
    }
}

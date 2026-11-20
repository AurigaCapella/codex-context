using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Data;

namespace CodexContext;

internal sealed partial class ContextWidget
{
    private bool forking;

    private sealed class Inspector : IDisposable
    {
        private sealed record TurnRow(string Id, string Label, string Preview, string Usage, bool CanFork, string BranchLabel, string? Status);
        private sealed record CallRow(string Id, string Turn, string Source, string Label, bool Running);
        private sealed record StepRow(string Key, string Turn, string Label, string? Model, JsonElement Data);

        private readonly ContextWidget owner;
        private readonly FrameworkElement view;
        private readonly CancellationTokenSource lifetime = new();
        private CancellationTokenSource? summaryRequest, detailRequest, instructionRequest;
        private string? thread, requestedRevision, document, detailKey;
        private string modelText = "", schemaRevision = "";
        private bool loadingList, showingFullCall, hasSummary;
        private Dictionary<string, JsonElement> mcp = new(StringComparer.Ordinal);

        internal Inspector(ContextWidget owner, FrameworkElement view)
        {
            this.owner = owner;
            this.view = view;
            thread = owner.selected;
            Get<TextBlock>("InspectorCaption").SetBinding(TextBlock.TextProperty, new Binding("Text") { Source = owner.Caption });
            Get<TextBlock>("InspectorStatus").SetBinding(TextBlock.TextProperty, new Binding("Text") { Source = owner.Status });
            var follow = Get<CheckBox>("FollowChat");
            follow.IsChecked = owner.followChat;
            follow.Checked += (_, _) =>
            {
                owner.followChat = true;
                owner.UpdateHint();
                owner.UpdateForeground();
            };
            follow.Unchecked += (_, _) =>
            {
                owner.followChat = false;
                owner.chatProbe.Stop();
                owner.UpdateHint();
            };
            Get<ComboBox>("Threads").SelectionChanged += (_, _) =>
            {
                if (loadingList || Get<ComboBox>("Threads").SelectedItem is not ThreadChoice item) return;
                follow.IsChecked = false;
                owner.SelectThread(item.Id);
            };
            Get<Button>("OpenCodex").Click += (_, _) =>
            {
                if (Guid.TryParseExact(owner.selected, "D", out var id))
                {
                    try { Process.Start(new ProcessStartInfo($"codex://threads/{id:D}") { UseShellExecute = true }); }
                    catch (System.ComponentModel.Win32Exception error) { owner.Notice(error.Message, true); }
                }
            };
            Get<Button>("Instructions").Click += async (_, _) => await ReadInstructions("instructions");
            Get<Button>("CustomInstructions").Click += async (_, _) => await ReadInstructions("configured-instructions");
            Get<Button>("RefreshMcp").Click += async (_, _) => await RefreshCatalog();
            Get<Button>("RequestContext").Click += async (_, _) => await ToggleRequestContext();
            Get<Button>("FullCall").Click += (_, _) =>
            {
                showingFullCall = !showingFullCall;
                RenderSelection();
            };
            var tabs = Get<TabControl>("InspectionTabs");
            tabs.SelectionChanged += (_, e) => { if (ReferenceEquals(e.Source, tabs)) SelectionChanged(); };
            foreach (string list in new[] { "Turns", "Calls", "Schemas", "Steps" })
                Get<ListBox>(list).SelectionChanged += (_, _) => SelectionChanged();
            Get<ListBox>("Turns").AddHandler(ButtonBase.ClickEvent, new RoutedEventHandler(async (_, e) =>
            {
                if (e.OriginalSource is Button { Tag: string id }) await Fork(id);
            }));
        }

        private T Get<T>(string name) where T : class => (T)view.FindName(name);

        internal void UpdateThreads(ThreadChoice[] available, string? selected)
        {
            loadingList = true;
            var box = Get<ComboBox>("Threads");
            if (!ReferenceEquals(available, box.ItemsSource)) box.ItemsSource = available;
            box.SelectedValue = selected;
            loadingList = false;
        }

        internal void ChangeThread(string id)
        {
            Cancel(ref summaryRequest);
            Cancel(ref detailRequest);
            Cancel(ref instructionRequest);
            thread = id;
            hasSummary = false;
            requestedRevision = detailKey = document = null;
            modelText = schemaRevision = "";
            mcp.Clear();
            schemaNames = [];
            showingRequest = showingFullCall = false;
            loadingList = true;
            foreach (string name in new[] { "Turns", "Calls", "Steps", "Schemas" }) Get<ListBox>(name).ItemsSource = null;
            loadingList = false;
            foreach (string name in new[] { "TurnMessage", "CallDetails", "SchemaDetails", "StepDetails", "ModelDetails" })
                Get<TextBox>(name).Clear();
            foreach (string name in new[] { "Instructions", "CustomInstructions", "RefreshMcp", "OpenCodex", "FullCall", "RequestContext" })
                Get<Button>(name).IsEnabled = false;
            Get<TextBlock>("SchemaStatus").Text = "以下为会话留存的 Schema。";
            UpdateInstructionButtons();
            UpdateThreads(owner.threads, id);
        }

        internal void RequestSummary(string id, string? revision)
        {
            if (thread != id) ChangeThread(id);
            if (revision == requestedRevision && (hasSummary || summaryRequest is not null)) return;
            requestedRevision = revision;
            Cancel(ref summaryRequest);
            summaryRequest = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
            _ = LoadSummary(id, summaryRequest.Token);
        }

        private async Task LoadSummary(string id, CancellationToken token)
        {
            try
            {
                var data = await owner.client.Read(ContextClient.Query("thread-summary", id), token);
                if (token.IsCancellationRequested || thread != id) return;
                RenderSummary(data);
                hasSummary = true;
            }
            catch (Exception error)
            {
                if (!token.IsCancellationRequested)
                {
                    Cancel(ref summaryRequest);
                    requestedRevision = null;
                    owner.Report(error, lifetime.Token);
                }
            }
        }

        private void RenderSummary(JsonElement data)
        {
            List<TurnRow> turns = [];
            List<StepRow> steps = [];
            List<CallRow> calls = [];
            List<string> trend = [];
            HashSet<string> sent = [], received = [];
            JsonElement latest = default;
            foreach (var turn in data.Get("turns").Items())
            {
                if (turn.Str("id") is not { } id) continue;
                latest = turn;
                int n = turns.Count + 1, request = 0;
                var status = turn.Str("state");
                turns.Add(new TurnRow(id, $"第 {n} 轮  ·  {State(status)}", turn.Str("preview") ?? "暂无文本回复",
                    Usage(turn.Get("usage")), status == "complete" && !data.Get("thread").Flag("archived"), $"从第 {n} 轮分支", status));
                foreach (var call in turn.Get("calls").Items())
                    if (call.Str("id") is { } callId && call.Str("source") is { } source)
                        calls.Add(new CallRow(callId, id, source, $"{n}  ·  {call.Str("name")}", status == "running"));
                foreach (var step in turn.Get("steps").Items())
                {
                    request++;
                    string? responseModel = step.Str("responseModel");
                    var label = $"轮 {n}  ·  步 {request}" + (responseModel is null ? "" : $"  ·  {responseModel}");
                    steps.Add(new StepRow($"{id}:{request}", id, label, turn.Str("model"), step));
                    if (responseModel is not null) received.Add(responseModel);
                    if (step.Str("sentModel") is { } model) sent.Add(model);
                    var use = step.Get("usage");
                    if (use.Num("input") + use.Num("output") is double total)
                        trend.Add($"{n}.{request}   {Token(total)} Token");
                }
            }
            var trace = data.Get("providerTrace");
            var live = data.Get("providerLive");
            var lines = new List<string>
            {
                $"配置模型  {latest.Str("model") ?? data.Str("model") ?? Empty}",
                $"服务商     {data.Str("provider") ?? Empty}",
                $"请求模型  {(sent.Count == 0 ? "日志未记录" : string.Join(" / ", sent))}",
                $"响应模型  {(received.Count == 0 ? "日志未记录" : string.Join(" / ", received))}",
                $"最近改派  {latest.Str("rerouted") ?? Empty}"
            };
            if (live.Str("responseModel") is { } liveModel) lines.Add($"流式响应模型  {liveModel}");
            if (trace.Num("matched") is > 0 and double matched) lines.Add($"上游记录  已匹配 {matched} 步");
            if (trace.Str("error") is { } error) lines.Add(error);
            lines.AddRange(["", $"上下文占用  {owner.Find<TextBlock>("ContextSize").ToolTip}", "服务端完整系统提示词未公开。", "", "最近请求用量"]);
            lines.AddRange(trend.TakeLast(12));
            lines.AddRange(data.Get("events").Items().TakeLast(5).Select(item => $"{item.Str("type")}  {item.Str("detail") ?? item.Str("at")}"));
            modelText = string.Join('\n', lines);
            if (document is null) Get<TextBox>("ModelDetails").Text = modelText;
            Get<Button>("Instructions").IsEnabled = data.Flag("hasInstructions");
            Get<Button>("CustomInstructions").IsEnabled = true;
            Get<Button>("RefreshMcp").IsEnabled = true;
            Get<Button>("OpenCodex").IsEnabled = true;
            schemaRevision = trace.Str("version") ?? "";
            schemaNames = data.Get("schemaNames").Items().Select(item => item.String()).OfType<string>().ToArray();
            loadingList = true;
            try
            {
                UpdateList("Turns", turns, item => item.Id);
                UpdateList("Calls", calls, item => (item.Turn, item.Id, item.Source));
                UpdateList("Steps", steps, item => item.Key);
                RefreshSchemaList();
            }
            finally { loadingList = false; }
            RenderSelection(refreshLive: true);
        }

        private void UpdateList<T, TKey>(string name, List<T> items, Func<T, TKey> key)
        {
            var list = Get<ListBox>(name);
            if (list.ItemsSource is IEnumerable<T> old && old.SequenceEqual(items)) return;
            var selected = list.SelectedItem;
            list.ItemsSource = items;
            if (selected is T item)
                list.SelectedItem = items.Find(next => EqualityComparer<TKey>.Default.Equals(key(next), key(item)));
            else if (items.Count > 0) list.ScrollIntoView(items[^1]);
        }

        private string[] schemaNames = [];
        private void RefreshSchemaList() =>
            UpdateList("Schemas", [.. schemaNames.Concat(mcp.Keys.Order(StringComparer.Ordinal))], item => item);

        private void SelectionChanged()
        {
            if (loadingList) return;
            showingFullCall = false;
            RenderSelection();
        }

        private void RenderSelection(bool refreshLive = false)
        {
            if (thread is not { } id) return;
            int tab = Get<TabControl>("InspectionTabs").SelectedIndex;
            var turn = Get<ListBox>("Turns").SelectedItem as TurnRow;
            var call = Get<ListBox>("Calls").SelectedItem as CallRow;
            var step = Get<ListBox>("Steps").SelectedItem as StepRow;
            var schema = Get<ListBox>("Schemas").SelectedItem as string;
            string key = tab switch
            {
                0 => $"turn/{turn?.Id}/{turn?.Status}",
                2 => $"call/{call?.Turn}/{call?.Id}/{call?.Source}/{call?.Running}/{showingFullCall}",
                3 => $"schema/{schema}",
                4 => $"step/{step?.Key}/{schemaRevision}",
                _ => "context"
            };
            bool streaming = tab == 0 && turn?.Status == "running" || tab == 2 && call?.Running == true && !showingFullCall;
            if (tab != 4 && detailKey == key && !(refreshLive && streaming)) return;
            bool newSelection = detailKey != key;
            if (tab != 4 || newSelection) Cancel(ref detailRequest);
            detailKey = key;
            switch (tab)
            {
                case 0 when turn is not null:
                    _ = LoadSelection("TurnMessage", ContextClient.Query("turn", id, ("turn", turn.Id)), data =>
                        string.Join("\n\n", data.Get("messages").Items().Where(message => message.Str("phase") != "commentary")
                        .Select(message => $"{(message.Str("role") == "user" ? "你" : "Codex")}\n{message.Str("text")}")), newSelection);
                    break;
                case 0: Get<TextBox>("TurnMessage").Text = "选择轮次查看正文。"; break;
                case 2 when call is not null:
                    bool full = showingFullCall;
                    if (newSelection) Get<Button>("FullCall").IsEnabled = false;
                    _ = LoadSelection("CallDetails", ContextClient.Query(full ? "call" : "call-preview", id,
                        ("turn", call.Turn), ("call", call.Id), ("source", call.Source)), data =>
                    {
                        var button = Get<Button>("FullCall");
                        button.IsEnabled = full || data.Flag("truncated");
                        button.Content = full ? "返回预览" : "查看完整输出";
                        return full ? data.Get("details").FormatJson() : (data.Str("text") ?? "") +
                            (data.Flag("truncated") ? "\n\n… 预览已截断" : "");
                    }, newSelection);
                    break;
                case 2:
                    Get<TextBox>("CallDetails").Text = "选择工具调用查看详情。";
                    Get<Button>("FullCall").IsEnabled = false;
                    break;
                case 3 when schema is not null && mcp.TryGetValue(schema, out var document):
                    Get<TextBox>("SchemaDetails").Text = document.FormatJson();
                    break;
                case 3 when schema is not null:
                    _ = LoadSelection("SchemaDetails", ContextClient.Query("schema", id, ("name", schema)),
                        data => data.Get("schema").FormatJson(), newSelection);
                    break;
                case 3: Get<TextBox>("SchemaDetails").Clear(); break;
                case 4:
                    if (newSelection) showingRequest = false;
                    RenderStep(step);
                    break;
            }
        }

        private async Task LoadSelection(string name, string path, Func<JsonElement, string> format, bool showLoading)
        {
            Cancel(ref detailRequest);
            detailRequest = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
            var token = detailRequest.Token;
            var output = Get<TextBox>(name);
            if (showLoading) output.Text = "正在读取…";
            try
            {
                var data = await owner.client.Read(path, token);
                if (!token.IsCancellationRequested)
                {
                    string text = format(data);
                    if (output.Text != text) output.Text = text;
                }
            }
            catch (Exception error) { if (!token.IsCancellationRequested) output.Text = error.Message; }
        }

        private static string Model(JsonElement step, string field)
        {
            var name = step.Str(field);
            var source = step.Str(field + "Source");
            return name is null ? "日志未记录" : source is null ? name : $"{name} 〔{source}〕";
        }

        private bool showingRequest;
        private void RenderStep(StepRow? row)
        {
            var button = Get<Button>("RequestContext");
            button.IsEnabled = row?.Data.Flag("hasProviderContext") == true;
            button.Content = showingRequest ? "返回请求用量" : "请求指令与 Schema";
            if (showingRequest) return;
            if (row is null) { Get<TextBox>("StepDetails").Clear(); return; }
            var step = row.Data;
            var gateway = step.Get("gatewayTiming");
            var use = step.Get("usage");
            var estimate = step.Get("apiEstimate");
            var lines = new List<string> { row.Label, $"响应 ID  {step.Str("id") ?? Empty}", $"配置模型  {row.Model ?? Empty}",
                $"请求模型  {Model(step, "sentModel")}", $"响应模型  {Model(step, "responseModel")}" };
            if (gateway.Num("ttftMs") is double ms) lines.Add($"网关首段文本  {ms / 1000} s");
            if (gateway.Num("textSpanMs") is double span) lines.Add($"网关文本流跨度  {span / 1000} s");
            if (gateway.Num("textTps") is double tps) lines.Add($"网关可见文本 TPS  ≈ {tps:F1}");
            if (step.Flag("modelConflict")) lines.Add("本地上游记录与会话记录不一致。");
            if (step.Flag("providerContextConflict")) lines.Add("同一响应 ID 有不一致的请求快照。");
            lines.AddRange(["", Usage(use), $"缓存写入  {Token(use.Num("cacheWrite"))}", $"推理 Token  {Token(use.Num("reasoning"))}",
                $"合计 Token  {Token(use.Num("total"))}",
                estimate.Exists() ? $"API 估算  {Cost(estimate.Num("usd"))} · {estimate.Str("tier")}" : "API 估算  无可用费率或用量"]);
            Get<TextBox>("StepDetails").Text = string.Join('\n', lines);
        }

        private async Task ToggleRequestContext()
        {
            if (thread is not { } id || Get<ListBox>("Steps").SelectedItem is not StepRow row || !row.Data.Flag("hasProviderContext")) return;
            showingRequest = !showingRequest;
            RenderStep(row);
            if (!showingRequest) { Cancel(ref detailRequest); return; }
            await LoadSelection("StepDetails", ContextClient.Query("request-context", id, ("turn", row.Turn), ("response", row.Data.Str("id"))),
                data => $"来源 · 自管网关的用户提供记录\n响应 ID · {row.Data.Str("id")}\n\n请求指令\n" +
                    (data.Get("instructions").String() ?? data.Get("instructions").FormatJson()) +
                    $"\n\nsystem / developer 文本消息\n{data.Get("messages").FormatJson()}\n\n函数与自定义工具 Schema\n{data.Get("tools").FormatJson()}", true);
        }

        private void UpdateInstructionButtons()
        {
            Get<Button>("Instructions").Content = document == "instructions" ? "返回上下文" : "会话指令快照";
            Get<Button>("CustomInstructions").Content = document == "configured-instructions" ? "返回上下文" : "配置的指令文件";
        }

        private async Task ReadInstructions(string kind)
        {
            if (thread is not { } id) return;
            Cancel(ref instructionRequest);
            document = document == kind ? null : kind;
            UpdateInstructionButtons();
            var output = Get<TextBox>("ModelDetails");
            if (document is null)
            {
                output.Text = modelText;
                return;
            }
            instructionRequest = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
            var token = instructionRequest.Token;
            output.Text = "正在读取…";
            try
            {
                var data = await owner.client.Read(ContextClient.Query(kind, id), token);
                if (token.IsCancellationRequested) return;
                output.Text = kind == "instructions" ? $"AGENTS.md 指令快照\n\n{data.Str("text")}" :
                    data.Str("text") is { } text ? $"当前配置文件 · {data.Str("path")}\n\n{text}" :
                    "当前本地配置未设置用户或工作区的 model_instructions_file。";
            }
            catch (Exception error) { if (!token.IsCancellationRequested) output.Text = error.Message; }
        }

        private async Task RefreshCatalog()
        {
            if (thread is not { } id) return;
            var token = lifetime.Token;
            var button = Get<Button>("RefreshMcp");
            var status = Get<TextBlock>("SchemaStatus");
            button.IsEnabled = false;
            status.Text = "正在查询已配置的 MCP 服务器…";
            try
            {
                var data = await owner.client.Read(ContextClient.Query("mcp-schemas", id), token, "list-mcp-schemas");
                if (token.IsCancellationRequested || id != thread) return;
                mcp = data.Get("tools").Items().ToDictionary(tool => $"MCP · {tool.Str("server")} / {tool.Str("name")}", StringComparer.Ordinal);
                RefreshSchemaList();
                var unavailable = string.Join("、", data.Get("unavailable").Items().Select(item => item.String()));
                status.Text = $"{(data.Str("scope") == "workspace" ? "当前本地配置" : "本机配置")} · {mcp.Count} 项 MCP 定义。" +
                    (unavailable.Length == 0 ? "" : $" 无法查询：{unavailable}");
            }
            catch (Exception error) { if (!token.IsCancellationRequested && id == thread) status.Text = $"MCP 查询失败 · {error.Message}"; }
            finally { if (!token.IsCancellationRequested && id == thread) button.IsEnabled = true; }
        }

        private async Task Fork(string turn)
        {
            if (owner.forking || thread is not { } id) return;
            owner.forking = true;
            var turns = Get<ListBox>("Turns");
            turns.IsEnabled = false;
            owner.Notice("正在创建分支…", true);
            try
            {
                var response = await owner.client.Read(ContextClient.Query("fork", id), CancellationToken.None, "fork",
                    new JsonObject { ["lastTurnId"] = turn });
                if (response.Str("id") is not { } branch) return;
                if (owner.selected == id)
                {
                    if (owner.inspector is { } active) active.Get<CheckBox>("FollowChat").IsChecked = false;
                    owner.followChat = false;
                    owner.SelectThread(branch);
                }
                owner.Queue(RefreshWork.Threads);
                owner.Notice($"已创建分支 {branch[..8]}", true);
            }
            catch (Exception error) { owner.Notice($"分支创建失败 · {error.Message}", true); }
            finally { owner.forking = false; turns.IsEnabled = true; }
        }

        public void Dispose()
        {
            Cancel(ref summaryRequest);
            Cancel(ref detailRequest);
            Cancel(ref instructionRequest);
            lifetime.Cancel();
            lifetime.Dispose();
        }
    }
}

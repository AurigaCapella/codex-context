#requires -Version 7.0
param(
    [ValidateRange(1024,65535)][int]$Port = 47371,
    [string]$ThreadId,
    [switch]$Detached,
    [string]$ReadyEvent,
    [string]$MailboxName,
    [switch]$Probe
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase
$layout = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'native.xaml') -Raw -Encoding UTF8
$reader = [System.Xml.XmlReader]::Create([System.IO.StringReader]::new($layout))
try { $window = [Windows.Markup.XamlReader]::Load($reader) } finally { $reader.Dispose() }

$ui = @{}
foreach ($name in ('Shell Metrics DragArea ThreadCaption Expand Dock Hide CloseWindow Rounds Speed FirstTokenLabel FirstToken Tokens Cache CostLabel Cost ContextSize RunState ContextProgress Status Inspector' -split ' ')) {
    $ui[$name] = $window.FindName($name)
    if ($null -eq $ui[$name]) { throw "无法载入界面控件 $name" }
}
$inspectorNames = 'InspectorCaption InspectorStatus InspectionTabs Threads FollowChat OpenCodex Turns TurnMessage Instructions CustomInstructions ModelDetails Calls CallDetails Schemas SchemaDetails SchemaStatus RefreshMcp Steps StepDetails RequestContext' -split ' '
if ($Probe) {
    $panel = $window.FindResource('InspectorTemplate').LoadContent()
    foreach ($name in $inspectorNames) {
        if (-not $panel.FindName($name)) { throw "无法载入详情控件 $name" }
    }
    Write-Output "WPF 可用，已验证 $($ui.Count + $inspectorNames.Count) 个控件"
    return
}

$compiledInterop = $false
$assembly = Join-Path $PSScriptRoot 'ContextInterop.dll'
# The bundled helper targets .NET 10. Older PowerShell releases compile the same source.
if ([Environment]::Version.Major -ge 10 -and (Test-Path -LiteralPath $assembly)) {
    try {
        Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
        Add-Type -Path $assembly
        $compiledInterop = $true
    } catch { }
}
if (-not $compiledInterop) { Add-Type -Path (Join-Path $PSScriptRoot 'context-windows.cs') }

$composerAvailable = $compiledInterop
try {
    if (-not $compiledInterop) {
        Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
        $anchorReferences = @(
            [Windows.Automation.AutomationElement].Assembly.Location
            [Windows.Automation.ControlType].Assembly.Location
            [Windows.Rect].Assembly.Location
            'System.Runtime'
            'System.Threading.Tasks'
            'System.Collections'
        )
        Add-Type -Path (Join-Path $PSScriptRoot 'composer-anchor.cs') -ReferencedAssemblies $anchorReferences
        $composerAvailable = $true
    }
} catch { }

$address = "http://127.0.0.1:$Port"
$http = [System.Net.Http.HttpClient]::new()
$http.Timeout = [TimeSpan]::FromSeconds(26)
$pending = [System.Collections.Generic.List[object]]::new()
$mailbox = $null
if ($MailboxName) {
    if (-not $compiledInterop) { Add-Type -Path (Join-Path $PSScriptRoot 'widget-mailbox.cs') }
    $mailbox = [WidgetMailbox]::new($MailboxName, $PID)
}
$hostWindow = [Windows.Interop.WindowInteropHelper]::new($window)
$script:state = @{
    selected = ([string]$ThreadId).ToLowerInvariant()
    snapshot = $null
    inspectorGeneration = 0
    detailRevision = $null
    metricRevision = $null
    latestState = $null
    capturedStep = $null
    modelText = ''
    instructionKind = ''
    requestedInstructions = ''
    mcpSchemas = @{}
    mcpRevision = 0
    busy = $false
    rendering = $false
    locked = -not $Detached
    hidden = $false
    followChat = $composerAvailable
    anchorProbe = $null
    nextAnchorProbe = [DateTime]::MinValue
    threadTitles = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
    detectedThread = $null
    owner = [IntPtr]::Zero
    windows = $null
    nextWindowCheck = [DateTime]::MinValue
    noticeUntil = [DateTime]::MinValue
    nextThreads = [DateTime]::MinValue
    nextSnapshot = [DateTime]::MinValue
    nextAppearance = [DateTime]::MinValue
    paletteKey = $null
}

$empty = '—'
$culture = [Globalization.CultureInfo]::InvariantCulture

function Format-Token($Value) {
    if ($null -eq $Value) { return $empty }
    return ([long]$Value).ToString('N0', $culture)
}

function Format-CompactToken($Value) {
    if ($null -eq $Value) { return $empty }
    if ($Value -ge 1e6) { return ($Value / 1e6).ToString('0.##', $culture) + 'M' }
    if ($Value -ge 1e4) { return ($Value / 1e3).ToString('0', $culture) + 'K' }
    if ($Value -ge 1e3) { return ($Value / 1e3).ToString('0.#', $culture) + 'K' }
    return Format-Token $Value
}

function Format-Usage($Usage) {
    if ($null -eq $Usage) { return '暂无单轮用量' }
    return "输入 $(Format-Token $Usage.input)  ·  输出 $(Format-Token $Usage.output)  ·  缓存 $(Format-Token $Usage.cached)"
}

function Format-Cost($Value) {
    if ($null -eq $Value) { return $empty }
    return '$' + ([double]$Value).ToString('0.0000', $culture)
}

function Mix-Color($Base, $Ink, [double]$Amount, [byte]$Alpha = 255) {
    return [Windows.Media.Color]::FromArgb($Alpha,
        [byte]($Base.R + ($Ink.R - $Base.R) * $Amount),
        [byte]($Base.G + ($Ink.G - $Base.G) * $Amount),
        [byte]($Base.B + ($Ink.B - $Base.B) * $Amount))
}

function Get-Luminance($Color) {
    return 0.2126 * $Color.ScR + 0.7152 * $Color.ScG + 0.0722 * $Color.ScB
}

function Get-ReadableColor($Color, $Surface, $Fallback) {
    $base = Get-Luminance $Surface
    for ($blend = 0; $blend -lt 1; $blend += 0.25) {
        $candidate = Mix-Color $Color $Fallback $blend
        $light = Get-Luminance $candidate
        if (([Math]::Max($base, $light) + 0.05) / ([Math]::Min($base, $light) + 0.05) -ge 4.5) { return $candidate }
    }
    return $Fallback
}

function Set-Appearance($Appearance) {
    $mode = $Appearance.mode
    if ($mode -notin 'light','dark') {
        $system = Get-ItemPropertyValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' AppsUseLightTheme -ErrorAction SilentlyContinue
        $mode = if ($system -eq 0) { 'dark' } else { 'light' }
    }
    $preferred = $Appearance[$mode]
    $key = "$mode/$($preferred.surface)/$($preferred.ink)/$($preferred.accent)"
    if ($state.paletteKey -eq $key) { return }
    $defaults = if ($mode -eq 'light') { @('#FFFFFF','#1A1C1F','#2464BD') }
                else { @('#212121','#F1F1F1','#8CB9FF') }
    $surface = [Windows.Media.ColorConverter]::ConvertFromString($preferred.surface ?? $defaults[0])
    $safe = if ((Get-Luminance $surface) -lt 0.179) { [Windows.Media.Colors]::White } else { [Windows.Media.Colors]::Black }
    $ink = Get-ReadableColor ([Windows.Media.ColorConverter]::ConvertFromString($preferred.ink ?? $defaults[1])) $surface $safe
    $accent = [Windows.Media.ColorConverter]::ConvertFromString($preferred.accent ?? $defaults[2])
    $colors = @{
        RibbonBackground = Mix-Color $surface $ink 0 222
        InspectorBackground = Mix-Color $surface $ink 0 246
        ThemeText = $ink
        ThemeMuted = Get-ReadableColor (Mix-Color $surface $ink 0.7) $surface $ink
        ThemeMetric = Get-ReadableColor (Mix-Color $ink $accent 0.24) $surface $ink
        ThemeAccent = $accent
        ThemeAccentText = Get-ReadableColor $accent $surface $ink
        ThemeBorder = Mix-Color $surface $ink 0.24
        ThemePanel = Mix-Color $surface $ink 0.025
        ThemeControl = Mix-Color $surface $ink 0.065
        ThemeHover = Mix-Color $surface $accent 0.16
        ThemeSelected = Mix-Color $surface $accent 0.13
        ThemeTrack = Mix-Color $surface $accent 0.32
    }
    foreach ($brushKey in $colors.Keys) {
        $brush = [Windows.Media.SolidColorBrush]::new($colors[$brushKey])
        $brush.Freeze()
        $window.Resources[$brushKey] = $brush
    }
    $window.Resources[[Windows.SystemColors]::WindowBrushKey] = $window.Resources['ThemeControl']
    $window.Resources[[Windows.SystemColors]::WindowTextBrushKey] = $window.Resources['ThemeText']
    $window.Resources[[Windows.SystemColors]::HighlightBrushKey] = $window.Resources['ThemeSelected']
    $window.Resources[[Windows.SystemColors]::HighlightTextBrushKey] = $window.Resources['ThemeText']
    $state.paletteKey = $key
}

function Update-ThreadHint {
    $current = $ui.ThreadCaption.Text
    $ui.ThreadCaption.ToolTip = if (-not $state.followChat) { "$current · 手动选择" }
    elseif ($state.detectedThread -eq $state.selected) { "$current · 跟随聊天" }
    else { "$current · 尚未确认桌面当前聊天" }
}

function Format-State($Value) {
    switch ($Value) {
        'complete' { '已完成' }
        'interrupted' { '已中断' }
        'running' { '进行中' }
        default { $empty }
    }
}

function Set-Status([string]$Message, [switch]$Notice) {
    if ($Notice) { $state.noticeUntil = [DateTime]::UtcNow.AddSeconds(5) }
    if ($Notice -or [DateTime]::UtcNow -ge $state.noticeUntil) { $ui.Status.Text = $Message }
}

function Set-List($Control, [object[]]$Items, [string]$Key, [string]$Preferred) {
    if ($Control.Tag -eq $Key) { return }
    $Control.Tag = $Key
    $Control.ItemsSource = $Items
    if ($Items.Count -eq 0) { return }
    $index = $Items.Count - 1
    if ($Preferred) {
        for ($i = 0; $i -lt $Items.Count; $i++) {
            if ($Items[$i].id -eq $Preferred) { $index = $i; break }
        }
    }
    $Control.SelectedIndex = $index
}

function Update-SelectedTurn {
    $data = $state.snapshot
    $turn = $null
    if ($data -and $ui.Turns.SelectedItem) {
        $turn = $data.turns[$ui.Turns.SelectedItem.index]
    }
    $body = @(
        foreach ($message in $turn.messages) {
            if ($message.phase -eq 'commentary') { continue }
            $role = if ($message.role -eq 'user') { '你' } else { 'Codex' }
            "$role`n$($message.text)"
        }
    )
    $rendered = $body -join "`n`n"
    if ($ui.TurnMessage.Text -ne $rendered) { $ui.TurnMessage.Text = $rendered }
}

function Turn-Preview($Turn) {
    $message = $null
    foreach ($item in $Turn.messages) {
        if (-not $item.text) { continue }
        if ($item.role -eq 'assistant' -and $item.phase -ne 'commentary') { $message = $item }
        elseif (-not $message -and $item.role -eq 'user') { $message = $item }
    }
    if (-not $message) { return '暂无文本回复' }
    $preview = $message.text.Substring(0, [Math]::Min(180, $message.text.Length))
    return ($preview -replace '\s+', ' ').Trim()
}

function Format-Model([string]$Model, [string]$Source) {
    if (-not $Model) { return '日志未记录' }
    if (-not $Source) { return $Model }
    return "$Model 〔$Source〕"
}

function Get-SelectedStep {
    $item = $ui.Steps.SelectedItem
    if (-not $item -or -not $state.snapshot) { return }
    $turn = $state.snapshot.turns[$item.turnIndex]
    $step = $turn.steps[$item.stepIndex]
    $key = "$($state.selected)/$($turn.id)/$($step.id)/$($state.snapshot.providerTrace.version)"
    return @{item=$item;turn=$turn;step=$step;key=$key}
}

function Update-SelectedStep {
    $selection = Get-SelectedStep
    $ui.RequestContext.IsEnabled = [bool]$selection.step.hasProviderContext
    $ui.RequestContext.Content = '请求指令与 Schema'
    if (-not $selection) {
        $ui.StepDetails.Clear()
        return
    }
    if ($selection.key -ceq $state.capturedStep.key -and $selection.step.hasProviderContext) {
        $ui.RequestContext.Content = '返回请求用量'
        if ($ui.StepDetails.Text -ne $state.capturedStep.text) { $ui.StepDetails.Text = $state.capturedStep.text }
        return
    }
    $item = $selection.item
    $turn = $selection.turn
    $step = $selection.step
    $text = @(
        $item.label
        "响应 ID  $($step.id ?? $empty)"
        "配置模型  $($turn.model ?? $empty)"
        "请求模型  $(Format-Model $step.sentModel $step.sentModelSource)"
        "响应模型  $(Format-Model $step.responseModel $step.responseModelSource)"
        $(if ($step.gatewayTiming) { "网关首段文本  $([double]$step.gatewayTiming.ttftMs / 1000) s" })
        $(if ($step.gatewayTiming.textSpanMs) { "网关文本流跨度  $([double]$step.gatewayTiming.textSpanMs / 1000) s" })
        $(if ($step.gatewayTiming.textTps) { '网关可见文本 TPS  ≈ {0:F1}' -f $step.gatewayTiming.textTps })
        $(if ($step.modelConflict) { '本地上游记录与会话记录不一致。' })
        $(if ($step.providerContextConflict) { '同一响应 ID 有不一致的请求快照。' })
        ''
        (Format-Usage $step.usage)
        "缓存写入  $(Format-Token $step.usage.cacheWrite)"
        "推理 Token  $(Format-Token $step.usage.reasoning)"
        "合计 Token  $(Format-Token $step.usage.total)"
        $(if ($step.apiEstimate) { "API 估算  $(Format-Cost $step.apiEstimate.usd) · $($step.apiEstimate.tier)" }
          else { 'API 估算  无可用费率或用量' })
    ) -join "`n"
    if ($ui.StepDetails.Text -ne $text) { $ui.StepDetails.Text = $text }
}

function Update-SchemaList {
    $key = "$($state.selected)|$($state.mcpRevision)|$($state.snapshot.schemaNames -join '|')"
    if ($ui.Schemas.Tag -eq $key) { return }
    $ui.Schemas.Tag = $key
    $selected = $ui.Schemas.SelectedItem
    $items = @($state.snapshot.schemaNames | Where-Object { $_ }) + @($state.mcpSchemas.Keys | Sort-Object)
    $ui.Schemas.ItemsSource = [string[]]$items
    if ($selected -in $items) { $ui.Schemas.SelectedItem = $selected }
    else { $ui.SchemaDetails.Clear() }
}

function Show-Instructions([string]$Kind, [string]$Content) {
    $state.instructionKind = $Kind
    $ui.Instructions.Content = if ($Kind -eq 'instructions') { '返回上下文' } else { '会话指令快照' }
    $ui.CustomInstructions.Content = if ($Kind -eq 'configured-instructions') { '返回上下文' } else { '配置的指令文件' }
    $ui.ModelDetails.Text = if ($Kind) { $Content } else { $state.modelText }
}

function Update-Metrics($Data) {
    $ui.ThreadCaption.Text = $Data.thread.title ?? $Data.thread.id
    Update-ThreadHint
    $ui.Rounds.Text = "$($Data.roundCount)/$($Data.apiEstimate.total)"
    $timed = $Data.timing
    $ui.Speed.Text = $empty
    $ui.FirstToken.Text = $empty
    $ui.Speed.ToolTip = $null
    $ui.FirstToken.ToolTip = $null
    $ui.FirstTokenLabel.Text = 'TTFT'
    if ($null -ne $timed) {
        $timingLabel = if ($timed.id -eq $Data.latestTurnId) { '本轮' } else { '最近有计时的轮次' }
        $delay = $timed.ttft ?? $timed.firstTextDelayMs
        $prefix = if ($null -eq $timed.ttft) { '≈' } else { '' }
        $ui.FirstToken.Text = $prefix + ('{0:F2}s' -f ($delay / 1000.0))
        $ui.FirstToken.ToolTip = "${timingLabel}的 TTFT。≈ 为首段文本日志推算。"
        if ($timed.outputWindowMs -gt 0 -and $null -ne $timed.output) {
            $ui.Speed.Text = ('≈{0:F1}' -f ($timed.output * 1000.0 / $timed.outputWindowMs))
            $ui.Speed.ToolTip = "${timingLabel}的有效 TPS。生成中按最近已记账请求，包含工具等待。"
        }
    }
    $live = $Data.providerLive
    if ($null -ne $live.ttftMs) {
        $ui.FirstTokenLabel.Text = '首文'
        $ui.FirstToken.Text = '{0:F2}s' -f ($live.ttftMs / 1000.0)
        $ui.FirstToken.ToolTip = '当前请求从转发到第一个可见文本增量的时间'
    }
    if ($null -ne $live.textTps) {
        $ui.Speed.Text = '≈{0:F1}' -f $live.textTps
        $ui.Speed.ToolTip = '根据上游已返回的可见文本 Token 和接收时间估计'
    }
    $ui.RunState.Text = Format-State $Data.latestState
    $ui.Tokens.Text = Format-CompactToken $Data.cumulative.total
    $ui.Tokens.ToolTip = Format-Usage $Data.cumulative
    $ui.Cache.Text = if ($Data.cumulative.input -gt 0 -and $null -ne $Data.cumulative.cached) {
        '{0:P1}' -f ($Data.cumulative.cached / $Data.cumulative.input)
    } else { $empty }
    $price = $Data.apiEstimate
    $ui.Cost.Text = Format-Cost $price.usd
    $ui.CostLabel.Text = if ($null -ne $price.usd -and $price.priced -lt $price.total) { '估费*' } else { '估费' }
    $ui.Cost.ToolTip = "API Standard · USD · 已估算 $($price.priced) / $($price.total) 个请求步"
    $context = if ($Data.windowSize -gt 0 -and $null -ne $Data.contextSize) { $Data.contextSize / $Data.windowSize }
    $used = Format-CompactToken $Data.contextSize
    $ui.ContextSize.Text = if ($null -eq $context) { $used } else { '{0:P1} {1}' -f $context,$used }
    $ui.ContextSize.ToolTip = "$(Format-Token $Data.contextSize) / $(Format-Token $Data.windowSize) Token"
    $ui.ContextProgress.Value = [Math]::Min(100, 100 * ($context ?? 0))
}

function Update-Snapshot($Data) {
    $state.snapshot = $Data
    $turns = @($Data.turns | Where-Object { $null -ne $_ })
    $latest = $null
    if ($turns.Count) { $latest = $turns[-1] }
    $turnIndex = 0
    $callItems = [System.Collections.Generic.List[object]]::new()
    $stepItems = [System.Collections.Generic.List[object]]::new()
    $trend = [System.Collections.Generic.List[string]]::new()
    $responseModels = [System.Collections.Generic.HashSet[string]]::new()
    $sentModels = [System.Collections.Generic.HashSet[string]]::new()
    $turnItems = @(
        foreach ($turn in $turns) {
            $turnIndex++
            $stepIndex = 0
            foreach ($step in $turn.steps) {
                $stepIndex++
                $stepName = "轮 $turnIndex  ·  步 $stepIndex"
                if ($step.responseModel) { $stepName += "  ·  $($step.responseModel)" }
                $stepItems.Add([pscustomobject]@{id="$($turn.id):$stepIndex"; turnIndex=$turnIndex-1; stepIndex=$stepIndex-1; label=$stepName})
                if ($step.responseModel) { [void]$responseModels.Add($step.responseModel) }
                if ($step.sentModel) { [void]$sentModels.Add($step.sentModel) }
                if ($null -ne $step.usage.input -and $null -ne $step.usage.output) {
                    $size = Format-Token ($step.usage.input + $step.usage.output)
                    $trend.Add("$turnIndex.$stepIndex   $size Token")
                }
            }
            foreach ($call in $turn.calls) {
                $callItems.Add([pscustomobject]@{id=$call.id; turn=$turn.id; source=$call.source; label="$turnIndex  ·  $($call.name)"})
            }
            [pscustomobject]@{
                id=$turn.id; index=$turnIndex-1; label="第 $turnIndex 轮  ·  $(Format-State $turn.state)"
                preview=Turn-Preview $turn
                usage=Format-Usage $turn.usage
                canFork=[bool]($turn.state -eq 'complete' -and -not $Data.thread.archived)
                branchLabel="从第 $turnIndex 轮分支"
            }
        }
    )
    $live = $Data.providerLive
    $ui.OpenCodex.IsEnabled = $true
    $ui.Instructions.IsEnabled = [bool]$Data.hasInstructions
    $ui.CustomInstructions.IsEnabled = $true

    $sent = if ($sentModels.Count) { $sentModels -join ' / ' } else { '日志未记录' }
    $received = if ($responseModels.Count) { $responseModels -join ' / ' } else { '日志未记录' }
    $model = $latest.model ?? $Data.model ?? $empty
    $state.modelText = @(
        "配置模型  $model"
        "服务商     $($Data.provider ?? $empty)"
        "请求模型  $sent"
        "响应模型  $received"
        "最近改派  $($latest.rerouted ?? $empty)"
        $(if ($live.responseModel) { "流式响应模型  $($live.responseModel)" })
        $(if ($Data.providerTrace.matched -gt 0) { "上游记录  已匹配 $($Data.providerTrace.matched) 步" })
        $(if ($Data.providerTrace.error) { $Data.providerTrace.error })
        ''
        "上下文占用  $($ui.ContextSize.ToolTip)"
        '服务端完整系统提示词未公开。'
        ''
        '最近请求用量'
        $trend | Select-Object -Last 12
        foreach ($event in ($Data.events | Select-Object -Last 5)) { "$($event.type)  $($event.detail ?? $event.at)" }
    ) -join "`n"
    if (-not $state.instructionKind -and $ui.ModelDetails.Text -ne $state.modelText) {
        $ui.ModelDetails.Text = $state.modelText
    }
    $state.rendering = $true
    try {
        $turnKey = "$($Data.thread.id)|$($Data.thread.archived)|$($turnItems.id -join '|')|$($turnItems.label -join '|')|$($turnItems.usage -join '|')|$($turnItems.preview -join '|')"
        if ($ui.Turns.Tag -ne $turnKey) {
            $preferredTurn = $ui.Turns.SelectedItem.id
            if ($ui.Turns.SelectedIndex -eq $ui.Turns.Items.Count - 1) { $preferredTurn = $null }
            Set-List $ui.Turns $turnItems $turnKey $preferredTurn
            if ($ui.Turns.SelectedItem) { $ui.Turns.ScrollIntoView($ui.Turns.SelectedItem) }
        }
        $stepKey = "$($Data.thread.id)|$($stepItems.label -join '|')"
        $stepPreferred = $ui.Steps.SelectedItem.id
        if ($ui.Steps.SelectedIndex -eq $ui.Steps.Items.Count - 1) { $stepPreferred = $null }
        Set-List $ui.Steps $stepItems.ToArray() $stepKey $stepPreferred
        $callKey = "$($Data.thread.id)|$($callItems.id -join '|')"
        if ($ui.Calls.Tag -ne $callKey) {
            $selectedCall = $ui.Calls.SelectedItem.id
            $ui.CallDetails.Clear()
            Set-List $ui.Calls $callItems.ToArray() $callKey $selectedCall
        }
        Update-SchemaList
    } finally { $state.rendering = $false }
    Update-SelectedTurn
    Update-SelectedStep
}

function Send-Request([string]$Kind, [string]$Path, [hashtable]$Query, [string]$LastTurnId) {
    if ($pending.ToArray().Where({$_.kind -eq $Kind}).Count) { return }
    $parts = foreach ($key in $Query.Keys) {
        "$key=$([Uri]::EscapeDataString([string]$Query[$key]))"
    }
    $uri = "$address$Path"
    if ($parts) { $uri += '?' + ($parts -join '&') }
    $method = if ($Kind -in 'fork','mcp-schemas') { [Net.Http.HttpMethod]::Post } else { [Net.Http.HttpMethod]::Get }
    $request = [Net.Http.HttpRequestMessage]::new($method, $uri)
    if ($Kind -eq 'fork') {
        $request.Headers.Add('Origin', $address)
        $request.Headers.Add('X-Context-Action', 'fork')
        $request.Content = [Net.Http.StringContent]::new((@{ lastTurnId=$LastTurnId } | ConvertTo-Json -Compress), [Text.Encoding]::UTF8, 'application/json')
    }
    if ($Kind -eq 'mcp-schemas') {
        $request.Headers.Add('Origin', $address)
        $request.Headers.Add('X-Context-Action', 'list-mcp-schemas')
    }
    try {
        $pending.Add(@{kind=$Kind; thread=$Query.id; query=$Query; request=$request; task=$http.SendAsync($request); inspector=$state.inspectorGeneration})
    } catch {
        $request.Dispose()
        throw
    }
}

function Set-SelectedThread([string]$Id) {
    if (-not $Id -or $state.selected -eq $Id) { return }
    $state.selected = $Id
    $state.snapshot = $null
    $state.detailRevision = $null
    $state.metricRevision = $null
    $state.latestState = $null
    $state.capturedStep = $null
    $ui.ThreadCaption.Text = '正在切换会话'
    foreach ($metric in 'Rounds','Speed','FirstToken','Tokens','Cache','Cost','ContextSize','RunState') { $ui[$metric].Text = $empty }
    $ui.FirstTokenLabel.Text = 'TTFT'
    $ui.ContextProgress.Value = 0
    $state.modelText = ''
    $state.requestedInstructions = ''
    $state.mcpSchemas = @{}
    $state.mcpRevision++
    if ($ui.Inspector.Content) {
        $ui.Turns.ItemsSource = $null
        $ui.Calls.ItemsSource = $null
        $ui.Schemas.ItemsSource = $null
        $ui.Steps.ItemsSource = $null
        Show-Instructions '' ''
        $ui.Instructions.IsEnabled = $false
        $ui.CustomInstructions.IsEnabled = $false
        $ui.SchemaStatus.Text = '以下为会话留存的 Schema。'
        $ui.RefreshMcp.IsEnabled = $false
        $ui.OpenCodex.IsEnabled = $false
        Update-SelectedTurn
        Update-SelectedStep
    }
    Update-ThreadHint
    $state.nextThreads = [DateTime]::MinValue
    $state.nextSnapshot = [DateTime]::MinValue
}

function Receive-Request($Entry) {
    $response = $null
    try {
        $response = $Entry.task.GetAwaiter().GetResult()
        if ($Entry.kind -in 'snapshot','call','schema','mcp-schemas','instructions','configured-instructions','request-context' -and
            (-not $ui.Inspector.Content -or $Entry.inspector -ne $state.inspectorGeneration)) { return }
        if ($Entry.thread -and $Entry.thread -ne $state.selected -and $Entry.kind -ne 'fork') { return }
        $raw = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $data = ConvertFrom-Json -InputObject $raw -AsHashtable -NoEnumerate
        if (-not $response.IsSuccessStatusCode) {
            $detail = if ($data -is [System.Collections.IDictionary]) { $data.error } else { $null }
            throw ($detail ?? "HTTP $([int]$response.StatusCode)")
        }
        switch ($Entry.kind) {
            'appearance' { Set-Appearance $data }
            'threads' {
                $titles = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
                foreach ($thread in $data) {
                    if (-not $thread.title) { continue }
                    if ($titles.ContainsKey($thread.title)) { $titles[$thread.title] = $null }
                    else { $titles[$thread.title] = $thread.id }
                }
                $state.threadTitles = $titles
                if (-not $state.selected -and $data.Count) { Set-SelectedThread $data[0].id }
                if (-not $ui.Inspector.Content) { return }
                $items = @(
                    foreach ($item in $data) {
                        $title = $item.title ?? $item.id.Substring(0,8)
                        if ($item.archived) { $title += '  ·  已归档' }
                        [pscustomobject]@{id=$item.id; label=$title}
                    }
                )
                $state.rendering = $true
                try {
                    $key = ($items | ForEach-Object { "$($_.id)=$($_.label)" }) -join '|'
                    $key += "|$($state.selected)"
                    Set-List $ui.Threads $items $key $state.selected
                    if ($ui.Threads.SelectedValue -ne $state.selected) { $ui.Threads.SelectedIndex = -1 }
                } finally { $state.rendering = $false }
            }
            'metrics' {
                $state.latestState = $data.latestState
                if ($state.metricRevision -ne $data.revision) {
                    Update-Metrics $data
                    $state.metricRevision = $data.revision
                }
                $interval = if ($state.latestState -eq 'running') { 1 } else { 3 }
                Set-Status ('本地日志 · {0} 秒刷新' -f $interval)
                if ($ui.Inspector.Visibility -eq [Windows.Visibility]::Visible -and $state.detailRevision -ne $data.revision) {
                    Send-Request 'snapshot' '/api/thread' @{id=$state.selected}
                }
            }
            'snapshot' {
                if ($ui.Inspector.Visibility -ne [Windows.Visibility]::Visible -or $state.detailRevision -eq $data.revision) { return }
                if (-not $pending.ToArray().Where({$_.kind -eq 'mcp-schemas'}).Count) { $ui.RefreshMcp.IsEnabled = $true }
                Update-Snapshot $data
                $state.detailRevision = $data.revision
            }
            'call' {
                if ($Entry.query.call -eq $ui.Calls.SelectedItem.id -and $Entry.query.source -eq $ui.Calls.SelectedItem.source) {
                    $ui.CallDetails.Text = ConvertTo-Json $data.details -Depth 85
                }
            }
            'schema' {
                if ($Entry.query.name -eq $ui.Schemas.SelectedItem) {
                    $ui.SchemaDetails.Text = ConvertTo-Json $data.schema -Depth 85
                }
            }
            'mcp-schemas' {
                $state.mcpSchemas = @{}
                foreach ($tool in $data.tools) { $state.mcpSchemas["MCP · $($tool.server) / $($tool.name)"] = $tool }
                $state.mcpRevision++
                Update-SchemaList
                $scope = if ($data.scope -eq 'workspace') { '当前本地配置' } else { '本机配置' }
                $ui.SchemaStatus.Text = "$scope · $($state.mcpSchemas.Count) 项 MCP 定义。"
                if ($data.unavailable.Count) { $ui.SchemaStatus.Text += " 无法查询：$($data.unavailable -join '、')" }
            }
            'instructions' {
                if ($state.requestedInstructions -eq $Entry.kind) {
                    Show-Instructions $Entry.kind "AGENTS.md 指令快照`n`n$($data.text)"
                }
            }
            'configured-instructions' {
                if ($state.requestedInstructions -eq $Entry.kind) {
                    $body = if ($null -eq $data.text) { '当前本地配置未设置用户或工作区的 model_instructions_file。' }
                    else { "当前配置文件 · $($data.path)`n`n$($data.text)" }
                    Show-Instructions $Entry.kind $body
                }
            }
            'request-context' {
                $selection = Get-SelectedStep
                if ($selection.key -ceq $Entry.query.captureKey) {
                    $body = @(
                        '来源 · 自管网关的用户提供记录'
                        "响应 ID · $($selection.step.id)"
                        ''
                        '请求指令'
                        $(if ($data.instructions -is [string]) { $data.instructions } else { ConvertTo-Json -InputObject $data.instructions -Depth 85 })
                        ''
                        'system / developer 文本消息'
                        (ConvertTo-Json -InputObject $data.messages -Depth 85)
                        ''
                        '函数与自定义工具 Schema'
                        (ConvertTo-Json -InputObject $data.tools -Depth 85)
                    ) -join "`n"
                    $state.capturedStep = @{key=$selection.key;text=$body}
                    Update-SelectedStep
                }
            }
            'fork' {
                $state.nextThreads = [DateTime]::MinValue
                if ($Entry.thread -eq $state.selected) {
                    $state.followChat = $false
                    if ($ui.FollowChat) { $ui.FollowChat.IsChecked = $false }
                    Set-SelectedThread $data.id
                }
                Set-Status "已创建分支 $($data.id.Substring(0,8))" -Notice
            }
        }
    } catch {
        if ($Entry.kind -eq 'fork') { Set-Status "分支创建失败 · $($_.Exception.Message)" -Notice }
        elseif ($Entry.kind -eq 'mcp-schemas' -and $ui.SchemaStatus -and $Entry.thread -eq $state.selected) { $ui.SchemaStatus.Text = "MCP 查询失败 · $($_.Exception.Message)" }
        else { Set-Status $_.Exception.Message }
    } finally {
        if ($Entry.kind -eq 'mcp-schemas' -and $ui.RefreshMcp) {
            $ui.RefreshMcp.IsEnabled = [bool]$state.snapshot
        }
        if ($Entry.kind -eq 'fork') {
            $state.busy = $false
            if ($ui.Turns) {
                $ui.Turns.IsEnabled = $true
                Update-SelectedTurn
            }
        }
        if ($response) { $response.Dispose() }
        $Entry.request.Dispose()
    }
}

function Set-WidgetLayout([double]$AvailableWidth, [double]$AvailableHeight) {
    $expanded = $ui.Inspector.Visibility -eq [Windows.Visibility]::Visible
    $preferredWidth = if ($expanded) { 545 } else { 1024 }
    $width = [Math]::Clamp($AvailableWidth - 14, $window.MinWidth, $preferredWidth)
    if ($window.Width -ne $width) { $window.Width = $width }

    $row = [int]($expanded -or $width -lt 820)
    if ([Windows.Controls.Grid]::GetRow($ui.Metrics) -ne $row) {
        [Windows.Controls.Grid]::SetRow($ui.Metrics, $row)
        [Windows.Controls.Grid]::SetColumn($ui.Metrics, 1 - $row)
        [Windows.Controls.Grid]::SetColumnSpan($ui.Metrics, 1 + 2 * $row)
        $ui.Metrics.HorizontalAlignment = if ($row) { 'Left' } else { 'Center' }
    }
    if ($expanded) {
        $window.SizeToContent = 'Manual'
        $window.Height = [Math]::Clamp($AvailableHeight, 200, 585)
    } else {
        $window.SizeToContent = 'Height'
    }
}

function Update-ActiveChat {
    if (-not $state.followChat -or -not $state.owner) { return }
    $now = [DateTime]::UtcNow
    $key = $state.owner
    if ($state.anchorProbe -and $state.anchorProbe.task.IsCompleted) {
        $probe = $state.anchorProbe
        $state.anchorProbe = $null
        $detected = $null
        try { $detected = $probe.task.GetAwaiter().GetResult() } catch {}
        if ($probe.key -eq $key) {
            $state.detectedThread = $detected
            if ($detected -and $state.threadTitles.ContainsValue($detected)) {
                Set-SelectedThread $detected
            }
            Update-ThreadHint
        }
    }
    if (-not $state.anchorProbe -and $now -ge $state.nextAnchorProbe -and $state.threadTitles.Count) {
        if ([ContextWindows]::GetForegroundWindow() -ne $state.owner) { return }
        $state.nextAnchorProbe = $now.AddSeconds(2)
        $state.anchorProbe = @{key=$key;task=[ComposerAnchor]::ReadThreadAsync($state.owner,$state.threadTitles)}
    }
}


function Update-CodexTarget {
    if (-not $state.followChat -or $state.hidden) { return }
    $owner = $state.windows.SelectMainWindow($state.owner)
    if ($owner -eq $state.owner) { return }
    $state.owner = $owner
    $state.detectedThread = $null
    $state.nextAnchorProbe = [DateTime]::MinValue
    Update-ThreadHint
}

function Move-DesktopLock {
    if (-not $state.locked -or $state.hidden -or -not $state.windows) { return }
    [ContextWindows]::SetTopmost($hostWindow.Handle, $true)
    $area = [ContextWindows+Rect]::new()
    if (-not [ContextWindows]::ReadWorkArea([IntPtr]::Zero, [ref]$area)) { return }
    $scale = [Math]::Max(1, [ContextWindows]::GetDpiForWindow($hostWindow.Handle) / 96.0)
    Set-WidgetLayout ($area.Width / $scale) ($area.Height / $scale - 16)
    $frame = [ContextWindows+Rect]::new()
    if (-not [ContextWindows]::ReadBounds($hostWindow.Handle, [ref]$frame)) { return }
    $x = [int][Math]::Max($area.Left, ($area.Left + $area.Right - $frame.Width) / 2)
    $y = [int]($area.Top + 8 * $scale)
    if ($frame.Left -ne $x -or $frame.Top -ne $y) {
        [ContextWindows]::Move($hostWindow.Handle, $x, $y)
    }
}

function Set-DesktopLock([bool]$Enabled) {
    $state.locked = $Enabled
    $window.Topmost = $Enabled -and -not $state.hidden
    [ContextWindows]::SetTopmost($hostWindow.Handle, $window.Topmost)
    $ui.Dock.Content = if ($Enabled) { '已锁定' } else { '锁定' }
    Move-DesktopLock
}

function Hide-StatusBar {
    $state.hidden = $true
    if ($ui.Inspector.Content) { Toggle-Inspector }
    $window.Topmost = $false
    [ContextWindows]::SetTopmost($hostWindow.Handle, $false)
    $window.Hide()
}

function Show-StatusBar {
    if (-not $state.hidden) { return }
    $state.hidden = $false
    $state.nextThreads = [DateTime]::MinValue
    $state.nextSnapshot = [DateTime]::MinValue
    $state.nextAppearance = [DateTime]::MinValue
    $state.nextWindowCheck = [DateTime]::MinValue
    $state.nextAnchorProbe = [DateTime]::MinValue
    Set-DesktopLock $state.locked
    $window.Show()
    Move-DesktopLock
}

$ui.CloseWindow.Add_Click({ $window.Close() })
$ui.Hide.Add_Click({ Hide-StatusBar })
$ui.Dock.Add_Click({ Set-DesktopLock (-not $state.locked) })

function Toggle-Inspector {
    $expanded = $ui.Inspector.Visibility -ne [Windows.Visibility]::Visible
    if ($expanded) {
        Connect-Inspector
        $state.nextThreads = [DateTime]::MinValue
    } else {
        $state.inspectorGeneration++
        $ui.Inspector.Content = $null
        foreach ($name in $inspectorNames) { $ui.Remove($name) }
        $state.snapshot = $null
        $state.detailRevision = $null
        $state.capturedStep = $null
        $state.instructionKind = ''
        $state.requestedInstructions = ''
        $state.modelText = ''
        $state.mcpSchemas = @{}
    }
    $ui.Inspector.Visibility = if ($expanded) { [Windows.Visibility]::Visible } else { [Windows.Visibility]::Collapsed }
    $brush = if ($expanded) { 'InspectorBackground' } else { 'RibbonBackground' }
    $ui.Shell.SetResourceReference([Windows.Controls.Border]::BackgroundProperty, $brush)
    $area = [ContextWindows+Rect]::new()
    if ([ContextWindows]::ReadWorkArea($hostWindow.Handle, [ref]$area)) {
        $scale = [Math]::Max(1, [ContextWindows]::GetDpiForWindow($hostWindow.Handle) / 96.0)
        Set-WidgetLayout ($area.Width / $scale) ($area.Height / $scale - 56)
    }
    if ($expanded -and $state.selected) {
        $state.nextSnapshot = [DateTime]::MinValue
        if ($state.detailRevision -ne $state.metricRevision -or -not $state.snapshot) {
            Send-Request 'snapshot' '/api/thread' @{id=$state.selected}
        }
    }
    $ui.Expand.Content = if ($expanded) { '收起' } else { '展开' }
    Move-DesktopLock
}
$ui.Expand.Add_Click({ Toggle-Inspector })
$ui.DragArea.Add_MouseLeftButtonDown({
    if ($state.locked) { Set-DesktopLock $false }
    try { $window.DragMove() } catch [InvalidOperationException] {}
})
function Start-TurnFork([string]$TurnId) {
    $data = $state.snapshot
    if ($state.busy -or -not $data -or $data.thread.archived -or $data.thread.id -ne $state.selected) { return }
    $turn = $data.turns | Where-Object { $_.id -ceq $TurnId } | Select-Object -First 1
    if ($turn.state -ne 'complete') { return }
    $state.busy = $true
    $ui.Turns.IsEnabled = $false
    Set-Status '正在创建分支…' -Notice
    Send-Request 'fork' '/api/fork' @{id=$state.selected} $TurnId
}

function Open-InstructionView([string]$Kind) {
    if ($state.instructionKind -eq $Kind) {
        $state.requestedInstructions = ''
        Show-Instructions '' ''
    } else {
        $state.requestedInstructions = $Kind
        Send-Request $Kind "/api/$Kind" @{id=$state.selected}
    }
}

function Connect-Inspector {
    $panel = $window.FindResource('InspectorTemplate').LoadContent()
    foreach ($name in $inspectorNames) { $ui[$name] = $panel.FindName($name) }
    foreach ($label in @(@('InspectorCaption','ThreadCaption'), @('InspectorStatus','Status'))) {
        $binding = [Windows.Data.Binding]::new('Text')
        $binding.Source = $ui[$label[1]]
        [void]$ui[$label[0]].SetBinding([Windows.Controls.TextBlock]::TextProperty, $binding)
    }
    $ui.FollowChat.IsEnabled = $composerAvailable
    $ui.FollowChat.IsChecked = $state.followChat
    $ui.Turns.IsEnabled = -not $state.busy
    $ui.Threads.Add_SelectionChanged({
        if (-not $state.rendering -and $ui.Threads.SelectedValue) {
            $ui.FollowChat.IsChecked = $false
            Set-SelectedThread $ui.Threads.SelectedValue
        }
    })
    $ui.FollowChat.Add_Checked({ $state.followChat = $true; $state.nextAnchorProbe = [DateTime]::MinValue; Update-ThreadHint })
    $ui.FollowChat.Add_Unchecked({ $state.followChat = $false; Update-ThreadHint })
    $ui.Turns.Add_SelectionChanged({ if (-not $state.rendering) { Update-SelectedTurn } })
    $ui.Steps.Add_SelectionChanged({ if (-not $state.rendering) { Update-SelectedStep } })
    $ui.RequestContext.Add_Click({
        $selection = Get-SelectedStep
        if (-not $selection.step.hasProviderContext) { return }
        if ($selection.key -ceq $state.capturedStep.key) {
            $state.capturedStep = $null
            Update-SelectedStep
        } else {
            Send-Request 'request-context' '/api/request-context' @{id=$state.selected;turn=$selection.turn.id;response=$selection.step.id;captureKey=$selection.key}
        }
    })
    $ui.OpenCodex.Add_Click({
        if ($state.selected -match '^[0-9a-f-]{36}$') { Start-Process "codex://threads/$($state.selected)" }
    })
    $ui.Turns.AddHandler([Windows.Controls.Primitives.ButtonBase]::ClickEvent, [Windows.RoutedEventHandler]{
        param($sender, $eventArgs)
        $button = $eventArgs.OriginalSource
        if ($button -is [Windows.Controls.Button] -and $button.Tag) {
            Start-TurnFork $button.Tag
        }
    })
    $ui.Calls.Add_SelectionChanged({
        if (-not $state.rendering) { $ui.CallDetails.Clear() }
    })
    $ui.Schemas.Add_SelectionChanged({
        $ui.SchemaDetails.Clear()
    })
    $ui.RefreshMcp.Add_Click({
        $ui.RefreshMcp.IsEnabled = $false
        $ui.SchemaStatus.Text = '正在查询已配置的 MCP 服务器…'
        Send-Request 'mcp-schemas' '/api/mcp-schemas' @{id=$state.selected}
    })
    $ui.Instructions.Add_Click({ Open-InstructionView 'instructions' })
    $ui.CustomInstructions.Add_Click({ Open-InstructionView 'configured-instructions' })
    $ui.Inspector.Content = $panel
}

$timer = [Windows.Threading.DispatcherTimer]::new()
$visibleInterval = [TimeSpan]::FromMilliseconds(250)
$hiddenInterval = [TimeSpan]::FromMilliseconds(500)
$timer.Interval = $visibleInterval
$timer.Add_Tick({
    try {
        if ($mailbox) {
            $target = $mailbox.Take()
            if ($target) {
                if ($target[0] -eq 'D') { Set-DesktopLock $false }
                Set-SelectedThread $target.Substring(1).ToLowerInvariant()
                Show-StatusBar
            }
        }
        foreach ($entry in $pending.ToArray()) {
            if (-not $entry.task.IsCompleted) { continue }
            [void]$pending.Remove($entry)
            Receive-Request $entry
        }
        if (-not $window.IsVisible) {
            if ($timer.Interval -ne $hiddenInterval) { $timer.Interval = $hiddenInterval }
            return
        }
        if ($timer.Interval -ne $visibleInterval) { $timer.Interval = $visibleInterval }
        $now = [DateTime]::UtcNow
        if ($state.windows.TakeChange() -or $now -ge $state.nextWindowCheck) {
            $state.nextWindowCheck = $now.AddSeconds(2)
            Update-CodexTarget
            Move-DesktopLock
        }
        Update-ActiveChat
        if ($now -ge $state.nextAppearance) {
            $state.nextAppearance = $now.AddSeconds(2)
            Send-Request 'appearance' '/api/appearance' @{}
        }
        $trackingChat = $state.followChat -and $state.owner -eq [ContextWindows]::GetForegroundWindow()
        if ($now -ge $state.nextThreads -and ($trackingChat -or $ui.Inspector.Content -or -not $state.selected)) {
            $state.nextThreads = $now.AddSeconds(8)
            Send-Request 'threads' '/api/threads' @{}
        }
        if ($state.selected -and $now -ge $state.nextSnapshot) {
            $interval = if ($state.latestState -eq 'running' -or -not $state.metricRevision) { 1 } else { 3 }
            $state.nextSnapshot = $now.AddSeconds($interval)
            Send-Request 'metrics' '/api/thread-metrics' @{id=$state.selected}
        }
        if ($ui.Inspector.Visibility -eq [Windows.Visibility]::Visible) {
            $call = $ui.Calls.SelectedItem
            if ($call -and -not $ui.CallDetails.Text -and $ui.InspectionTabs.SelectedIndex -eq 2) {
                Send-Request 'call' '/api/call' @{id=$state.selected;turn=$call.turn;call=$call.id;source=$call.source}
            }
            $schema = $ui.Schemas.SelectedItem
            if ($schema -and -not $ui.SchemaDetails.Text -and $ui.InspectionTabs.SelectedIndex -eq 3) {
                if ($state.mcpSchemas.ContainsKey($schema)) {
                    $definition = $state.mcpSchemas[$schema]
                    $ui.SchemaDetails.Text = ConvertTo-Json @{source='已配置 MCP';server=$definition.server;name=$definition.name;inputSchema=$definition.inputSchema;outputSchema=$definition.outputSchema} -Depth 85
                } else { Send-Request 'schema' '/api/schema' @{id=$state.selected;name=$schema} }
            }
        }
    } catch { Set-Status $_.Exception.Message -Notice }
})
$windowHook = [Windows.Interop.HwndSourceHook]{
    param($handle, $message, $wParam, $lParam, [ref]$handled)
    if ($message -in 0x007E,0x001A,0x02E0) { $state.windows.Invalidate() }
    if ($message -eq [ContextWindows]::ChangeMessage -and $state.windows.TakeChange() -and -not $state.hidden) {
        try {
            Update-CodexTarget
            Move-DesktopLock
        } catch { Set-Status $_.Exception.Message -Notice }
    }
    return [IntPtr]::Zero
}
$window.Add_SourceInitialized({
    [ContextWindows]::HideFromTaskbar($hostWindow.Handle)
    $state.windows = [ContextWindows]::new($hostWindow.Handle)
    $source = [Windows.Interop.HwndSource]::FromHwnd($hostWindow.Handle)
    $source.AddHook($windowHook)
    $area = [Windows.SystemParameters]::WorkArea
    Set-WidgetLayout $area.Width ($area.Height - 56)
    $window.Left = $area.Left + ($area.Width - $window.Width) / 2
    $window.Top = $area.Top + 10
})
$window.Add_SizeChanged({ if ($state.windows) { $state.windows.Invalidate() } })
$window.Add_Loaded({
    if ($timer.IsEnabled) { return }
    Set-Appearance @{}
    Set-DesktopLock $state.locked
    $timer.Start()
    if ($ReadyEvent) {
        $signal = [Threading.EventWaitHandle]::OpenExisting($ReadyEvent)
        try { [void]$signal.Set() } finally { $signal.Dispose() }
    }
})
$window.Add_Closed({
    $timer.Stop()
    if ($state.windows) { $state.windows.Dispose() }
    if ($mailbox) { $mailbox.Dispose() }
    $http.Dispose()
    $window.Dispatcher.BeginInvokeShutdown([Windows.Threading.DispatcherPriority]::Background)
})
$window.Show()
[Windows.Threading.Dispatcher]::Run()

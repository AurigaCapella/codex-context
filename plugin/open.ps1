#requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateRange(1024,65535)][int]$Port = 47371,
    [ValidatePattern('^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$')][string]$ThreadId,
    [switch]$NoBrowser,
    [switch]$Browser,
    [switch]$Detached,
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$address = "http://127.0.0.1:$Port"
$health = "$address/api/health"
function Test-ContextServer {
    try {
        return (Invoke-RestMethod -Uri $health -TimeoutSec 1).service -eq 'codex-context'
    } catch {
        return $false
    }
}

if ($Stop) {
    if (Test-ContextServer) {
        Invoke-RestMethod -Method Post -Uri "$address/api/stop" -Headers @{Origin=$address; 'X-Context-Action'='stop'} | Out-Null
    }
    return
}

if (-not (Test-ContextServer)) {
    $node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    $program = Join-Path $PSScriptRoot 'server.mjs'
    $process = Start-Process -FilePath $node -ArgumentList ('"{0}" --port {1}' -f $program,$Port) -WindowStyle Hidden -PassThru
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if (Test-ContextServer) { break }
        if ($process.HasExited) { throw "Codex Context could not start on port $Port. Exit code $($process.ExitCode)." }
        Start-Sleep -Milliseconds 150
    }
    if (-not (Test-ContextServer)) { throw "Codex Context did not respond on port $Port." }
}

if ($NoBrowser -or $Browser) {
    if ($ThreadId) { $address += "/#$ThreadId" }
    if ($Browser -and -not $NoBrowser) { Start-Process $address }
    Write-Output $address
    return
}

function Send-WidgetTarget([string]$Name) {
    $options = [IO.Pipes.PipeOptions]::Asynchronous -bor [IO.Pipes.PipeOptions]::CurrentUserOnly
    $pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $Name, [IO.Pipes.PipeDirection]::InOut, $options)
    try {
        try { $pipe.Connect(350) } catch [TimeoutException] { return }
        $mode = if ($Detached) { 'D' } else { 'O' }
        $data = [Text.Encoding]::ASCII.GetBytes($mode + ([string]$ThreadId).PadRight(36))
        $pipe.Write($data, 0, $data.Length)
        $reply = [byte[]]::new(4)
        $deadline = [Threading.CancellationTokenSource]::new(2200)
        try {
            for ($offset = 0; $offset -lt $reply.Length;) {
                $bytes = $pipe.ReadAsync($reply, $offset, $reply.Length - $offset, $deadline.Token).GetAwaiter().GetResult()
                if (-not $bytes) { throw 'Codex Context widget closed its control pipe.' }
                $offset += $bytes
            }
        } finally { $deadline.Dispose() }
        return [BitConverter]::ToInt32($reply, 0)
    } finally { $pipe.Dispose() }
}

$sessionId = (Get-Process -Id $PID).SessionId
$mailboxName = "CodexContext.Widget.v1.$sessionId.$Port"
$launchMutex = [Threading.Mutex]::new($false, "Local\$mailboxName.launch")
$locked = $false
try {
    try { $locked = $launchMutex.WaitOne(15000) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another Codex Context launch is still in progress.' }
    $running = Send-WidgetTarget $mailboxName
    if ($running) {
        Write-Output "Codex Context (PID $running, reused)"
        return
    }

    $dotnet = (Get-Command dotnet.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not $dotnet -or -not (& $dotnet --list-runtimes | Where-Object { $_ -match '^Microsoft\.WindowsDesktop\.App 10\.' })) {
        throw 'Codex Context GUI requires the .NET 10 Desktop Runtime.'
    }
    $panel = Join-Path $PSScriptRoot 'widget/ContextWidget.dll'
    if (-not (Test-Path -LiteralPath $panel)) { throw 'The compiled ContextWidget.dll is missing. Run build-widget.ps1 before packaging.' }
    $panelArguments = 'exec "{0}" -Port {1}' -f $panel,$Port
    if ($ThreadId) { $panelArguments += " -ThreadId $ThreadId" }
    if ($Detached) { $panelArguments += ' -Detached' }
    $eventName = 'Local\CodexContext-' + [Guid]::NewGuid().ToString('N')
    $ready = [Threading.EventWaitHandle]::new($false,[Threading.EventResetMode]::ManualReset,$eventName)
    try {
        $panelArguments += " -ReadyEvent $eventName -MailboxName $mailboxName"
        $panelProcess = Start-Process -FilePath $dotnet -ArgumentList $panelArguments -WindowStyle Hidden -PassThru
        $expires = [DateTime]::UtcNow.AddSeconds(12)
        while (-not $ready.WaitOne(200)) {
            if ($panelProcess.HasExited) { throw "Codex Context GUI exited with code $($panelProcess.ExitCode)." }
            if ([DateTime]::UtcNow -gt $expires) { throw 'Codex Context GUI did not become ready.' }
        }
    } finally { $ready.Dispose() }
    Write-Output "Codex Context (PID $($panelProcess.Id))"
} finally {
    if ($locked) { $launchMutex.ReleaseMutex() }
    $launchMutex.Dispose()
}

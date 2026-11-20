#requires -Version 7.6
param([string]$OutputPath = (Join-Path $PSScriptRoot 'plugin/ContextInterop.dll'))

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName WindowsBase,UIAutomationClient,UIAutomationTypes
$references = @(
    [Windows.Automation.AutomationElement].Assembly.Location
    [Windows.Automation.ControlType].Assembly.Location
    [Windows.Rect].Assembly.Location
    Get-ChildItem -LiteralPath (Join-Path $PSHOME 'ref') -Filter '*.dll' |
        Select-Object -ExpandProperty FullName
)
$sources = 'context-windows.cs','composer-anchor.cs','widget-mailbox.cs' | ForEach-Object {
    Join-Path $PSScriptRoot "plugin/$_"
}
$temporary = Join-Path ([IO.Path]::GetTempPath()) ("context-interop-" + [Guid]::NewGuid().ToString('N') + '.dll')
try {
    Add-Type -Path $sources -ReferencedAssemblies $references -OutputAssembly $temporary
    Move-Item -LiteralPath $temporary -Destination $OutputPath -Force
} finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
}

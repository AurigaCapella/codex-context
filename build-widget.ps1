#requires -Version 7.0
param([string]$Dotnet = 'dotnet')

$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot 'widget/ContextWidget.csproj'
$output = Join-Path $PSScriptRoot 'plugin/widget'
$artifacts = Join-Path ([IO.Path]::GetTempPath()) 'codex-context-build'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_GENERATE_ASPNET_CERTIFICATE = 'false'
& $Dotnet publish $project -c Release --artifacts-path $artifacts --no-self-contained -o $output
if ($LASTEXITCODE -ne 0) { throw "ContextWidget build failed (exit code $LASTEXITCODE)." }

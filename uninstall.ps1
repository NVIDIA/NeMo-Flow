# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

[CmdletBinding()]
param(
    [string]$InstallDir,
    [switch]$DryRun,
    [switch]$Force,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'

function Show-Usage {
    @'
Remove the NeMo Relay CLI installed by install.ps1.

Usage:
  irm https://raw.githubusercontent.com/NVIDIA/NeMo-Relay/main/uninstall.ps1 | iex
  .\uninstall.ps1 [-InstallDir DIR] [-DryRun] [-Force] [-Help]

Options:
  -InstallDir DIR      Installation directory (default: %LOCALAPPDATA%\nemo-relay\bin).
  -DryRun              Print the binary that would be removed without removing it.
  -Force               Interactively offer to terminate active Relay client processes.
  -Help                Show this help text.

Examples:
  irm https://raw.githubusercontent.com/NVIDIA/NeMo-Relay/main/uninstall.ps1 | iex
  .\uninstall.ps1 -InstallDir "$HOME\bin"

This removes only the installed CLI binary. It does not remove PATH entries,
Relay configuration, observability output, or coding-agent integrations. It
refuses removal while this CLI has active Relay processes unless -Force is used.
'@ | Write-Output
}

function Fail([string]$Message) {
    throw "nemo-relay uninstaller: $Message"
}

function Test-CodingAgentProcess([string]$CommandLine) {
    return $CommandLine -match '(?i)(?:^|\s|[\\/])(codex|claude|pi)(?:\.exe)?(?:\s|$|[\\/])'
}

function Test-RelayMcpProcess([string]$CommandLine) {
    return $CommandLine -match '(?i)(?:^|\s)mcp(?:\s|$)'
}

function Get-ActiveRelayShutdownTargets([string]$Destination) {
    if ($env:OS -ne 'Windows_NT') {
        return @()
    }
    try {
        $processes = @(Get-CimInstance Win32_Process)
    }
    catch {
        Fail "could not inspect active processes before uninstall: $($_.Exception.Message)"
    }
    $processesById = @{}
    foreach ($process in $processes) {
        $processesById[[string]$process.ProcessId] = $process
    }
    $targets = @{}
    $expectedName = [System.IO.Path]::GetFileName($Destination)
    foreach ($relayProcess in $processes) {
        $commandLine = [string]$relayProcess.CommandLine
        $executablePath = [string]$relayProcess.ExecutablePath
        $hasExpectedName = [string]::Equals($relayProcess.Name, $expectedName, [System.StringComparison]::OrdinalIgnoreCase)
        $usesInstalledCli = $executablePath.Equals($Destination, [System.StringComparison]::OrdinalIgnoreCase) -or
            ($hasExpectedName -and $commandLine.IndexOf($Destination, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
        if (-not $usesInstalledCli) {
            continue
        }

        $target = $relayProcess
        if (Test-RelayMcpProcess $commandLine) {
            $currentId = [string]$relayProcess.ParentProcessId
            while ($currentId -and $currentId -ne '0') {
                $current = $processesById[$currentId]
                if ($null -eq $current) {
                    break
                }
                if (-not [string]::IsNullOrEmpty($current.CommandLine) -and (Test-CodingAgentProcess $current.CommandLine)) {
                    $target = $current
                    break
                }
                $nextId = [string]$current.ParentProcessId
                if ($nextId -eq $currentId) {
                    break
                }
                $currentId = $nextId
            }
        }
        $targets[[string]$target.ProcessId] = $target
    }
    return @($targets.Values)
}

function Test-ActiveRelayShutdownTarget([uint32]$ProcessId, [string]$Destination) {
    return @(Get-ActiveRelayShutdownTargets $Destination | Where-Object { $_.ProcessId -eq $ProcessId }).Count -gt 0
}

function Format-ProcessDescription($Process) {
    if ([string]::IsNullOrEmpty($Process.CommandLine)) {
        return "PID $($Process.ProcessId)"
    }
    return "PID $($Process.ProcessId): $($Process.CommandLine)"
}

function Stop-ConfirmedProcessTree($Process, [string]$Destination) {
    $answer = Read-Host "Terminate $(Format-ProcessDescription $Process) and its child processes? [y/N]"
    if ($answer -notmatch '^(?i:y|yes)$') {
        Fail "uninstall cancelled; process $($Process.ProcessId) remains active"
    }
    if (-not (Test-ActiveRelayShutdownTarget $Process.ProcessId $Destination)) {
        Fail "process $($Process.ProcessId) changed after confirmation; refusing to terminate it"
    }
    & taskkill.exe /PID $Process.ProcessId /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Fail "could not terminate process $($Process.ProcessId)"
    }
}

function Stop-ActiveRelayProcesses([string]$Destination) {
    $activeTargets = @(Get-ActiveRelayShutdownTargets $Destination)
    if ($activeTargets.Count -eq 0) {
        return
    }

    [Console]::Error.WriteLine('Active Relay processes prevent uninstallation:')
    foreach ($process in $activeTargets) {
        [Console]::Error.WriteLine((Format-ProcessDescription $process))
    }
    if ($DryRun) {
        [Console]::Error.WriteLine('Dry run would refuse removal until these processes exit.')
        return
    }
    if (-not $Force) {
        Fail 'refusing to uninstall while active Relay processes exist; close the coding agents and retry, or rerun with -Force to confirm each process shutdown'
    }
    foreach ($process in $activeTargets) {
        Stop-ConfirmedProcessTree $process $Destination
    }

    for ($attempt = 0; $attempt -lt 25; $attempt++) {
        if (@(Get-ActiveRelayShutdownTargets $Destination).Count -eq 0) {
            return
        }
        Start-Sleep -Milliseconds 200
    }
    Fail 'refusing to uninstall because Relay processes remain active'
}

if ($Help) {
    Show-Usage
    exit 0
}

try {
    if ([string]::IsNullOrWhiteSpace($InstallDir)) {
        if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
            Fail 'LOCALAPPDATA must be set to choose the default install directory'
        }
        $InstallDir = Join-Path $env:LOCALAPPDATA 'nemo-relay\bin'
    }
    if ([string]::IsNullOrWhiteSpace($InstallDir)) {
        Fail 'install directory must not be empty'
    }

    if ((Test-Path -LiteralPath $InstallDir) -and -not (Test-Path -LiteralPath $InstallDir -PathType Container)) {
        Fail "install path is not a directory: $InstallDir"
    }

    $InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
    $destination = Join-Path $InstallDir 'nemo-relay.exe'
    if (Test-Path -LiteralPath $destination -PathType Container) {
        Fail "install target is a directory: $destination"
    }
    if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
        Write-Output "NeMo Relay CLI is not installed at $destination"
        exit 0
    }
    Stop-ActiveRelayProcesses $destination
    if ($DryRun) {
        Write-Output "Would remove NeMo Relay CLI at $destination"
        exit 0
    }

    Remove-Item -LiteralPath $destination -Force
    Write-Output "Removed NeMo Relay CLI from $destination"
}
catch {
    Write-Error $_
    exit 1
}

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
  iwr https://raw.githubusercontent.com/NVIDIA/NeMo-Relay/main/uninstall.ps1 -OutFile uninstall.ps1
  .\uninstall.ps1 -Force

This removes only the installed CLI binary. It does not remove PATH entries,
Relay configuration, observability output, or coding-agent integrations. It
refuses removal while this CLI has active Relay processes unless -Force is used.
Active managed daemon processes always block removal, including with -Force.
Close affected coding-agent sessions, allow shared workers to drain, then stop
the managed deployment through its service manager. Managed bundles, daemon
identity/trust state, and deployment services are preserved.
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

function Get-RelayCimInstance {
    param([Parameter(ValueFromRemainingArguments = $true)]$Arguments)
    return Get-CimInstance @Arguments
}

function Read-UninstallConfirmation([string]$Prompt) {
    return Read-Host $Prompt
}

function Get-ActiveRelayShutdownTargets([string]$Destination, [switch]$ManagedOnly) {
    if ($env:OS -ne 'Windows_NT') {
        return @()
    }
    try {
        $processes = @(Get-RelayCimInstance Win32_Process)
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

        if ($ManagedOnly) {
            if ($commandLine -match '(?i)(?:^|\s)daemon(?:\s|$)') {
                $targets[[string]$relayProcess.ProcessId] = $relayProcess
            }
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

function Test-SameProcessIdentity($Expected, $Current) {
    return $Expected.ProcessId -eq $Current.ProcessId -and
        $Expected.ParentProcessId -eq $Current.ParentProcessId -and
        [string]$Expected.CreationDate -eq [string]$Current.CreationDate -and
        [string]::Equals(
            [string]$Expected.ExecutablePath,
            [string]$Current.ExecutablePath,
            [System.StringComparison]::OrdinalIgnoreCase
        )
}

function Test-ActiveRelayShutdownTarget($ExpectedProcess, [string]$Destination) {
    foreach ($current in @(Get-ActiveRelayShutdownTargets $Destination)) {
        if ($current.ProcessId -eq $ExpectedProcess.ProcessId) {
            return Test-SameProcessIdentity $ExpectedProcess $current
        }
    }
    return $false
}

function Format-ProcessDescription($Process) {
    if ([string]::IsNullOrEmpty($Process.CommandLine)) {
        return "PID $($Process.ProcessId)"
    }
    return "PID $($Process.ProcessId): $($Process.CommandLine)"
}

function Test-ProcessIsAncestorOfUninstaller([uint32]$AncestorId) {
    $currentId = [uint32]$PID
    while ($currentId -gt 0) {
        if ($currentId -eq $AncestorId) {
            return $true
        }
        try {
            $current = Get-RelayCimInstance Win32_Process -Filter "ProcessId = $currentId"
        }
        catch {
            Fail "could not inspect the uninstaller process tree: $($_.Exception.Message)"
        }
        if ($null -eq $current -or $current.ParentProcessId -eq $currentId) {
            return $false
        }
        $currentId = [uint32]$current.ParentProcessId
    }
    return $false
}

function Stop-ConfirmedProcessTree($Process, [string]$Destination) {
    if (Test-ProcessIsAncestorOfUninstaller $Process.ProcessId) {
        Fail "cannot terminate process $($Process.ProcessId) from within its own process tree; rerun the uninstaller from an independent terminal"
    }
    $answer = Read-UninstallConfirmation "Terminate $(Format-ProcessDescription $Process) and its child processes? [y/N]"
    if ($answer -notmatch '^(?i:y|yes)$') {
        Fail "uninstall cancelled; process $($Process.ProcessId) remains active"
    }
    if (-not (Test-ActiveRelayShutdownTarget $Process $Destination)) {
        Fail "process $($Process.ProcessId) changed after confirmation; refusing to terminate it"
    }
    Assert-NoManagedRelayProcesses $Destination
    & taskkill.exe /PID $Process.ProcessId /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Fail "could not terminate process $($Process.ProcessId)"
    }
}

function Assert-NoManagedRelayProcesses([string]$Destination) {
    # Managed workers can serve sessions outside their local process tree.
    $managedProcesses = @(Get-ActiveRelayShutdownTargets $Destination -ManagedOnly)
    if ($managedProcesses.Count -gt 0) {
        foreach ($process in $managedProcesses) {
            [Console]::Error.WriteLine((Format-ProcessDescription $process))
        }
        $message = 'active managed daemon deployment; close affected coding-agent sessions, allow shared workers to drain, then stop it through its service manager. -Force cannot override this restriction'
        if ($DryRun) {
            Fail "dry run would refuse removal: $message"
        }
        Fail $message
    }
}

function Stop-ActiveRelayProcesses([string]$Destination) {
    Assert-NoManagedRelayProcesses $Destination
    $activeTargets = @(Get-ActiveRelayShutdownTargets $Destination)
    if ($activeTargets.Count -eq 0) {
        return
    }

    [Console]::Error.WriteLine('Active Relay processes prevent uninstallation:')
    foreach ($process in $activeTargets) {
        [Console]::Error.WriteLine((Format-ProcessDescription $process))
    }
    if ($DryRun) {
        Fail 'dry run would refuse removal until these processes exit'
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

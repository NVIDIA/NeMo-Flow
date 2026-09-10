# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Uninstaller = Join-Path $RepoRoot 'uninstall.ps1'
$PowerShell = (Get-Process -Id $PID).Path
$TestRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("nemo-relay-uninstall-test-" + [guid]::NewGuid().ToString('N'))
$OriginalLocalAppData = $env:LOCALAPPDATA
$TestsRun = 0

function Fail([string]$Message) {
    throw "FAIL: $Message"
}

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) {
        Fail $Message
    }
}

function Assert-Contains([string]$Text, [string]$Expected) {
    Assert-True ($Text.Contains($Expected)) "expected '$Expected' in: $Text"
}

function Assert-NotContains([string]$Text, [string]$Unexpected) {
    Assert-True (-not $Text.Contains($Unexpected)) "did not expect '$Unexpected' in: $Text"
}

function Invoke-Uninstaller {
    param(
        [string[]]$Arguments = @(),
        [AllowNull()][string]$InputText = $null
    )

    if ($null -eq $InputText) {
        $script:RunOutput = (& $PowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Uninstaller @Arguments 2>&1 | Out-String -Width 4096)
    }
    else {
        $script:RunOutput = ($InputText | & $PowerShell -NoProfile -ExecutionPolicy Bypass -File $Uninstaller @Arguments 2>&1 | Out-String -Width 4096)
    }
    $script:RunStatus = $LASTEXITCODE
}

function Assert-Success {
    Assert-True ($RunStatus -eq 0) "expected success, got ${RunStatus}: $RunOutput"
}

function Assert-Failure {
    Assert-True ($RunStatus -ne 0) "expected failure: $RunOutput"
}

try {
    New-Item -ItemType Directory -Force -Path $TestRoot | Out-Null

    # Exercise Windows process classification on every host without signaling
    # real processes. Keep the real Windows executable tests below as well.
    & {
        $originalOS = $env:OS
        try {
            $env:OS = 'Windows_NT'
            $ast = [System.Management.Automation.Language.Parser]::ParseFile($Uninstaller, [ref]$null, [ref]$null)
            foreach ($definition in $ast.FindAll({
                param($node)
                $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
            }, $false)) {
                . ([scriptblock]::Create($definition.Extent.Text))
            }
            $destination = 'C:\relay\nemo-relay.exe'
            $agent = [pscustomobject]@{ ProcessId = 10; ParentProcessId = 1; Name = 'codex.exe'; ExecutablePath = 'C:\codex.exe'; CommandLine = 'codex' }
            $relay = [pscustomobject]@{ ProcessId = 11; ParentProcessId = 10; Name = 'nemo-relay.exe'; ExecutablePath = $destination; CommandLine = "$destination mcp" }
            function Get-RelayCimInstance { @($agent, $relay) }
            function Read-UninstallConfirmation { throw 'unexpected shutdown prompt' }
            $Force = $true
            $DryRun = $false
            Assert-True ((Get-ActiveRelayShutdownTargets $destination).ProcessId -eq 10) 'personal MCP did not select its agent'
            foreach ($role in @('daemon', 'daemon mcp', 'daemon worker', 'daemon hook')) {
                $relay.CommandLine = "$destination $role"
                try {
                    Stop-ActiveRelayProcesses $destination
                    throw 'managed uninstall unexpectedly succeeded'
                }
                catch {
                    Assert-Contains $_.Exception.Message 'active managed daemon deployment'
                }
            }
            $DryRun = $true
            $relay.CommandLine = "$destination daemon"
            try {
                Stop-ActiveRelayProcesses $destination
                throw 'managed dry-run unexpectedly succeeded'
            }
            catch {
                Assert-Contains $_.Exception.Message 'dry run would refuse removal'
            }
            $relay.ExecutablePath = 'C:\other\nemo-relay.exe'
            $relay.CommandLine = 'C:\other\nemo-relay.exe daemon'
            Assert-True (@(Get-ActiveRelayShutdownTargets $destination -ManagedOnly).Count -eq 0) 'unrelated installation blocked uninstall'
        }
        finally {
            $env:OS = $originalOS
        }
    }
    $TestsRun += 7

    $TestsRun++
    Invoke-Uninstaller -Arguments @('-Help')
    Assert-Success
    Assert-Contains $RunOutput 'Usage:'

    $TestsRun++
    Invoke-Uninstaller -Arguments @('-Unknown')
    Assert-Failure

    $TestsRun++
    $env:LOCALAPPDATA = Join-Path $TestRoot 'local-app-data'
    $DefaultDir = Join-Path $env:LOCALAPPDATA 'nemo-relay\bin'
    $DefaultDestination = Join-Path $DefaultDir 'nemo-relay.exe'
    New-Item -ItemType Directory -Force -Path $DefaultDir | Out-Null
    New-Item -ItemType File -Path $DefaultDestination | Out-Null
    Invoke-Uninstaller
    Assert-Success
    Assert-True (-not (Test-Path -LiteralPath $DefaultDestination)) 'default binary was not removed'

    $TestsRun++
    $InstallDir = Join-Path $TestRoot 'custom-bin'
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $Destination = Join-Path $InstallDir 'nemo-relay.exe'
    $UnrelatedPath = Join-Path $InstallDir 'unrelated-tool'
    New-Item -ItemType File -Path $Destination, $UnrelatedPath | Out-Null
    Invoke-Uninstaller -Arguments @('-InstallDir', $InstallDir, '-DryRun')
    Assert-Success
    Assert-True (Test-Path -LiteralPath $Destination -PathType Leaf) 'dry run removed the binary'
    Assert-Contains $RunOutput "Would remove NeMo Relay CLI at $Destination"

    $TestsRun++
    Invoke-Uninstaller -Arguments @('-InstallDir', $InstallDir)
    Assert-Success
    Assert-True (-not (Test-Path -LiteralPath $Destination)) 'custom binary was not removed'
    Assert-True (Test-Path -LiteralPath $UnrelatedPath -PathType Leaf) 'uninstaller removed an unrelated file'

    $TestsRun++
    $AbsentDir = Join-Path $TestRoot 'absent-bin'
    $AbsentDestination = Join-Path $AbsentDir 'nemo-relay.exe'
    Invoke-Uninstaller -Arguments @('-InstallDir', $AbsentDir)
    Assert-Success
    Assert-Contains $RunOutput "NeMo Relay CLI is not installed at $AbsentDestination"

    if ($env:OS -eq 'Windows_NT') {
        foreach ($role in @('daemon', 'daemon mcp', 'daemon worker', 'daemon hook')) {
            $TestsRun++
            $ManagedDir = Join-Path $TestRoot ('managed-' + $TestsRun)
            $ManagedDestination = Join-Path $ManagedDir 'nemo-relay.exe'
            New-Item -ItemType Directory -Path $ManagedDir | Out-Null
            Copy-Item -LiteralPath $env:ComSpec -Destination $ManagedDestination
            # Keep a real executable alive with the managed command tokens in argv.
            $ManagedProcess = Start-Process -FilePath $ManagedDestination -ArgumentList @(
                '/d', '/c', "timeout /t 30 /nobreak >NUL & rem $role"
            ) -PassThru
            try {
                Start-Sleep -Milliseconds 500
                foreach ($mode in @('normal', 'force', 'dry-run')) {
                    $arguments = @('-InstallDir', $ManagedDir)
                    if ($mode -eq 'force') { $arguments += '-Force' }
                    if ($mode -eq 'dry-run') { $arguments += '-DryRun' }
                    Invoke-Uninstaller -Arguments $arguments -InputText 'y'
                    Assert-Failure
                    Assert-Contains $RunOutput 'active managed daemon deployment'
                    Assert-Contains $RunOutput '-Force cannot'
                    Assert-Contains $RunOutput 'override this restriction'
                    Assert-NotContains $RunOutput 'Would remove NeMo Relay CLI'
                    Assert-True (-not $ManagedProcess.HasExited) 'managed process was terminated'
                    Assert-True (Test-Path -LiteralPath $ManagedDestination) 'managed binary was removed'
                }
            }
            finally {
                if (-not $ManagedProcess.HasExited) {
                    Stop-Process -Id $ManagedProcess.Id -Force
                    $ManagedProcess.WaitForExit()
                }
            }
        }

        $TestsRun++
        $ActiveDir = Join-Path $TestRoot 'active-bin'
        $ActiveDestination = Join-Path $ActiveDir 'nemo-relay.exe'
        New-Item -ItemType Directory -Force -Path $ActiveDir | Out-Null
        Copy-Item -LiteralPath $env:ComSpec -Destination $ActiveDestination
        $ActiveProcess = Start-Process -FilePath $ActiveDestination -ArgumentList @(
            '/d', '/c', 'timeout /t 30 /nobreak >NUL'
        ) -PassThru
        try {
            Start-Sleep -Milliseconds 500
            Invoke-Uninstaller -Arguments @('-InstallDir', $ActiveDir)
            Assert-Failure
            Assert-Contains $RunOutput 'refusing to uninstall while active Relay processes exist'
            Assert-True (Test-Path -LiteralPath $ActiveDestination -PathType Leaf) 'uninstaller removed an active binary'

            $TestsRun++
            Invoke-Uninstaller -Arguments @('-InstallDir', $ActiveDir, '-DryRun')
            Assert-Failure
            Assert-Contains $RunOutput 'dry run would refuse removal until these processes exit'
            Assert-NotContains $RunOutput 'Would remove NeMo Relay CLI'
            Assert-True (-not $ActiveProcess.HasExited) 'dry run terminated the active Relay process'
            Assert-True (Test-Path -LiteralPath $ActiveDestination -PathType Leaf) 'dry run removed the active binary'

            $TestsRun++
            Invoke-Uninstaller -Arguments @('-InstallDir', $ActiveDir, '-Force') -InputText 'n'
            Assert-Failure
            Assert-Contains $RunOutput "uninstall cancelled; process $($ActiveProcess.Id) remains active"
            Assert-True (-not $ActiveProcess.HasExited) 'rejected confirmation terminated the active Relay process'
            Assert-True (Test-Path -LiteralPath $ActiveDestination -PathType Leaf) 'rejected confirmation removed the active binary'

            $TestsRun++
            Invoke-Uninstaller -Arguments @('-InstallDir', $ActiveDir, '-Force') -InputText 'y'
            Assert-Success
            $ActiveProcess.WaitForExit(5000) | Out-Null
            Assert-True $ActiveProcess.HasExited 'accepted confirmation did not terminate the active Relay process'
            Assert-True (-not (Test-Path -LiteralPath $ActiveDestination)) 'accepted confirmation did not remove the active binary'
        }
        finally {
            if (-not $ActiveProcess.HasExited) {
                Stop-Process -Id $ActiveProcess.Id -Force
                $ActiveProcess.WaitForExit()
            }
        }
    }

    Write-Output "PASS: $TestsRun PowerShell CLI uninstaller scenarios"
}
finally {
    if ($null -eq $OriginalLocalAppData) {
        Remove-Item Env:LOCALAPPDATA -ErrorAction SilentlyContinue
    }
    else {
        $env:LOCALAPPDATA = $OriginalLocalAppData
    }
    Remove-Item -LiteralPath $TestRoot -Recurse -Force -ErrorAction SilentlyContinue
}

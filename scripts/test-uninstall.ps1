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

function Invoke-Uninstaller {
    param([string[]]$Arguments = @())

    $script:RunOutput = (& $PowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Uninstaller @Arguments 2>&1 | Out-String)
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

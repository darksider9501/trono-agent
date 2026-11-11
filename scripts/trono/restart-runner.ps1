<#
.SYNOPSIS
    Restart the Trono runner with the code currently on disk.

.DESCRIPTION
    The runner keeps for(;;) forever once started with --loop, so a code change
    only takes effect after a restart. This script stops the live runner, rotates
    its logs, and starts a fresh one with the same arguments.

    A killed runner leaves logs/driver.lock behind, but driverlock.current()
    ignores locks whose pid is not alive, so no cleanup is required here.

.EXAMPLE
    powershell -NoProfile -File scripts/trono/restart-runner.ps1
    powershell -NoProfile -File scripts/trono/restart-runner.ps1 -Loop 120 -Wait 45
#>
param(
    [int]$Loop = 90,
    [int]$Wait = 45
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$logs = Join-Path $root 'scripts\trono\logs'
$out = Join-Path $logs 'runner.out'
$err = Join-Path $logs 'runner.err'

Push-Location $root
try {
    $existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like '*trono/runner.js*' }

    if ($existing) {
        foreach ($proc in $existing) {
            Write-Output "stopping runner pid $($proc.ProcessId)"
            Stop-Process -Id $proc.ProcessId -Force
        }
        Start-Sleep -Seconds 3
        $still = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
            Where-Object { $_.CommandLine -like '*trono/runner.js*' }
        if ($still) { throw "runner still alive after stop: $($still.ProcessId -join ',')" }
        Write-Output 'runner stopped'
    }
    else {
        Write-Output 'no runner was running'
    }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    foreach ($file in @($out, $err)) {
        if (Test-Path $file) {
            $rotated = [IO.Path]::Combine($logs, [IO.Path]::GetFileNameWithoutExtension($file) + ".$stamp." + [IO.Path]::GetExtension($file).TrimStart('.'))
            Move-Item $file $rotated -Force
        }
    }

    $proc = Start-Process -FilePath 'node' `
        -ArgumentList 'scripts/trono/runner.js', '--live', "--loop=$Loop" `
        -WorkingDirectory $root -WindowStyle Hidden `
        -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
    Write-Output "started runner pid $($proc.Id) with --loop=$Loop"

    Start-Sleep -Seconds $Wait

    Write-Output ''
    Write-Output '--- runner.out (tail) ---'
    if (Test-Path $out) { Get-Content $out -Tail 25 } else { Write-Output '(no output)' }

    Write-Output ''
    Write-Output '--- runner.err (tail) ---'
    if ((Get-Item $err -ErrorAction SilentlyContinue).Length -gt 0) { Get-Content $err -Tail 10 } else { Write-Output '(empty)' }

    Write-Output ''
    if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) {
        Write-Output "ALIVE pid $($proc.Id)"
    }
    else {
        Write-Output "EXITED pid $($proc.Id) -- check runner.err"
        exit 1
    }
}
finally {
    Pop-Location
}

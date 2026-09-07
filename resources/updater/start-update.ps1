param([Parameter(Mandatory = $true)][string]$PlanPath, [switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
$stage = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($PlanPath))
$workerPath = Join-Path $PSScriptRoot 'apply-update.ps1'
$arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $workerPath + '"'), '-PlanPath', ('"' + $PlanPath + '"'))
if ($NoLaunch) { $arguments += '-NoLaunch' }
$worker = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -WorkingDirectory $stage -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $stage 'helper.log') -RedirectStandardError (Join-Path $stage 'helper-error.log')
$worker.Id

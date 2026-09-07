param([string]$PlanPath, [string]$LockedFile)
$held = [IO.File]::Open($LockedFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
    & "$PSScriptRoot/../../resources/updater/apply-update.ps1" -PlanPath $PlanPath -NoLaunch
    exit $LASTEXITCODE
} finally { $held.Dispose() }

param([Parameter(Mandatory = $true)][string]$PlanPath, [switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
$plan = Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8 | ConvertFrom-Json
$stage = [IO.Path]::GetFullPath($plan.stageDir)
$target = [IO.Path]::GetFullPath($plan.targetDir)
$backup = Join-Path $stage 'backup'
$resultPath = Join-Path $stage 'result.json'
$touched = [Collections.Generic.List[string]]::new()
$original = @{}
$committed = $false

function Safe-Path([string]$root, [string]$name) {
    if ($name -match '[\\:<>"|?*\x00-\x1f]' -or $name -match '(^|/)($|\.{1,2}(/|$))') { throw "Unsafe update path: $name" }
    foreach ($part in $name.Split('/')) {
        if (!$part -or $part -match '[. ]$' -or $part -match '^(?i:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)') { throw "Unsafe update path: $name" }
    }
    $path = [IO.Path]::GetFullPath((Join-Path $root $name))
    if (!$path.StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Update path escapes root' }
    $probe = $path
    while ($probe) {
        if (Test-Path -LiteralPath $probe) {
            if ((Get-Item -LiteralPath $probe -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked update path: $probe" }
        }
        $probe = [IO.Path]::GetDirectoryName($probe)
    }
    return $path
}

function Record-Result([string]$state, [string]$message) {
    $json = @{ state = $state; message = $message; version = $plan.manifest.version; backup = $backup } | ConvertTo-Json
    [IO.File]::WriteAllText($resultPath, $json, [Text.UTF8Encoding]::new($false))
}

function Verify-File([string]$path, $record) {
    if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing update file: $path" }
    if ((Get-Item -LiteralPath $path).Length -ne $record.size -or (Hash-File $path) -ne $record.sha256) { throw "Update checksum mismatch: $path" }
}

function Hash-File([string]$path) {
    $stream = [IO.File]::OpenRead($path)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $hasher.Dispose() }
}

try {
    if ($target -eq [IO.Path]::GetPathRoot($target) -or $stage.StartsWith($target.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe update directories' }
    if ($plan.manifest.schema -ne 1 -or $plan.previous.schema -ne 1 -or $plan.manifest.entry -ne $plan.previous.entry) { throw 'Invalid update plan' }
    $oldNames = @($plan.previous.files.PSObject.Properties.Name)
    $newNames = @($plan.manifest.files.PSObject.Properties.Name)
    if ($newNames -notcontains $plan.manifest.entry) { throw 'Missing application executable' }
    $changes = @($plan.changed)
    $removals = @($plan.removed)
    foreach ($name in $changes) { if ($newNames -notcontains $name) { throw 'Invalid replacement ownership' } }
    foreach ($name in $removals) { if ($oldNames -notcontains $name -or $newNames -contains $name) { throw 'Invalid removal ownership' } }
    $manifestPath = Safe-Path $target 'update-manifest.json'
    $installed = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($installed.version -ne $plan.previous.version) { throw 'Installed version changed after staging' }
    foreach ($name in $newNames) {
        $destination = Safe-Path $target $name
        if ($changes -contains $name) {
            Verify-File (Safe-Path $stage $name) $plan.manifest.files.$name
            if ($oldNames -notcontains $name -and (Test-Path -LiteralPath $destination)) { throw "User file collision: $name" }
        } else {
            Verify-File $destination $plan.manifest.files.$name
        }
    }
    $stagedManifest = Get-Content -LiteralPath (Join-Path $stage 'update-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if (($stagedManifest | ConvertTo-Json -Depth 10 -Compress) -ne ($plan.manifest | ConvertTo-Json -Depth 10 -Compress)) { throw 'Staged manifest changed' }
    'ready' | Set-Content -LiteralPath (Join-Path $stage 'helper.ready') -Encoding ASCII
    if ($plan.parentPid -gt 0) {
        Wait-Process -Id $plan.parentPid -Timeout 60 -ErrorAction SilentlyContinue
        if (Get-Process -Id $plan.parentPid -ErrorAction SilentlyContinue) { throw 'Application did not exit; update cancelled' }
    }
    # Back up every managed destination before the first write. The manifest commits last.
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    $operations = @($changes) + @($removals) + @('update-manifest.json')
    foreach ($name in $operations) {
        $path = Safe-Path $target $name
        $exists = Test-Path -LiteralPath $path
        if ($exists -and $name -ne 'update-manifest.json' -and $oldNames -notcontains $name) { throw "User file collision after app exit: $name" }
        $original[$name] = $exists
        if ($exists) {
            if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw "Destination is not a file: $name" }
            $saved = Safe-Path $backup $name
            New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($saved)) -Force | Out-Null
            Copy-Item -LiteralPath $path -Destination $saved
        }
    }
    Record-Result 'applying' 'Replacing managed application files'
    foreach ($name in $operations) {
        $destination = Safe-Path $target $name
        $newFile = $null
        if (!$original[$name] -and $removals -notcontains $name) {
            New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force | Out-Null
            $newFile = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        }
        try {
            $touched.Add($name)
            $touched | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'journal.json') -Encoding UTF8
            if ($removals -contains $name) {
                if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Force }
            } elseif ($newFile) {
                $source = [IO.File]::OpenRead((Safe-Path $stage $name))
                try { $source.CopyTo($newFile) } finally { $source.Dispose() }
            } else {
                Copy-Item -LiteralPath (Safe-Path $stage $name) -Destination $destination -Force
            }
        } finally { if ($newFile) { $newFile.Dispose() } }
        if ($name -ne 'update-manifest.json' -and $removals -notcontains $name) { Verify-File $destination $plan.manifest.files.$name }
    }
    $committed = $true
    Record-Result 'applied' 'ZIP update completed'
} catch {
    $failure = $_.Exception.Message
    $rollbackErrors = [Collections.Generic.List[string]]::new()
    for ($index = $touched.Count - 1; $index -ge 0; $index--) {
        $name = $touched[$index]
        try {
            $destination = Safe-Path $target $name
            if ($original[$name]) {
                $saved = Safe-Path $backup $name
                if ((Test-Path -LiteralPath $destination -PathType Leaf) -and (Hash-File $destination) -eq (Hash-File $saved)) { continue }
                Copy-Item -LiteralPath $saved -Destination $destination -Force
            } elseif (Test-Path -LiteralPath $destination -PathType Leaf) {
                Remove-Item -LiteralPath $destination -Force
            }
        } catch { $rollbackErrors.Add($_.Exception.Message) }
    }
    if ($rollbackErrors.Count) {
        Record-Result 'recovery-required' ($failure + '; recovery: ' + ($rollbackErrors -join '; '))
        exit 1
    }
    Record-Result 'rolled-back' $failure
}

if (!$NoLaunch -and ($plan.parentPid -le 0 -or !(Get-Process -Id $plan.parentPid -ErrorAction SilentlyContinue))) {
    try {
        $launchOptions = @{ FilePath = (Safe-Path $target $plan.manifest.entry); WorkingDirectory = $target; WindowStyle = 'Normal' }
        if ($plan.launchUserDataDir) { $launchOptions.ArgumentList = @('--user-data-dir="' + $plan.launchUserDataDir + '"') }
        Start-Process @launchOptions | Out-Null
    }
    catch { Record-Result 'launch-failed' $_.Exception.Message }
}
if (!$committed) { exit 1 }

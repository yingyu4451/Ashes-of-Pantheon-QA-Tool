param([string]$UnityEditorPath = 'D:\Unity Editor\2022.3.62f2c1\Editor')
$ErrorActionPreference = 'Stop'
$toolsRoot = Join-Path $UnityEditorPath 'Data/MonoBleedingEdge'
$mono = Join-Path $toolsRoot 'bin/mono.exe'
$compiler = Join-Path $toolsRoot 'lib/mono/msbuild/Current/bin/Roslyn/csc.exe'
$managed = Join-Path $UnityEditorPath 'Data/Managed'
$references = @(
    (Join-Path $toolsRoot 'lib/mono/4.5/Facades/netstandard.dll'),
    (Join-Path $managed 'Newtonsoft.Json.dll'),
    (Join-Path $managed 'UnityEngine/UnityEngine.dll'),
    (Join-Path $managed 'UnityEngine/UnityEngine.CoreModule.dll'),
    (Join-Path $managed 'UnityEngine/UnityEngine.ImageConversionModule.dll'),
    'resources/package-bridge/bepinex-win-x64/BepInEx/core/BepInEx.dll'
) | ForEach-Object { "-r:$_" }
& $mono $compiler -nologo -langversion:preview -target:library -out:resources/package-bridge/plugin/AshesOfPantheon.QA.PackageBridge.dll @references 'resources/package-bridge/plugin-src/AshesOfPantheonPackageBridge.cs'
if ($LASTEXITCODE -ne 0) { throw 'QA package Bridge compilation failed.' }

param([string]$UnityEditorPath = 'D:\Unity Editor\2022.3.62f2c1\Editor', [string[]]$Cases = @('catalog', 'battle', 'movement', 'runtime'))
$ErrorActionPreference = 'Stop'
$toolsRoot = Join-Path $UnityEditorPath 'Data/MonoBleedingEdge'
$mono = Join-Path $toolsRoot 'bin/mono.exe'
$compiler = Join-Path $toolsRoot 'lib/mono/msbuild/Current/bin/Roslyn/csc.exe'
$json = Join-Path $UnityEditorPath 'Data/Managed/Newtonsoft.Json.dll'
$netstandard = Join-Path $toolsRoot 'lib/mono/4.5/Facades/netstandard.dll'
$output = Join-Path ([IO.Path]::GetTempPath()) ('qa-bridge-tests-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $output | Out-Null
Copy-Item -LiteralPath $json -Destination (Join-Path $output 'Newtonsoft.Json.dll')
$executable = Join-Path $output 'BridgeTests.exe'
& $mono $compiler -nologo -langversion:preview -target:exe "-out:$executable" "-r:$json" "-r:$netstandard" 'tests/bridge/EquipmentBridgeTests.cs' 'tests/bridge/MovementBridgeTests.cs' 'tests/bridge/RuntimeBridgeTests.cs' 'resources/unity-package/com.ashes-of-pantheon.qa-bridge/Editor/QaGameReflectionAdapter.cs' 'resources/package-bridge/plugin-src/AshesOfPantheonPackageBridge.cs'
if ($LASTEXITCODE -ne 0) { throw 'QA Bridge fixture compilation failed.' }
& $mono $executable @Cases
if ($LASTEXITCODE -ne 0) { throw 'QA Bridge regression test failed.' }

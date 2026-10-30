$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\bridge-machine-install.ps1')
$root = Join-Path (Split-Path $PSScriptRoot) ('.bridge-test-' + [guid]::NewGuid().ToString('N'))
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Put($file, $text) {
  New-Item -ItemType Directory -Force -Path (Split-Path $file) | Out-Null
  [IO.File]::WriteAllText($file, $text)
}
function Get-Process { param($Name, $ErrorAction) if ($script:running) { return @{ Id = 123 } } }
try {
  $src = Join-Path $root 'source'
  $machine = Join-Path $root 'machine'
  $user = Join-Path $root 'user'
  Put (Join-Path $src 'manifest.json') '{"id":"com.orange.bridge","version":"1.0.59","name":"Bridge","host":{"minVersion":"23.3.0"}}'
  Put (Join-Path $src 'bridge.js') 'new code'
  Put (Join-Path $src 'presets\new.tpl') 'new preset'
  foreach ($base in @($machine, $user)) {
    Put (Join-Path $base 'Plugins\External\com.orange.bridge_live\manifest.json') '{"id":"com.orange.bridge","version":"1.0.58"}'
    Put (Join-Path $base 'Plugins\External\com.orange.bridge_live\obsolete.js') 'old code'
    Put (Join-Path $base 'Plugins\External\com.orange.bridge_1.0.57\manifest.json') '{"id":"com.orange.bridge"}'
    Put (Join-Path $base 'Plugins\External\unrelated\manifest.json') '{"id":"other.plugin"}'
    Put (Join-Path $base 'PluginsInfo\v1\PS.json') '{"custom":"keep","plugins":[{"pluginId":"other.plugin"},{"pluginId":"com.orange.bridge","versionString":"1.0.58"}]}'
  }
  $script:running = $true
  try { Install-LifeBridge $src $machine $user; throw 'Expected process guard' }
  catch { Assert ($_.Exception.Message -eq 'PS_RUNNING') 'PS guard failed' }
  Assert (Test-Path (Join-Path $machine 'Plugins\External\com.orange.bridge_live\obsolete.js')) 'Running PS installation changed'
  $script:running = $false
  # A failure after the machine-level changes must restore its files and registry.
  $reg = Join-Path $user 'PluginsInfo\v1\PS.json'
  $userReg = [IO.File]::ReadAllText($reg)
  Put $reg '{broken'
  try { Install-LifeBridge $src $machine $user; throw 'Expected invalid registry failure' }
  catch { Assert ($_.Exception.Message -ne 'Expected invalid registry failure') 'Corrupt registry accepted' }
  Assert (Test-Path (Join-Path $machine 'Plugins\External\com.orange.bridge_live\obsolete.js')) 'Rollback did not restore old files'
  $restored = Get-Content (Join-Path $machine 'PluginsInfo\v1\PS.json') -Raw | ConvertFrom-Json
  Assert (@($restored.plugins | Where-Object pluginId -eq 'com.orange.bridge')[0].versionString -eq '1.0.58') 'Rollback did not restore registry'
  Put $reg $userReg
  $result = Install-LifeBridge $src $machine $user
  Assert $result.ok 'Replacement failed'
  Assert ($result.removed -eq 4) 'Duplicate directories not removed'
  Assert (Test-Path (Join-Path $machine 'Plugins\External\com.orange.bridge_live\presets\new.tpl')) 'Nested file missing'
  Assert (-not (Test-Path (Join-Path $machine 'Plugins\External\com.orange.bridge_live\obsolete.js'))) 'Obsolete file remains'
  Assert (-not (Test-Path (Join-Path $user 'Plugins\External\com.orange.bridge_live'))) 'Duplicate stable directory remains'
  foreach ($base in @($machine, $user)) {
    Assert (Test-Path (Join-Path $base 'Plugins\External\unrelated\manifest.json')) 'Unrelated plugin deleted'
    $data = Get-Content (Join-Path $base 'PluginsInfo\v1\PS.json') -Raw | ConvertFrom-Json
    Assert ($data.custom -eq 'keep') 'Registry metadata lost'
    Assert (@($data.plugins | Where-Object pluginId -eq 'other.plugin').Count -eq 1) 'Other registration lost'
  }
  $data = Get-Content $reg -Raw | ConvertFrom-Json
  Assert (@($data.plugins | Where-Object pluginId -eq 'com.orange.bridge').Count -eq 0) 'Duplicate registration remains'
  $again = Install-LifeBridge $src $machine $user
  Assert $again.ok 'Repeated installation failed'
  Write-Output 'PASS: process guard, rollback, full replacement, duplicate cleanup, registry preservation, repeated installation.'
} finally {
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}

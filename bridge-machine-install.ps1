# orange bridge machine-level install (run by the elevated app installer)
# Copies ps-bridge to the stable UXP External folder and merges the PluginsInfo registry.
# Pure ASCII on purpose; all localized strings come from manifest.json (UTF8).
param([string]$Src)
$ErrorActionPreference = "Stop"
try {
  $mf = Get-Content -Raw -Encoding UTF8 (Join-Path $Src "manifest.json") | ConvertFrom-Json
  $extBase = "C:\Program Files\Common Files\Adobe\UXP\Plugins\External"
  $dst = Join-Path $extBase "com.orange.bridge_live"
  $regDir = "C:\Program Files\Common Files\Adobe\UXP\PluginsInfo\v1"
  $reg = Join-Path $regDir "PS.json"
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  Copy-Item -Path (Join-Path $Src "*") -Destination $dst -Recurse -Force
  New-Item -ItemType Directory -Force -Path $regDir | Out-Null
  $j = $null
  if (Test-Path $reg) { try { $j = Get-Content -Raw -Encoding UTF8 $reg | ConvertFrom-Json } catch {} }
  if (-not $j) { $j = [pscustomobject]@{ plugins = @() } }
  if (-not $j.plugins) { $j | Add-Member -Force -MemberType NoteProperty -Name plugins -Value @() }
  $entry = [pscustomobject]@{
    hostMinVersion = $mf.host.minVersion
    name = $mf.name
    path = "`$systemPlugins\External\com.orange.bridge_live"
    pluginId = "com.orange.bridge"
    status = "enabled"
    type = "uxp"
    versionString = $mf.version
  }
  $j.plugins = @($j.plugins | Where-Object { $_.pluginId -ne "com.orange.bridge" }) + $entry
  [IO.File]::WriteAllText($reg, ($j | ConvertTo-Json -Depth 6))
  Get-ChildItem $extBase -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "com.orange.bridge_*" -and $_.Name -ne "com.orange.bridge_live" } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  exit 0
} catch {
  exit 1
}

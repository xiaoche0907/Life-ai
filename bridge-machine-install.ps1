# Machine-level UXP install. The caller supplies its own UXP directory for legacy cleanup.
param([string]$Src, [string]$UserRoot = (Join-Path $env:APPDATA 'Adobe\UXP'))

function Install-LifeBridge($Source, $MachineRoot, $UserRoot) {
  $id = 'com.orange.bridge'
  $stable = $id + '_live'
  $mf = Get-Content -LiteralPath (Join-Path $Source 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($mf.id -ne $id) { throw 'Invalid bridge manifest' }
  foreach ($name in @('bridge.js', 'presets\marquee.tpl')) {
    if (!(Test-Path -LiteralPath (Join-Path $Source $name) -PathType Leaf)) { throw "Bridge source missing $name" }
  }
  if (Get-Process -Name Photoshop -ErrorAction SilentlyContinue) { throw 'PS_RUNNING' }

  $external = Join-Path $MachineRoot 'Plugins\External'
  $dest = Join-Path $external $stable
  $suffix = [guid]::NewGuid().ToString('N')
  $stage = Join-Path $external ('.life-bridge-stage-' + $suffix)
  $moved = @()
  $registries = @()
  $installed = $false
  try {
    foreach ($root in @($MachineRoot, $UserRoot) | Select-Object -Unique) {
      $reg = Join-Path $root 'PluginsInfo\v1\PS.json'
      $raw = if (Test-Path -LiteralPath $reg) { [IO.File]::ReadAllText($reg) } else { $null }
      if ($null -eq $raw -and $root -ne $MachineRoot) { continue }
      $data = if ($null -ne $raw) { ConvertFrom-Json -InputObject $raw } else { [pscustomobject]@{plugins = @()} }
      if ($null -eq $data -or $null -eq $data.PSObject.Properties['plugins']) { throw 'Invalid Photoshop plugin registry' }
      $data.plugins = @($data.plugins | Where-Object { $_ -and $_.pluginId -ne $id })
      if ($root -eq $MachineRoot) {
        $data.plugins += [pscustomobject]@{
          hostMinVersion = $mf.host.minVersion; name = $mf.name; path = ('$systemPlugins\External\' + $stable)
          pluginId = $id; status = 'enabled'; type = 'uxp'; versionString = $mf.version
        }
      }
      $registries += @{ path = $reg; raw = $raw; next = ($data | ConvertTo-Json -Depth 20); written = $false }
    }
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    Get-ChildItem -LiteralPath $Source -Force | Copy-Item -Destination $stage -Recurse -Force
    foreach ($file in Get-ChildItem -LiteralPath $Source -File -Recurse -Force) {
      $copy = Join-Path $stage $file.FullName.Substring($Source.TrimEnd('\', '/').Length + 1)
      if ((Get-FileHash -LiteralPath $copy).Hash -ne (Get-FileHash -LiteralPath $file.FullName).Hash) { throw "Bridge copy failed: $($file.Name)" }
    }
    if (Get-Process -Name Photoshop -ErrorAction SilentlyContinue) { throw 'PS_RUNNING' }
    foreach ($root in @($MachineRoot, $UserRoot) | Select-Object -Unique) {
      $base = Join-Path $root 'Plugins\External'
      if (!(Test-Path -LiteralPath $base)) { continue }
      foreach ($dir in Get-ChildItem -LiteralPath $base -Directory -Filter ($id + '_*')) {
        $backup = Join-Path $base ('.life-bridge-backup-' + $suffix + '-' + $dir.Name)
        Move-Item -LiteralPath $dir.FullName -Destination $backup
        $moved += @{ old = $dir.FullName; backup = $backup }
      }
    }
    Move-Item -LiteralPath $stage -Destination $dest
    $installed = $true
    foreach ($reg in $registries) {
      New-Item -ItemType Directory -Force -Path (Split-Path $reg.path) | Out-Null
      $reg.written = $true
      [IO.File]::WriteAllText($reg.path, $reg.next)
    }
  } catch {
    $failure = $_
    if ($installed) { Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction Continue }
    foreach ($dir in $moved) { Move-Item -LiteralPath $dir.backup -Destination $dir.old -ErrorAction Continue }
    foreach ($reg in $registries | Where-Object { $_.written }) {
      try {
        if ($null -eq $reg.raw) { Remove-Item -LiteralPath $reg.path -Force -ErrorAction SilentlyContinue }
        else { [IO.File]::WriteAllText($reg.path, $reg.raw) }
      } catch { Write-Warning $_.Exception.Message }
    }
    throw $failure
  } finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction Continue }
  }
  foreach ($dir in $moved) { Remove-Item -LiteralPath $dir.backup -Recurse -Force -ErrorAction Continue }
  @{ok = $true; removed = $moved.Count}
}

if ($MyInvocation.InvocationName -ne '.') {
  $ErrorActionPreference = 'Stop'
  try {
    $sourcePath = (Resolve-Path -LiteralPath $Src).Path
    Install-LifeBridge $sourcePath 'C:\Program Files\Common Files\Adobe\UXP' $UserRoot | Out-Null
    exit 0
  } catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    if ($_.Exception.Message -eq 'PS_RUNNING') { exit 2 }
    exit 1
  }
}

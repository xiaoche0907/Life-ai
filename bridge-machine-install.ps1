# Shared installer for interactive and automatic bridge updates.
param([string]$Src, [string]$UserData, [string]$ResultPath)
$ErrorActionPreference = 'Stop'

function Install-LifeBridge {
  param([string]$Source, [string]$MachineRoot, [string]$UserRoot)
  if (Get-Process -Name Photoshop -ErrorAction SilentlyContinue) {
    throw 'PS_RUNNING'
  }
  $id = 'com.orange.bridge'
  $stable = $id + '_live'
  $manifest = Get-Content -LiteralPath (Join-Path $Source 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($manifest.id -ne $id -or -not $manifest.version) { throw 'INVALID_MANIFEST' }
  $levels = @(
    @{ root = $MachineRoot; token = '$systemPlugins' },
    @{ root = $UserRoot; token = '$userPlugins' }
  )
  $stage = $null
  $moves = New-Object System.Collections.ArrayList
  $registries = New-Object System.Collections.ArrayList
  $published = $null
  $committed = $false
  try {
    # Stage a complete copy before changing any existing installation.
    foreach ($level in $levels) {
      $ext = Join-Path $level.root 'Plugins\External'
      $candidate = Join-Path $ext ('.life-bridge-stage-' + [guid]::NewGuid().ToString('N'))
      try {
        New-Item -ItemType Directory -Force -Path $candidate | Out-Null
        Get-ChildItem -LiteralPath $Source -Force | Copy-Item -Destination $candidate -Recurse -Force
        $stage = $candidate
        $target = $level
        break
      } catch {
        if (Test-Path -LiteralPath $candidate) { Remove-Item -LiteralPath $candidate -Recurse -Force }
      }
    }
    if (-not $stage) { throw 'NO_WRITABLE_INSTALL_LOCATION' }
    $removed = 0
    foreach ($level in $levels) {
      $reg = Join-Path $level.root 'PluginsInfo\v1\PS.json'
      $exists = Test-Path -LiteralPath $reg
      $bytes = $null
      $data = [pscustomobject]@{ plugins = @() }
      if ($exists) {
        $bytes = [IO.File]::ReadAllBytes($reg)
        # A corrupt registry must never be replaced with an empty one.
        $data = Get-Content -LiteralPath $reg -Raw -Encoding UTF8 | ConvertFrom-Json
        if (-not ($data.PSObject.Properties.Name -contains 'plugins')) { throw 'INVALID_PLUGIN_REGISTRY' }
      }
      $ours = @($data.plugins | Where-Object { $_.pluginId -eq $id })
      $ext = Join-Path $level.root 'Plugins\External'
      if (Test-Path -LiteralPath $ext) {
        foreach ($dir in Get-ChildItem -LiteralPath $ext -Directory -Force) {
          # Restrict removal to our stable/version directories or matching manifests.
          $owned = $dir.Name -eq $stable -or $dir.Name -match '^com\.orange\.bridge_\d+(\.\d+)*$'
          $mfPath = Join-Path $dir.FullName 'manifest.json'
          if ($dir.FullName -eq $stage) { continue }
          if ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            if ($owned) { throw 'BRIDGE_REPARSE_POINT' }
            continue
          }
          if (Test-Path -LiteralPath $mfPath) {
            try {
              $other = Get-Content -LiteralPath $mfPath -Raw -Encoding UTF8 | ConvertFrom-Json
              $owned = $other.id -eq $id
            } catch { if (-not $owned) { continue } }
          }
          if (-not $owned) { continue }
          $backup = Join-Path $ext ('.life-bridge-backup-' + [guid]::NewGuid().ToString('N'))
          Move-Item -LiteralPath $dir.FullName -Destination $backup
          [void]$moves.Add(@{ original = $dir.FullName; backup = $backup })
          $removed++
        }
      }
      if ($level -eq $target -or $ours.Count -gt 0) {
        [void]$registries.Add(@{ path = $reg; existed = $exists; bytes = $bytes })
        $data.plugins = @($data.plugins | Where-Object { $_.pluginId -ne $id })
        if ($level -eq $target) {
          $data.plugins += [pscustomobject]@{
            hostMinVersion = $manifest.host.minVersion
            name = $manifest.name
            path = $level.token + '\External\' + $stable
            pluginId = $id
            status = 'enabled'
            type = 'uxp'
            versionString = $manifest.version
          }
        }
        New-Item -ItemType Directory -Force -Path (Split-Path $reg) | Out-Null
        [IO.File]::WriteAllText($reg, ($data | ConvertTo-Json -Depth 30), (New-Object Text.UTF8Encoding($false)))
      }
    }
    # Check again after staging/cleanup in case PS was reopened during the update.
    if (Get-Process -Name Photoshop -ErrorAction SilentlyContinue) { throw 'PS_RUNNING' }
    $published = Join-Path (Join-Path $target.root 'Plugins\External') $stable
    Move-Item -LiteralPath $stage -Destination $published
    $stage = $null
    foreach ($file in Get-ChildItem -LiteralPath $Source -File -Recurse -Force) {
      $relative = $file.FullName.Substring($Source.TrimEnd('\').Length).TrimStart('\')
      $copy = Join-Path $published $relative
      if ((Get-FileHash -LiteralPath $file.FullName).Hash -ne (Get-FileHash -LiteralPath $copy).Hash) { throw 'VERIFY_FAILED' }
    }
    $committed = $true
    $warnings = @()
    foreach ($move in $moves) {
      try { Remove-Item -LiteralPath $move.backup -Recurse -Force }
      catch { $warnings += $_.Exception.Message }
    }
    return @{ ok = $true; updated = $true; version = $manifest.version; removed = $removed; warnings = $warnings }
  } catch {
    $failure = $_.Exception.Message
    $rollbackErrors = @()
    if (-not $committed) {
      if ($published -and (Test-Path -LiteralPath $published)) {
        try { Remove-Item -LiteralPath $published -Recurse -Force } catch { $rollbackErrors += $_.Exception.Message }
      }
      for ($i = $registries.Count - 1; $i -ge 0; $i--) {
        $item = $registries[$i]
        try {
          if ($item.existed) { [IO.File]::WriteAllBytes($item.path, $item.bytes) }
          elseif (Test-Path -LiteralPath $item.path) { Remove-Item -LiteralPath $item.path -Force }
        } catch { $rollbackErrors += $_.Exception.Message }
      }
      for ($i = $moves.Count - 1; $i -ge 0; $i--) {
        try { Move-Item -LiteralPath $moves[$i].backup -Destination $moves[$i].original }
        catch { $rollbackErrors += $_.Exception.Message }
      }
    }
    if ($rollbackErrors.Count) { throw ($failure + '; ROLLBACK_FAILED: ' + ($rollbackErrors -join '; ')) }
    throw $failure
  } finally {
    if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force }
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  try {
    if (-not $UserData) { $UserData = $env:APPDATA }
    $result = Install-LifeBridge -Source ([IO.Path]::GetFullPath($Src)) `
      -MachineRoot 'C:\Program Files\Common Files\Adobe\UXP' `
      -UserRoot (Join-Path $UserData 'Adobe\UXP')
  } catch {
    $permissionDenied = $_.CategoryInfo.Category -eq 'PermissionDenied' -or $_.Exception.Message -match '(?i)access.*denied|unauthorized|\u8bbf\u95ee.*\u62d2\u7edd|\u62d2\u7edd.*\u8bbf\u95ee|NO_WRITABLE_INSTALL_LOCATION'
    $result = @{ ok = $false; error = $_.Exception.Message; code = $(if ($permissionDenied) { 'PERMISSION_DENIED' } else { 'INSTALL_FAILED' }) }
  }
  $json = $result | ConvertTo-Json -Depth 6 -Compress
  if ($ResultPath) { [IO.File]::WriteAllText($ResultPath, $json, (New-Object Text.UTF8Encoding($false))) }
  else { Write-Output $json }
  if (-not $result.ok) { exit 1 }
}

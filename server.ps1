<#
  Сервер сайта «Претензионно-исковая работа».
  Работает на встроенном PowerShell Windows, без установки Node/Python.

  Запуск:  powershell -ExecutionPolicy Bypass -File server.ps1 [-Port 8080] [-Bind localhost]
  Остановка: Ctrl+C

  Хранилище:
    data\docs\<коллекция>\<id>.json  — записи (cases, notices, files, users)
    data\blobs\<id>.bin / <id>.type  — прикреплённые документы
#>
param(
  [int]$Port = 8080,
  [string]$Bind = "localhost"
)

$ErrorActionPreference = "Stop"
$Root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$Public = Join-Path $Root "public"
$Data   = Join-Path $Root "data"
$Docs   = Join-Path $Data "docs"
$Blobs  = Join-Path $Data "blobs"
$Seed   = Join-Path $Root "seed"

$Utf8 = New-Object System.Text.UTF8Encoding($false)
$IdRe = '^[A-Za-z0-9_-]{1,80}$'
$Collections = @("cases", "notices", "files", "users")
$MaxDocBytes = 1MB
$MaxBlobBytes = 20MB
$MaxRecords = 25000
$BlobTypes = @("application/pdf", "image/jpeg", "image/png")
$StaticTypes = @{
  ".html" = "text/html; charset=utf-8"; ".js" = "application/javascript; charset=utf-8";
  ".css" = "text/css; charset=utf-8"; ".json" = "application/json; charset=utf-8"; ".svg" = "image/svg+xml"; ".png" = "image/png"; ".ico" = "image/x-icon"
}

foreach ($d in @($Docs, $Blobs)) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null } }
foreach ($c in $Collections) { $p = Join-Path $Docs $c; if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p | Out-Null } }

# Демонстрационные дела — только при первом запуске
$SeedMark = Join-Path $Data ".seeded"
if (-not (Test-Path $SeedMark)) {
  $src = Join-Path $Seed "cases"
  if (Test-Path $src) { Copy-Item -Path (Join-Path $src "*.json") -Destination (Join-Path $Docs "cases") }
  Set-Content -Path $SeedMark -Value (Get-Date -Format o) -Encoding ASCII
}

$script:Rev = [DateTime]::UtcNow.Ticks
function Update-Rev { $script:Rev = [Math]::Max($script:Rev + 1, [DateTime]::UtcNow.Ticks) }

function New-Id([int]$n = 24) {
  $a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  $bytes = New-Object byte[] $n
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  -join ($bytes | ForEach-Object { $a[$_ % $a.Length] })
}

function Send-Text($ctx, [int]$code, [string]$text, [string]$type = "application/json; charset=utf-8") {
  $b = $Utf8.GetBytes($text)
  $r = $ctx.Response
  $r.StatusCode = $code
  $r.ContentType = $type
  $r.Headers["Cache-Control"] = "no-store"
  $r.Headers["X-Content-Type-Options"] = "nosniff"
  $r.ContentLength64 = $b.Length
  $r.OutputStream.Write($b, 0, $b.Length)
}
function Send-Error($ctx, [int]$code, [string]$errCode, [string]$msg) {
  $m = $msg -replace '\\', '\\' -replace '"', '\"'
  Send-Text $ctx $code ('{"code":"' + $errCode + '","message":"' + $m + '"}')
}
function Send-File($ctx, [string]$path, [string]$type, [string]$disposition) {
  $r = $ctx.Response
  $r.StatusCode = 200
  $r.ContentType = $type
  $r.Headers["X-Content-Type-Options"] = "nosniff"
  $r.Headers["Cache-Control"] = "no-cache"
  if ($disposition) { $r.Headers["Content-Disposition"] = $disposition }
  $fs = [System.IO.File]::OpenRead($path)
  try { $r.ContentLength64 = $fs.Length; $fs.CopyTo($r.OutputStream) } finally { $fs.Dispose() }
}
function Write-Atomic([string]$path, [string]$text) {
  $tmp = $path + ".tmp"
  [System.IO.File]::WriteAllText($tmp, $text, $Utf8)
  if (Test-Path $path) { [System.IO.File]::Replace($tmp, $path, [NullString]::Value) } else { [System.IO.File]::Move($tmp, $path) }
}
function Read-Body($ctx) {
  $sr = New-Object System.IO.StreamReader($ctx.Request.InputStream, $Utf8)
  try { $sr.ReadToEnd() } finally { $sr.Dispose() }
}
function Get-RecordCount {
  $n = 0
  foreach ($c in $Collections) { $n += @(Get-ChildItem -Path (Join-Path $Docs $c) -Filter *.json -File).Count }
  $n
}

function Get-State {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('{"rev":"' + $script:Rev + '","cols":{')
  $firstCol = $true
  foreach ($c in $Collections) {
    if (-not $firstCol) { [void]$sb.Append(',') }; $firstCol = $false
    [void]$sb.Append('"' + $c + '":{')
    $first = $true
    foreach ($f in Get-ChildItem -Path (Join-Path $Docs $c) -Filter *.json -File) {
      $id = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)
      if ($id -notmatch $IdRe) { continue }
      $txt = [System.IO.File]::ReadAllText($f.FullName, $Utf8).Trim()
      if (-not $txt.StartsWith("{")) { continue }
      if (-not $first) { [void]$sb.Append(',') }; $first = $false
      [void]$sb.Append('"' + $id + '":' + $txt)
    }
    [void]$sb.Append('}')
  }
  [void]$sb.Append('}}')
  $sb.ToString()
}

function Invoke-Api($ctx) {
  $req = $ctx.Request
  $path = $req.Url.AbsolutePath
  $method = $req.HttpMethod

  # --- общее состояние (опрос клиентами) ---
  if ($path -eq "/api/state" -and $method -eq "GET") {
    if ($req.QueryString["rev"] -eq [string]$script:Rev) { Send-Text $ctx 200 ('{"rev":"' + $script:Rev + '","same":true}'); return }
    Send-Text $ctx 200 (Get-State); return
  }

  # --- записи ---
  if ($path -match '^/api/doc/([A-Za-z0-9_-]+)/([A-Za-z0-9_-]+)$') {
    $col = $Matches[1]; $id = $Matches[2]
    if ($Collections -notcontains $col -or $id -notmatch $IdRe) { Send-Error $ctx 400 "invalid_argument" "Некорректный путь"; return }
    $file = Join-Path (Join-Path $Docs $col) ($id + ".json")
    switch ($method) {
      "GET" {
        if (Test-Path $file) { Send-Text $ctx 200 ('{"exists":true,"data":' + [System.IO.File]::ReadAllText($file, $Utf8).Trim() + '}') }
        else { Send-Text $ctx 200 '{"exists":false,"data":null}' }
        return
      }
      "PUT" {
        if ($req.ContentLength64 -gt $MaxDocBytes) { Send-Error $ctx 413 "too_large" "Запись слишком большая"; return }
        $body = (Read-Body $ctx).Trim()
        if (-not $body.StartsWith("{")) { Send-Error $ctx 400 "invalid_argument" "Ожидается JSON-объект"; return }
        try { [void](ConvertFrom-Json -InputObject $body) } catch { Send-Error $ctx 400 "invalid_argument" "Некорректный JSON"; return }
        if (-not (Test-Path $file) -and (Get-RecordCount) -ge $MaxRecords) { Send-Error $ctx 507 "quota_exceeded" "Хранилище заполнено"; return }
        Write-Atomic $file $body
        Update-Rev
        Send-Text $ctx 200 ('{"ok":true,"id":"' + $id + '"}'); return
      }
      "DELETE" {
        if (Test-Path $file) { Remove-Item -LiteralPath $file -Force; Update-Rev }
        Send-Text $ctx 200 '{"ok":true}'; return
      }
    }
    Send-Error $ctx 405 "method_not_allowed" "Метод не поддерживается"; return
  }

  # --- загрузка документа ---
  if ($path -eq "/api/blob" -and $method -eq "POST") {
    $type = [string]$req.Headers["X-Content-Type"]
    if ($BlobTypes -notcontains $type) { Send-Error $ctx 415 "unsupported_type" "Нужен PDF, JPG или PNG"; return }
    if ($req.ContentLength64 -gt $MaxBlobBytes) { Send-Error $ctx 413 "too_large" "Файл больше 20 МБ"; return }
    $id = New-Id 24
    $bin = Join-Path $Blobs ($id + ".bin")
    $fs = [System.IO.File]::Create($bin)
    try {
      $buf = New-Object byte[] 65536; $total = 0
      while (($n = $req.InputStream.Read($buf, 0, $buf.Length)) -gt 0) {
        $total += $n
        if ($total -gt $MaxBlobBytes) { break }
        $fs.Write($buf, 0, $n)
      }
    } finally { $fs.Dispose() }
    if ($total -gt $MaxBlobBytes) { Remove-Item -LiteralPath $bin -Force; Send-Error $ctx 413 "too_large" "Файл больше 20 МБ"; return }
    # проверка сигнатуры файла
    $head = New-Object byte[] 4
    $rs = [System.IO.File]::OpenRead($bin); try { [void]$rs.Read($head, 0, 4) } finally { $rs.Dispose() }
    $ok = switch ($type) {
      "application/pdf" { $head[0] -eq 0x25 -and $head[1] -eq 0x50 -and $head[2] -eq 0x44 -and $head[3] -eq 0x46 }
      "image/png"       { $head[0] -eq 0x89 -and $head[1] -eq 0x50 -and $head[2] -eq 0x4E -and $head[3] -eq 0x47 }
      "image/jpeg"      { $head[0] -eq 0xFF -and $head[1] -eq 0xD8 }
    }
    if (-not $ok) { Remove-Item -LiteralPath $bin -Force; Send-Error $ctx 415 "unsupported_type" "Содержимое файла не соответствует формату"; return }
    [System.IO.File]::WriteAllText((Join-Path $Blobs ($id + ".type")), $type, $Utf8)
    Send-Text $ctx 200 ('{"id":"' + $id + '","contentType":"' + $type + '","sizeBytes":' + $total + '}'); return
  }
  if ($path -match '^/api/blob/([A-Za-z0-9_-]+)$' -and $method -eq "DELETE") {
    $id = $Matches[1]
    foreach ($ext in @(".bin", ".type")) { $p = Join-Path $Blobs ($id + $ext); if (Test-Path $p) { Remove-Item -LiteralPath $p -Force } }
    Send-Text $ctx 200 '{"ok":true}'; return
  }

  Send-Error $ctx 404 "not_found" "Не найдено"
}

function Invoke-Request($ctx) {
  $path = $ctx.Request.Url.AbsolutePath
  if ($path.StartsWith("/api/")) { Invoke-Api $ctx; return }

  if ($path -match '^/_blob/([A-Za-z0-9_-]{8,64})$') {
    $id = $Matches[1]
    $bin = Join-Path $Blobs ($id + ".bin"); $tf = Join-Path $Blobs ($id + ".type")
    if (-not (Test-Path $bin)) { Send-Text $ctx 404 "Файл не найден" "text/plain; charset=utf-8"; return }
    $type = if (Test-Path $tf) { [System.IO.File]::ReadAllText($tf, $Utf8).Trim() } else { "application/octet-stream" }
    if ($BlobTypes -notcontains $type) { $type = "application/octet-stream" }
    Send-File $ctx $bin $type "inline"; return
  }

  if ($path -eq "/") { $path = "/index.html" }
  if ($path -match '^/[A-Za-z0-9_.-]+$' -and $path -notmatch '\.\.') {
    $file = Join-Path $Public $path.TrimStart("/")
    $ext = [System.IO.Path]::GetExtension($file).ToLower()
    if ((Test-Path $file -PathType Leaf) -and $StaticTypes.ContainsKey($ext)) { Send-File $ctx $file $StaticTypes[$ext] $null; return }
  }
  Send-Text $ctx 404 "Не найдено" "text/plain; charset=utf-8"
}

$listener = New-Object System.Net.HttpListener
$prefix = "http://${Bind}:$Port/"
$listener.Prefixes.Add($prefix)
try { $listener.Start() }
catch {
  Write-Host "Не удалось запустить сервер на $prefix" -ForegroundColor Red
  Write-Host $_.Exception.Message
  if ($Bind -ne "localhost") { Write-Host "Для доступа из сети запустите один раз от администратора:  netsh http add urlacl url=$prefix user=$env:USERNAME" }
  exit 1
}
$shown = if ($Bind -eq "localhost") { "http://localhost:$Port/" } else { "http://$($env:COMPUTERNAME):$Port/" }
Write-Host "Претензионно-исковая работа: сервер запущен — $shown" -ForegroundColor Green
Write-Host "Данные: $Data"
Write-Host "Остановить: Ctrl+C"

try {
  while ($listener.IsListening) {
    $task = $listener.GetContextAsync()
    while (-not $task.Wait(500)) { }   # короткое ожидание, чтобы работал Ctrl+C
    $ctx = $task.Result
    try { Invoke-Request $ctx }
    catch {
      Write-Host ("Ошибка: " + $_.Exception.Message) -ForegroundColor Yellow
      try { Send-Error $ctx 500 "internal" "Внутренняя ошибка сервера" } catch { }
    }
    finally { try { $ctx.Response.Close() } catch { } }
  }
}
finally { $listener.Stop(); $listener.Close() }

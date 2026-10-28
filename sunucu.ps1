# Soru Ekleme - Yerel Guvenli Sunucu (PowerShell)
$ports = 5500, 5501, 5502, 5503, 8080
$listener = $null
$selectedPort = 5500

foreach ($port in $ports) {
    try {
        $l = New-Object System.Net.HttpListener
        $l.Prefixes.Add("http://127.0.0.1:$port/")
        $l.Start()
        $listener = $l
        $selectedPort = $port
        break
    } catch {
        if ($l) { $l.Close() }
    }
}

if (-not $listener) {
    Write-Host "[HATA] Yerel sunucu baslatilamadi!" -ForegroundColor Red
    pause
    exit
}

$url = "http://127.0.0.1:$selectedPort/"
Write-Host "================================================================" -ForegroundColor Green
Write-Host ">>> Soru Ekleme Basariyla Calisiyor!" -ForegroundColor Green
Write-Host ">>> Adres: $url" -ForegroundColor Cyan
Write-Host ">>> Tarayiciniz simdi otomatik aciliyor..." -ForegroundColor Yellow
Write-Host "================================================================" -ForegroundColor Green
Write-Host "NOT: Uygulamayi kullanirken bu pencereyi kapatmayiniz."
Write-Host "(Gorev cubuguna simge durumuna kucultebilirsiniz)."
Write-Host "Kapatmak istediginizde pencereyi carpidan kapatabilirsiniz."

if (-not $env:SORU_NO_BROWSER) {
    try {
        Start-Process $url
    } catch {}
}

$baseDir = $PSScriptRoot
if (-not $baseDir) { $baseDir = (Get-Location).Path }

$mimeMap = @{
    ".html" = "text/html; charset=utf-8"
    ".htm"  = "text/html; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".mjs"  = "application/javascript; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".png"  = "image/png"
    ".jpg"  = "image/jpeg"
    ".jpeg" = "image/jpeg"
    ".gif"  = "image/gif"
    ".svg"  = "image/svg+xml"
    ".ico"  = "image/x-icon"
    ".webp" = "image/webp"
    ".woff" = "font/woff"
    ".woff2"= "font/woff2"
    ".ttf"  = "font/ttf"
}

while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        $rawPath = $request.Url.LocalPath.TrimStart('/')
        if ([string]::IsNullOrEmpty($rawPath) -or $rawPath -eq "/") {
            $rawPath = "index.html"
        }

        $decodedPath = [System.Uri]::UnescapeDataString($rawPath)
        $localPath = Join-Path $baseDir $decodedPath

        if (Test-Path -Path $localPath -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($localPath).ToLower()
            $ct = $mimeMap[$ext]
            if (-not $ct) { $ct = "application/octet-stream" }
            $response.ContentType = $ct
            $bytes = [System.IO.File]::ReadAllBytes($localPath)
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $indexPath = Join-Path $baseDir "index.html"
            if (Test-Path -Path $indexPath -PathType Leaf) {
                $response.ContentType = "text/html; charset=utf-8"
                $bytes = [System.IO.File]::ReadAllBytes($indexPath)
                $response.ContentLength64 = $bytes.Length
                $response.OutputStream.Write($bytes, 0, $bytes.Length)
            } else {
                $response.StatusCode = 404
            }
        }
        $response.OutputStream.Close()
    } catch {}
}

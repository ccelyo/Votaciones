# Campaña k6 del Prototipo 3 (frente de Andrés).
# Mide GET /api/elections/open a través del WAF en HTTPS, con el límite de tasa
# del Gateway desactivado, y guarda latencia, throughput, errores y docker stats.
#
#   powershell -File docs/p3-performance/run-campaign.ps1
#   powershell -File docs/p3-performance/run-campaign.ps1 -SkipUp

param(
    [switch]$SkipUp,
    [int[]]$Levels = @(1, 25, 50, 75, 100, 125, 150, 200),
    [int]$Reps = 2,
    [string]$Duration = "30s",
    [string]$Tag = ""
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $Root

$Compose = @(
    "compose",
    "-f", "docker-compose.yml",
    "-f", "docs/lab6-performance/docker-compose.perf.yml"
)

function Wait-Docker {
    $deadline = (Get-Date).AddMinutes(3)
    while ((Get-Date) -lt $deadline) {
        docker info *> $null
        if ($LASTEXITCODE -eq 0) { return }
        Start-Sleep -Seconds 3
    }
    throw "Docker no respondió a tiempo."
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker no está instalado."
}
docker info *> $null
if ($LASTEXITCODE -ne 0) {
    $desktop = @(
        "$Env:ProgramFiles\Docker\Docker\Docker Desktop.exe",
        "${Env:ProgramFiles(x86)}\Docker\Docker\Docker Desktop.exe",
        "$Env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $desktop) { throw "Docker Desktop no está en ejecución y no se encontró el ejecutable." }
    Start-Process $desktop
    Wait-Docker
}

$results = Join-Path $PSScriptRoot "results"
New-Item -ItemType Directory -Force -Path $results | Out-Null

$conditions = [ordered]@{
    started_at = (Get-Date).ToString("o")
    hostname = $env:COMPUTERNAME
    cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name
    logical_processors = [Environment]::ProcessorCount
    ram_gb = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
    git = (git rev-parse --short HEAD)
    path = "k6 -> HTTPS :8088 WAF (TLS + ModSecurity CRS) -> Gateway TLS -> Identity -> PostgreSQL"
    endpoint = "GET /api/elections/open"
    rate_limit = "GATEWAY_RATE_LIMIT_DEFAULT=0 (docs/lab6-performance/docker-compose.perf.yml)"
    think_time_s = 1
    duration = $Duration
    levels = $Levels
    reps = $Reps
    generator = "grafana/k6:0.54.0 en Docker, misma máquina que el sistema"
    tls = "certificado de desarrollo; k6 con insecureSkipTLSVerify"
}
$conditions | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $results "conditions.json")

if (-not $SkipUp) {
    Write-Host "Levantando el stack (límite de tasa desactivado)..."
    & docker @Compose up -d --build waf
    if ($LASTEXITCODE -ne 0) { throw "docker compose up falló" }
}

Write-Host "Esperando https://localhost:8088/api/elections/open ..."
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    try {
        $resp = curl.exe -sk -o NUL -w "%{http_code}" https://localhost:8088/api/elections/open
        if ($resp -eq "200") { $ready = $true; break }
        Write-Host "  intento $($i + 1): HTTP $resp"
    } catch {
        Write-Host "  intento $($i + 1): $($_.Exception.Message)"
    }
    Start-Sleep -Seconds 5
}
if (-not $ready) { throw "El endpoint no respondió 200." }

function Start-Stats([string]$OutFile) {
    return Start-Process -FilePath "powershell.exe" -ArgumentList @(
        "-NoProfile", "-File", (Join-Path $PSScriptRoot "monitor.ps1"), "-OutFile", $OutFile
    ) -WindowStyle Hidden -PassThru
}

Write-Host "Calentamiento (5 VUs, 10 s, se descarta)..."
docker run --rm --add-host=host.docker.internal:host-gateway `
    -v "${PSScriptRoot}:/scripts" `
    -e BASE_URL=https://host.docker.internal:8088 `
    -e VUS=5 -e DURATION=10s `
    grafana/k6:0.54.0 run /scripts/open_elections.js
if ($LASTEXITCODE -ne 0) { throw "El calentamiento de k6 falló." }

foreach ($rep in 1..$Reps) {
    $dir = Join-Path $results "${Tag}rep$rep"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    foreach ($vus in $Levels) {
        $base = Join-Path $dir "vus_$vus"
        $stats = "$base.stats.tsv"
        if (Test-Path $stats) { Remove-Item $stats }
        Write-Host "rep $rep / VUs $vus"
        $monitor = Start-Stats $stats
        docker run --rm --add-host=host.docker.internal:host-gateway `
            -v "${PSScriptRoot}:/scripts" `
            -e BASE_URL=https://host.docker.internal:8088 `
            -e VUS=$vus -e DURATION=$Duration `
            -e SUMMARY_FILE=/scripts/results/${Tag}rep$rep/vus_$vus.json `
            grafana/k6:0.54.0 run /scripts/open_elections.js
        $code = $LASTEXITCODE
        Stop-Process -Id $monitor.Id -Force -ErrorAction SilentlyContinue
        if ($code -ne 0) { throw "k6 falló en rep $rep VUs $vus (exit $code)" }
        Start-Sleep -Seconds 8
    }
}

Write-Host "Listo. Resultados en docs/p3-performance/results"
python (Join-Path $PSScriptRoot "analyze.py")

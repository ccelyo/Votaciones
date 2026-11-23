# Nodo A (Windows): levanta el SUT (frontend + gateway + identity + BD y dependencias).
# Desde la raíz del repo:  .\performance-tests\deploy\nodeA-up.ps1
# Con -Down baja el despliegue; con -Down -Reset borra además sus volúmenes (solo votaciones-perf).
param([switch]$Down, [switch]$Reset)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')
$p = if ($env:P) { $env:P } else { 'votaciones-perf' }
$gwPort = if ($env:GATEWAY_PORT) { $env:GATEWAY_PORT } else { '8088' }
$webPort = if ($env:WEB_PORT) { $env:WEB_PORT } else { '3000' }
$compose = @('compose', '-f', 'docker-compose.yml', '-f', 'performance-tests/deploy/docker-compose.perf.yml', '-p', $p)

if ($Down) {
  if ($Reset) { docker @compose down -v } else { docker @compose down }
  return
}

$env:COMPOSE_PARALLEL_LIMIT = '1'
docker @compose config --quiet
if ($LASTEXITCODE -ne 0) { throw 'docker compose config falló' }
# `platform` arrastra al gateway y a todo lo que necesita (depends_on). No se levantan mobile ni election.
docker @compose up -d --build platform
if ($LASTEXITCODE -ne 0) { throw 'docker compose up falló' }

Write-Host 'Esperando /readyz del Gateway (hasta 5 min)...'
foreach ($i in 1..60) {
  try {
    $r = Invoke-WebRequest "http://127.0.0.1:$gwPort/readyz" -UseBasicParsing -TimeoutSec 5
    Write-Host "Gateway listo: $($r.Content)"
    $web = Invoke-WebRequest "http://127.0.0.1:$webPort" -UseBasicParsing -TimeoutSec 10
    Write-Host "Frontend: HTTP $($web.StatusCode)"
    return
  } catch { Start-Sleep 5 }
}
throw "El Gateway no quedó listo. Revisa: docker $($compose -join ' ') ps / logs"

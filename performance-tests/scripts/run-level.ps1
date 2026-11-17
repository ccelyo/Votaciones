# Nodo B (Windows): ejecuta UN nivel de carga (un proceso k6) y guarda su resumen.
# Desde la raíz del repo:
#   .\performance-tests\scripts\run-level.ps1 -Vus 200 [-Rep 1] [-Campaign ID]
#   .\performance-tests\scripts\run-level.ps1 -Warmup
# Variables de entorno obligatorias: BASE_URL, LAB_PASSWORD, LAB_MFA_CODE.
# Opcionales: RAMP_S, HOLD_S, TOKENS_PER_USER, TIMEOUT.
param(
  [int]$Vus = 0,
  [int]$Rep = 1,
  [string]$Campaign = $(if ($env:CAMPAIGN) { $env:CAMPAIGN } else { Get-Date -Format 'yyyyMMddTHHmmss' }),
  [switch]$Warmup
)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')

foreach ($name in 'BASE_URL', 'LAB_PASSWORD', 'LAB_MFA_CODE') {
  if (-not (Get-Item "Env:$name" -ErrorAction SilentlyContinue)) { throw "Define `$env:$name (ver README)" }
}
if (-not (Get-Command k6 -ErrorAction SilentlyContinue)) { throw 'k6 no está instalado (winget install k6 --source winget)' }
if ($env:BASE_URL -match 'localhost|127\.0\.0\.1|\[::1\]') {
  throw 'BASE_URL apunta a este mismo equipo: el lab exige un nodo independiente.'
}

if ($Warmup) {
  $name = 'warmup'
  $summary = "performance-tests/results/raw/$Campaign-warmup.json"   # se descarta
  $env:MODE = 'warmup'
  Remove-Item Env:VUS -ErrorAction SilentlyContinue
} else {
  if ($Vus -lt 1) { throw 'Indica -Vus <n> o -Warmup' }
  $name = 'vus{0:D4}-rep{1}' -f $Vus, $Rep
  $summary = "performance-tests/results/summary/runs/$Campaign-$name.json"
  $env:MODE = 'level'
  $env:VUS = "$Vus"
}
New-Item -ItemType Directory -Force (Split-Path $summary), 'performance-tests/results/raw' | Out-Null
$env:SUMMARY_FILE = $summary

# CPU del propio generador cada 5 s, para comprobar que no se saturó.
$hostLog = (Resolve-Path 'performance-tests/results/raw').Path + "\$Campaign-$name-hostB.csv"
$sampler = Start-Job -ArgumentList $hostLog -ScriptBlock {
  param($log)
  'ts,cpu_pct' | Out-File $log -Encoding ascii
  Get-Counter '\Processor(_Total)\% Processor Time' -SampleInterval 5 -Continuous | ForEach-Object {
    '{0},{1:N1}' -f [DateTimeOffset]::UtcNow.ToUnixTimeSeconds(), $_.CounterSamples[0].CookedValue |
      Out-File $log -Append -Encoding ascii
  }
}

try {
  Write-Host ">>> $name (modo $($env:MODE)) -> $summary"
  & k6 run --quiet performance-tests/k6/auth_me.js
  if ($LASTEXITCODE -ne 0) { throw "k6 terminó con código $LASTEXITCODE" }
} finally {
  Stop-Job $sampler -ErrorAction SilentlyContinue
  Remove-Job $sampler -Force -ErrorAction SilentlyContinue
}

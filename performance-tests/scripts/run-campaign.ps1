# Nodo B (Windows): campaña de niveles, cada uno en un proceso k6 independiente.
#   .\performance-tests\scripts\run-campaign.ps1                          # 1,50,200,500,2000
#   .\performance-tests\scripts\run-campaign.ps1 -Levels 200 -Reps 3 -NoWarmup
param(
  [int[]]$Levels = @(1, 50, 200, 500, 2000),
  [int]$Reps = 1,
  [int]$Cooldown = 60,
  [string]$Campaign = (Get-Date -Format 'yyyyMMddTHHmmss'),
  [switch]$NoWarmup
)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')
$run = Join-Path $PSScriptRoot 'run-level.ps1'

if (-not $NoWarmup) {
  & $run -Warmup -Campaign $Campaign
  Write-Host "Calentamiento listo; pausa de ${Cooldown}s."
  Start-Sleep $Cooldown
}

$total = $Levels.Count * $Reps
$n = 0
foreach ($rep in 1..$Reps) {
  foreach ($level in $Levels) {
    $n++
    & $run -Vus $level -Rep $rep -Campaign $Campaign
    if ($n -lt $total) { Write-Host "Enfriamiento ${Cooldown}s..."; Start-Sleep $Cooldown }
  }
}
Write-Host "Campaña $Campaign terminada. Siguiente: python performance-tests\analysis\analyze.py"

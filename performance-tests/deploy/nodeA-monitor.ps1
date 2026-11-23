# Nodo A (Windows): muestrea CPU/memoria de los contenedores y conexiones a Postgres.
# Detener con Ctrl+C.  Uso: .\performance-tests\deploy\nodeA-monitor.ps1 [-Interval 2]
param([int]$Interval = 2)
Set-Location (Join-Path $PSScriptRoot '..\..')
$p = if ($env:P) { $env:P } else { 'votaciones-perf' }
$stamp = Get-Date -Format 'yyyyMMddTHHmmss'
$dir = (Resolve-Path 'performance-tests/results/raw').Path
$out = "$dir\sut-$stamp.csv"
$pg = "$dir\sut-pg-$stamp.csv"
'ts,container,cpu_pct,mem_usage,mem_pct' | Out-File $out -Encoding ascii
'ts,connections,active' | Out-File $pg -Encoding ascii
Write-Host "Monitoreando cada ${Interval}s -> $out y $pg"

while ($true) {
  $ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.MemPerc}}' |
    Where-Object { $_ -like "$p-*" } | ForEach-Object { "$ts,$_" } | Out-File $out -Append -Encoding ascii
  $row = docker exec "$p-postgres-1" psql -U votaciones -d votaciones '-tAF,' -c "select count(*), count(*) filter (where state='active') from pg_stat_activity where datname='votaciones'" 2>$null
  if ($row) { "$ts,$row" | Out-File $pg -Append -Encoding ascii }
  Start-Sleep $Interval
}

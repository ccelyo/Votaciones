# Registra las características del equipo (Windows). No vuelca variables de entorno.
#   Nodo A: .\performance-tests\scripts\collect-env.ps1 -Role A
#   Nodo B: .\performance-tests\scripts\collect-env.ps1 -Role B -AIp <IP Tailscale del Nodo A>
param(
  [Parameter(Mandatory)][ValidateSet('A', 'B')][string]$Role,
  [string]$AIp
)
$ErrorActionPreference = 'Continue'
Set-Location (Join-Path $PSScriptRoot '..\..')
New-Item -ItemType Directory -Force 'performance-tests/results/env' | Out-Null
$out = "performance-tests/results/env/node$Role-$env:COMPUTERNAME-$(Get-Date -Format 'yyyyMMddTHHmmss').txt"

$lines = & {
  "Rol: Nodo $Role ($(if ($Role -eq 'A') { 'SUT: despliegue de Votaciones' } else { 'generador de carga k6' }))"
  "Fecha (UTC): $((Get-Date).ToUniversalTime().ToString('s'))Z"
  "Hostname: $env:COMPUTERNAME"

  "`n== Sistema operativo =="
  $os = Get-CimInstance Win32_OperatingSystem
  "$($os.Caption) $($os.Version) build $($os.BuildNumber)"

  "`n== CPU =="
  Get-CimInstance Win32_Processor | ForEach-Object {
    "$($_.Name) | núcleos $($_.NumberOfCores) | hilos $($_.NumberOfLogicalProcessors) | $($_.MaxClockSpeed) MHz"
  }

  "`n== Memoria =="
  '{0:N1} GB totales, {1:N1} GB libres' -f ($os.TotalVisibleMemorySize / 1MB), ($os.FreePhysicalMemory / 1MB)

  "`n== Disco =="
  Get-PhysicalDisk | ForEach-Object { "$($_.FriendlyName) | $($_.MediaType) | $([math]::Round($_.Size / 1GB)) GB" }

  "`n== Energía =="
  (powercfg /getactivescheme) -join ' '
  $battery = Get-CimInstance Win32_Battery
  if ($battery) { "Batería presente (estado $($battery.BatteryStatus); 2 = conectado a corriente)" } else { 'Sin batería (sobremesa)' }

  "`n== Red =="
  Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '169.254*' } |
    ForEach-Object { "$($_.InterfaceAlias): $($_.IPAddress)" }
  if (Get-Command tailscale -ErrorAction SilentlyContinue) { "Tailscale: $(tailscale ip -4)" }

  "`n== Repositorio =="
  "rama: $(git rev-parse --abbrev-ref HEAD)"
  "commit: $(git rev-parse HEAD)"
  "cambios sin commitear: $((git status --porcelain | Measure-Object).Count)"

  if ($Role -eq 'A') {
    "`n== Docker (SUT) =="
    docker version --format 'cliente {{.Client.Version}} / servidor {{.Server.Version}}'
    docker info --format 'CPUs asignadas a Docker: {{.NCPU}}  Memoria total (bytes): {{.MemTotal}}  SO del daemon: {{.OperatingSystem}}'
    if (Test-Path "$env:USERPROFILE\.wslconfig") { "`n.wslconfig:"; Get-Content "$env:USERPROFILE\.wslconfig" }
    "`nContenedores:"
    docker ps --filter 'name=votaciones-perf-' --format '{{.Names}}  {{.Image}}  {{.Status}}'
  } else {
    "`n== k6 =="
    k6 version
    if ($AIp) {
      "`n== Red hacia el Nodo A ($AIp) =="
      ping -n 50 $AIp | Select-Object -Last 6
      if (Get-Command tailscale -ErrorAction SilentlyContinue) { tailscale ping -c 5 $AIp }
    } else { '(pasa -AIp para medir RTT y pérdida)' }
  }

  "`n== Notas manuales (completar a mano) =="
  '- Tipo de equipo / conexión (cable, Wi-Fi) / otras cargas durante la prueba:'
}
$lines | Tee-Object -FilePath $out
Write-Host "`nGuardado en $out"

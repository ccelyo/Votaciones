param([Parameter(Mandatory = $true)][string]$OutFile)
$ErrorActionPreference = "Continue"
while ($true) {
    docker stats --no-stream --format "{{.Name}}`t{{.CPUPerc}}`t{{.MemUsage}}" |
        Add-Content -Path $OutFile -Encoding utf8
    Start-Sleep -Seconds 3
}

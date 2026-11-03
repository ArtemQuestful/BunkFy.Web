[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) {
    throw 'This verification wrapper requires Windows.'
}

$diagnosticsRoot = if ($env:RUNNER_TEMP) {
    $env:RUNNER_TEMP
} else {
    [System.IO.Path]::GetTempPath()
}
$diagnosticsPath = Join-Path $diagnosticsRoot (
    'bunkfy-web-sockets-' + [guid]::NewGuid().ToString('N') + '.jsonl')
$watcher = Start-Job -ArgumentList $diagnosticsPath -ScriptBlock {
    param([string] $OutputPath)
    while ($true) {
        try {
            $connections = @(Get-NetTCPConnection -ErrorAction Stop)
            $memory = Get-CimInstance Win32_OperatingSystem
            $sample = [ordered]@{
                utc = [DateTimeOffset]::UtcNow.ToString('O')
                freePhysicalMemoryKiB = $memory.FreePhysicalMemory
                states = @($connections | Group-Object State |
                    Select-Object Name, Count)
                dynamicLocalPorts = @($connections |
                    Where-Object LocalPort -GE 10000 |
                    Select-Object -ExpandProperty LocalPort -Unique).Count
                busiest = @($connections |
                    Group-Object State, OwningProcess |
                    Sort-Object Count -Descending |
                    Select-Object -First 8 Name, Count)
                processes = @(Get-Process -Name 'chrome*', 'node*' -ErrorAction SilentlyContinue |
                    Select-Object Id, ProcessName, Handles, WorkingSet64)
            }
            $sample | ConvertTo-Json -Depth 5 -Compress |
                Add-Content -LiteralPath $OutputPath -Encoding utf8
        } catch {
            [ordered]@{
                utc = [DateTimeOffset]::UtcNow.ToString('O')
                diagnosticError = $_.Exception.GetType().FullName
            } | ConvertTo-Json -Compress |
                Add-Content -LiteralPath $OutputPath -Encoding utf8
        }
        Start-Sleep -Seconds 20
    }
}

$verificationExitCode = 1
try {
    & pnpm verify
    $verificationExitCode = $LASTEXITCODE
} finally {
    Stop-Job -Job $watcher
    Receive-Job -Job $watcher -ErrorAction Continue
    Remove-Job -Job $watcher
    if (Test-Path -LiteralPath $diagnosticsPath) {
        Write-Host 'Windows verification resource samples:'
        Get-Content -LiteralPath $diagnosticsPath
    }
}
exit $verificationExitCode

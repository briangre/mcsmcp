[CmdletBinding()]
param(
    [string]$OutputDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent) "artifacts"),
    [string]$WinSwVersion = "2.12.0",
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$repositoryRoot = Split-Path $PSScriptRoot -Parent
$packageJson = Get-Content (Join-Path $repositoryRoot "package.json") -Raw | ConvertFrom-Json
$stageRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("banking-mcp-" + [guid]::NewGuid())

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "'$FilePath $($Arguments -join ' ')' failed with exit code $LASTEXITCODE."
    }
}

try {
    $nodeCommand = Get-Command node -ErrorAction Stop
    $nodeMajorVersion = [int]((& $nodeCommand.Source --version).TrimStart("v").Split(".")[0])
    if ($nodeMajorVersion -lt 22) {
        throw "Node.js 22 or later is required to build the deployment package."
    }

    Push-Location $repositoryRoot
    try {
        Invoke-NativeCommand npm.cmd ci --no-audit --no-fund
        if ($SkipTests) {
            Invoke-NativeCommand npm.cmd run build
        }
        else {
            Invoke-NativeCommand npm.cmd test
        }
    }
    finally {
        Pop-Location
    }

    $appDirectory = Join-Path $stageRoot "app"
    $runtimeDirectory = Join-Path $stageRoot "runtime"
    $toolsDirectory = Join-Path $stageRoot "tools"
    $templatesDirectory = Join-Path $stageRoot "templates"
    $seedDataDirectory = Join-Path $stageRoot "seed-data"
    New-Item $appDirectory, $runtimeDirectory, $toolsDirectory, $templatesDirectory, $seedDataDirectory -ItemType Directory -Force | Out-Null

    Copy-Item (Join-Path $repositoryRoot "dist") $appDirectory -Recurse
    Get-ChildItem (Join-Path $appDirectory "dist") -Filter "*.test.js" | Remove-Item -Force
    Copy-Item (Join-Path $repositoryRoot "package.json") $appDirectory
    Copy-Item (Join-Path $repositoryRoot "package-lock.json") $appDirectory
    Copy-Item (Join-Path $repositoryRoot "data\*.json") $seedDataDirectory
    Copy-Item (Join-Path $PSScriptRoot "Install-BankingMcp.ps1") $stageRoot
    Copy-Item (Join-Path $PSScriptRoot "templates\*") $templatesDirectory -Recurse
    Copy-Item $nodeCommand.Source (Join-Path $runtimeDirectory "node.exe")

    Push-Location $appDirectory
    try {
        Invoke-NativeCommand npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund
    }
    finally {
        Pop-Location
    }

    $caddyExecutable = Join-Path $toolsDirectory "caddy.exe"
    $caddyDownloadUri = "https://caddyserver.com/api/download?os=windows&arch=amd64&p=github.com/caddy-dns/godaddy"
    Invoke-WebRequest -Uri $caddyDownloadUri -OutFile $caddyExecutable

    $caddyModules = & $caddyExecutable list-modules
    if ($LASTEXITCODE -ne 0 -or $caddyModules -notcontains "dns.providers.godaddy") {
        throw "The downloaded Caddy build does not contain dns.providers.godaddy."
    }

    $winSwUri = "https://github.com/winsw/winsw/releases/download/v$WinSwVersion/WinSW-x64.exe"
    Invoke-WebRequest -Uri $winSwUri -OutFile (Join-Path $toolsDirectory "WinSW-x64.exe")

    New-Item $OutputDirectory -ItemType Directory -Force | Out-Null
    $archivePath = Join-Path $OutputDirectory ("sample-banking-mcp-{0}.zip" -f $packageJson.version)
    if (Test-Path $archivePath) {
        Remove-Item $archivePath -Force
    }
    Compress-Archive -Path (Join-Path $stageRoot "*") -DestinationPath $archivePath -CompressionLevel Optimal

    $hash = Get-FileHash $archivePath -Algorithm SHA256
    Write-Host "Created $archivePath"
    Write-Host "SHA256 $($hash.Hash)"
}
finally {
    if (Test-Path $stageRoot) {
        Remove-Item $stageRoot -Recurse -Force
    }
}

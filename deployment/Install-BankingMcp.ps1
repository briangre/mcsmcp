[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern("^(?=.{1,253}$)(?!-)(?:[a-zA-Z0-9-]{1,63}\.)+[a-zA-Z]{2,63}$")]
    [string]$DomainName,

    [ValidatePattern("^[^@\s]+@[^@\s]+\.[^@\s]+$")]
    [string]$AcmeEmail,

    [ValidatePattern("^[A-Za-z]:\\")]
    [string]$InstallRoot = "C:\Services\BankingMcp",

    [Security.SecureString]$GoDaddyApiKey,

    [Security.SecureString]$GoDaddyApiSecret
)

$ErrorActionPreference = "Stop"
$packageRoot = $PSScriptRoot
$bankingServiceName = "BankingMcp"
$caddyServiceName = "BankingMcpCaddy"

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run this installer from an elevated PowerShell session."
    }
}

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    & $FilePath @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "'$FilePath $($Arguments -join ' ')' failed with exit code $LASTEXITCODE."
    }
}

function Stop-ServiceIfPresent {
    param([string]$Name)

    $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if ($service -and $service.Status -ne "Stopped") {
        Stop-Service -Name $Name -Force
        $service.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
    }
}

function ConvertTo-XmlText {
    param([string]$Value)
    return [Security.SecurityElement]::Escape($Value)
}

function Set-Utf8File {
    param(
        [string]$Path,
        [string]$Value
    )

    [IO.File]::WriteAllText($Path, $Value, [Text.UTF8Encoding]::new($false))
}

function ConvertFrom-SecureValue {
    param([Security.SecureString]$Value)

    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

Assert-Administrator

if (-not $GoDaddyApiKey) {
    Write-Host "Paste with right-click or Shift+Insert; Ctrl+V may be captured as a control character in Windows PowerShell 5.1."
    $GoDaddyApiKey = Read-Host "GoDaddy production API key" -AsSecureString
}
if (-not $GoDaddyApiSecret) {
    $GoDaddyApiSecret = Read-Host "GoDaddy production API secret" -AsSecureString
}

$plainTextGoDaddyApiKey = ConvertFrom-SecureValue $GoDaddyApiKey
$plainTextGoDaddyApiSecret = ConvertFrom-SecureValue $GoDaddyApiSecret
if (
    [string]::IsNullOrWhiteSpace($plainTextGoDaddyApiKey) -or
    [string]::IsNullOrWhiteSpace($plainTextGoDaddyApiSecret)
) {
    throw "The GoDaddy production API key and secret are both required."
}
if ($plainTextGoDaddyApiKey.Contains(":") -or $plainTextGoDaddyApiSecret.Contains(":")) {
    throw "The GoDaddy API key and secret cannot contain a colon."
}
if (
    $plainTextGoDaddyApiKey -notmatch "^[\x21-\x7E]+$" -or
    $plainTextGoDaddyApiSecret -notmatch "^[\x21-\x7E]+$"
) {
    throw "The GoDaddy API key or secret contains an invalid character. In Windows PowerShell 5.1, paste into hidden prompts with right-click or Shift+Insert instead of Ctrl+V."
}
$plainTextGoDaddyApiToken = "${plainTextGoDaddyApiKey}:${plainTextGoDaddyApiSecret}"
$plainTextGoDaddyApiKey = $null
$plainTextGoDaddyApiSecret = $null

$requiredPaths = @(
    (Join-Path $packageRoot "app"),
    (Join-Path $packageRoot "runtime\node.exe"),
    (Join-Path $packageRoot "tools\caddy.exe"),
    (Join-Path $packageRoot "tools\WinSW-x64.exe"),
    (Join-Path $packageRoot "seed-data")
)
foreach ($requiredPath in $requiredPaths) {
    if (-not (Test-Path $requiredPath)) {
        throw "Deployment package is incomplete: '$requiredPath' is missing."
    }
}

$appDirectory = Join-Path $InstallRoot "app"
$newAppDirectory = Join-Path $InstallRoot "app.new"
$previousAppDirectory = Join-Path $InstallRoot "app.previous"
$dataDirectory = Join-Path $InstallRoot "data"
$logDirectory = Join-Path $InstallRoot "logs"
$runtimeDirectory = Join-Path $InstallRoot "runtime"
$serviceDirectory = Join-Path $InstallRoot "services"
$caddyDirectory = Join-Path $InstallRoot "caddy"
$caddyDataDirectory = Join-Path $caddyDirectory "data"

New-Item $InstallRoot, $dataDirectory, $logDirectory, $runtimeDirectory, $serviceDirectory, $caddyDirectory, $caddyDataDirectory -ItemType Directory -Force | Out-Null

$localServiceSid = "*S-1-5-19"
$administratorsSid = "*S-1-5-32-544"
$systemSid = "*S-1-5-18"
Invoke-NativeCommand icacls.exe $serviceDirectory /inheritance:r
Invoke-NativeCommand icacls.exe $serviceDirectory /grant:r "${administratorsSid}:(OI)(CI)F" "${systemSid}:(OI)(CI)F" "${localServiceSid}:(OI)(CI)RX" /T /C /Q

Stop-ServiceIfPresent $caddyServiceName
Stop-ServiceIfPresent $bankingServiceName

if (Test-Path $newAppDirectory) {
    Remove-Item $newAppDirectory -Recurse -Force
}
Copy-Item (Join-Path $packageRoot "app") $newAppDirectory -Recurse

if (Test-Path $previousAppDirectory) {
    Remove-Item $previousAppDirectory -Recurse -Force
}
if (Test-Path $appDirectory) {
    Move-Item $appDirectory $previousAppDirectory
}
Move-Item $newAppDirectory $appDirectory

Copy-Item (Join-Path $packageRoot "runtime\node.exe") $runtimeDirectory -Force
Copy-Item (Join-Path $packageRoot "tools\caddy.exe") $caddyDirectory -Force

foreach ($seedFile in Get-ChildItem (Join-Path $packageRoot "seed-data") -Filter "*.json") {
    $destination = Join-Path $dataDirectory $seedFile.Name
    if (-not (Test-Path $destination)) {
        Copy-Item $seedFile.FullName $destination
    }
}

$bankingWrapper = Join-Path $serviceDirectory "BankingMcpService.exe"
$caddyWrapper = Join-Path $serviceDirectory "CaddyService.exe"
Copy-Item (Join-Path $packageRoot "tools\WinSW-x64.exe") $bankingWrapper -Force
Copy-Item (Join-Path $packageRoot "tools\WinSW-x64.exe") $caddyWrapper -Force

$nodeExecutable = ConvertTo-XmlText (Join-Path $runtimeDirectory "node.exe")
$serverScript = ConvertTo-XmlText (Join-Path $appDirectory "dist\server.js")
$appWorkingDirectory = ConvertTo-XmlText $appDirectory
$xmlDataDirectory = ConvertTo-XmlText $dataDirectory
$xmlLogDirectory = ConvertTo-XmlText $logDirectory

$bankingServiceXml = @"
<service>
  <id>$bankingServiceName</id>
  <name>Sample Banking MCP</name>
  <description>JSON-backed sample banking Model Context Protocol server.</description>
  <executable>$nodeExecutable</executable>
  <arguments>&quot;$serverScript&quot;</arguments>
  <workingdirectory>$appWorkingDirectory</workingdirectory>
  <env name="NODE_ENV" value="production" />
  <env name="HOST" value="127.0.0.1" />
  <env name="PORT" value="3000" />
  <env name="BANK_DATA_DIRECTORY" value="$xmlDataDirectory" />
  <logpath>$xmlLogDirectory</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
  <stoptimeout>15 sec</stoptimeout>
  <onfailure action="restart" delay="5 sec" />
  <resetfailure>1 hour</resetfailure>
</service>
"@
Set-Utf8File (Join-Path $serviceDirectory "BankingMcpService.xml") $bankingServiceXml

$caddyPath = ConvertTo-XmlText (Join-Path $caddyDirectory "caddy.exe")
$caddyFilePath = Join-Path $caddyDirectory "Caddyfile"
$xmlCaddyFilePath = ConvertTo-XmlText $caddyFilePath
$xmlCaddyWorkingDirectory = ConvertTo-XmlText $caddyDirectory
$xmlCaddyDataDirectory = ConvertTo-XmlText $caddyDataDirectory
$xmlGoDaddyApiToken = ConvertTo-XmlText $plainTextGoDaddyApiToken

$globalOptions = "    auto_https disable_redirects`r`n    acme_dns godaddy {env.GODADDY_API_TOKEN}"
if ($AcmeEmail) {
    $globalOptions = "    email $AcmeEmail`r`n$globalOptions"
}
$caddyLogPath = (Join-Path $logDirectory "caddy-access.log").Replace("\", "/")
$caddyConfiguration = @"
{
$globalOptions
}

$DomainName {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000
    log {
        output file "$caddyLogPath" {
            roll_size 10MiB
            roll_keep 8
        }
    }
}
"@
Set-Utf8File $caddyFilePath $caddyConfiguration

$caddyServiceXml = @"
<service>
  <id>$caddyServiceName</id>
  <name>Sample Banking MCP HTTPS</name>
  <description>Caddy HTTPS reverse proxy and automatic certificate renewal for the banking MCP server.</description>
  <executable>$caddyPath</executable>
  <arguments>run --config &quot;$xmlCaddyFilePath&quot; --adapter caddyfile</arguments>
  <workingdirectory>$xmlCaddyWorkingDirectory</workingdirectory>
  <env name="XDG_DATA_HOME" value="$xmlCaddyDataDirectory" />
  <env name="GODADDY_API_TOKEN" value="$xmlGoDaddyApiToken" />
  <logpath>$xmlLogDirectory</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
  <depend>$bankingServiceName</depend>
  <stoptimeout>30 sec</stoptimeout>
  <onfailure action="restart" delay="5 sec" />
  <resetfailure>1 hour</resetfailure>
</service>
"@
Set-Utf8File (Join-Path $serviceDirectory "CaddyService.xml") $caddyServiceXml
$xmlGoDaddyApiToken = $null

$previousGoDaddyApiToken = $env:GODADDY_API_TOKEN
try {
    $env:GODADDY_API_TOKEN = $plainTextGoDaddyApiToken
    Invoke-NativeCommand (Join-Path $caddyDirectory "caddy.exe") validate --config $caddyFilePath --adapter caddyfile
}
finally {
    $env:GODADDY_API_TOKEN = $previousGoDaddyApiToken
}
$plainTextGoDaddyApiToken = $null

Invoke-NativeCommand icacls.exe $InstallRoot /grant "${localServiceSid}:(OI)(CI)RX" /T /C /Q
Invoke-NativeCommand icacls.exe $dataDirectory /grant "${localServiceSid}:(OI)(CI)M" /T /C /Q
Invoke-NativeCommand icacls.exe $logDirectory /grant "${localServiceSid}:(OI)(CI)M" /T /C /Q
Invoke-NativeCommand icacls.exe $caddyDataDirectory /grant "${localServiceSid}:(OI)(CI)M" /T /C /Q

if (-not (Get-Service -Name $bankingServiceName -ErrorAction SilentlyContinue)) {
    Invoke-NativeCommand $bankingWrapper install
}
if (-not (Get-Service -Name $caddyServiceName -ErrorAction SilentlyContinue)) {
    Invoke-NativeCommand $caddyWrapper install
}

Invoke-NativeCommand sc.exe config $bankingServiceName start= delayed-auto obj= "NT AUTHORITY\LocalService"
Invoke-NativeCommand sc.exe failure $bankingServiceName reset= 86400 actions= restart/5000/restart/15000/restart/30000
Invoke-NativeCommand sc.exe config $caddyServiceName start= delayed-auto obj= "NT AUTHORITY\LocalService"
Invoke-NativeCommand sc.exe failure $caddyServiceName reset= 86400 actions= restart/5000/restart/15000/restart/30000

$legacyHttpRule = Get-NetFirewallRule -Name "BankingMcp-HTTP" -ErrorAction SilentlyContinue
if ($legacyHttpRule) {
    Remove-NetFirewallRule -Name "BankingMcp-HTTP"
}

foreach ($firewallRule in @(
    @{ Name = "BankingMcp-HTTPS"; Port = 443 }
)) {
    if (-not (Get-NetFirewallRule -Name $firewallRule.Name -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -Name $firewallRule.Name `
            -DisplayName "Sample Banking MCP TCP $($firewallRule.Port)" `
            -Direction Inbound `
            -Protocol TCP `
            -LocalPort $firewallRule.Port `
            -Action Allow `
            -Profile Any | Out-Null
    }
}

Start-Service $bankingServiceName
$bankingService = Get-Service $bankingServiceName
$bankingService.WaitForStatus("Running", [TimeSpan]::FromSeconds(30))

$healthy = $false
for ($attempt = 1; $attempt -le 15; $attempt++) {
    try {
        $health = Invoke-RestMethod "http://127.0.0.1:3000/health" -TimeoutSec 3
        if ($health.status -eq "ok") {
            $healthy = $true
            break
        }
    }
    catch {
        Start-Sleep -Seconds 2
    }
}
if (-not $healthy) {
    Stop-ServiceIfPresent $bankingServiceName
    if (Test-Path $previousAppDirectory) {
        Remove-Item $appDirectory -Recurse -Force
        Move-Item $previousAppDirectory $appDirectory
        Start-Service $bankingServiceName
    }
    throw "The BankingMcp service started but did not pass its local health check. Review '$logDirectory'."
}

Start-Service $caddyServiceName
$caddyService = Get-Service $caddyServiceName
$caddyService.WaitForStatus("Running", [TimeSpan]::FromSeconds(30))

$httpsHealthy = $false
for ($attempt = 1; $attempt -le 12; $attempt++) {
    try {
        $publicHealth = Invoke-RestMethod "https://$DomainName/health" -TimeoutSec 5
        if ($publicHealth.status -eq "ok") {
            $httpsHealthy = $true
            break
        }
    }
    catch {
        Start-Sleep -Seconds 5
    }
}

if (Test-Path $previousAppDirectory) {
    Remove-Item $previousAppDirectory -Recurse -Force
}

Write-Host ""
Write-Host "Banking MCP services installed successfully."
Write-Host "Endpoint: https://$DomainName/mcp"
Write-Host "Logs: $logDirectory"
if (-not $httpsHealthy) {
    Write-Warning "The local service is healthy, but HTTPS could not be verified from this VM. Check private DNS, network routing, and CaddyService logs."
}
Write-Warning "The endpoint has no authentication. Restrict its audience with network controls if it must not be public."
Write-Warning "Allow inbound TCP 443 only from the private networks that contain authorized MCP clients."

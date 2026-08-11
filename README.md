# Sample Banking MCP Server

A no-auth sample banking application exposed as a
[Model Context Protocol (MCP)](https://modelcontextprotocol.io/introduction)
server. Customer, account, and transaction data is stored in human-readable
JSON files under `data/`.

> [!WARNING]
> This project is for demos and learning only. It has no authentication,
> authorization, encryption, or production-grade database.

## Data

- `data/customers.json`: first name, last name, and customer ID
- `data/accounts.json`: account type, open date, balance, status, customer ID,
  and account ID
- `data/transactions.json`: detailed deposits and withdrawals, including
  before/after balances, timestamps, and descriptions

Balances are rounded to cents. Mutations are serialized to prevent concurrent
withdrawals from spending the same balance.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `list-customers` | List all customers |
| `get-customer` | Find a customer by ID |
| `list-accounts` | List all accounts or filter by customer ID |
| `balance-inquiry` | Return an account's current balance and status |
| `deposit` | Deposit a positive amount into an active account |
| `withdraw` | Withdraw from an active account when sufficient funds exist |
| `transaction-history` | Query the detailed log by account or customer |

Deposits and withdrawals are rejected for frozen or closed accounts.
Withdrawals are also rejected when the requested amount exceeds the current
balance, without changing the account or transaction files.

## Run locally

Requires Node.js 22 or later.

```powershell
npm install
npm test
npm start
```

The MCP endpoint is available at `http://localhost:3000/mcp`. Configure an MCP
client to use that Streamable HTTP URL.

## Sample requests

After connecting the server to an MCP client, try:

```text
List the accounts for customer CUST-1001.
What is the balance of ACCT-2001?
Deposit $125.50 into ACCT-2001 with the description "Paycheck".
Withdraw $40 from ACCT-2001 with the description "ATM withdrawal".
Show the transaction history for ACCT-2001.
```

## Deploy to a Windows VM

The deployment package runs two automatic Windows services:

- `BankingMcp` runs the Node.js server on `127.0.0.1:3000` through
  [WinSW](https://github.com/winsw/winsw).
- `BankingMcpCaddy` runs a custom [Caddy](https://caddyserver.com/) build with
  the GoDaddy DNS plugin on port 443, obtains and renews a public TLS certificate
  through DNS-01 validation, and proxies requests to the local MCP server.

The MCP endpoint is `https://<your-domain>/mcp`. Port 3000 is never opened
through Windows Firewall and is not reachable through the VM's public network
interface.

> [!CAUTION]
> TLS protects traffic in transit but does not authenticate callers. This
> sample intentionally has no authentication, so anyone who can reach the
> endpoint can use its banking tools. Restrict inbound traffic at the Azure
> network security group when the endpoint should not be generally public.

### Prerequisites

On the build computer:

- Windows PowerShell 5.1 or PowerShell 7
- Node.js 22 or later
- Internet access to download a custom Caddy build and WinSW

On the Windows VM:

- A private IP reachable by the intended MCP clients
- Private DNS resolving the custom hostname to that private IP
- The public authoritative DNS zone hosted by GoDaddy
- A GoDaddy production API key and secret with permission to modify DNS records
- Inbound TCP 443 allowed from the client networks by the VM's Azure network
  security group
- Outbound HTTPS access to the certificate authority and GoDaddy API
- An elevated Windows PowerShell session for installation

The VM does not need a public IP. Do not create inbound rules for ports 80 or
3000. DNS-01 validation works by creating temporary `_acme-challenge` TXT
records through GoDaddy's API rather than connecting to the VM.

When upgrading from the earlier HTTP-01 configuration, remove its TCP 80 rule
from the Azure network security group. The installer removes the obsolete
Windows Firewall rule automatically.

### 1. Build a deployment package

From the repository root:

```powershell
.\deployment\New-DeploymentPackage.ps1
```

The script installs exact npm lockfile dependencies, runs all tests, compiles
TypeScript, downloads a Caddy Windows build containing
`github.com/caddy-dns/godaddy` and WinSW 2.12.0, bundles the current Node
runtime, and writes:

```text
artifacts\sample-banking-mcp-1.0.0.zip
```

It also verifies that the Caddy binary exposes `dns.providers.godaddy` and
prints the archive's SHA-256 hash.

### 2. Prepare DNS and the Azure VM

1. Create a GoDaddy production API key and secret. The required installer token
   format is `KEY:SECRET`.
2. Configure private DNS so the custom hostname resolves to the VM's private IP
   for MCP clients.
3. Add an Azure network security group inbound rule for TCP 443 from only the
   private client network ranges.
4. Copy the deployment ZIP to the VM and extract it to a temporary folder.

The public GoDaddy zone does not need an `A` record pointing to the VM. Caddy
only uses that zone to create temporary DNS TXT records for certificate
validation.

### 3. Install or upgrade

Open an elevated Windows PowerShell session in the extracted package:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\Install-BankingMcp.ps1 `
  -DomainName "bank.example.com" `
  -AcmeEmail "admin@example.com"
```

The installer securely prompts for the GoDaddy token. Paste `KEY:SECRET`; the
value is not echoed or placed in PowerShell history. It is stored as a Caddy
service environment variable in the WinSW XML, whose ACL permits access only to
Administrators, SYSTEM, and LocalService.

The default installation root is `C:\Services\BankingMcp`. Use
`-InstallRoot "D:\Services\BankingMcp"` to select another fixed drive.

The installer:

1. Stops existing banking services during an upgrade.
2. replaces application and runtime files;
3. initializes seed JSON only when a data file does not already exist;
4. preserves all existing JSON balances and transactions;
5. grants the restricted `LocalService` account only the required file access;
6. installs both services with automatic delayed startup and failure recovery;
7. opens Windows Firewall port 443;
8. checks the local application health endpoint; and
9. starts Caddy so it can complete GoDaddy DNS-01 validation and obtain the
   certificate.

Run the installer from each new deployment package to upgrade. Back up
`C:\Services\BankingMcp\data` before upgrades or manual data maintenance.

### Verify

Check service state:

```powershell
Get-Service BankingMcp, BankingMcpCaddy
Invoke-RestMethod http://127.0.0.1:3000/health
```

From a computer connected to the private network:

```powershell
Invoke-WebRequest https://bank.example.com/health
```

Configure the MCP client with:

```text
https://bank.example.com/mcp
```

WinSW service logs and Caddy access logs are written under
`C:\Services\BankingMcp\logs`. Caddy certificate state is under
`C:\Services\BankingMcp\caddy\data\caddy` and survives service or VM restarts.

### Service operations

```powershell
Restart-Service BankingMcp
Restart-Service BankingMcpCaddy
Get-Content C:\Services\BankingMcp\logs\BankingMcpService.out.log -Tail 100
Get-Content C:\Services\BankingMcp\logs\CaddyService.out.log -Tail 100
```

Both services start automatically after a VM restart and are configured to
restart after process failures. Caddy renews the certificate through the
GoDaddy API without inbound internet connectivity.

### Remove the services

Run these commands from an elevated PowerShell session:

```powershell
Stop-Service BankingMcpCaddy, BankingMcp
& C:\Services\BankingMcp\services\CaddyService.exe uninstall
& C:\Services\BankingMcp\services\BankingMcpService.exe uninstall
Remove-NetFirewallRule -Name BankingMcp-HTTPS
```

The commands intentionally leave the installation and `data` directory in
place. Remove or archive those files separately only after confirming the
banking records are no longer needed.

Service and Caddy configurations are rendered by Install-BankingMcp.ps1
because they contain installation-specific paths, the custom domain, and the
Microsoft Entra API identifiers.

Run the installer from an elevated Windows PowerShell session:

.\Install-BankingMcp.ps1 `
  -DomainName "bank.example.com" `
  -AcmeEmail "admin@example.com" `
  -EntraTenantId "<directory-tenant-id>" `
  -EntraClientId "<banking-api-application-client-id>"

The installer prompts for the GoDaddy production API key and secret. It
upgrades existing services in place and preserves banking JSON and Caddy
certificate data.

Endpoints:

https://bank.example.com/mcp
https://bank.example.com/authenticated/mcp

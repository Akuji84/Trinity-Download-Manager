param(
  [Parameter(Mandatory = $true)]
  [string]$Version,

  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [Parameter(Mandatory = $true)]
  [string]$SignaturePath,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [string]$Notes = "Trinity update",

  [string]$Platform = "windows-x86_64"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-RequiredEnv([string]$Name) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Missing required environment variable: $Name"
  }
  return $value.TrimEnd("/")
}

if (-not (Test-Path -LiteralPath $InstallerPath)) {
  throw "Installer not found: $InstallerPath"
}

if (-not (Test-Path -LiteralPath $SignaturePath)) {
  throw "Signature not found: $SignaturePath"
}

$baseUrl = Get-RequiredEnv "TRINITY_UPDATE_BASE_URL"
$installerName = Split-Path -Leaf $InstallerPath
$signature = (Get-Content -LiteralPath $SignaturePath -Raw).Trim()
$pubDate = [DateTimeOffset]::UtcNow.ToString("o")

$manifest = [ordered]@{
  version = $Version
  notes = $Notes
  pub_date = $pubDate
  platforms = [ordered]@{
    $Platform = [ordered]@{
      signature = $signature
      url = "$baseUrl/$installerName"
    }
  }
}

$outputDirectory = Split-Path -Parent $OutputPath
if (-not [string]::IsNullOrWhiteSpace($outputDirectory)) {
  New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}

$json = $manifest | ConvertTo-Json -Depth 6
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($OutputPath, $json, $utf8NoBom)
Write-Host "Wrote updater manifest to $OutputPath"

param(
  [Parameter(Mandatory = $true)]
  [string]$ManifestPath,

  [Parameter(Mandatory = $true)]
  [string[]]$ArtifactPaths
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-RequiredEnv([string]$Name) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Missing required environment variable: $Name"
  }
  return $value
}

$updateHost = Get-RequiredEnv "TRINITY_UPDATE_HOST"
$updateUser = Get-RequiredEnv "TRINITY_UPDATE_USER"
$updatePath = Get-RequiredEnv "TRINITY_UPDATE_PATH"
$sshKeyPath = Get-RequiredEnv "TRINITY_SSH_KEY_PATH"

if (-not (Test-Path -LiteralPath $ManifestPath)) {
  throw "Manifest not found: $ManifestPath"
}

foreach ($artifact in $ArtifactPaths) {
  if (-not (Test-Path -LiteralPath $artifact)) {
    throw "Artifact not found: $artifact"
  }
}

$allUploads = @($ManifestPath) + $ArtifactPaths

& ssh -i $sshKeyPath "$updateUser@$updateHost" "mkdir -p '$updatePath'"
if ($LASTEXITCODE -ne 0) {
  throw "Failed to prepare remote update directory."
}

foreach ($path in $allUploads) {
  & scp -i $sshKeyPath $path "${updateUser}@${updateHost}:$updatePath/"
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to upload: $path"
  }
}

Write-Host "Uploaded update manifest and artifacts to $updateUser@$updateHost:$updatePath"

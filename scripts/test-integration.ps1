
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $RepoRoot

try {
    & "$PSScriptRoot/setup-integration-db.ps1"

    if ($LASTEXITCODE -ne 0) {
        throw 'Integration database setup failed.'
    }

    # Run the actual Vitest command without recursively invoking this wrapper.
    & npm run test:integration:vitest

    if ($LASTEXITCODE -ne 0) {
        throw "Integration tests failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
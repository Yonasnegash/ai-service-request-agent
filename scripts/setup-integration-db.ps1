
$ErrorActionPreference = 'Stop'

$TargetDatabase = 'service_request_agent_test'
$RequiredDatabaseName = 'service_request_agent_test'
$RepoRoot = Split-Path -Parent $PSScriptRoot

# This guard must remain in place. This script is destructive only
# toward the dedicated integration-test database.
if ($TargetDatabase -cne $RequiredDatabaseName) {
    throw "Refusing to continue: unexpected integration database name '$TargetDatabase'."
}

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Description,

        [Parameter(Mandatory = $true)]
        [string]$Executable,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    Write-Host "`n> $Description"
    & $Executable @Arguments

    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE."
    }
}

Push-Location $RepoRoot

try {
    if (-not (Test-Path 'docker-compose.yml')) {
        throw 'docker-compose.yml was not found at the repository root.'
    }

    $Migrations = @(
        'migrations/001_create_routing_policies.sql',
        'migrations/002_create_cases.sql',
        'migrations/003_create_processing_jobs.sql',
        'migrations/004_add_claim_processing_job_function.sql',
        'migrations/005_align_intake_lifecycle_audit.sql'
    )

    foreach ($Migration in $Migrations) {
        if (-not (Test-Path $Migration)) {
            throw "Required migration not found: $Migration"
        }
    }

    # Confirm that the PostgreSQL service is running.
    Invoke-CheckedCommand `
        -Description 'Check PostgreSQL availability' `
        -Executable 'docker' `
        -Arguments @(
            'compose', 'exec', '-T', 'postgres',
            'pg_isready', '-U', 'service_agent', '-d', 'postgres'
        )

    # Roles are cluster-wide, not database-specific.
    $RoleCount = & docker compose exec -T postgres psql `
        -U service_agent -d postgres -X -A -t `
        -v ON_ERROR_STOP=1 `
        -c "SELECT count(*) FROM pg_roles WHERE rolname IN ('service_request_owner', 'service_request_runtime', 'service_request_policy_admin');"

    if ($LASTEXITCODE -ne 0) {
        throw 'Could not verify the required PostgreSQL roles.'
    }

    if ("$RoleCount".Trim() -ne '3') {
        throw 'Required PostgreSQL roles are missing. No database has been dropped.'
    }

    foreach ($VariableName in @(
        'TEST_DATABASE_URL',
        'TEST_RUNTIME_DATABASE_URL'
    )) {
        $ConnectionString = [Environment]::GetEnvironmentVariable(
            $VariableName,
            'Process'
        )

        if ([string]::IsNullOrWhiteSpace($ConnectionString)) {
            throw "$VariableName is not set. No database has been dropped."
        }

        try {
            $ConnectionUri = [Uri]$ConnectionString
            $DatabaseName = [Uri]::UnescapeDataString(
                $ConnectionUri.AbsolutePath.TrimStart('/')
            )
        }
        catch {
            throw "$VariableName is not a valid PostgreSQL connection URL. No database has been dropped."
        }

        if ($DatabaseName -cne $RequiredDatabaseName) {
            throw "$VariableName targets '$DatabaseName', not '$RequiredDatabaseName'. No database has been dropped."
        }
    }

    Write-Host "`nPreparing disposable database: $TargetDatabase"

    # Disconnect clients only from this exact database.
    Invoke-CheckedCommand `
        -Description 'Disconnect sessions from the integration database' `
        -Executable 'docker' `
        -Arguments @(
            'compose', 'exec', '-T', 'postgres', 'psql',
            '-U', 'service_agent', '-d', 'postgres',
            '-v', 'ON_ERROR_STOP=1',
            '-c', "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$TargetDatabase' AND pid <> pg_backend_pid();"
        )

    Invoke-CheckedCommand `
        -Description 'Drop the disposable integration database if it exists' `
        -Executable 'docker' `
        -Arguments @(
            'compose', 'exec', '-T', 'postgres', 'psql',
            '-U', 'service_agent', '-d', 'postgres',
            '-v', 'ON_ERROR_STOP=1',
            '-c', "DROP DATABASE IF EXISTS $TargetDatabase;"
        )

    Invoke-CheckedCommand `
        -Description 'Create a clean integration database' `
        -Executable 'docker' `
        -Arguments @(
            'compose', 'exec', '-T', 'postgres', 'psql',
            '-U', 'service_agent', '-d', 'postgres',
            '-v', 'ON_ERROR_STOP=1',
            '-c', "CREATE DATABASE $TargetDatabase OWNER service_agent;"
        )

    # Copy and apply each migration in order. A failure stops the script;
    # the next run will recreate the disposable database before retrying.
    foreach ($Migration in $Migrations) {
        $MigrationName = Split-Path -Leaf $Migration
        $ContainerPath = "/tmp/$MigrationName"
        $AbsoluteMigrationPath = Join-Path $RepoRoot $Migration

        Invoke-CheckedCommand `
            -Description "Copy $MigrationName into PostgreSQL container" `
            -Executable 'docker' `
            -Arguments @(
                'compose', 'cp',
                $AbsoluteMigrationPath,
                "postgres:$ContainerPath"
            )

        Invoke-CheckedCommand `
            -Description "Apply $MigrationName" `
            -Executable 'docker' `
            -Arguments @(
                'compose', 'exec', '-T', 'postgres', 'psql',
                '-U', 'service_agent', '-d', $TargetDatabase,
                '-v', 'ON_ERROR_STOP=1',
                '-f', $ContainerPath
            )
    }

    Write-Host "`nIntegration database is ready: $TargetDatabase" -ForegroundColor Green
}
finally {
    Pop-Location
}
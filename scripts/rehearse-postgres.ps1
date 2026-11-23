$ErrorActionPreference = 'Stop'

function Invoke-Postgres {
    docker compose exec -T postgres @args
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL rehearsal command failed: $($args[0])" }
}

$stamp = [Guid]::NewGuid().ToString('N').Substring(0,12)
$source = "era_pilot_source_$stamp"
$target = "era_pilot_restore_$stamp"
$archive = "/tmp/era-pilot-$stamp.dump"
$previousDatabase = $env:DATABASE_URL
$sourceCreated = $false
$targetCreated = $false
$archiveUsed = $false

Push-Location (Join-Path $PSScriptRoot '..')
try {
    Invoke-Postgres createdb -U era $source
    $sourceCreated = $true
    Invoke-Postgres createdb -U era $target
    $targetCreated = $true
    $env:DATABASE_URL = "postgresql://era:era_dev@127.0.0.1:5432/$source"
    node apps/api/dist/migrate.js
    if ($LASTEXITCODE -ne 0) { throw 'Could not prepare source schema' }
    node apps/api/dist/seed.js
    if ($LASTEXITCODE -ne 0) { throw 'Could not prepare source fixtures' }

    $sample = @'
INSERT INTO branches (merchant_id,id,name,timezone) VALUES ('fixture-in','pilot','Pilot','Asia/Kolkata');
INSERT INTO registers (merchant_id,branch_id,id,name) VALUES ('fixture-in','pilot','counter','Pilot counter');
INSERT INTO catalog_barcodes VALUES ('fixture-in','0001','NOTE');
INSERT INTO branch_catalog VALUES ('fixture-in','pilot','NOTE','Notebook','0001',12900,'{}');
INSERT INTO stock_movements (merchant_id,branch_id,sku,id,kind,quantity) VALUES
    ('fixture-in','pilot','NOTE',gen_random_uuid(),'opening',2),
    ('fixture-in','pilot','NOTE',gen_random_uuid(),'cash_sale',-1);
INSERT INTO cash_sales (merchant_id,branch_id,register_id,operation_id,occurred_at,digest,receipt) VALUES
    ('fixture-in','pilot','counter','d7bec635-b70f-43ab-a156-7f707deb5f9b',now(),'rehearsal',
        '{"shiftId":"8c239e4c-f197-49c9-be27-60e49e38597d","currency":"INR","lines":[{"sku":"NOTE","product":"Notebook","quantity":1,"unitMinor":12900}],"discountMinor":0,"tenderedMinor":12900,"totalMinor":12900}');
'@
    $sample | docker compose exec -T postgres psql -U era -d $source -v ON_ERROR_STOP=1
    if ($LASTEXITCODE -ne 0) { throw 'Could not prepare sample receipt' }

    $archiveUsed = $true
    Invoke-Postgres pg_dump -U era --format=custom "--file=$archive" $source
    Invoke-Postgres pg_restore -U era --exit-on-error --no-owner "--dbname=$target" $archive
    $query = @'
SELECT operation_id || ':' || (receipt->>'totalMinor') || ':' ||
    (SELECT sum(quantity)::text FROM stock_movements WHERE merchant_id = 'fixture-in' AND branch_id = 'pilot')
FROM cash_sales WHERE merchant_id = 'fixture-in';
'@
    $restored = Invoke-Postgres psql -U era -d $target -Atc $query
    if ($restored -ne 'd7bec635-b70f-43ab-a156-7f707deb5f9b:12900:1') {
        throw 'The restored receipt amount or stock balance differs'
    }
    Write-Output 'PostgreSQL backup and restore reproduced the acknowledged receipt and sellable stock balance'
} finally {
    $env:DATABASE_URL = $previousDatabase
    if ($sourceCreated) { docker compose exec -T postgres dropdb -U era $source }
    if ($targetCreated) { docker compose exec -T postgres dropdb -U era $target }
    if ($archiveUsed) { docker compose exec -T postgres rm -f -- $archive }
    Pop-Location
}

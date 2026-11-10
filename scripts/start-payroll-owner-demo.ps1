# Creates the demo's private PostgreSQL and starts the local HTTP process.
# Re-running with the same checkout preserves its users, schemes and payments.
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$store=Join-Path $root 'tmp/payroll-owner-demo'
$container='payroll-owner-ux-demo-20261110'
$private=Join-Path $store 'db.local.json'
$env:NODE_PATH=if($env:NODE_PATH){$env:NODE_PATH}else{Join-Path $root 'node_modules'}
Push-Location $root
try {
    $null=New-Item -ItemType Directory -Force $store
    Set-Content -Encoding ascii -LiteralPath (Join-Path $store '.gitignore') -Value '*'
    if(-not (Test-Path -LiteralPath $private)) {
        if(docker ps -aq --filter "name=^/$container$"){throw "Existing demo container requires its matching local credentials."}
        $config=@{name='orders_qa_'+[guid]::NewGuid().ToString('N').Substring(0,16);password=[guid]::NewGuid().ToString('N')}
        $config|ConvertTo-Json|Set-Content -Encoding ascii $private
    }
    $config=Get-Content -Raw $private|ConvertFrom-Json
    if(-not (docker ps -aq --filter "name=^/$container$")){
        $env:POSTGRES_PASSWORD=$config.password
        try {
            docker run --detach --name $container --restart unless-stopped -p 127.0.0.1:54561:5432 -e POSTGRES_PASSWORD -e "POSTGRES_DB=$($config.name)" postgres:16
            if($LASTEXITCODE){throw 'PostgreSQL startup failed.'}
        } finally {Remove-Item Env:POSTGRES_PASSWORD}
    } else {
        docker start $container | Out-Null
        if($LASTEXITCODE){throw 'Unable to start existing demo container.'}
    }
    for($attempt=0;$attempt -lt 30;$attempt++){
        docker exec $container pg_isready -U postgres -d $config.name | Out-Null
        if($LASTEXITCODE -eq 0){break}
        Start-Sleep -Seconds 1
    }
    $login='http://127.0.0.1:4179/login'
    try {$available=(Invoke-WebRequest -UseBasicParsing -Uri $login -TimeoutSec 3).StatusCode -eq 200} catch {$available=$false}
    if(-not $available){
        Start-Process node -WindowStyle Hidden -ArgumentList 'scripts/payroll-owner-ux-stand.mjs' -WorkingDirectory $root -RedirectStandardOutput "$store/server.out" -RedirectStandardError "$store/server.err"
        for($attempt=0;$attempt -lt 60;$attempt++){
            try {if((Invoke-WebRequest -UseBasicParsing -Uri $login -TimeoutSec 2).StatusCode -eq 200){$available=$true;break}} catch {}
            Start-Sleep -Seconds 1
        }
        if(-not $available){throw "HTTP startup failed. See $store/server.err"}
    }
    Write-Output "Local demo: http://127.0.0.1:4179/finance#payroll"
    Write-Output "Local credentials: $store/demo.local.json"
} finally {Pop-Location}

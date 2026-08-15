[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $AdminSourceCidr,

    [Parameter(Mandatory)]
    [string] $SubscriptionId,

    [Parameter(Mandatory)]
    [string] $BudgetContactEmail,

    [string] $Location = 'westus2',
    [string] $ResourceGroupName = 'rg-agent-outpost-westus2',
    [string] $AdminUsername = 'agentadmin',
    [string] $SshPublicKeyPath = (Join-Path $HOME '.ssh\id_ed25519.pub'),
    [int] $MonthlyBudgetAmount = 50,
    [switch] $Apply
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw 'Azure CLI is required. Install it from https://aka.ms/installazurecliwindows.'
}

$subscription = az account show --subscription $SubscriptionId --output json 2>$null |
    ConvertFrom-Json
if (-not $subscription -or $subscription.state -ne 'Enabled') {
    throw "Azure subscription $SubscriptionId is not available in the current Azure CLI login."
}

if (-not (Test-Path -LiteralPath $SshPublicKeyPath -PathType Leaf)) {
    throw "SSH public key not found: $SshPublicKeyPath"
}

if ($AdminSourceCidr -notmatch '^(?:\d{1,3}\.){3}\d{1,3}/(?:\d|[12]\d|3[0-2])$') {
    throw "AdminSourceCidr must be an IPv4 CIDR, usually your current public IP followed by /32."
}

$sshPublicKey = (Get-Content -LiteralPath $SshPublicKeyPath -Raw).Trim()
$budgetStartDate = [DateTime]::UtcNow.ToString('yyyy-MM-01')
$budgetEndDate = [DateTime]::UtcNow.AddYears(10).ToString('yyyy-MM-01')
$deploymentName = "agent-outpost-$([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))"
$template = Join-Path $PSScriptRoot 'main.bicep'
$parameters = @(
    '--subscription', $SubscriptionId,
    '--location', $Location,
    '--name', $deploymentName,
    '--template-file', $template,
    '--parameters',
    "location=$Location",
    "resourceGroupName=$ResourceGroupName",
    "adminUsername=$AdminUsername",
    "adminSshPublicKey=$sshPublicKey",
    "adminSourceCidr=$AdminSourceCidr",
    "monthlyBudgetAmount=$MonthlyBudgetAmount",
    "budgetContactEmail=$BudgetContactEmail",
    "budgetStartDate=$budgetStartDate",
    "budgetEndDate=$budgetEndDate"
)

Write-Host "Subscription: $($subscription.name) ($($subscription.id))"
Write-Host "Tenant:       $($subscription.tenantId)"
Write-Host "Region:       $Location"
Write-Host "Resource group: $ResourceGroupName"

if ($Apply) {
    az deployment sub create @parameters --output json
} else {
    Write-Host 'Running Azure what-if only. Re-run with -Apply after reviewing the changes.'
    az deployment sub what-if @parameters --result-format FullResourcePayloads
}

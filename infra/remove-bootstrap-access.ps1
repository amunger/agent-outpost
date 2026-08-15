[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [string] $SubscriptionId,
    [string] $ResourceGroupName = 'rg-agent-outpost-westus2'
)

$ErrorActionPreference = 'Stop'
$networkInterfaceName = 'nic-agent-outpost'
$networkSecurityGroupName = 'nsg-agent-outpost'
$publicIpName = 'pip-agent-outpost'

if (-not $PSCmdlet.ShouldProcess(
    "$ResourceGroupName in $SubscriptionId",
    'detach and delete the bootstrap public IP and remove the SSH rule'
)) {
    return
}

az network nic ip-config update `
    --subscription $SubscriptionId `
    --resource-group $ResourceGroupName `
    --nic-name $networkInterfaceName `
    --name primary `
    --remove publicIPAddress `
    --output none

az network nsg rule delete `
    --subscription $SubscriptionId `
    --resource-group $ResourceGroupName `
    --nsg-name $networkSecurityGroupName `
    --name AllowRestrictedSsh `
    --output none

az network public-ip delete `
    --subscription $SubscriptionId `
    --resource-group $ResourceGroupName `
    --name $publicIpName `
    --output none

Write-Host 'Bootstrap public access has been removed. Confirm Tailscale SSH before closing your current session.'

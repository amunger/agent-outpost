[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)]
    [string] $SubscriptionId,
    [string] $ResourceGroupName = 'rg-agent-outpost-westus2'
)

$ErrorActionPreference = 'Stop'

if ($PSCmdlet.ShouldProcess(
    "$ResourceGroupName in $SubscriptionId",
    'permanently delete the Agent Outpost resource group and all resources it contains'
)) {
    az group delete `
        --subscription $SubscriptionId `
        --name $ResourceGroupName `
        --yes `
        --no-wait
}

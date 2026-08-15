targetScope = 'subscription'

@description('Azure region for all project resources.')
param location string = 'westus2'

@description('Resource group containing every Agent Outpost resource.')
param resourceGroupName string = 'rg-agent-outpost-westus2'

@description('Linux VM administrator username.')
param adminUsername string = 'agentadmin'

@secure()
@description('OpenSSH public key installed for the Linux administrator.')
param adminSshPublicKey string

@description('CIDR allowed to use temporary SSH access, such as 203.0.113.10/32.')
param adminSourceCidr string

@description('Monthly project budget in the subscription billing currency.')
@minValue(1)
param monthlyBudgetAmount int = 50

@description('Email that receives cost notifications.')
param budgetContactEmail string

@description('First day of the current month in ISO 8601 form.')
param budgetStartDate string

@description('End date for the budget in ISO 8601 form.')
param budgetEndDate string

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: {
    project: 'agent-outpost'
    environment: 'development'
    managedBy: 'bicep'
  }
}

module resources './resources.bicep' = {
  name: 'agent-outpost-resources'
  scope: resourceGroup
  params: {
    location: location
    adminUsername: adminUsername
    adminSshPublicKey: adminSshPublicKey
    adminSourceCidr: adminSourceCidr
    enablePublicIp: true
  }
}

resource budget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: 'agent-outpost-monthly'
  properties: {
    category: 'Cost'
    amount: monthlyBudgetAmount
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: budgetStartDate
      endDate: budgetEndDate
    }
    filter: {
      dimensions: {
        name: 'ResourceGroupName'
        operator: 'In'
        values: [
          resourceGroupName
        ]
      }
    }
    notifications: {
      actual60: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 60
        thresholdType: 'Actual'
        contactEmails: [
          budgetContactEmail
        ]
      }
      actual80: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: [
          budgetContactEmail
        ]
      }
      actual95: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 95
        thresholdType: 'Actual'
        contactEmails: [
          budgetContactEmail
        ]
      }
      forecast100: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: [
          budgetContactEmail
        ]
      }
    }
  }
}

output resourceGroupName string = resourceGroup.name
output vmName string = resources.outputs.vmName
output publicIpAddress string = resources.outputs.publicIpAddress
output sshCommand string = resources.outputs.sshCommand

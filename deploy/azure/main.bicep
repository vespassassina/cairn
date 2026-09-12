// Cairn on Azure Container Apps (ADR-018). See docs/DEPLOY-AZURE.md.
//
// What this creates, all inside the free grants for one person's use:
//
// 1. A storage account with one private blob container. Litestream keeps the
//    SQLite database there, so it survives restarts and scale to zero.
// 2. A Container Apps environment on the consumption plan, with no Log
//    Analytics workspace, which would bill per gigabyte.
// 3. The Cairn container app: one replica at most, zero when idle, HTTPS on
//    its own address, and a managed identity allowed to write to the blob
//    container. No storage key is stored anywhere.
//
// Two passes. The first, without oauthClientId, creates the storage and the
// environment and reports the address the app will have. Create the OAuth app
// at your provider with that address, then run the same deployment again with
// its client id and secret to create the app itself.

@description('Name for the app, and the prefix of every other resource. Lower-case letters, digits and dashes.')
@minLength(3)
@maxLength(24)
param name string = 'cairn'

@description('Azure region. Defaults to the resource group\'s.')
param location string = resourceGroup().location

@description('The container image to run.')
param image string = 'ghcr.io/vespassassina/cairn:latest'

@description('Where people sign in: github, or oidc for Entra ID, Google and other OpenID Connect providers.')
@allowed([
  'github'
  'oidc'
])
param authProvider string = 'github'

@description('For oidc only: the issuer URL, such as https://login.microsoftonline.com/<tenant-id>/v2.0.')
param oidcIssuer string = ''

@description('The OAuth app\'s client id. Leave empty on the first pass.')
param oauthClientId string = ''

@description('The OAuth app\'s client secret.')
@secure()
param oauthClientSecret string = ''

@description('Signing secret for tokens and sessions, at least 32 characters. Keep it the same between deployments.')
@secure()
param authSecret string = ''

@description('The previous signing secret, during a rotation. Tokens it signed keep working until they expire.')
@secure()
param authSecretPrevious string = ''

@description('Who may sign in, comma-separated: github:yourlogin, email:you@example.com, or oidc:<subject>.')
param allowedUsers string = ''

@description('Optional service token, at least 32 characters, for scripts that cannot sign in.')
@secure()
param serviceToken string = ''

var deployApp = !empty(oauthClientId)
var suffix = uniqueString(resourceGroup().id, name)
var storageName = toLower('${take(replace(name, '-', ''), 10)}${take(suffix, 12)}')
var blobContainerName = 'cairn'

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    accessTier: 'Hot'
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource blobContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: blobContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${name}-env'
  location: location
  properties: {
    // No appLogsConfiguration: logs stream live with `az containerapp logs
    // show`, and nothing is stored or billed.
  }
}

var publicUrl = 'https://${name}.${environment.properties.defaultDomain}'

var baseEnv = [
  { name: 'CAIRN_PUBLIC_URL', value: publicUrl }
  { name: 'CAIRN_AUTH_PROVIDER', value: authProvider }
  { name: 'CAIRN_OAUTH_CLIENT_ID', value: oauthClientId }
  { name: 'CAIRN_OAUTH_CLIENT_SECRET', secretRef: 'oauth-client-secret' }
  { name: 'CAIRN_AUTH_SECRET', secretRef: 'auth-secret' }
  { name: 'CAIRN_ALLOWED_USERS', value: allowedUsers }
  { name: 'CAIRN_REPLICA_URL', value: 'abs://${storage.name}@${blobContainerName}/cairn.sqlite' }
]
var oidcEnv = authProvider == 'oidc' ? [ { name: 'CAIRN_OIDC_ISSUER', value: oidcIssuer } ] : []
var tokenEnv = empty(serviceToken) ? [] : [ { name: 'CAIRN_TOKEN', secretRef: 'service-token' } ]
var previousEnv = empty(authSecretPrevious) ? [] : [ { name: 'CAIRN_AUTH_SECRET_PREVIOUS', secretRef: 'auth-secret-previous' } ]

var baseSecrets = [
  { name: 'auth-secret', value: authSecret }
  { name: 'oauth-client-secret', value: oauthClientSecret }
]
var tokenSecrets = empty(serviceToken) ? [] : [ { name: 'service-token', value: serviceToken } ]
var previousSecrets = empty(authSecretPrevious) ? [] : [ { name: 'auth-secret-previous', value: authSecretPrevious } ]

resource app 'Microsoft.App/containerApps@2024-03-01' = if (deployApp) {
  name: name
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      ingress: {
        external: true
        targetPort: 8787
        transport: 'auto'
        allowInsecure: false
      }
      secrets: concat(baseSecrets, tokenSecrets, previousSecrets)
    }
    template: {
      containers: [
        {
          name: 'cairn'
          image: image
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: concat(baseEnv, oidcEnv, tokenEnv, previousEnv)
          volumeMounts: [
            {
              volumeName: 'data'
              mountPath: '/data'
            }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/health'
                port: 8787
              }
              periodSeconds: 3
              failureThreshold: 60
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 8787
              }
              periodSeconds: 30
            }
          ]
        }
      ]
      // SQLite has one writer, and Litestream one replicator: never more
      // than one replica. Zero when idle, so an unused Cairn costs nothing.
      scale: {
        minReplicas: 0
        maxReplicas: 1
        rules: [
          {
            name: 'http'
            http: {
              metadata: {
                concurrentRequests: '50'
              }
            }
          }
        ]
      }
      volumes: [
        {
          name: 'data'
          storageType: 'EmptyDir'
        }
      ]
    }
  }
}

// Storage Blob Data Contributor, for the app's identity, on this account only.
resource blobAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployApp) {
  scope: storage
  name: guid(storage.id, name, 'storage-blob-data-contributor')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: app!.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

@description('Where Cairn is, once the app exists.')
output url string = publicUrl

@description('The callback URL to give your OAuth app.')
output callbackUrl string = '${publicUrl}/oauth/callback'

@description('Where the database is kept.')
output replica string = 'abs://${storage.name}@${blobContainerName}/cairn.sqlite'

@description('False on the first pass: create the OAuth app, then deploy again with its client id.')
output appDeployed bool = deployApp

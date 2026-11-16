// Using VibeKit? Ask the user whether they'd rather deploy through the MCP
// server's `app_deploy` tool with artifacts/Voting.arc56.json. It handles
// signing and network selection, so there's no .env file or mnemonic to set up.
// This script is the standalone path, for when VibeKit isn't in the picture.

import { AlgorandClient, algo } from '@algorandfoundation/algokit-utils'
import algosdk from 'algosdk'
import { VotingFactory } from './index.js'
import { getLocalNetDispenser } from './localnet.js'

const CANDIDATES = (process.env.CANDIDATES ?? 'Alice,Bob,Carol')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name.length > 0)

const algorand = AlgorandClient.fromEnvironment()

// Accounts come from plain algosdk (stateless, explicit).
// On localnet, use the default KMD dispenser account.
// On testnet/mainnet, set DEPLOYER_MNEMONIC in your .env file.
const isLocal =
  Boolean(
    process.env.ALGOD_SERVER &&
      (process.env.ALGOD_SERVER.includes('localhost') || process.env.ALGOD_SERVER.includes('127.0.0.1')),
  ) || !process.env.ALGOD_SERVER

let deployer: algosdk.Account
if (process.env.DEPLOYER_MNEMONIC && process.env.DEPLOYER_MNEMONIC.trim().length > 0) {
  deployer = algosdk.mnemonicToSecretKey(process.env.DEPLOYER_MNEMONIC.trim())
} else if (isLocal) {
  deployer = await getLocalNetDispenser(algorand.client.algod)
} else {
  console.error('\n❌ DEPLOYER_MNEMONIC is missing in your .env.testnet file.')
  console.error('To deploy to Testnet via CLI:')
  console.error('  1. Add the 25-word mnemonic of a funded Testnet wallet in blockchain/.env.testnet: DEPLOYER_MNEMONIC="word1 word2 ..."')
  console.error('  OR')
  console.error('  2. (Recommended) Deploy directly via Pera Wallet in your browser at http://localhost:5173/deploy.html without exposing your mnemonic.\n')
  process.exit(1)
}

// The typed factory handles deployment: it uses the indexer to find an
// existing deployment by creator + app name, making deploys idempotent.
const factory = algorand.client.getTypedAppFactory(VotingFactory, {
  defaultSender: deployer.addr,
  defaultSigner: algosdk.makeBasicAccountTransactionSigner(deployer),
})

const { appClient } = await factory.deploy({
  onUpdate: 'append',
  onSchemaBreak: 'append',
})

// Candidate records and voter flags live in boxes, and the app account pays the
// minimum balance for them. 2 ALGO is roughly 40 voters.
await appClient.appClient.fundAppAccount({ amount: algo(2) })

const state = await appClient.appClient.getGlobalState()
const candidateCount = state.candidateCount ? state.candidateCount.value : 0n

if (candidateCount === 0n) {
  await appClient.send.initialize({ args: { names: CANDIDATES } })
  console.log(`Initialized candidates: ${CANDIDATES.join(', ')}`)
} else {
  console.log(`Already initialized with ${candidateCount} candidates, skipping initialize.`)
}

console.log(`Deployed Voting: APP_ID=${appClient.appId}`)
console.log(`App address (holds the box storage): ${appClient.appAddress}`)
console.log(`Set this in the frontend config: VOTING_APP_ID=${appClient.appId}`)

// Algorand Testnet. Public endpoints only — no secrets belong in the frontend.
export const ALGOD_SERVER = "https://testnet-api.algonode.cloud";
export const INDEXER_SERVER = "https://testnet-idx.algonode.cloud";
export const TESTNET_CHAIN_ID = 416002;
export const EXPLORER_APP = (appId) => `https://testnet.explorer.perawallet.app/application/${appId}`;

// App ID from Testnet deployment via Pera Wallet
// Auto-deployed: 775961157
export const VOTING_APP_ID = 775965069n;

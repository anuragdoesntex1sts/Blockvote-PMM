// Algorand Testnet. Public endpoints only — no secrets belong in the frontend.
export const ALGOD_SERVER =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_ALGOD_SERVER) ||
  "https://testnet-api.algonode.cloud";

export const INDEXER_SERVER =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_INDEXER_SERVER) ||
  "https://testnet-idx.algonode.cloud";

export const TESTNET_CHAIN_ID =
  (typeof import.meta !== "undefined" && Number(import.meta.env?.VITE_TESTNET_CHAIN_ID)) ||
  416002;

export const EXPLORER_APP = (appId) => `https://testnet.explorer.perawallet.app/application/${appId}`;

// Default App ID (0n = unconfigured / fresh session)
export const VOTING_APP_ID =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_VOTING_APP_ID && /^\d+$/.test(import.meta.env.VITE_VOTING_APP_ID))
    ? BigInt(import.meta.env.VITE_VOTING_APP_ID)
    : 0n;

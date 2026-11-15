import { PeraWalletConnect } from "@perawallet/connect";
import algosdk from "algosdk";
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { ALGOD_SERVER, INDEXER_SERVER, TESTNET_CHAIN_ID } from "./config";

export const peraWallet = new PeraWalletConnect({
  chainId: TESTNET_CHAIN_ID,
  shouldShowSignTxnToast: true,
});

export const algod = new algosdk.Algodv2("", ALGOD_SERVER, "");

export const algorand = AlgorandClient.fromClients({
  algod,
  indexer: new algosdk.Indexer("", INDEXER_SERVER, ""),
});

/** Sign a single algosdk Transaction via Pera and submit it to algod. */
export async function signSendWait(txn) {
  const signed = await peraWallet.signTransaction([[{ txn }]]);
  let raw = signed[0];
  if (typeof raw === "string") {
    raw = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  } else if (!(raw instanceof Uint8Array)) {
    raw = new Uint8Array(raw);
  }

  const res = await algod.sendRawTransaction(raw).do();
  const txId = res.txId ?? res.txid ?? (typeof res === "string" ? res : txn.txID());
  return algosdk.waitForConfirmation(algod, txId, 8);
}

/** Read global application state directly from algod. */
export async function getAppState(appId) {
  const numericId = Number(appId);
  if (!numericId || numericId <= 0) return null;
  const appInfo = await algod.getApplicationByID(numericId).do();
  const state = {
    admin: "",
    candidateCount: 0,
    started: false,
    ended: false,
  };
  for (const kv of appInfo.params?.globalState || []) {
    const key = new TextDecoder().decode(kv.key);
    if (key === "admin" && kv.value.bytes && kv.value.bytes.length === 32) {
      state.admin = algosdk.encodeAddress(kv.value.bytes);
    } else if (key === "count") {
      state.candidateCount = Number(kv.value.uint);
    } else if (key === "started") {
      state.started = Boolean(Number(kv.value.uint));
    } else if (key === "ended") {
      state.ended = Boolean(Number(kv.value.uint));
    }
  }
  return state;
}

/** Read candidates list from box storage directly from algod. */
export async function getCandidates(appId, count) {
  const numericId = Number(appId);
  const candType = algosdk.ABIType.from("(string,uint64)");
  const candidates = [];
  for (let i = 0; i < count; i++) {
    try {
      const boxName = new Uint8Array([0x63, ...algosdk.encodeUint64(i)]);
      const res = await algod.getApplicationBoxByName(numericId, boxName).do();
      const decoded = candType.decode(res.value);
      candidates.push({
        id: i,
        name: decoded[0],
        votes: Number(decoded[1]),
      });
    } catch (e) {
      console.warn(`Candidate box ${i} error:`, e);
    }
  }
  return candidates;
}

/** Read voter status for an address from box storage directly from algod. */
export async function getVoterStatus(appId, voterAddress) {
  const numericId = Number(appId);
  if (!numericId || !voterAddress || !algosdk.isValidAddress(voterAddress)) {
    return { registered: false, voted: false };
  }
  try {
    const voterPubKey = algosdk.decodeAddress(voterAddress).publicKey;
    const boxName = new Uint8Array([0x76, ...voterPubKey]);
    const res = await algod.getApplicationBoxByName(numericId, boxName).do();
    const voterType = algosdk.ABIType.from("(bool,bool)");
    const decoded = voterType.decode(res.value);
    return { registered: Boolean(decoded[0]), voted: Boolean(decoded[1]) };
  } catch {
    // 404 box not found means not registered
    return { registered: false, voted: false };
  }
}

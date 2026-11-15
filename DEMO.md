# BlockVote — demo runbook (Algorand Testnet)

Same product as the original brief, rebuilt on Algorand: React + Vite frontend,
Algorand TypeScript (Puya) contract, Pera Wallet instead of MetaMask, and
`@algorandfoundation/algokit-utils` instead of ethers.js. Testnet replaces the
Hardhat local chain.

## Requirement → implementation

| Requirement | Where it lives |
| --- | --- |
| Connect wallet | `frontend/src/algorand.js` (Pera Wallet Connect, chain ID 416002) |
| Candidate list with vote buttons | `frontend/src/App.jsx` → `getCandidates()` |
| One wallet, one vote | `blockchain/src/voting.algo.ts` → `vote()` asserts `!status.voted` |
| Votes stored on chain | `candidates` BoxMap, incremented inside `vote()` |
| Live results | `getCandidates()` tally, re-read after every confirmed transaction |
| Admin registers voters | `registerVoter(address)`, admin-only, before the election starts |
| Admin starts / ends election | `startElection()`, `endElection()`, admin-only |
| Deploy script | `blockchain/deploy.ts` (LocalNet/Testnet) and `frontend/deploy.html` (Pera-signed) |

The contract enforces the rules on-chain. The UI only mirrors them, so a user who
edits the frontend still cannot vote twice, vote unregistered, or vote after the
election ends.

## Prerequisites

- Two Pera accounts (one admin, one or two voters). In Pera: **Add account →
  Create new account**, then switch each to **Settings → Developer settings →
  Testnet**.
- Each account funded from `bank.testnet.algorand.network`: ~5 ALGO for the
  admin (2 gets locked in the app account for box storage), ~1 ALGO per voter.

## One-time deploy

```bash
cd frontend
npm run dev
```

Open <http://localhost:5173/deploy.html>, connect the **admin** account, keep the
default candidates (`Alice,Bob,Carol`), press **Deploy to Testnet**, and approve
three Pera prompts: create, 2 ALGO funding, `initialize`.

Copy the printed App ID into `frontend/src/config.js`:

```js
export const VOTING_APP_ID = 1234567890n;
```

Build the contract first if `artifacts/VotingClient.ts` is missing:
`cd blockchain && npm run build`.

## Nine-step test checklist

| # | Action | Expected |
| --- | --- | --- |
| 1 | Connect the admin account | Address appears; **Administration** panel is visible |
| 2 | Register two voter addresses | Two confirmed transactions, status shows each one |
| 3 | Press **Start election** | Status becomes `Open`; vote buttons enable for registered wallets |
| 4 | **Switch** to voter 1 | Address changes, admin panel disappears |
| 5 | Vote for a candidate | Pera prompt, then that candidate's tally increments |
| 6 | Try to vote again from the same wallet | Button reads *Already voted*; a hand-crafted call reverts on-chain |
| 7 | **Switch** to voter 2, vote differently | Second tally increments; total votes = 2 |
| 8 | Switch back to admin, **End election** | Status becomes `Ended` |
| 9 | Try to vote after the end | Buttons disabled; on-chain calls revert; results remain visible |

Step 4 and 7 use the **Switch** button in the header — Pera keeps whichever
account it connected with first, so the app drops the session and asks you to
pick the other account.

## Explaining it in the viva

- **Pera Wallet** holds the keys and signs; it never shares them with the app.
- **`@perawallet/connect`** returns base64-signed transactions, which the
  AlgoKit signer adapter in `frontend/src/algorand.js` hands back to the client.
- **`algokit-utils`** builds, groups and submits transactions, and reads state.
- **The contract** (ARC-4 app, ARC-56 spec) stores candidates and voter flags in
  box storage, because Algorand state has no dynamic arrays or mappings. The app
  account pays the minimum balance for those boxes.
- **Testnet** replaces Hardhat's local chain: same rules, real consensus, free
  test ALGO.

## Limitations to state plainly

- Vote choices and voter addresses are public in the transaction log — no secret
  ballot.
- One wallet, one vote ≠ one person, one vote: anyone can create more accounts.
- The admin is a single key with no multisig or timelock.
- Educational prototype; not audited, not for real elections.

## Resetting the demo

Redeploying creates a **new** app ID with fresh state; update `VOTING_APP_ID`
afterwards. To run the demo repeatedly on one app ID, deploy fresh rather than
trying to clear boxes — the contract has no reset path by design.

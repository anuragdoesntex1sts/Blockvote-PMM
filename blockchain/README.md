# BlockVote — Algorand contracts

Algorand TypeScript (PuyaTs) smart contracts for the BlockVote voting demo,
scaffolded with [VibeKit](https://getvibekit.ai). This replaces the earlier
Solidity + Hardhat contract.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 24
- [Docker](https://www.docker.com/) and [VibeKit](https://getvibekit.ai) — to run LocalNet
- VibeKit is already installed at `~/.vibekit/bin` (restart your terminal so `vibekit` is on PATH)

Compiling and unit testing need neither Docker nor VibeKit: PuyaTs and the client
generator are npm devDependencies.

## Getting started

```bash
npm install
npm run build   # compile Voting to TEAL + regenerate artifacts/VotingClient.ts
npm test        # unit tests (in-memory AVM, no network)
```

Deploying needs a network:

```bash
vibekit localnet start                   # Docker-based local Algorand
cp .env.localnet.example .env.localnet
npm run deploy
```

`npm run deploy` deploys, funds the app account with 2 ALGO (box storage is paid
from it), and calls `initialize` with the candidates from `CANDIDATES`
(default `Alice,Bob,Carol`):

```bash
CANDIDATES="Alice,Bob,Carol" npm run deploy
```

## The contract

`src/voting.algo.ts` — a port of the old `Voting.sol`:

| Solidity | Algorand TypeScript |
| --- | --- |
| `address public immutable admin` | `admin` global state, set to `Txn.sender` in the constructor |
| `bool electionStarted / electionEnded` | global state, initialized to `false` at create |
| `Candidate[] candidates` | box storage keyed by index (`BoxMap<uint64, Candidate>`) |
| `mapping(address => bool) registeredVoters/hasVoted` | one box per voter (`BoxMap<Account, VoterStatus>`) |
| `constructor(string[] names)` | `initialize(names)` right after deploy |
| `require(...)` | `assert(..., 'message')` |

Algorand has no dynamic state arrays or mappings, so candidate and voter records
live in boxes. Boxes need a minimum balance, which is why the app account is
funded at deploy time and `initialize` runs after the app exists.

Methods: `initialize`, `registerVoter`, `startElection`, `vote`, `endElection`,
`getCandidates`, `getVoterStatus`.

## Layout

- `src/voting.algo.ts` — the contract
- `src/voting.algo.spec.ts` — unit tests (no network)
- `artifacts/` — compiled TEAL, ARC-56 spec, generated typed client (committed)
- `deploy.ts`, `localnet.ts` — deploy script and KMD dispenser helper
- `index.ts` — re-exports the client and app spec

## Limitations

Same classroom caveats as before: addresses and votes are public on-chain,
one-wallet-one-vote is not one-person-one-vote, and this is not audited. The
frontend in `../frontend` targets Algorand Testnet and signs with Pera Wallet
through the typed client in `artifacts/VotingClient.ts`.

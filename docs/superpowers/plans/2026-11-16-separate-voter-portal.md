# Separate Voter Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a dedicated, standalone Voter Portal (`vote.html` / `VoterApp.jsx`) where voters can connect their registered Pera wallet, verify their eligibility in real time, cast their vote on Algorand Testnet, and view live results without admin controls or distractions.

**Architecture:** Multi-page Vite architecture adding `vote.html` and `src/vote.jsx` / `src/VoterApp.jsx`, registered in `vite.config.js`. Shared Algorand communication and Pera Wallet connector (`src/algorand.js`, `src/config.js`) are reused. Navigation headers link between the Voter Portal, Admin Dashboard, and Deploy page.

**Tech Stack:** React 18, Vite 5, Pera Wallet Connect (`@perawallet/connect`), Algorand JS SDK (`algosdk`), CSS3.

**Spec:** User request to separate the voter experience into a dedicated voter-facing page completely decoupled from the election admin page.

## Global Constraints
- Target Algorand Testnet (chain ID 416002).
- Pure client-side dApp: no secrets or private keys stored in the frontend.
- Do not modify smart contract bytecode or ARC-56 ABI specifications; utilize existing box storage patterns (`c` + candidate index, `v` + voter public key).
- Keep design sleek, modern, dark-themed, and responsive, matching BlockVote's aesthetic.

## Review Focus
1. **Unregistered wallet connecting**: UI must clearly display a warning that the wallet is not registered and disable vote buttons.
2. **Election not started yet**: UI must inform registered voters that voting has not commenced yet.
3. **Already voted voter**: UI must display confirmed voted status and prevent double-voting attempts.
4. **Election ended**: UI must seal voting and display official winner and final tallies.
5. **App ID synchronization / URL params**: Allow voters to load a specific contract via query param (e.g. `?appId=...`) or local storage so they automatically see the active election.

---

### Task 1: Vite Multi-Page Configuration & HTML Entrypoint

**Files:**
- Create: `BlockVote/frontend/vote.html`
- Create: `BlockVote/frontend/src/vote.jsx`
- Modify: `BlockVote/frontend/vite.config.js`

**Interfaces:**
- Produces: `vote.html` bundled by Vite with `vote` entry point pointing to `src/vote.jsx`.

- [x] **Step 1: Create `BlockVote/frontend/vote.html`**
Create HTML file with `#root` container loading `/src/vote.jsx` with page title "BlockVote — Voter Portal".

- [x] **Step 2: Create `BlockVote/frontend/src/vote.jsx`**
Mount `VoterApp` component into `#root` with `React.StrictMode` and import `./style.css`.

- [x] **Step 3: Update `BlockVote/frontend/vite.config.js`**
Add `vote: "vote.html"` to `build.rollupOptions.input`.

- [x] **Step 4: Verify build succeeds**
Run: `npm run build` in `BlockVote/frontend` to verify all 3 pages (`main`, `deploy`, `vote`) are bundled.

---

### Task 2: Build the Dedicated Voter Portal Component (`VoterApp.jsx`)

**Files:**
- Create: `BlockVote/frontend/src/VoterApp.jsx`

**Interfaces:**
- Consumes: `peraWallet`, `algod`, `signSendWait` from `./algorand.js`; `VOTING_APP_ID`, `EXPLORER_APP` from `./config.js`.
- Produces: Standalone React component handling wallet connection, eligibility checking, ballot display, vote casting, and live tallies.

- [x] **Step 1: Implement State & On-Chain Refresh Logic in `VoterApp.jsx`**
  - Implement contract reading for `appId`, `started`, `ended`, `admin`, `candidates`, `totalVotes`.
  - Implement voter box check (`0x76` + voter address public key) returning `{ registered: boolean, voted: boolean }`.
  - Handle URL query parameter `?appId=...` and fallback to `localStorage` / `VOTING_APP_ID`.

- [x] **Step 2: Implement Real-Time Voter Eligibility Badge & Flow**
  - Show 5 distinct states:
    1. Wallet not connected
    2. Connected & Not registered
    3. Connected & Registered (Waiting for election to start)
    4. Connected & Registered (Ready to vote)
    5. Already voted
    6. Election ended

- [x] **Step 3: Implement Candidate Ballot & Cast Vote Action**
  - Render candidate cards with candidate name, badge, and "Cast Vote" button.
  - Enable voting ONLY if `account && registered && started && !ended && !voted && !busy`.
  - Execute `vote(uint64)` ABI call with candidate box and voter box references, sign via Pera Wallet.
  - Provide clear transaction status feedback and refresh on-chain state on confirmation.

- [x] **Step 4: Implement Results & Live Tally Section**
  - Display progress bars and vote counts per candidate.
  - Display winner banner with celebratory styling when election is ended.

---

### Task 3: Navbar Navigation Across Pages & Admin Hub Clarification

**Files:**
- Modify: `BlockVote/frontend/src/App.jsx`
- Modify: `BlockVote/frontend/src/deploy.jsx`

**Interfaces:**
- Produces: Consistent, clear navigation linking between "Voter Portal" (`/vote.html`), "Admin Dashboard" (`/index.html`), and "Deploy Contract" (`/deploy.html`).

- [x] **Step 1: Add Navigation Bar to `VoterApp.jsx`**
Include links to `vote.html` (active), `index.html` (Admin Dashboard), and `deploy.html` (Deploy).

- [x] **Step 2: Add Navigation Bar and Voter Portal Link to `App.jsx`**
Make it clear that `index.html` is the **Admin & Election Hub**, with a prominent banner: "Looking to vote? Open the Voter Portal →".

- [x] **Step 3: Verify with Vite Production Build**
Run: `npm run build` in `BlockVote/frontend` and verify zero errors.

import React, { useCallback, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import algosdk from "algosdk";
import { peraWallet, algod, signSendWait } from "./algorand";
import { EXPLORER_APP } from "./config";
import spec from "../../blockchain/artifacts/Voting.arc56.json";
import "./style.css";

// Compiled TEAL bytecode from the ARC-56 spec, decoded once at import time.
const APPROVAL = Uint8Array.from(atob(spec.byteCode.approval), (c) => c.charCodeAt(0));
const CLEAR = Uint8Array.from(atob(spec.byteCode.clear), (c) => c.charCodeAt(0));
const GLOBAL_INTS = spec.state.schema.global.ints;
const GLOBAL_BYTES = spec.state.schema.global.bytes;

// Boxes (candidates + voters) live in the app account's balance.
// 2 ALGO covers roughly 40 voters worth of box storage.
const APP_FUNDING = 2_000_000n;

export default function Deploy() {
  const [account, setAccount] = useState("");
  const [names, setNames] = useState("Alice,Bob,Carol");
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);
  const [appId, setAppId] = useState("");

  const note = useCallback((message) => setLog((lines) => [...lines, message]), []);

  useEffect(() => {
    peraWallet
      .reconnectSession()
      .then((accounts) => {
        if (accounts.length > 0) setAccount(accounts[0]);
      })
      .catch(() => {});
  }, []);

  async function connect() {
    try {
      const accounts = await peraWallet.connect();
      setAccount(accounts[0]);
    } catch (e) {
      note(
        e?.data?.type === "CONNECT_MODAL_CLOSED"
          ? "Connection cancelled."
          : e?.message ?? "Could not connect."
      );
    }
  }

  async function deploy() {
    if (!account || busy) return;
    const candidates = names
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    if (candidates.length < 2) {
      setLog(["The contract needs at least two candidate names."]);
      return;
    }

    setBusy(true);
    setAppId("");
    setLog([`Deploying from ${account} on Testnet…`]);

    const step = async (label, run) => {
      try {
        return await run();
      } catch (e) {
        note(`✗ ${label} failed: ${e?.response?.body?.message ?? e?.message ?? String(e)}`);
        throw e;
      }
    };

    try {
      // ── Step 1: Create the application on-chain ──────────────────────
      const newAppId = await step("Creating the application", async () => {
        const sp = await algod.getTransactionParams().do();
        note("1/4 Creating the application — approve in Pera…");

        const txn = algosdk.makeApplicationCreateTxnFromObject({
          sender: account,
          approvalProgram: APPROVAL,
          clearProgram: CLEAR,
          numGlobalInts: GLOBAL_INTS,
          numGlobalByteSlices: GLOBAL_BYTES,
          numLocalInts: 0,
          numLocalByteSlices: 0,
          onComplete: algosdk.OnApplicationComplete.NoOpOC,
          suggestedParams: sp,
        });

        const result = await signSendWait(txn);
        const createdId = result.applicationIndex ?? result["application-index"];
        if (!createdId) throw new Error("No application index found in confirmation result");
        note(`Application created — ID ${createdId}`);
        return BigInt(createdId);
      });

      // Compute the application's escrow address for funding.
      const appAddr = algosdk.getApplicationAddress(newAppId);

      // ── Step 2: Fund the app account for box storage ─────────────────
      await step("Funding the app account", async () => {
        const sp = await algod.getTransactionParams().do();
        note(`2/4 Funding app account with ${Number(APP_FUNDING) / 1e6} ALGO — approve in Pera…`);

        const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          sender: account,
          receiver: appAddr.toString(),
          amount: APP_FUNDING,
          suggestedParams: sp,
        });

        await signSendWait(txn);
        note("App account funded for box storage.");
      });

      // ── Step 3: Call initialize(string[]) to register candidates ─────
      await step("Writing the candidates", async () => {
        const sp = await algod.getTransactionParams().do();
        note(`3/4 Initializing ballot (${candidates.join(", ")}) — approve in Pera…`);

        const selector = algosdk.ABIMethod.fromSignature("initialize(string[])void").getSelector();
        const encodedNames = algosdk.ABIType.from("string[]").encode(candidates);

        const txn = algosdk.makeApplicationCallTxnFromObject({
          sender: account,
          appIndex: Number(newAppId),
          onComplete: algosdk.OnApplicationComplete.NoOpOC,
          appArgs: [selector, encodedNames],
          boxes: candidates.map((_, i) => ({
            appIndex: 0,
            name: new Uint8Array([0x63, ...algosdk.encodeUint64(i)]),
          })),
          suggestedParams: sp,
        });

        await signSendWait(txn);
        note(`Initialized candidates: ${candidates.join(", ")}`);
      });

      // ── Step 4: Automatically register the deployer as first voter ───
      await step("Registering deployer as voter", async () => {
        const sp = await algod.getTransactionParams().do();
        note(`4/4 Auto-registering deployer (${account.slice(0, 6)}…) as voter — approve in Pera…`);

        const selector = algosdk.ABIMethod.fromSignature("registerVoter(address)void").getSelector();
        const voterPubKey = algosdk.decodeAddress(account).publicKey;

        const txn = algosdk.makeApplicationCallTxnFromObject({
          sender: account,
          appIndex: Number(newAppId),
          onComplete: algosdk.OnApplicationComplete.NoOpOC,
          appArgs: [selector, voterPubKey],
          boxes: [{
            appIndex: 0,
            name: new Uint8Array([0x76, ...voterPubKey]),
          }],
          suggestedParams: sp,
        });

        await signSendWait(txn);
        note(`Deployer automatically registered as voter!`);
      });

      const appIdStr = String(newAppId);
      setAppId(appIdStr);
      try {
        localStorage.setItem("blockvote_app_id", appIdStr);
      } catch {
        /* ignore localStorage quota/privacy exceptions */
      }
      note(`✓ All 4 steps confirmed on-chain!`);
      note(`Application #${appIdStr} is ready. Click "Go to Election Ballot" below.`);
    } catch {
      note("Deployment stopped. Earlier steps that were already confirmed stay on-chain.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wrap">
      <nav>
        <div className="logo"><span>A</span> BlockVote</div>
        <div className="nav-actions">
          <a href="/" className="outline" style={{ textDecoration: "none", padding: "8px 14px", borderRadius: "8px", color: "#c3b4ff", marginRight: "8px" }}>
            ← Back to Ballot
          </a>
          <span className="network-tag">TESTNET</span>
          {account ? (
            <span className="addr">
              {account.slice(0, 6)}…{account.slice(-4)}
            </span>
          ) : (
            <button className="outline" onClick={connect}>Connect Pera</button>
          )}
        </div>
      </nav>

      <header>
        <div className="tag">ONE-TIME DEPLOY</div>
        <h1>Deploy the contract.<br /><em>Sign with Pera.</em></h1>
        <p>
          Creates the Voting application on Testnet, funds it for box storage, registers
          the candidates, and auto-registers your admin wallet as a voter.
        </p>
      </header>

      <section className="panel admin">
        <div className="tag">STEP 1 — WALLET</div>
        <p>
          {account ? (
            <>
              Connected: <b>{account}</b>
            </>
          ) : (
            "Connect Pera Wallet on Testnet before deploying."
          )}
        </p>
        {!account && <button onClick={connect}>Connect Pera Wallet</button>}
      </section>

      <section className="panel admin">
        <div className="tag">STEP 2 — CANDIDATES</div>
        <h2>Ballot names</h2>
        <input
          value={names}
          onChange={(e) => setNames(e.target.value)}
          placeholder="Alice,Bob,Carol"
          disabled={busy}
        />
        <p>
          Comma separated, at least two. This is written to chain once and cannot be changed.
        </p>
        <button disabled={!account || busy} onClick={deploy}>
          {busy ? "Deploying (4 steps)…" : "Deploy to Testnet"}
        </button>
      </section>

      {appId && appId !== "0" && (
        <div className="notice" style={{ borderColor: "#795be5", background: "#1c183a" }}>
          <b style={{ fontSize: "16px", color: "#a58aff" }}>✓ Deployed — Application #{appId}</b>
          <p style={{ margin: "14px 0" }}>
            <a
              href="/"
              style={{
                display: "inline-block",
                padding: "12px 24px",
                background: "linear-gradient(110deg,#9275fa,#6046d0)",
                color: "white",
                borderRadius: "8px",
                textDecoration: "none",
                fontWeight: 700,
                fontSize: "14px",
              }}
            >
              Go to Election Ballot →
            </a>
          </p>
          <p>
            <a
              href={EXPLORER_APP(appId)}
              target="_blank"
              rel="noreferrer"
              style={{ color: "#c3b4ff" }}
            >
              View Application #{appId} on Pera Explorer ↗
            </a>
          </p>
          <p style={{ fontSize: "12px", color: "#8a8f9d" }}>
            Saved to browser storage. You can also update <code>src/config.js</code>:
            <br />
            <code>export const VOTING_APP_ID = {appId}n;</code>
          </p>
        </div>
      )}

      <div className="notice">
        <b>Progress</b>
        {log.length === 0 ? (
          <p>Click "Deploy to Testnet" to start the 4 on-chain deployment steps.</p>
        ) : log.map((line, i) => <p key={i}>{line}</p>)}
      </div>

      <footer>BLOCKVOTE · TESTNET DEPLOY TOOL</footer>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Deploy />
  </React.StrictMode>,
);

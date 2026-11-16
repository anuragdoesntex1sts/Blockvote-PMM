import { useCallback, useEffect, useMemo, useState } from "react";
import algosdk from "algosdk";
import {
  peraWallet,
  algod,
  signSendWait,
  getAppState,
  getCandidates,
  getVoterStatus,
} from "./algorand";
import { VOTING_APP_ID, EXPLORER_APP } from "./config";

function getActiveAppId() {
  try {
    // 1. Explicit query parameter takes highest priority (?appId=... or ?app=...)
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("appId") || params.get("app");
    if (fromUrl && /^\d+$/.test(fromUrl.trim()) && fromUrl.trim() !== "0") {
      return BigInt(fromUrl.trim());
    }

    // 2. Active browser session storage
    const fromSession = sessionStorage.getItem("blockvote_app_id");
    if (fromSession && /^\d+$/.test(fromSession.trim()) && fromSession.trim() !== "0") {
      return BigInt(fromSession.trim());
    }

    // 3. Persistent localStorage only if NOT marked as concluded
    const saved = localStorage.getItem("blockvote_app_id");
    if (saved && /^\d+$/.test(saved.trim()) && saved.trim() !== "0") {
      const isConcluded = localStorage.getItem(`blockvote_concluded_${saved.trim()}`) === "true";
      if (!isConcluded) {
        return BigInt(saved.trim());
      }
    }
  } catch {
    /* fallback to config */
  }
  return VOTING_APP_ID || 0n;
}

export default function App() {
  const [appId, setAppId] = useState(getActiveAppId);
  const [appInput, setAppInput] = useState(() => {
    const initId = getActiveAppId();
    return initId > 0n ? String(initId) : "";
  });
  const [lastConcludedId, setLastConcludedId] = useState(() => {
    try {
      return localStorage.getItem("blockvote_last_concluded_app_id") || "";
    } catch {
      return "";
    }
  });
  const [account, setAccount] = useState("");
  const [accountsList, setAccountsList] = useState([]);
  const [admin, setAdmin] = useState("");
  const [candidates, setCandidates] = useState([]);
  const [registered, setRegistered] = useState(false);
  const [voted, setVoted] = useState(false);
  const [started, setStarted] = useState(false);
  const [ended, setEnded] = useState(false);
  const [voter, setVoter] = useState("");
  const [status, setStatus] = useState("Loading election from Algorand Testnet…");
  const [busy, setBusy] = useState(false);

  const configured = appId > 0n;

  const isAdmin = useMemo(
    () => Boolean(account && admin && account.trim().toUpperCase() === admin.trim().toUpperCase()),
    [account, admin],
  );

  // ── Load on-chain state directly from algod ──────────────────────────
  const refresh = useCallback(
    async (targetAppId, userAddress, isExplicit = false) => {
      const numericId = Number(targetAppId);
      if (!numericId || numericId <= 0) {
        setAdmin("");
        setStarted(false);
        setEnded(false);
        setCandidates([]);
        setRegistered(false);
        setVoted(false);
        setStatus("No active election loaded. Deploy a new election or enter an App ID to begin.");
        return null;
      }

      try {
        // 1. Fetch global state
        const appState = await getAppState(numericId);
        if (!appState) {
          setStatus(`Application #${numericId} not found on Algorand Testnet.`);
          return null;
        }

        const hasExplicitUrl = Boolean(new URLSearchParams(window.location.search).get("appId"));
        const sessionActive = sessionStorage.getItem("blockvote_admin_session_active") === String(numericId);

        // If this election is already concluded
        if (appState.ended) {
          try {
            localStorage.setItem(`blockvote_concluded_${numericId}`, "true");
            localStorage.setItem("blockvote_last_concluded_app_id", String(numericId));
            localStorage.removeItem("blockvote_app_id");
            sessionStorage.removeItem("blockvote_app_id");
          } catch {
            /* ignore */
          }
          setLastConcludedId(String(numericId));

          // If opening a new session and this ended election was not explicitly requested by user:
          if (!isExplicit && !hasExplicitUrl && !sessionActive) {
            setAppId(0n);
            setAppInput("");
            setAdmin("");
            setStarted(false);
            setEnded(false);
            setCandidates([]);
            setRegistered(false);
            setVoted(false);
            setStatus(`Previous election #${numericId} has concluded. Started a fresh admin session.`);
            return null;
          }
        } else {
          // Election is active (open or not started)
          try {
            sessionStorage.setItem("blockvote_admin_session_active", String(numericId));
          } catch {
            /* ignore */
          }
        }

        setAdmin(appState.admin);
        setStarted(appState.started);
        setEnded(appState.ended);

        // 2. Fetch candidates
        if (appState.candidateCount > 0) {
          const list = await getCandidates(numericId, appState.candidateCount);
          setCandidates(list);
        } else {
          setCandidates([]);
        }

        // 3. Fetch voter eligibility for the connected address
        if (userAddress) {
          const vStatus = await getVoterStatus(numericId, userAddress);
          setRegistered(vStatus.registered);
          setVoted(vStatus.voted);
        } else {
          setRegistered(false);
          setVoted(false);
        }

        if (appState.ended) {
          setStatus(`Election #${numericId} has concluded. Final results displayed below.`);
        } else if (appState.started) {
          setStatus(`Election #${numericId} is OPEN on Testnet. Registered voters can cast votes.`);
        } else {
          setStatus(`Election #${numericId} is NOT STARTED yet. Admin can register voters and start.`);
        }
        return appState;
      } catch (err) {
        console.error("Failed to load on-chain state:", err);
        setStatus(`Error querying app #${numericId}: ${err?.message ?? String(err)}`);
        return null;
      }
    },
    [],
  );

  // Switch or reload active App ID
  const handleSwitchAppId = (newIdStr) => {
    const clean = (newIdStr || "").trim();
    if (!/^\d+$/.test(clean) || clean === "0") {
      setStatus("Please enter a valid numeric Algorand application ID.");
      return;
    }
    const newBigInt = BigInt(clean);
    setAppId(newBigInt);
    setAppInput(clean);
    try {
      localStorage.setItem("blockvote_app_id", clean);
      sessionStorage.setItem("blockvote_app_id", clean);
      sessionStorage.setItem("blockvote_admin_session_active", clean);
    } catch {
      /* ignore storage quota */
    }
    refresh(newBigInt, account, true);
  };

  // Start fresh admin session (clear any old election from active view)
  const handleStartNewSession = useCallback(() => {
    try {
      localStorage.removeItem("blockvote_app_id");
      sessionStorage.removeItem("blockvote_app_id");
      sessionStorage.removeItem("blockvote_admin_session_active");
    } catch {
      /* ignore */
    }
    setAppId(0n);
    setAppInput("");
    setAdmin("");
    setCandidates([]);
    setStarted(false);
    setEnded(false);
    setRegistered(false);
    setVoted(false);
    setStatus("Started a new admin session. Deploy a new election or enter an App ID to begin.");
  }, []);

  const attach = useCallback(
    async (address) => {
      setAccount(address);
      await refresh(appId, address);
    },
    [appId, refresh],
  );

  // Mount effect: load state immediately and restore Pera session
  useEffect(() => {
    let alive = true;
    (async () => {
      await refresh(appId, null);

      try {
        const accounts = await peraWallet.reconnectSession();
        if (alive && accounts.length > 0) {
          setAccountsList(accounts);
          await attach(accounts[0]);
        }
      } catch {
        /* no active session */
      }
    })();

    return () => {
      alive = false;
    };
  }, [appId, attach, refresh]);

  const connect = useCallback(async () => {
    setBusy(true);
    try {
      const accounts = await peraWallet.connect();
      setAccountsList(accounts);
      if (accounts && accounts.length > 0) {
        await attach(accounts[0]);
      }
    } catch (e) {
      if (e?.data?.type === "CONNECT_MODAL_CLOSED") {
        setStatus("Wallet connection cancelled in Pera.");
      } else {
        setStatus(e?.message ?? "Could not connect to Pera Wallet.");
      }
    } finally {
      setBusy(false);
    }
  }, [attach]);

  async function disconnect() {
    try {
      await peraWallet.disconnect();
    } catch {
      /* ignore */
    }
    try {
      Object.keys(localStorage).forEach((k) => {
        if (k.toLowerCase().includes("pera") || k.toLowerCase().includes("walletconnect")) {
          localStorage.removeItem(k);
        }
      });
    } catch {
      /* ignore */
    }
    setAccount("");
    setAccountsList([]);
    setRegistered(false);
    setVoted(false);
    setStatus("Wallet disconnected. Any registered voter can now connect their Pera wallet.");
    await refresh(appId, null);
  }

  async function switchWallet() {
    if (busy) return;
    setBusy(true);
    try {
      await peraWallet.disconnect();
    } catch {
      /* ignore */
    }
    try {
      Object.keys(localStorage).forEach((k) => {
        if (k.toLowerCase().includes("pera") || k.toLowerCase().includes("walletconnect")) {
          localStorage.removeItem(k);
        }
      });
    } catch {
      /* ignore */
    }
    setAccount("");
    setAccountsList([]);
    setRegistered(false);
    setVoted(false);
    setStatus("Connecting new wallet… Select your voter account in Pera.");
    await connect();
  }

  // ── On-chain Contract Actions ────────────────────────────────────────

  async function handleStartElection() {
    if (!account || busy) return;
    setBusy(true);
    try {
      setStatus("Starting election — approve transaction in Pera Wallet…");
      const sp = await algod.getTransactionParams().do();
      const selector = algosdk.ABIMethod.fromSignature("startElection()void").getSelector();
      const txn = algosdk.makeApplicationCallTxnFromObject({
        sender: account,
        appIndex: Number(appId),
        onComplete: algosdk.OnApplicationComplete.NoOpOC,
        appArgs: [selector],
        suggestedParams: sp,
      });

      await signSendWait(txn);
      setStatus("✓ Election started successfully! Registered voters can now cast ballots.");
      await refresh(appId, account);
    } catch (e) {
      console.error("Start election failed:", e);
      const msg = e?.response?.body?.message ?? e?.message ?? String(e);
      setStatus(`Start election failed: ${msg.includes("Cannot start") ? "Election is already started or concluded." : msg}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleEndElection() {
    if (!account || busy) return;
    setBusy(true);
    try {
      setStatus("Closing election — approve transaction in Pera Wallet…");
      const sp = await algod.getTransactionParams().do();
      const selector = algosdk.ABIMethod.fromSignature("endElection()void").getSelector();
      const txn = algosdk.makeApplicationCallTxnFromObject({
        sender: account,
        appIndex: Number(appId),
        onComplete: algosdk.OnApplicationComplete.NoOpOC,
        appArgs: [selector],
        suggestedParams: sp,
      });

      await signSendWait(txn);
      setStatus("✓ Election closed successfully. Voting is now sealed permanently.");
      try {
        localStorage.setItem(`blockvote_concluded_${appId}`, "true");
        localStorage.setItem("blockvote_last_concluded_app_id", appId.toString());
        localStorage.removeItem("blockvote_app_id");
        sessionStorage.removeItem("blockvote_app_id");
      } catch {
        /* ignore */
      }
      setLastConcludedId(appId.toString());
      await refresh(appId, account, true);
    } catch (e) {
      console.error("End election failed:", e);
      const msg = e?.response?.body?.message ?? e?.message ?? String(e);
      setStatus(`End election failed: ${msg.includes("Cannot end") ? "Election is not open." : msg}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleRegisterVoter(targetAddress) {
    const addr = (targetAddress || voter).trim();
    if (!account || busy) return;
    if (!addr || !algosdk.isValidAddress(addr)) {
      setStatus("Please enter a valid 58-character Algorand wallet address.");
      return;
    }
    setBusy(true);
    try {
      setStatus(`Registering voter ${addr.slice(0, 6)}… — approve in Pera Wallet…`);
      const sp = await algod.getTransactionParams().do();
      const selector = algosdk.ABIMethod.fromSignature("registerVoter(address)void").getSelector();
      const voterPubKey = algosdk.decodeAddress(addr).publicKey;
      const txn = algosdk.makeApplicationCallTxnFromObject({
        sender: account,
        appIndex: Number(appId),
        onComplete: algosdk.OnApplicationComplete.NoOpOC,
        appArgs: [selector, voterPubKey],
        boxes: [{
          appIndex: 0,
          name: new Uint8Array([0x76, ...voterPubKey]),
        }],
        suggestedParams: sp,
      });

      await signSendWait(txn);
      setStatus(`✓ Voter ${addr.slice(0, 6)}… successfully registered on-chain!`);
      setVoter("");
      await refresh(appId, account);
    } catch (e) {
      console.error("Register voter failed:", e);
      const msg = e?.response?.body?.message ?? e?.message ?? String(e);
      setStatus(`Register voter failed: ${msg.includes("Already registered") ? "Address is already registered." : msg.includes("Election already started") ? "Cannot register new voters after election has started." : msg}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleVote(candidateId) {
    if (!account) {
      await connect();
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const candidateName = candidates.find((c) => c.id === candidateId)?.name || `#${candidateId + 1}`;
      setStatus(`Casting your vote for "${candidateName}" — approve in your Pera Wallet…`);
      const sp = await algod.getTransactionParams().do();
      const selector = algosdk.ABIMethod.fromSignature("vote(uint64)void").getSelector();
      const voterPubKey = algosdk.decodeAddress(account).publicKey;
      const txn = algosdk.makeApplicationCallTxnFromObject({
        sender: account,
        appIndex: Number(appId),
        onComplete: algosdk.OnApplicationComplete.NoOpOC,
        appArgs: [selector, algosdk.encodeUint64(candidateId)],
        boxes: [
          { appIndex: 0, name: new Uint8Array([0x63, ...algosdk.encodeUint64(candidateId)]) },
          { appIndex: 0, name: new Uint8Array([0x76, ...voterPubKey]) },
        ],
        suggestedParams: sp,
      });

      await signSendWait(txn);
      setStatus(`✓ Vote cast for "${candidateName}" confirmed on Algorand Testnet!`);
      await refresh(appId, account);
    } catch (e) {
      console.error("Vote failed:", e);
      const msg = e?.response?.body?.message ?? e?.message ?? String(e);
      if (msg.includes("fee") || msg.includes("overspend")) {
        setStatus("Vote failed: Voter wallet has insufficient Testnet ALGO for the 0.001 ALGO network fee. Please get free Testnet ALGO from bank.testnet.algorand.network.");
      } else if (msg.includes("Wallet not registered")) {
        setStatus("Vote failed: Your wallet address is not registered for this election.");
      } else if (msg.includes("Already voted")) {
        setStatus("Vote failed: You have already cast your vote in this election.");
      } else if (msg.includes("Election not open")) {
        setStatus("Vote failed: The election is not currently open for voting.");
      } else {
        setStatus(`Vote failed: ${msg}`);
      }
    } finally {
      setBusy(false);
    }
  }

  const total = candidates.reduce((sum, c) => sum + c.votes, 0);
  const maxVotes = Math.max(...candidates.map((x) => x.votes), 0);
  const winner = ended && total > 0 ? candidates.find((c) => c.votes === maxVotes) : null;
  const short = (addr) => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "");

  return (
    <div className="wrap">
      <nav>
        <div className="logo" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span>A</span> BlockVote
          <span style={{ fontSize: "10px", padding: "2px 6px", borderRadius: "4px", background: "#ffffff15", color: "#a5a8b9", fontWeight: 600 }}>
            ADMIN & ELECTION HUB
          </span>
        </div>
        <div className="nav-actions">
          <a
            href="/vote.html"
            className="outline"
            style={{ textDecoration: "none", padding: "7px 13px", borderRadius: "8px", color: "#79f2c3", borderColor: "#79f2c350", marginRight: "6px", fontWeight: 700 }}
          >
            🗳️ Voter Portal →
          </a>
          <a
            href="/deploy.html"
            className="outline"
            style={{ textDecoration: "none", padding: "7px 13px", borderRadius: "8px", color: "#c3b4ff", marginRight: "6px" }}
          >
            + Deploy New Election
          </a>
          <span className="network-tag">TESTNET</span>
          {account ? (
            <>
              {accountsList.length > 1 ? (
                <select
                  value={account}
                  onChange={(e) => attach(e.target.value)}
                  style={{
                    background: "#0e1424",
                    border: "1px solid #795be5",
                    color: "#f5f4fb",
                    padding: "6px 10px",
                    borderRadius: "8px",
                    fontSize: "12px",
                    fontFamily: "DM Mono",
                    marginRight: "6px",
                  }}
                  title="Switch between your connected Pera accounts"
                >
                  {accountsList.map((addr) => {
                    const isAccountAdmin = addr.trim().toUpperCase() === admin.trim().toUpperCase();
                    return (
                      <option key={addr} value={addr}>
                        {short(addr)} {isAccountAdmin ? "(Admin)" : "(Voter)"}
                      </option>
                    );
                  })}
                </select>
              ) : (
                <span className="addr">{short(account)}</span>
              )}
              <button className="outline" onClick={switchWallet} disabled={busy} title="Switch to another Pera Wallet account">
                Switch
              </button>
              <button className="outline" onClick={disconnect} disabled={busy} title="Disconnect Pera session">
                Disconnect
              </button>
            </>
          ) : (
            <button className="outline" onClick={connect} disabled={busy}>Connect Pera</button>
          )}
        </div>
      </nav>

      <header>
        <div className="tag">ALGORAND TESTNET VOTING DEMONSTRATION</div>
        <h1>Every vote.<br /><em>On the chain.</em></h1>
        <p>A decentralized voting prototype powered by an Algorand TypeScript smart contract.</p>
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginTop: "15px" }}>
          <button onClick={account ? disconnect : connect} disabled={busy}>
            {account ? `Connected: ${short(account)} ↗` : "Connect Pera Wallet ↗"}
          </button>
          <a
            href="/deploy.html"
            style={{
              display: "inline-grid",
              placeItems: "center",
              padding: "12px 17px",
              background: "#ffffff0a",
              border: "1px solid #ffffff30",
              borderRadius: "9px",
              color: "white",
              textDecoration: "none",
              fontWeight: 700,
            }}
          >
            Deploy New Election
          </a>
        </div>
      </header>

      {/* ── Voter Portal Quick Navigation Banner ── */}
      <div
        className="notice"
        style={{
          borderColor: "#795be5",
          background: "linear-gradient(135deg, #1c183a, #14172c)",
          marginBottom: "20px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "12px",
          padding: "16px 20px",
        }}
      >
        <div>
          <b style={{ color: "#c4b6ff", fontSize: "14px" }}>🗳️ Looking for the Dedicated Voter Portal?</b>
          <p style={{ margin: "4px 0 0 0", color: "#a5a8b9", fontSize: "13px" }}>
            Voters can connect their registered Pera Wallet and cast ballots cleanly on the dedicated Voter Portal.
          </p>
        </div>
        <a
          href="/vote.html"
          style={{
            padding: "9px 18px",
            background: "linear-gradient(110deg,#795be5,#6046d0)",
            color: "white",
            borderRadius: "8px",
            textDecoration: "none",
            fontWeight: 700,
            fontSize: "13px",
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
          }}
        >
          Open Voter Portal →
        </a>
      </div>

      {/* ── App ID Bar ── */}
      <section className="panel" style={{ padding: "14px 20px", marginBottom: "20px", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <span style={{ fontSize: "12px", fontFamily: "DM Mono", color: "#9398ad" }}>ACTIVE CONTRACT:</span>
          <b style={{ color: configured ? "#c3b4ff" : "#94a3b8", fontFamily: "DM Mono" }}>
            {configured ? `#${appId.toString()}` : "None (Fresh Session)"}
          </b>
          {configured && (
            <a href={EXPLORER_APP(appId.toString())} target="_blank" rel="noreferrer" style={{ fontSize: "12px", color: "#a99bf0" }}>
              Explorer ↗
            </a>
          )}
          {lastConcludedId && !configured && (
            <span style={{ fontSize: "11px", color: "#8a8f9d", fontFamily: "DM Mono" }}>
              Last Concluded: #{lastConcludedId} (
              <button
                type="button"
                onClick={() => handleSwitchAppId(lastConcludedId)}
                style={{ background: "none", border: "none", color: "#a78bfa", cursor: "pointer", padding: 0, textDecoration: "underline", fontSize: "11px" }}
              >
                Review Archive
              </button>
              )
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={appInput}
            onChange={(e) => setAppInput(e.target.value)}
            placeholder="Enter App ID"
            style={{ padding: "6px 10px", background: "#0e1424", border: "1px solid #ffffff2b", borderRadius: "6px", color: "white", width: "130px", fontSize: "12px" }}
          />
          <button
            className="outline"
            style={{ padding: "6px 12px", fontSize: "12px" }}
            onClick={() => handleSwitchAppId(appInput)}
            disabled={busy || !appInput.trim()}
          >
            Load App
          </button>
          {configured && (
            <button
              className="outline"
              style={{ padding: "6px 12px", fontSize: "12px", borderColor: "rgba(255,255,255,0.15)" }}
              onClick={handleStartNewSession}
              disabled={busy}
              title="Clear active election and start a fresh session"
            >
              New Session
            </button>
          )}
        </div>
      </section>

      {/* ── Election Ended Alert ── */}
      {ended && (
        <div className="notice" style={{ borderColor: "#a99bf0", background: "#1c183a", marginBottom: "25px", padding: "18px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
            <b style={{ fontSize: "15px", color: "#c4b6ff" }}>Election Concluded</b>
            <span style={{ fontSize: "12px", color: "#a5a8b9", fontFamily: "DM Mono" }}>Contract #{appId.toString()}</span>
          </div>
          <p style={{ marginTop: "6px", color: "#d6d0ff" }}>
            This election has permanently closed. Total votes cast: <b>{total}</b>.
            {winner && (
              <span> Winning candidate: <strong style={{ color: "#79f2c3" }}>{winner.name}</strong> with {winner.votes} vote{winner.votes === 1 ? "" : "s"}.</span>
            )}
          </p>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginTop: "14px", alignItems: "center" }}>
            <a
              href="/deploy.html"
              style={{
                display: "inline-block",
                padding: "8px 16px",
                background: "linear-gradient(110deg,#9275fa,#6046d0)",
                color: "white",
                borderRadius: "6px",
                textDecoration: "none",
                fontWeight: 700,
                fontSize: "13px",
              }}
            >
              Deploy a fresh election to test voting →
            </a>
            <button
              className="outline"
              onClick={handleStartNewSession}
              style={{ fontSize: "13px", padding: "8px 16px" }}
            >
              Start Fresh Admin Session (Clear Screen)
            </button>
          </div>
        </div>
      )}

      {/* ── Stats ── */}
      <section className="stats">
        <div><small>TOTAL VOTES</small><b>{configured ? total : "—"}</b></div>
        <div><small>CANDIDATES</small><b>{configured ? candidates.length || "—" : "—"}</b></div>
        <div>
          <small>ELECTION STATUS</small>
          <b className="smallb" style={{ color: !configured ? "#94a3b8" : ended ? "#e06c75" : started ? "#79f2c3" : "#e5c07b" }}>
            {!configured ? "No Active Election" : ended ? "Ended (Closed)" : started ? "Open (Live)" : "Not started"}
          </b>
        </div>
      </section>

      {/* ── Candidate Standings ── */}
      <div className="heading"><div className="tag">ELECTION CANDIDATES</div><h2>Candidate Standings</h2></div>

      <section className="cards">
        {!configured ? (
          <div className="panel" style={{ gridColumn: "1 / -1", textAlign: "center", padding: "40px" }}>
            <p style={{ fontSize: "15px", marginBottom: "10px", color: "#cbd5e1" }}>
              No active election contract loaded in this session.
            </p>
            <p style={{ fontSize: "13px", color: "#94a3b8", marginBottom: "20px", maxWidth: "520px", margin: "0 auto 20px", lineHeight: "1.6" }}>
              Ready for a fresh election! Deploy a new contract to Algorand Testnet to set up candidates and start voting, or enter an App ID above to inspect an active election.
            </p>
            <a
              href="/deploy.html"
              style={{
                display: "inline-block",
                padding: "10px 20px",
                background: "linear-gradient(110deg,#9275fa,#6046d0)",
                color: "white",
                borderRadius: "8px",
                textDecoration: "none",
                fontWeight: 700,
              }}
            >
              + Deploy New Election Contract →
            </a>
          </div>
        ) : candidates.length === 0 ? (
          <div className="panel" style={{ gridColumn: "1 / -1", textAlign: "center", padding: "40px" }}>
            <p style={{ fontSize: "15px", marginBottom: "15px" }}>No candidate boxes found on Contract #{appId.toString()}.</p>
            <a
              href="/deploy.html"
              style={{
                display: "inline-block",
                padding: "10px 20px",
                background: "linear-gradient(110deg,#9275fa,#6046d0)",
                color: "white",
                borderRadius: "8px",
                textDecoration: "none",
                fontWeight: 700,
              }}
            >
              Deploy New Contract with Candidates →
            </a>
          </div>
        ) : (
          candidates.map((c, i) => {
            const pct = total > 0 ? ((c.votes / total) * 100).toFixed(1) : "0.0";
            return (
              <article className="panel candidate" key={c.id}>
                <div className="avatar">{c.name[0]}</div>
                <small>CANDIDATE 0{i + 1}</small>
                <h3>{c.name}</h3>
                <b>{c.votes} <small>vote{c.votes === 1 ? "" : "s"}</small></b>
                <div style={{ marginTop: "12px", width: "100%", background: "rgba(255,255,255,0.08)", borderRadius: "999px", height: "6px", overflow: "hidden" }}>
                  <div style={{ width: `${pct}%`, height: "100%", background: "linear-gradient(90deg, #7c5dfa, #a78bfa)", borderRadius: "999px" }} />
                </div>
                <span style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "6px", fontFamily: "DM Mono" }}>
                  {pct}% of total votes
                </span>
              </article>
            );
          })
        )}
      </section>

      {/* ── Lower Panels ── */}
      <section className="lower">
        <div className="panel">
          <div className="tag">LIVE TALLY</div>
          <h2>Election results</h2>
          {!configured ? (
            <p style={{ color: "#8a8f9d" }}>No active election loaded in this session.</p>
          ) : candidates.length === 0 ? (
            <p style={{ color: "#8a8f9d" }}>No candidate data available.</p>
          ) : (
            candidates.map((c) => (
              <div className="result" key={c.id}>
                <span>{c.name}</span>
                <b>{c.votes}</b>
                <div><i style={{ width: `${total ? (c.votes / Math.max(...candidates.map((x) => x.votes), 1)) * 100 : 0}%` }} /></div>
              </div>
            ))
          )}
          {configured && ended && (
            <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: "1px solid #795be5" }}>
              <b style={{ color: "#79f2c3" }}>🏆 Winner: {winner ? winner.name : "No votes cast"}</b>
              {winner && (
                <p style={{ margin: "8px 0" }}>Winning votes: <strong>{winner.votes}</strong> out of {total} total votes</p>
              )}
            </div>
          )}
        </div>

        <div className="panel">
          <div className="tag">YOUR WALLET</div>
          <h2>Eligibility</h2>
          <p>
            Connected wallet:{" "}
            <b>
              {account
                ? `${short(account)} ${isAdmin ? "(Admin)" : "(Voter)"}`
                : "No"}
            </b>
          </p>
          <p>
            Registered to vote:{" "}
            <b>
              {!configured ? "—" : account ? (registered ? "Yes ✓" : "No (Register below)") : "Connect wallet"}
            </b>
          </p>
          <p>
            Has voted:{" "}
            <b>
              {!configured ? "—" : account ? (voted ? "Yes ✓" : "No") : "Connect wallet"}
            </b>
          </p>
          <p>Election Admin: <b>{configured && admin ? (isAdmin ? `${short(admin)} (You)` : short(admin)) : "—"}</b></p>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "12px" }}>
            <button className="outline" disabled={busy} onClick={() => refresh(appId, account)}>
              Refresh on-chain state
            </button>
            {account && (
              <button className="outline" disabled={busy} onClick={switchWallet}>
                Switch account
              </button>
            )}
          </div>
        </div>
      </section>

      {/* ── Administration Controls ── */}
      {isAdmin && (
        <section className="panel admin">
          <div className="tag">ADMINISTRATION (YOUR CONNECTED WALLET IS ADMIN)</div>
          <h2>Election controls</h2>
          <p style={{ fontSize: "13px", color: "#a5a8b9", marginBottom: "15px" }}>
            {ended
              ? "This election is permanently ended on Testnet. Start a new election using 'Deploy New Election' above."
              : started
                ? "Election is OPEN! Registered voters can vote above. Voter registration is closed while the election is active."
                : "Step 1: Register eligible voters below before starting. Step 2: Click 'Start election' to open voting."}
          </p>

          {!ended && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", marginBottom: "16px" }}>
              <input
                value={voter}
                onChange={(e) => setVoter(e.target.value)}
                placeholder="Voter wallet address (58-character Algorand address)"
                disabled={started || ended || busy}
                style={{ flexGrow: 1, minWidth: "260px" }}
              />
              <button
                className="outline"
                disabled={started || ended || busy || !algosdk.isValidAddress(voter.trim())}
                onClick={() => handleRegisterVoter(voter.trim())}
                title={started ? "Cannot register once election has started" : "Register the entered wallet address"}
              >
                Register voter
              </button>
              {!registered && !started && (
                <button
                  className="outline"
                  disabled={busy}
                  onClick={() => handleRegisterVoter(account)}
                  title="Click to register your own connected admin wallet as an eligible voter"
                  style={{ borderColor: "#9275fa", color: "#c3b4ff" }}
                >
                  Register my wallet
                </button>
              )}
            </div>
          )}

          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button
              disabled={started || ended || busy}
              onClick={handleStartElection}
              title={started ? "Election already started" : ended ? "Election already concluded" : "Opens the election for registered voters"}
            >
              {started ? "Election started ✓" : "Start election"}
            </button>
            <button
              className="danger"
              disabled={!started || ended || busy}
              onClick={handleEndElection}
              title={!started ? "Election must be started first" : ended ? "Election already closed" : "Permanently seals and ends the election"}
            >
              {ended ? "Election closed" : "End election"}
            </button>
          </div>
        </section>
      )}

      {/* ── Transaction Status Bar ── */}
      <div className="notice">
        <b>Transaction & Network Status</b>
        <p>{status}</p>
      </div>

      <footer>BLOCKVOTE · EDUCATIONAL PROTOTYPE · ALGORAND TESTNET</footer>
    </div>
  );
}

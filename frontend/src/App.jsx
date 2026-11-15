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
    const saved = localStorage.getItem("blockvote_app_id");
    if (saved && /^\d+$/.test(saved.trim())) {
      return BigInt(saved.trim());
    }
  } catch {
    /* fallback to config */
  }
  return VOTING_APP_ID;
}

export default function App() {
  const [appId, setAppId] = useState(getActiveAppId);
  const [appInput, setAppInput] = useState(String(getActiveAppId()));
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
    async (targetAppId, userAddress) => {
      const numericId = Number(targetAppId);
      if (!numericId || numericId <= 0) {
        setStatus("No application ID configured. Deploy to Testnet to get started.");
        return;
      }

      try {
        // 1. Fetch global state
        const appState = await getAppState(numericId);
        if (!appState) {
          setStatus(`Application #${numericId} not found on Algorand Testnet.`);
          return;
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
      } catch (err) {
        console.error("Failed to load on-chain state:", err);
        setStatus(`Error querying app #${numericId}: ${err?.message ?? String(err)}`);
      }
    },
    [],
  );

  // Switch or reload active App ID
  const handleSwitchAppId = (newIdStr) => {
    const clean = newIdStr.trim();
    if (!/^\d+$/.test(clean) || clean === "0") {
      setStatus("Please enter a valid numeric Algorand application ID.");
      return;
    }
    const newBigInt = BigInt(clean);
    setAppId(newBigInt);
    try {
      localStorage.setItem("blockvote_app_id", clean);
    } catch {
      /* ignore storage quota */
    }
    refresh(newBigInt, account);
  };

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
      await refresh(appId, account);
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
        <div className="logo"><span>A</span> BlockVote</div>
        <div className="nav-actions">
          <a
            href="/deploy.html"
            className="outline"
            style={{ textDecoration: "none", padding: "8px 14px", borderRadius: "8px", color: "#c3b4ff", marginRight: "8px" }}
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

      {/* ── App ID Bar ── */}
      <section className="panel" style={{ padding: "14px 20px", marginBottom: "20px", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <span style={{ fontSize: "12px", fontFamily: "DM Mono", color: "#9398ad" }}>ACTIVE CONTRACT:</span>
          <b style={{ color: "#c3b4ff", fontFamily: "DM Mono" }}>#{appId.toString()}</b>
          {configured && (
            <a href={EXPLORER_APP(appId.toString())} target="_blank" rel="noreferrer" style={{ fontSize: "12px", color: "#a99bf0" }}>
              Explorer ↗
            </a>
          )}
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <input
            value={appInput}
            onChange={(e) => setAppInput(e.target.value)}
            placeholder="App ID"
            style={{ padding: "6px 10px", background: "#0e1424", border: "1px solid #ffffff2b", borderRadius: "6px", color: "white", width: "130px", fontSize: "12px" }}
          />
          <button
            className="outline"
            style={{ padding: "6px 12px", fontSize: "12px" }}
            onClick={() => handleSwitchAppId(appInput)}
            disabled={busy}
          >
            Load App
          </button>
        </div>
      </section>

      {/* ── Election Ended Alert ── */}
      {ended && (
        <div className="notice" style={{ borderColor: "#a99bf0", background: "#1c183a", marginBottom: "25px", padding: "18px" }}>
          <b style={{ fontSize: "15px", color: "#c4b6ff" }}>Election Concluded</b>
          <p style={{ marginTop: "6px", color: "#d6d0ff" }}>
            This election has permanently closed. Total votes cast: <b>{total}</b>.
            {winner && (
              <span> Winning candidate: <strong style={{ color: "#79f2c3" }}>{winner.name}</strong> with {winner.votes} vote{winner.votes === 1 ? "" : "s"}.</span>
            )}
          </p>
          <p style={{ marginTop: "12px" }}>
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
          </p>
        </div>
      )}

      {/* ── Stats ── */}
      <section className="stats">
        <div><small>TOTAL VOTES</small><b>{total}</b></div>
        <div><small>CANDIDATES</small><b>{candidates.length || "—"}</b></div>
        <div>
          <small>ELECTION STATUS</small>
          <b className="smallb" style={{ color: ended ? "#e06c75" : started ? "#79f2c3" : "#e5c07b" }}>
            {ended ? "Ended (Closed)" : started ? "Open (Live)" : "Not started"}
          </b>
        </div>
      </section>

      {/* ── Ballot ── */}
      <div className="heading"><div className="tag">THE BALLOT</div><h2>Choose your candidate</h2></div>

      <section className="cards">
        {candidates.length === 0 ? (
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
            const canVote = Boolean(account && started && !ended && registered && !voted && !busy);
            return (
              <article className="panel candidate" key={c.id}>
                <div className="avatar">{c.name[0]}</div>
                <small>CANDIDATE 0{i + 1}</small>
                <h3>{c.name}</h3>
                <b>{c.votes} <small>vote{c.votes === 1 ? "" : "s"}</small></b>
                <button
                  disabled={!canVote}
                  onClick={() => handleVote(c.id)}
                  style={canVote ? { cursor: "pointer" } : undefined}
                >
                  {!account
                    ? "Connect wallet to vote"
                    : ended
                    ? "Election closed"
                    : !started
                    ? "Election not started"
                    : voted
                    ? "Already voted ✓"
                    : !registered
                    ? (isAdmin ? "Register wallet below" : "Registration required")
                    : "Cast vote"}
                </button>
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
          {candidates.length === 0 ? (
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
              {account ? (registered ? "Yes ✓" : "No (Register below)") : "Connect wallet"}
            </b>
          </p>
          <p>
            Has voted:{" "}
            <b>
              {account ? (voted ? "Yes ✓" : "No") : "Connect wallet"}
            </b>
          </p>
          <p>Election Admin: <b>{admin ? (isAdmin ? `${short(admin)} (You)` : short(admin)) : "—"}</b></p>
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

      {/* ── Voter Instructions Card (Visible to everyone) ── */}
      {!isAdmin && account && (
        <section className="notice" style={{ marginTop: "20px" }}>
          <b>Voter Mode Active</b>
          <p style={{ marginTop: "4px" }}>
            {registered
              ? voted
                ? "You have cast your vote in this election. Thank you for participating!"
                : started
                ? "You are registered! Select your preferred candidate above and click 'Cast vote'."
                : "You are registered! Please wait for the admin to open the election."
              : "This wallet is not yet registered for this election. Please provide your address to the election admin to be added."}
          </p>
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

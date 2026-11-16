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
import { VOTING_APP_ID } from "./config";

function getActiveAppId() {
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("appId") || params.get("app");
    if (fromUrl && /^\d+$/.test(fromUrl.trim())) {
      return BigInt(fromUrl.trim());
    }
    const saved = localStorage.getItem("blockvote_app_id");
    if (saved && /^\d+$/.test(saved.trim())) {
      return BigInt(saved.trim());
    }
  } catch {
    /* fallback to config */
  }
  return VOTING_APP_ID;
}

function short(addr = "") {
  return addr.length > 10 ? `${addr.slice(0, 5)}…${addr.slice(-4)}` : addr;
}

export default function VoterApp() {
  const [appId, setAppId] = useState(getActiveAppId);
  const [account, setAccount] = useState("");
  const [accountsList, setAccountsList] = useState([]);
  const [admin, setAdmin] = useState("");
  const [candidates, setCandidates] = useState([]);
  const [registered, setRegistered] = useState(false);
  const [voted, setVoted] = useState(false);
  const [started, setStarted] = useState(false);
  const [ended, setEnded] = useState(false);
  const [status, setStatus] = useState("Connecting to Algorand Testnet…");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [blockedInfo, setBlockedInfo] = useState(null);

  const configured = appId > 0n;

  // Filter accounts list to only include non-admin addresses
  const voterEligibleAccounts = useMemo(() => {
    return accountsList.filter(
      (addr) => !admin || addr.trim().toUpperCase() !== admin.trim().toUpperCase()
    );
  }, [accountsList, admin]);

  const canVote = Boolean(account && started && !ended && registered && !voted && !busy);

  // ── Load on-chain state directly from algod ──────────────────────────
  const refresh = useCallback(
    async (targetAppId) => {
      const numericId = Number(targetAppId);
      if (!numericId || numericId <= 0) {
        setStatus("No valid application ID provided. Check your election link.");
        return null;
      }

      try {
        const appState = await getAppState(numericId);
        if (!appState) {
          setStatus(`Election Contract #${numericId} was not found on Algorand Testnet.`);
          return null;
        }

        setAdmin(appState.admin);
        setStarted(appState.started);
        setEnded(appState.ended);

        // Fetch candidates (names only for voting ballot, vote counts are not displayed to voters)
        if (appState.candidateCount > 0) {
          const list = await getCandidates(numericId, appState.candidateCount);
          setCandidates(list);
        } else {
          setCandidates([]);
        }

        if (appState.ended) {
          setStatus(`Election #${numericId} has concluded. Voting is permanently closed.`);
        } else if (appState.started) {
          setStatus(`Election #${numericId} is OPEN. Connect your registered voter wallet to cast a ballot.`);
        } else {
          setStatus(`Election #${numericId} has not opened for voting yet.`);
        }

        return appState;
      } catch (err) {
        console.error("Failed to load on-chain state:", err);
        setStatus(`Error reading contract #${numericId}: ${err?.message ?? String(err)}`);
        return null;
      }
    },
    [],
  );

  // ── Validate wallet: Must NOT be admin, and MUST be registered on-chain ──
  const validateAndAttach = useCallback(
    async (address, overrideAdmin = null, isEnded = false) => {
      const numericId = Number(appId);
      if (!numericId || numericId <= 0 || !address) {
        setAccount("");
        setRegistered(false);
        setVoted(false);
        setBlockedInfo(null);
        if (!numericId || numericId <= 0) {
          setStatus("⚠️ No active election contract loaded. Open the link with ?appId=<id> provided by the election admin.");
        }
        return false;
      }

      // If election has ended, strictly refuse all connections
      if (isEnded || ended) {
        setAccount("");
        setRegistered(false);
        setVoted(false);
        setStatus("Election concluded: Voting has ended. Wallet connection is disabled.");
        return false;
      }

      const effectiveAdmin = overrideAdmin ?? admin;

      // 1. Check if it's the admin wallet -> REJECT
      const isAdmin = Boolean(
        effectiveAdmin &&
        address &&
        address.trim().toUpperCase() === effectiveAdmin.trim().toUpperCase()
      );

      if (isAdmin) {
        setAccount("");
        setRegistered(false);
        setVoted(false);
        setBlockedInfo({
          type: "admin",
          address,
          message: `The admin wallet (${short(address)}) cannot connect to the Voter Portal. Please switch to an authorized voter account.`,
        });
        setStatus(`🚫 Admin Wallet Blocked: ${short(address)} cannot connect to the voter portal. Switch to a voter wallet in Pera.`);
        return false;
      }

      // 2. Check if registered on-chain via admin registration -> REJECT IF NOT
      const vStatus = await getVoterStatus(numericId, address);
      if (!vStatus.registered) {
        setAccount("");
        setRegistered(false);
        setVoted(false);
        setBlockedInfo({
          type: "unregistered",
          address,
          message: `Wallet ${short(address)} is not registered as an eligible voter on the Admin page.`,
        });
        setStatus(`⚠️ Unregistered Wallet: ${short(address)} is not registered. Register this address on the Admin page first.`);
        return false;
      }

      // 3. Registered voter accepted!
      setBlockedInfo(null);
      setAccount(address);
      setRegistered(true);
      setVoted(vStatus.voted);
      setStatus(
        vStatus.voted
          ? `✓ Connected as registered voter: ${short(address)}. Your ballot has already been submitted.`
          : `✓ Connected as registered voter: ${short(address)}. Ready to vote.`
      );
      return true;
    },
    [appId, admin, ended]
  );

  // Initial load & Pera session verification
  useEffect(() => {
    let alive = true;
    (async () => {
      const appState = await refresh(appId);
      const contractAdmin = appState?.admin || "";
      const isEnded = Boolean(appState?.ended);

      // If election already ended, disconnect session immediately
      if (isEnded) {
        try {
          await peraWallet.disconnect();
        } catch {
          /* ignore */
        }
        setAccount("");
        setRegistered(false);
        setVoted(false);
        setStatus("This election has concluded. Voting is permanently closed.");
        return;
      }

      try {
        const accounts = await peraWallet.reconnectSession();
        if (alive && accounts.length > 0) {
          setAccountsList(accounts);
          let matched = false;
          for (const acc of accounts) {
            const isAdm = contractAdmin && acc.trim().toUpperCase() === contractAdmin.trim().toUpperCase();
            if (!isAdm) {
              const vStatus = await getVoterStatus(Number(appId), acc);
              if (vStatus.registered) {
                await validateAndAttach(acc, contractAdmin, isEnded);
                matched = true;
                break;
              }
            }
          }
          if (!matched) {
            await validateAndAttach(accounts[0], contractAdmin, isEnded);
          }
        }
      } catch {
        /* no active session */
      }
    })();

    return () => {
      alive = false;
    };
  }, [appId, refresh, validateAndAttach]);

  // Real-time polling: automatically disconnect voter wallets as soon as admin ends the election
  useEffect(() => {
    const timer = setInterval(async () => {
      const numericId = Number(appId);
      if (!numericId || numericId <= 0) return;
      try {
        const appState = await getAppState(numericId);
        if (!appState) return;

        setStarted(appState.started);

        if (appState.ended) {
          setEnded(true);
          // If a wallet is connected, automatically disconnect it!
          setAccount((current) => {
            if (current) {
              try {
                peraWallet.disconnect();
              } catch {
                /* ignore */
              }
              setRegistered(false);
              setVoted(false);
              setAccountsList([]);
              setStatus("The election has been ended by the administrator. Your wallet has been automatically disconnected.");
            }
            return "";
          });
        }
      } catch {
        /* quiet background poll error */
      }
    }, 2500);

    return () => clearInterval(timer);
  }, [appId]);

  const connectWithTimeout = (timeoutMs = 30000) => {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            "Pera Wallet connection timed out. If using Brave or an Ad Blocker, please disable shields for this site. If using the Pera extension, click the Pera icon in your browser toolbar."
          )
        );
      }, timeoutMs);
    });

    return Promise.race([peraWallet.connect(), timeoutPromise]).finally(() => {
      clearTimeout(timer);
    });
  };

  const connect = useCallback(async () => {
    if (ended) {
      setStatus("Election closed: Voting has ended. Wallet connection is disabled.");
      return;
    }

    setBusy(true);
    setBlockedInfo(null);
    setStatus("Connecting to Pera Wallet… Check for modal, popups, or extension prompts.");
    try {
      const accounts = await connectWithTimeout(30000);
      setAccountsList(accounts);
      if (accounts && accounts.length > 0) {
        let chosen = accounts[0];
        for (const acc of accounts) {
          const isAdm = admin && acc.trim().toUpperCase() === admin.trim().toUpperCase();
          if (!isAdm) {
            const vStatus = await getVoterStatus(Number(appId), acc);
            if (vStatus.registered) {
              chosen = acc;
              break;
            }
          }
        }
        await validateAndAttach(chosen, admin, ended);
      }
    } catch (e) {
      console.warn("Pera connect error:", e);
      if (e?.data?.type === "CONNECT_MODAL_CLOSED") {
        setStatus("Wallet connection cancelled in Pera.");
      } else {
        setStatus(
          e?.message ||
            "Could not connect to Pera Wallet. Check popup blockers or disable Brave Shields / ad blockers for this domain."
        );
      }
    } finally {
      setBusy(false);
    }
  }, [admin, appId, ended, validateAndAttach]);

  async function disconnect() {
    try {
      await peraWallet.disconnect();
    } catch {
      /* ignore */
    }
    setAccount("");
    setAccountsList([]);
    setRegistered(false);
    setVoted(false);
    setBlockedInfo(null);
    setStatus("Wallet disconnected. Connect your registered voter wallet to cast your ballot.");
  }

  async function switchWallet() {
    if (ended) return;
    try {
      await peraWallet.disconnect();
    } catch {
      /* ignore */
    }
    setAccount("");
    setAccountsList([]);
    setRegistered(false);
    setVoted(false);
    setBlockedInfo(null);
    setStatus("Select your registered voter account in Pera Wallet…");
    await connect();
  }

  // ── Cast Vote ─────────────────────────────────────────────────────────
  async function handleVote(candidateId) {
    if (ended) {
      setStatus("Election closed: Voting is permanently closed.");
      return;
    }
    if (!account) {
      await connect();
      return;
    }
    if (!canVote) return;

    setBusy(true);
    const candidateName = candidates.find((c) => c.id === candidateId)?.name || `#${candidateId + 1}`;
    try {
      setStatus(`Casting vote for "${candidateName}" — approve transaction in your Pera Wallet…`);
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
      setStatus(`✓ Your vote for "${candidateName}" was permanently recorded on Algorand Testnet!`);
      await refresh(appId);
      await validateAndAttach(account, admin);
    } catch (e) {
      console.error("Vote failed:", e);
      const msg = e?.response?.body?.message ?? e?.message ?? String(e);
      if (msg.includes("fee") || msg.includes("overspend")) {
        setStatus("Transaction failed: Ensure your wallet has at least 0.002 ALGO for network fees.");
      } else if (msg.includes("Already voted")) {
        setStatus("Double voting prohibited: This wallet has already cast a vote in this election.");
      } else if (msg.includes("Not registered")) {
        setStatus("Vote rejected: This wallet is not registered by the election admin.");
      } else if (msg.includes("Election not open") || msg.includes("Election closed") || msg.includes("ended")) {
        setStatus("Voting is currently closed for this election.");
      } else {
        setStatus(`Voting failed: ${msg}`);
      }
    } finally {
      setBusy(false);
    }
  }

  const copyAddress = () => {
    const target = blockedInfo?.address || account;
    if (!target) return;
    navigator.clipboard.writeText(target);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="container">
      {/* ── Top Navigation Bar ── */}
      <nav>
        <div className="brand">
          <span>A</span> BlockVote
          <span style={{ fontSize: "10px", padding: "3px 8px", borderRadius: "4px", background: "rgba(124, 93, 250, 0.15)", color: "#bfa8ff", border: "1px solid rgba(124, 93, 250, 0.35)", fontWeight: 700, marginLeft: "8px" }}>
            VOTER PORTAL
          </span>
        </div>

        <div className="nav-actions">
          <a
            href="/vote.html"
            className="outline"
            style={{ padding: "7px 13px", fontSize: "12.5px", background: "var(--primary)", borderColor: "var(--primary)", color: "#fff", fontWeight: 700 }}
          >
            Voter Portal
          </a>
          <a
            href="/index.html"
            className="outline"
            style={{ padding: "7px 13px", fontSize: "12.5px" }}
          >
            Admin Hub
          </a>
          <span className="network-tag">TESTNET</span>

          {account ? (
            <>
              {voterEligibleAccounts.length > 1 ? (
                <select
                  value={account}
                  onChange={(e) => validateAndAttach(e.target.value)}
                  style={{ padding: "6px 10px", fontSize: "12px" }}
                  title="Switch between your registered voter accounts"
                  disabled={ended}
                >
                  {voterEligibleAccounts.map((addr) => (
                    <option key={addr} value={addr}>
                      {short(addr)} (Voter ✓)
                    </option>
                  ))}
                </select>
              ) : (
                <span className="addr">{short(account)}</span>
              )}
              <button className="outline" onClick={switchWallet} disabled={busy || ended} title="Switch Pera Account" style={{ padding: "6px 12px", minHeight: "34px", fontSize: "12px" }}>
                Switch
              </button>
              <button className="outline" onClick={disconnect} disabled={busy} title="Disconnect session" style={{ padding: "6px 12px", minHeight: "34px", fontSize: "12px" }}>
                Disconnect
              </button>
            </>
          ) : (
            <button
              className="outline"
              onClick={busy ? () => setBusy(false) : connect}
              disabled={ended}
              style={{ borderColor: "rgba(124, 93, 250, 0.5)", color: "#c3b4ff" }}
              title={busy ? "Click to cancel stuck connection" : "Connect Voter Wallet"}
            >
              {ended ? "Election Closed" : busy ? "Connecting… (Cancel)" : "Connect Voter Wallet"}
            </button>
          )}
        </div>
      </nav>

      {/* ── Voter Header ── */}
      <header>
        <div className="tag">OFFICIAL VOTER BALLOT</div>
        <h1>Cast Your Vote.<br /><em>Verifiable On Algorand.</em></h1>
        <p>
          Welcome to the official voter portal. Only wallets authorized and registered by the election admin on the Admin Hub can connect and cast ballots.
        </p>

        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", marginTop: "22px", alignItems: "center" }}>
          <button
            onClick={busy ? () => setBusy(false) : account ? disconnect : connect}
            disabled={ended}
          >
            {ended
              ? "Election Closed"
              : busy
                ? "Connecting… (Click to Cancel)"
                : account
                  ? `Connected: ${short(account)}`
                  : "Connect Voter Wallet ↗"}
          </button>
        </div>
      </header>

      {/* ── Election Concluded Notice (No results shown on voter page) ── */}
      {ended && (
        <section
          className="notice"
          style={{
            borderColor: "rgba(124, 93, 250, 0.4)",
            background: "rgba(124, 93, 250, 0.08)",
            marginBottom: "25px",
            padding: "22px 24px",
            borderRadius: "var(--radius-lg)",
            border: "1px solid rgba(124, 93, 250, 0.35)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
            <span style={{ fontSize: "11px", fontFamily: "DM Mono", fontWeight: 700, color: "#c4b6ff", background: "rgba(124, 93, 250, 0.2)", padding: "3px 8px", borderRadius: "4px" }}>
              POLLS SEALED · ELECTION CONCLUDED
            </span>
            <span style={{ fontSize: "12px", color: "#a5a8b9" }}>Algorand Testnet</span>
          </div>
          <h3 style={{ margin: "10px 0 6px 0", color: "#f8fafc", fontSize: "19px" }}>
            Voting Has Officially Closed
          </h3>
          <p style={{ marginTop: "6px", color: "#94a3b8", fontSize: "14px", lineHeight: "1.6", margin: "0 0 16px 0" }}>
            This election has ended from the admin dashboard. All voting is permanently sealed, and voter wallets have been automatically disconnected. Official vote tallies and certified results are published exclusively on the Admin Dashboard.
          </p>
          <div>
            <a
              href="/index.html"
              className="outline"
              style={{
                textDecoration: "none",
                fontSize: "13px",
                padding: "8px 16px",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                background: "rgba(124, 93, 250, 0.15)",
                borderColor: "rgba(124, 93, 250, 0.4)",
                color: "#e2e8f0",
              }}
            >
              View Certified Results on Admin Dashboard →
            </a>
          </div>
        </section>
      )}

      {/* ── Security Alert: Admin Wallet Blocked ── */}
      {!ended && blockedInfo?.type === "admin" && (
        <section
          className="notice"
          style={{
            borderColor: "rgba(239, 68, 68, 0.5)",
            background: "linear-gradient(145deg, #2b1419, #1e0d11)",
            marginBottom: "25px",
            padding: "22px 24px",
            borderRadius: "var(--radius-lg)",
            border: "1px solid rgba(239, 68, 68, 0.4)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
            <span style={{ fontSize: "11px", fontFamily: "DM Mono", fontWeight: 700, color: "#f87171", background: "rgba(239, 68, 68, 0.15)", padding: "3px 8px", borderRadius: "4px" }}>
              ACCESS DENIED · ADMIN WALLET RESTRICTION
            </span>
            <span style={{ fontSize: "12px", color: "#fca5a5" }}>Contract Admin: {short(admin)}</span>
          </div>
          <h3 style={{ margin: "10px 0 6px 0", color: "#fecaca", fontSize: "19px" }}>
            Admin Wallet Cannot Connect to the Voting Page
          </h3>
          <p style={{ color: "#fca5a5", fontSize: "14px", lineHeight: "1.6", margin: "0 0 16px 0" }}>
            You connected with the election administrator wallet (<code>{blockedInfo.address}</code>). 
            Per voting security rules, the administrator wallet cannot cast ballots. 
            The voting portal only connects to authorized voter wallets registered on the admin page.
          </p>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            <button className="outline" onClick={switchWallet} disabled={busy} style={{ borderColor: "rgba(239, 68, 68, 0.5)", color: "#fecaca" }}>
              Switch to a Voter Wallet in Pera
            </button>
            <a href="/index.html" className="outline" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
              Go to Admin Dashboard →
            </a>
          </div>
        </section>
      )}

      {/* ── Security Alert: Unregistered Wallet Blocked ── */}
      {!ended && blockedInfo?.type === "unregistered" && (
        <section
          className="notice"
          style={{
            borderColor: "rgba(245, 158, 11, 0.5)",
            background: "linear-gradient(145deg, #2b1f14, #1e150d)",
            marginBottom: "25px",
            padding: "22px 24px",
            borderRadius: "var(--radius-lg)",
            border: "1px solid rgba(245, 158, 11, 0.4)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
            <span style={{ fontSize: "11px", fontFamily: "DM Mono", fontWeight: 700, color: "#fbbf24", background: "rgba(245, 158, 11, 0.15)", padding: "3px 8px", borderRadius: "4px" }}>
              ACCESS DENIED · UNREGISTERED WALLET
            </span>
            <span style={{ fontSize: "12px", color: "#fde68a" }}>Contract #{appId.toString()}</span>
          </div>
          <h3 style={{ margin: "10px 0 6px 0", color: "#fef3c7", fontSize: "19px" }}>
            Wallet Not Registered on Admin Page
          </h3>
          <p style={{ color: "#fde68a", fontSize: "14px", lineHeight: "1.6", margin: "0 0 16px 0" }}>
            Wallet <code>{blockedInfo.address}</code> is not registered as an eligible voter for Contract #{appId.toString()}.
            The voting portal only connects to wallets registered by the admin on the Admin Hub before the election opens.
          </p>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
            <button className="outline" onClick={copyAddress} style={{ fontSize: "13px", padding: "8px 14px" }}>
              {copied ? "Copied Address ✓" : "Copy Wallet Address to Send to Admin"}
            </button>
            <button className="outline" onClick={switchWallet} disabled={busy} style={{ fontSize: "13px", padding: "8px 14px" }}>
              Try Another Account
            </button>
            <a href="/index.html" className="outline" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", fontSize: "13px", padding: "8px 14px" }}>
              Register on Admin Hub →
            </a>
          </div>
        </section>
      )}

      {/* ── Active Voter Eligibility & Status Card ── */}
      {!ended && !blockedInfo && (
        <section
          className="panel"
          style={{
            padding: "24px",
            marginBottom: "25px",
            background: !account
              ? "linear-gradient(145deg, #181d30, #131726)"
              : voted
              ? "linear-gradient(145deg, #152627, #101c1f)"
              : "linear-gradient(145deg, #1a233a, #131d33)",
            border: !account
              ? "1px solid var(--border-medium)"
              : voted
              ? "1px solid rgba(32, 201, 151, 0.5)"
              : "1px solid rgba(124, 93, 250, 0.6)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "10px" }}>
            <div>
              <div className="tag" style={{ marginBottom: "6px" }}>VOTER STATUS VERIFICATION</div>
              <h2 style={{ margin: "4px 0 10px 0", fontSize: "20px" }}>
                {!account
                  ? "Voter Wallet Required"
                  : voted
                  ? "Ballot Submitted & Confirmed ✓"
                  : started
                  ? "Eligible Voter Confirmed ✓"
                  : "Registered Voter — Awaiting Poll Opening"}
              </h2>
            </div>

            <span
              style={{
                padding: "4px 10px",
                borderRadius: "20px",
                fontSize: "11px",
                fontWeight: 700,
                letterSpacing: "0.5px",
                background: !account
                  ? "rgba(255, 255, 255, 0.08)"
                  : voted
                  ? "rgba(32, 201, 151, 0.2)"
                  : started
                  ? "rgba(124, 93, 250, 0.2)"
                  : "rgba(59, 130, 246, 0.2)",
                color: !account
                  ? "#a5a8b9"
                  : voted
                  ? "#79f2c3"
                  : started
                  ? "#c3b4ff"
                  : "#93c5fd",
                border: `1px solid ${
                  !account
                    ? "rgba(255, 255, 255, 0.15)"
                    : voted
                    ? "rgba(32, 201, 151, 0.4)"
                    : started
                    ? "rgba(124, 93, 250, 0.4)"
                    : "rgba(59, 130, 246, 0.4)"
                }`,
              }}
            >
              {!account
                ? "WALLET REQUIRED"
                : voted
                ? "BALLOT RECORDED"
                : started
                ? "READY TO VOTE"
                : "REGISTERED"}
            </span>
          </div>

          <p style={{ fontSize: "14px", color: "#c8cbda", lineHeight: "1.6", marginTop: "10px" }}>
            {!account ? (
              "Please connect your registered Pera Wallet. The voting portal will verify your on-chain registration before granting ballot access."
            ) : voted ? (
              <>
                Your vote has been cryptographically recorded on the Algorand blockchain. Each voter is permitted exactly one ballot. Thank you for participating!
              </>
            ) : !started ? (
              <>
                Your wallet (<code>{short(account)}</code>) is verified as a registered voter! The administrator has not yet opened the polls. Please wait for the election to start.
              </>
            ) : (
              <>
                Your wallet (<code>{short(account)}</code>) is verified as an active, registered voter. Select your preferred candidate below and submit your on-chain ballot.
              </>
            )}
          </p>
        </section>
      )}

      {/* ── Candidates / Official Ballot Section (No vote results shown) ── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "15px", flexWrap: "wrap", gap: "8px" }}>
        <div>
          <div className="tag">OFFICIAL BALLOT</div>
          <h2 style={{ margin: "2px 0 0 0" }}>Choose a Candidate</h2>
        </div>
        <span style={{ fontSize: "12px", color: "#8e93a6" }}>
          {ended ? "Voting ended" : started ? "Voting is live" : "Polls not yet open"} · {candidates.length} Candidate{candidates.length === 1 ? "" : "s"}
        </span>
      </div>

      <section className="grid" style={{ marginBottom: "30px" }}>
        {candidates.length === 0 ? (
          <div className="panel" style={{ gridColumn: "1 / -1", textAlign: "center", padding: "40px" }}>
            <p style={{ fontSize: "15px", color: "#8a8f9d" }}>No candidate data available for this election.</p>
          </div>
        ) : (
          candidates.map((c, i) => {
            return (
              <article
                className="panel candidate"
                key={c.id}
              >
                <div className="avatar">
                  {c.name[0]}
                </div>
                <small>CANDIDATE 0{i + 1}</small>
                <h3>{c.name}</h3>

                <button
                  disabled={!canVote}
                  onClick={() => handleVote(c.id)}
                  style={canVote ? { cursor: "pointer" } : undefined}
                >
                  {ended
                    ? "Election closed"
                    : !account
                    ? "Connect registered wallet to vote"
                    : !started
                    ? "Polls not open"
                    : voted
                    ? "Already voted ✓"
                    : `Vote for ${c.name}`}
                </button>
              </article>
            );
          })
        )}
      </section>

      {/* ── Transaction Status Bar ── */}
      <div className="notice" style={{ marginBottom: "20px" }}>
        <b>Transaction & Status</b>
        <p style={{ marginTop: "4px" }}>{status}</p>
      </div>

      <footer>BLOCKVOTE · SECURE VOTER PORTAL · ALGORAND TESTNET</footer>
    </div>
  );
}

// UI wiring for ui/core.js. All chain access goes through MetaMask (window.ethereum).
(function () {
  const C = window.VestingCore;
  const { ethers } = C;
  const $ = (id) => document.getElementById(id);

  const CHAINS = {
    1: { name: "Ethereum mainnet", cls: "mainnet", explorer: "https://etherscan.io", forge: "mainnet" },
    11155111: { name: "Sepolia", cls: "testnet", explorer: "https://sepolia.etherscan.io", forge: "sepolia" },
    31337: { name: "Local anvil", cls: "testnet", explorer: null, forge: null },
  };

  const S = { provider: null, signer: null, account: null, chainId: null, checks: null, factory: null, owner: null, schedules: [], verified: null };

  // ---------- helpers ----------
  const fmt = (n) => BigInt(n).toLocaleString("en-US");
  const date = (s) => new Date(Number(s) * 1000).toISOString().replace("T", " ").replace(":00.000Z", " UTC");
  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
  const isMainnet = () => S.chainId === 1;
  const chain = () => CHAINS[S.chainId];
  function link(kind, value) {
    const ex = chain() && chain().explorer;
    return ex ? `<a href="${ex}/${kind}/${value}" target="_blank" rel="noopener">${kind === "tx" ? short(value) : value}</a>` : value;
  }
  function log(msg, cls = "") {
    const line = document.createElement("div");
    if (cls) line.className = cls;
    line.innerHTML = `[${new Date().toLocaleTimeString()}] ${msg}`;
    $("log").prepend(line);
  }
  function errMsg(e) {
    if (e && (e.code === "ACTION_REJECTED" || e.code === 4001)) return "rejected in MetaMask";
    return (e && (e.shortMessage || e.reason || e.message)) || String(e);
  }
  function store(key, val) { try { val == null ? localStorage.removeItem(key) : localStorage.setItem(key, val); } catch {} }
  function load(key) { try { return localStorage.getItem(key); } catch { return null; } }

  // ---------- configuration ----------
  function readConfig() {
    const tge = Number($("tge").value);
    const month = Number($("month").value);
    if (!Number.isInteger(tge) || tge <= 0) throw new Error("TGE must be a positive integer (unix seconds)");
    if (!Number.isInteger(month) || month <= 0) throw new Error("Month length must be a positive integer");
    if (isMainnet() && month !== C.MONTH_30D) throw new Error("Month length must be 30 days on mainnet");
    const benef = {};
    for (const g of C.GRANTS) {
      const v = $(`benef-${g.name}`).value.trim();
      if (!ethers.isAddress(v)) throw new Error(`${g.name}: invalid beneficiary address`);
      benef[g.name] = v;
    }
    return { tge, month, rows: C.plan(tge, month, benef) };
  }

  function renderPlan() {
    let cfg = null;
    try { cfg = readConfig(); } catch (e) { $("checkSummary").innerHTML = `<span class="bad">${e.message}</span>`; }
    const tge = Number($("tge").value);
    $("tgeHuman").textContent = tge > 0 ? date(tge) + (tge !== C.MAINNET_TGE ? "  (differs from the planned mainnet TGE, 2026-10-02 00:00 UTC)" : "") : "";
    $("tgeHuman").className = "hint" + (isMainnet() && tge !== C.MAINNET_TGE ? " warnc" : "");
    for (const g of C.GRANTS) {
      const input = $(`benef-${g.name}`);
      input.classList.toggle("changed", input.value.trim().toLowerCase() !== C.DEFAULT_BENEFICIARIES[g.name].toLowerCase());
      const r = cfg && cfg.rows.find((x) => x.name === g.name);
      $(`start-${g.name}`).textContent = r ? date(r.start).replace(" UTC", "") : "–";
      $(`end-${g.name}`).textContent = r ? date(r.start + r.duration).replace(" UTC", "") : "–";
      const c = S.checks && S.checks[g.name];
      $(`check-${g.name}`).innerHTML = !c ? "–"
        : c.ok ? `<span class="pill ok" title="owners: ${c.owners.join(", ")}">Safe v${c.version} · ${c.threshold}-of-${c.owners.length}</span>`
        : `<span class="pill ${c.waived ? "warnc" : "bad"}">${c.reason}</span>`;
    }
  }

  function buildPlanTable() {
    $("planBody").innerHTML = C.GRANTS.map((g) => `
      <tr>
        <td><b>${g.name}</b></td>
        <td><input id="benef-${g.name}" class="mono" value="${C.DEFAULT_BENEFICIARIES[g.name]}" spellcheck="false"></td>
        <td id="check-${g.name}">–</td>
        <td class="r mono">${fmt(g.amount)}</td>
        <td>${g.cliff}m → ${g.vesting}m</td>
        <td id="start-${g.name}" class="mono small"></td>
        <td id="end-${g.name}" class="mono small"></td>
      </tr>`).join("");
    $("planTotal").textContent = fmt(C.TOTAL);
    $("walletBody").innerHTML = C.GRANTS.map((g) => `
      <tr><td><b>${g.name}</b></td><td id="wallet-${g.name}" class="mono small">–</td><td id="wstatus-${g.name}">–</td></tr>`).join("");
  }

  function invalidate() {
    S.checks = null; S.verified = null;
    $("checkSummary").textContent = "";
    $("verifyInfo").textContent = "";
    $("confirmPlan").checked = false;
    renderPlan(); refreshButtons();
  }

  // ---------- state / buttons ----------
  const preflightOk = () => S.checks && Object.values(S.checks).every((c) => c.ok || c.waived);
  const isOwner = () => S.owner && S.account && S.owner.toLowerCase() === S.account.toLowerCase();
  const allCreated = () => C.GRANTS.every((g) => S.schedules.some((s) => s.bucket === ethers.id(g.name)));

  function refreshButtons() {
    const connected = !!S.signer && !!chain();
    $("checkBtn").disabled = !connected;
    $("deployBtn").disabled = !connected || !preflightOk() || !!S.factory;
    $("loadFactoryBtn").disabled = !connected;
    $("createBtn").disabled = !connected || !S.factory || !preflightOk() || !$("confirmPlan").checked || !isOwner() || allCreated();
    $("renounceBtn").disabled = !connected || !S.factory || !isOwner() || !allCreated();
    $("verifyBtn").disabled = !connected || !S.factory || !ethers.isAddress($("token").value.trim());
    $("downloadBtn").disabled = !S.verified;
  }

  function busy(btn, on) {
    for (const id of ["checkBtn", "deployBtn", "loadFactoryBtn", "createBtn", "renounceBtn", "verifyBtn", "downloadBtn"]) $(id).disabled = on || $(id).disabled;
    if (btn) {
      btn.dataset.label ??= btn.textContent;
      btn.textContent = on ? "Working…" : btn.dataset.label;
    }
    if (!on) refreshButtons();
  }

  // ---------- connect ----------
  async function connect() {
    if (!window.ethereum) {
      log("MetaMask not found. Install it and open this page over http://localhost (not file://).", "bad");
      return;
    }
    S.provider = new ethers.BrowserProvider(window.ethereum);
    await S.provider.send("eth_requestAccounts", []);
    S.signer = await S.provider.getSigner();
    S.account = await S.signer.getAddress();
    S.chainId = Number((await S.provider.getNetwork()).chainId);
    const c = chain();
    $("netBadge").textContent = c ? c.name : `unsupported chain ${S.chainId}`;
    $("netBadge").className = "badge " + (c ? c.cls : "mainnet");
    const bal = await S.provider.getBalance(S.account);
    $("acctLine").innerHTML = `${link("address", S.account)} · ${Number(ethers.formatEther(bal)).toFixed(4)} ETH`;
    $("connectBtn").textContent = "Connected";
    $("mainnetBanner").hidden = !isMainnet();
    $("month").disabled = isMainnet();
    if (isMainnet()) $("month").value = C.MONTH_30D;
    $("testnetOverrideWrap").hidden = isMainnet();
    if (!c) log(`Chain ${S.chainId} is not supported. Switch MetaMask to Ethereum mainnet or Sepolia.`, "bad");
    else log(`Connected ${S.account} on ${c.name}`);
    const saved = load(`dact-factory-${S.chainId}`);
    if (saved && !$("factory").value) { $("factory").value = saved; await loadFactory(); }
    invalidate();
  }

  // ---------- pre-flight ----------
  async function runChecks() {
    busy($("checkBtn"), true);
    try {
      const { rows } = readConfig();
      const override = !isMainnet() && $("testnetOverride").checked;
      const checks = {};
      for (const r of rows) {
        const c = await C.checkSafe(S.provider, r.beneficiary);
        if (!c.ok && override) c.waived = true;
        checks[r.name] = c;
      }
      S.checks = checks;
      const bad = Object.entries(checks).filter(([, c]) => !c.ok);
      const warn = [];
      const grantStart = Number(rows.find((r) => r.name === "GRANT_AIRDROP").start);
      if (grantStart < Date.now() / 1000) warn.push("Grant/Airdrop vesting has already started, so fund right after creation.");
      if (isMainnet() && Number($("tge").value) !== C.MAINNET_TGE) warn.push("TGE differs from the planned 2026-10-02 00:00 UTC.");
      $("checkSummary").innerHTML =
        (bad.length === 0 ? `<span class="ok">✔ All ${C.GRANTS.length} beneficiaries are Safes with threshold ≥ 2.</span>`
          : bad.every(([, c]) => c.waived) ? `<span class="warnc">⚠ ${bad.length} beneficiaries aren't Safes on this network (waived for testnet).</span>`
          : `<span class="bad">✘ ${bad.length} beneficiaries failed: ${bad.map(([n]) => n).join(", ")}</span>`) +
        warn.map((w) => `<br><span class="warnc">⚠ ${w}</span>`).join("");
      log(`Pre-flight: ${C.GRANTS.length - bad.length}/${C.GRANTS.length} Safes OK`, bad.length && !override ? "bad" : "ok");
    } catch (e) {
      $("checkSummary").innerHTML = `<span class="bad">${errMsg(e)}</span>`;
    }
    renderPlan();
    busy($("checkBtn"), false);
  }

  // ---------- factory ----------
  async function loadFactory() {
    const addr = $("factory").value.trim();
    S.factory = null; S.owner = null; S.schedules = []; S.verified = null;
    if (!addr) { $("factoryInfo").textContent = ""; renderWallets(); refreshButtons(); return; }
    try {
      if (!ethers.isAddress(addr)) throw new Error("invalid address");
      if ((await S.provider.getCode(addr)) === "0x") throw new Error("no contract at this address on this network");
      const f = C.factoryAt(addr, S.provider);
      S.owner = await f.owner();
      S.schedules = await C.readSchedules(f);
      S.factory = ethers.getAddress(addr);
      store(`dact-factory-${S.chainId}`, S.factory);
      const ownerNote = S.owner === ethers.ZeroAddress ? "renounced (frozen)"
        : isOwner() ? "you" : `<span class="bad">${S.owner}, not the connected account</span>`;
      $("factoryInfo").innerHTML = `Factory ${link("address", S.factory)} · owner: ${ownerNote} · ${S.schedules.length} schedule(s)`;
    } catch (e) {
      $("factoryInfo").innerHTML = `<span class="bad">${errMsg(e)}</span>`;
    }
    renderWallets(); renderVerifyCmds(); refreshButtons();
  }

  function renderWallets() {
    for (const g of C.GRANTS) {
      const s = S.schedules.find((x) => x.bucket === ethers.id(g.name));
      $(`wallet-${g.name}`).innerHTML = s ? link("address", s.wallet) : "–";
      $(`wstatus-${g.name}`).innerHTML = s ? `<span class="pill ok">created</span>` : S.factory ? `<span class="pill warnc">missing</span>` : "–";
    }
  }

  async function deployFactory() {
    busy($("deployBtn"), true);
    try {
      log("Deploying VestingFactory, confirm in MetaMask…");
      const { address, hash } = await C.deployFactory(S.signer);
      log(`Factory deployed at ${link("address", address)} (tx ${link("tx", hash)})`, "ok");
      $("factory").value = address;
      await loadFactory();
    } catch (e) {
      log(`Factory deployment failed: ${errMsg(e)}`, "bad");
    }
    busy($("deployBtn"), false);
  }

  async function createWallets() {
    busy($("createBtn"), true);
    try {
      const { rows } = readConfig();
      const f = C.factoryAt(S.factory, S.signer);
      await C.createMissing(f, rows, (ev) => {
        if (ev.type === "exists") log(`${ev.name}: already exists at ${link("address", ev.wallet)}, skipped`);
        if (ev.type === "sent") { log(`${ev.name}: tx sent ${link("tx", ev.hash)}, waiting…`); $(`wstatus-${ev.name}`).innerHTML = `<span class="pill warnc">pending</span>`; }
        if (ev.type === "created") log(`${ev.name}: wallet ${link("address", ev.wallet)} created`, "ok");
      });
      log(`All ${C.GRANTS.length} wallets exist.`, "ok");
    } catch (e) {
      log(`Stopped: ${errMsg(e)}. Press "Create missing wallets" again to resume.`, "bad");
    }
    await loadFactory();
    busy($("createBtn"), false);
  }

  async function renounceFactory() {
    if (!confirm("Renounce factory ownership permanently? No further wallets can ever be created by this factory.")) return;
    busy($("renounceBtn"), true);
    try {
      const hash = await C.renounce(C.factoryAt(S.factory, S.signer));
      log(`Factory ownership renounced (tx ${link("tx", hash)})`, "ok");
    } catch (e) {
      log(`Renounce failed: ${errMsg(e)}`, "bad");
    }
    await loadFactory();
    busy($("renounceBtn"), false);
  }

  // ---------- verification & batch ----------
  async function checkToken() {
    const addr = $("token").value.trim();
    $("tokenInfo").textContent = "";
    S.verified = null;
    if (!S.provider || !ethers.isAddress(addr)) { refreshButtons(); return; }
    try {
      const t = new ethers.Contract(addr, C.ERC20_ABI, S.provider);
      const [sym, dec] = await Promise.all([t.symbol(), t.decimals()]);
      $("tokenInfo").innerHTML = Number(dec) === 18 ? `<span class="ok">${sym}, 18 decimals</span>` : `<span class="bad">${sym} has ${dec} decimals, expected 18</span>`;
    } catch {
      $("tokenInfo").innerHTML = `<span class="bad">not an ERC-20 on this network</span>`;
    }
    refreshButtons();
  }

  async function verify() {
    busy($("verifyBtn"), true);
    S.verified = null;
    try {
      const { rows } = readConfig();
      const token = ethers.getAddress($("token").value.trim());
      S.verified = await C.verifyForFunding(S.provider, S.factory, token, rows);
      const renounced = S.owner === ethers.ZeroAddress;
      $("verifyInfo").innerHTML = `<span class="ok">✔ All checks passed. The batch funds ${fmt(C.TOTAL)} DACT across ${C.GRANTS.length} wallets.</span>` +
        (renounced ? "" : `<br><span class="warnc">⚠ Factory is not renounced, so its owner could still add wallets later.</span>`) +
        `<table class="plan"><thead><tr><th>Bucket</th><th>Wallet</th><th class="r">DACT</th></tr></thead><tbody>` +
        S.verified.map((r) => `<tr><td>${r.name}</td><td class="mono small">${link("address", r.wallet)}</td><td class="r mono">${fmt(r.amount)}</td></tr>`).join("") +
        `</tbody></table>`;
      log("Verification passed", "ok");
    } catch (e) {
      $("verifyInfo").innerHTML = `<span class="bad">✘ ${errMsg(e)}</span>`;
      log(`Verification failed: ${errMsg(e)}`, "bad");
    }
    busy($("verifyBtn"), false);
  }

  function download() {
    const token = ethers.getAddress($("token").value.trim());
    const batch = C.buildSafeBatch(S.chainId, token, S.factory, S.verified);
    const blob = new Blob([JSON.stringify(batch, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `funding-batch-${S.chainId}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    log(`Downloaded ${a.download}. Import it in the treasury Safe → Transaction Builder.`, "ok");
  }

  function renderVerifyCmds() {
    const c = chain();
    if (!S.factory || !c || !c.forge) { $("verifyCmds").textContent = "Available after a factory is loaded on mainnet or Sepolia."; return; }
    const enc = ethers.AbiCoder.defaultAbiCoder();
    const lines = [`forge verify-contract ${S.factory} src/VestingFactory.sol:VestingFactory --chain ${c.forge} \\\n  --constructor-args ${enc.encode(["address"], [S.owner === ethers.ZeroAddress ? S.account : S.owner])} --watch`];
    for (const s of S.schedules) {
      lines.push(`forge verify-contract ${s.wallet} src/TokenVesting.sol:TokenVesting --chain ${c.forge} \\\n  --constructor-args ${enc.encode(["address", "uint64", "uint64", "uint64"], [s.beneficiary, s.start, s.duration, s.cliff])} --watch`);
    }
    $("verifyCmds").textContent = "# needs ETHERSCAN_API_KEY in the environment\n" + lines.join("\n\n") +
      (S.owner === ethers.ZeroAddress ? "\n\n# factory is renounced: the constructor arg above assumes the connected account deployed it" : "");
  }

  // ---------- init ----------
  buildPlanTable();
  $("tge").value = C.MAINNET_TGE;
  $("month").value = C.MONTH_30D;
  for (const id of ["tge", "month"]) $(id).addEventListener("input", invalidate);
  for (const g of C.GRANTS) $(`benef-${g.name}`).addEventListener("input", invalidate);
  $("testnetOverride").addEventListener("change", invalidate);
  $("confirmPlan").addEventListener("change", refreshButtons);
  $("token").addEventListener("input", checkToken);
  $("connectBtn").addEventListener("click", () => connect().catch((e) => log(`Connect failed: ${errMsg(e)}`, "bad")));
  $("checkBtn").addEventListener("click", runChecks);
  $("loadFactoryBtn").addEventListener("click", loadFactory);
  $("factory").addEventListener("input", () => { S.factory = null; S.schedules = []; renderWallets(); refreshButtons(); });
  $("deployBtn").addEventListener("click", deployFactory);
  $("createBtn").addEventListener("click", createWallets);
  $("renounceBtn").addEventListener("click", renounceFactory);
  $("verifyBtn").addEventListener("click", verify);
  $("downloadBtn").addEventListener("click", download);
  if (window.ethereum) {
    window.ethereum.on?.("chainChanged", () => location.reload());
    window.ethereum.on?.("accountsChanged", () => location.reload());
  }
  renderPlan(); refreshButtons();
})();

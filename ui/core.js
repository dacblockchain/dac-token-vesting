// Deployment logic for the MetaMask UI. DOM-free so it can be tested in Node
// (test/ui-core.test.js) with the same ethers build the page uses.
// Mirrors script/Deploy.s.sol (FUND=false) and script/safe-funding-batch.py.
(function (root) {
  const ethers = root.ethers || require("./vendor/ethers-6.13.4.umd.min.js");
  const CONTRACTS = root.CONTRACTS || (require("./contracts.js"), globalThis.CONTRACTS);

  const MONTH_30D = 30 * 86400;
  const MAINNET_TGE = 1792627200; // 2026-10-22 00:00:00 UTC

  // Must match script/Deploy.s.sol: bucket, cliff months, vesting months, DACT
  const GRANTS = [
    { name: "TEAM", cliff: 12, vesting: 36, amount: 150_000_000n },
    { name: "MARKETING", cliff: 2, vesting: 36, amount: 85_000_000n },
    { name: "ENTERPRISE", cliff: 12, vesting: 48, amount: 140_000_000n },
    { name: "INSTITUTIONAL", cliff: 3, vesting: 36, amount: 150_000_000n },
    { name: "INSTITUTIONAL_UNICORN", cliff: 12, vesting: 24, amount: 50_000_000n },
    { name: "GRANT_AIRDROP", cliff: 0, vesting: 24, amount: 75_000_000n },
    { name: "RESERVE", cliff: 12, vesting: 48, amount: 205_000_000n },
  ];
  const TOTAL = 855_000_000n;

  const DEFAULT_BENEFICIARIES = {
    TEAM: "0x11e422578aD6517CEe36e0eda36089Ce9022761f",
    MARKETING: "0x54B221aEA99e79904a57E183Fe502dbCc428f7d8",
    ENTERPRISE: "0xa798eDf8165acf633a05741B20Be67a664367aC6",
    INSTITUTIONAL: "0x1BE7EcC13FeB29A8a2F15C266EA20c92Fe937F8F",
    INSTITUTIONAL_UNICORN: "0xFd4d966d7418650D1F4167D1DDCEFE69d471b96b",
    GRANT_AIRDROP: "0x656796B89d2a7C0Ec11BCF53F686a8DDD05fa5fb",
    RESERVE: "0xC8a553dfC0387Dc1d83F2Ca3B2E1bf27DC7EF720",
  };

  // Mainnet DACT ("Dac Token", 18 decimals, fixed 1B supply, no mint/pause/blacklist), verified on Etherscan.
  const MAINNET_DACT = "0x0d9e0916eA60D5439F1535BEA4cB83b25780Eb36";

  // Takes over the factory (creation of new wallets) once the 7 wallets exist.
  const DEFAULT_FACTORY_OWNER = "0x11e422578aD6517CEe36e0eda36089Ce9022761f"; // DAC Team Safe

  const SAFE_ABI = [
    "function getThreshold() view returns (uint256)",
    "function getOwners() view returns (address[])",
    "function VERSION() view returns (string)",
  ];
  const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
  ];

  /** Expected schedule rows for a given TGE / month length / beneficiary map. */
  function plan(tge, month, beneficiaries) {
    return GRANTS.map((g) => ({
      ...g,
      bucket: ethers.id(g.name), // keccak256(bytes(name)), as in Deploy.s.sol
      beneficiary: ethers.getAddress(beneficiaries[g.name]),
      start: BigInt(tge + g.cliff * month),
      duration: BigInt(g.vesting * month),
      wei: g.amount * 10n ** 18n,
    }));
  }

  /** Same guard as Deploy.s.sol: deployed Safe, not a 7702 EOA, threshold >= 2. */
  async function checkSafe(provider, address) {
    const code = await provider.getCode(address);
    if (code === "0x") return { ok: false, reason: "no contract code on this network" };
    if (code.length === 2 + 23 * 2 && code.toLowerCase().startsWith("0xef0100"))
      return { ok: false, reason: "EIP-7702 delegated EOA, not a multisig" };
    const safe = new ethers.Contract(address, SAFE_ABI, provider);
    let threshold;
    try {
      threshold = await safe.getThreshold();
    } catch {
      return { ok: false, reason: "not a Safe (getThreshold() failed)" };
    }
    const owners = await safe.getOwners().catch(() => []);
    const version = await safe.VERSION().catch(() => "?");
    if (threshold < 2n) return { ok: false, reason: `threshold ${threshold} < 2`, threshold, owners, version };
    return { ok: true, threshold, owners: [...owners], version };
  }

  async function deployFactory(signer) {
    const { abi, bytecode } = CONTRACTS.VestingFactory;
    const owner = await signer.getAddress();
    const f = await new ethers.ContractFactory(abi, bytecode, signer).deploy(owner);
    const tx = f.deploymentTransaction();
    await f.waitForDeployment();
    return { address: await f.getAddress(), hash: tx.hash };
  }

  function factoryAt(address, runner) {
    return new ethers.Contract(address, CONTRACTS.VestingFactory.abi, runner);
  }

  async function readSchedules(factory) {
    const n = await factory.schedulesCount();
    const out = [];
    for (let i = 0n; i < n; i++) {
      const s = await factory.schedules(i);
      out.push({
        wallet: s.wallet, beneficiary: s.beneficiary, start: s.start, duration: s.duration,
        cliff: s.cliff, funded: s.funded, bucket: s.bucket,
      });
    }
    return out;
  }

  function sameSchedule(s, r) {
    return (
      s.beneficiary.toLowerCase() === r.beneficiary.toLowerCase() &&
      s.start === r.start && s.duration === r.duration && s.cliff === 0n
    );
  }

  /** Creates only the wallets that don't exist yet, so a rejected/failed tx can be resumed. */
  async function createMissing(factory, rows, onEvent = () => {}) {
    const existing = await readSchedules(factory);
    for (const r of rows) {
      const found = existing.filter((s) => s.bucket === r.bucket);
      if (found.length > 1) throw new Error(`${r.name}: ${found.length} schedules already exist`);
      if (found.length === 1) {
        if (!sameSchedule(found[0], r)) throw new Error(`${r.name}: existing schedule has different parameters`);
        onEvent({ type: "exists", name: r.name, wallet: found[0].wallet });
        continue;
      }
      const tx = await factory.createVesting(r.beneficiary, r.bucket, r.start, r.duration, 0);
      onEvent({ type: "sent", name: r.name, hash: tx.hash });
      const rc = await tx.wait();
      if (rc.status !== 1) throw new Error(`${r.name}: transaction failed`);
      const wallet = await factory.computeAddress(r.beneficiary, r.bucket, r.start, r.duration, 0);
      onEvent({ type: "created", name: r.name, wallet, hash: tx.hash });
    }
  }

  async function transferFactory(factory, newOwner) {
    const tx = await factory.transferOwnership(newOwner);
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error("transferOwnership failed");
    return tx.hash;
  }

  async function renounce(factory) {
    const tx = await factory.renounceOwnership();
    await tx.wait();
    return tx.hash;
  }

  /**
   * Independent pre-funding verification (same checks as safe-funding-batch.py).
   * Throws on the first problem; returns rows with wallet addresses otherwise.
   */
  async function verifyForFunding(provider, factoryAddress, tokenAddress, rows) {
    const fail = (m) => { throw new Error(m); };
    if ((await provider.getCode(factoryAddress)) === "0x") fail(`no contract at factory ${factoryAddress}`);
    const factory = factoryAt(factoryAddress, provider);
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const schedules = await readSchedules(factory);
    if (schedules.length !== rows.length)
      fail(`factory has ${schedules.length} schedules, expected ${rows.length} (decoys or incomplete deploy?)`);
    const out = [];
    for (const r of rows) {
      const found = schedules.filter((s) => s.bucket === r.bucket);
      if (found.length !== 1) fail(`${r.name}: ${found.length} schedules for this bucket`);
      const s = found[0];
      if (!sameSchedule(s, r))
        fail(`${r.name}: on-chain ${s.beneficiary} ${s.start}/${s.duration}/${s.cliff} != expected ${r.beneficiary} ${r.start}/${r.duration}/0`);
      const predicted = await factory.computeAddress(s.beneficiary, s.bucket, s.start, s.duration, s.cliff);
      if (predicted.toLowerCase() !== s.wallet.toLowerCase()) fail(`${r.name}: wallet is not the factory's CREATE2 deployment`);
      const w = new ethers.Contract(s.wallet, CONTRACTS.TokenVesting.abi, provider);
      if ((await w.owner()).toLowerCase() !== r.beneficiary.toLowerCase()) fail(`${r.name}: wallet owner mismatch`);
      if ((await w.start()) !== r.start) fail(`${r.name}: wallet start mismatch`);
      if ((await w.duration()) !== r.duration) fail(`${r.name}: wallet duration mismatch`);
      const bal = await token.balanceOf(s.wallet);
      if (bal !== 0n || s.funded !== 0n) fail(`${r.name}: wallet already holds ${ethers.formatUnits(bal, 18)} DACT`);
      out.push({ ...r, wallet: s.wallet });
    }
    const total = out.reduce((a, r) => a + r.amount, 0n);
    if (total !== TOTAL) fail(`total ${total} != ${TOTAL}`);
    return out;
  }

  /** Safe Transaction Builder batch: one DACT transfer(to, value) per wallet, one atomic Safe tx. */
  function buildSafeBatch(chainId, tokenAddress, factoryAddress, verifiedRows) {
    return {
      version: "1.0",
      chainId: String(chainId),
      createdAt: Date.now(),
      meta: {
        name: "DACT vesting funding",
        description: `Fund ${verifiedRows.length} DACT vesting wallets from factory ${factoryAddress}, total ${TOTAL.toLocaleString("en-US")} DACT`,
      },
      transactions: verifiedRows.map((r) => ({
        to: tokenAddress,
        value: "0",
        data: null,
        contractMethod: {
          inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }],
          name: "transfer",
          payable: false,
        },
        contractInputsValues: { to: r.wallet, value: r.wei.toString() },
      })),
    };
  }

  const api = {
    ethers, CONTRACTS, MONTH_30D, MAINNET_TGE, GRANTS, TOTAL, DEFAULT_BENEFICIARIES, DEFAULT_FACTORY_OWNER, MAINNET_DACT, ERC20_ABI,
    plan, checkSafe, deployFactory, factoryAt, readSchedules, createMissing, transferFactory, renounce,
    verifyForFunding, buildSafeBatch,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VestingCore = api;
})(typeof window !== "undefined" ? window : globalThis);

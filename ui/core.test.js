// Tests ui/core.js against a local anvil (chain id 1) with mock Safes at the real
// beneficiary addresses. Run: anvil --chain-id 1 --port 8602 & node --test ui/core.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const C = require("./core.js");
const { ethers } = C;

const RPC = process.env.TEST_RPC || "http://127.0.0.1:8602";
const provider = new ethers.JsonRpcProvider(RPC, undefined, { cacheTimeout: -1, pollingInterval: 100 });
const SAFE_CODE = "0x600360005260206000f3"; // returns 3 for any call, i.e. getThreshold() == 3
const ONE_OF_N_CODE = "0x600160005260206000f3"; // getThreshold() == 1
const rows = C.plan(C.MAINNET_TGE, C.MONTH_30D, C.DEFAULT_BENEFICIARIES);

let deployer, treasury, token;

test.before(async () => {
  assert.equal((await provider.getNetwork()).chainId, 1n);
  deployer = await provider.getSigner(0);
  treasury = await provider.getSigner(1);
  for (const a of Object.values(C.DEFAULT_BENEFICIARIES)) await provider.send("anvil_setCode", [a, SAFE_CODE]);
  const art = JSON.parse(fs.readFileSync(path.join(__dirname, "../out/VestingFactory.t.sol/MockDACt.json")));
  const t = await new ethers.ContractFactory(art.abi, art.bytecode.object, treasury).deploy();
  await t.waitForDeployment();
  token = new ethers.Contract(await t.getAddress(), [...C.ERC20_ABI, "function transfer(address,uint256) returns (bool)"], treasury);
});

test("plan matches Deploy.s.sol semantics", () => {
  const team = rows.find((r) => r.name === "TEAM");
  assert.equal(team.start, BigInt(C.MAINNET_TGE + 12 * C.MONTH_30D));
  assert.equal(team.duration, BigInt(36 * C.MONTH_30D));
  assert.equal(team.bucket, ethers.keccak256(ethers.toUtf8Bytes("TEAM")));
  assert.equal(rows.reduce((a, r) => a + r.amount, 0n), C.TOTAL);
});

test("checkSafe accepts Safes and rejects everything else", async () => {
  assert.equal((await C.checkSafe(provider, C.DEFAULT_BENEFICIARIES.TEAM)).ok, true);
  assert.match((await C.checkSafe(provider, ethers.Wallet.createRandom().address)).reason, /no contract/);
  const d7702 = ethers.Wallet.createRandom().address;
  await provider.send("anvil_setCode", [d7702, "0xef0100" + "11".repeat(20)]);
  assert.match((await C.checkSafe(provider, d7702)).reason, /7702/);
  assert.match((await C.checkSafe(provider, await token.getAddress())).reason, /not a Safe/);
  const weak = ethers.Wallet.createRandom().address;
  await provider.send("anvil_setCode", [weak, ONE_OF_N_CODE]);
  assert.match((await C.checkSafe(provider, weak)).reason, /threshold 1/);
});

test("deploy empty, resume after partial run, verify, fund via Safe batch", async () => {
  const { address } = await C.deployFactory(deployer);
  const factory = C.factoryAt(address, deployer);
  assert.equal(await factory.owner(), await deployer.getAddress());

  // Simulate the user rejecting/aborting after two wallets, then resuming.
  await C.createMissing(factory, rows.slice(0, 2));
  const events = [];
  await C.createMissing(factory, rows, (e) => events.push(e.type));
  assert.deepEqual(events.filter((t) => t === "exists").length, 2);
  assert.deepEqual(events.filter((t) => t === "created").length, rows.length - 2);
  // A second full run is a no-op.
  const again = [];
  await C.createMissing(factory, rows, (e) => again.push(e.type));
  assert.deepEqual(again, Array(rows.length).fill("exists"));

  const verified = await C.verifyForFunding(provider, address, await token.getAddress(), rows);
  const batch = C.buildSafeBatch(1, await token.getAddress(), address, verified);
  assert.equal(batch.transactions.length, rows.length);

  for (const t of batch.transactions) {
    await (await token.transfer(t.contractInputsValues.to, t.contractInputsValues.value)).wait();
  }
  for (const r of verified) {
    assert.equal(await token.balanceOf(r.wallet), r.wei);
    const w = new ethers.Contract(r.wallet, C.CONTRACTS.TokenVesting.abi, provider);
    const tokenAddr = await token.getAddress();
    assert.equal(await w["vestedAmount(address,uint64)"](tokenAddr, r.start - 1n), 0n);
    assert.equal(await w["vestedAmount(address,uint64)"](tokenAddr, r.start + r.duration), r.wei);
  }
  await assert.rejects(C.verifyForFunding(provider, address, await token.getAddress(), rows), /already holds/);

  await C.renounce(factory);
  assert.equal(await factory.owner(), ethers.ZeroAddress);
  await assert.rejects(factory.createVesting(await deployer.getAddress(), rows[0].bucket, 1, 1, 0));
});

test("verification rejects decoys, wrong parameters and wrong beneficiaries", async () => {
  const { address } = await C.deployFactory(deployer);
  const factory = C.factoryAt(address, deployer);
  await C.createMissing(factory, rows);
  const tokenAddr = await token.getAddress();

  const wrongTge = C.plan(C.MAINNET_TGE + 1, C.MONTH_30D, C.DEFAULT_BENEFICIARIES);
  await assert.rejects(C.verifyForFunding(provider, address, tokenAddr, wrongTge), /expected/);
  await assert.rejects(C.createMissing(factory, wrongTge), /different parameters/);

  const swapped = { ...C.DEFAULT_BENEFICIARIES, RESERVE: C.DEFAULT_BENEFICIARIES.TEAM };
  await assert.rejects(C.verifyForFunding(provider, address, tokenAddr, C.plan(C.MAINNET_TGE, C.MONTH_30D, swapped)), /RESERVE/);

  await (await factory.createVesting(await deployer.getAddress(), rows[0].bucket, rows[0].start, rows[0].duration, 0)).wait();
  await assert.rejects(C.verifyForFunding(provider, address, tokenAddr, rows), new RegExp(`${rows.length + 1} schedules`));
});

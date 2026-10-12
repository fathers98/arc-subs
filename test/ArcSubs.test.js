const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { newEnv, expectRevert, USDC } = require("./helpers");

const DAY = 24 * 3600;
const MONTH = 30 * DAY;

async function withPlan(env, price = USDC(9.99), period = MONTH, name = "Pro plan") {
  await (await env.subs.connect(env.merchant).createPlan(price, period, name)).wait();
  return 1n;
}

describe("plans", () => {
  test("createPlan stores the plan and emits an event", async () => {
    const env = await newEnv();
    const tx = await env.subs.connect(env.merchant).createPlan(USDC(5), DAY, "Daily news");
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => env.iface.parseLog(l)).find((l) => l && l.name === "PlanCreated");
    assert.equal(ev.args.planId, 1n);
    assert.equal(ev.args.merchant, await env.merchant.getAddress());
    const p = await env.subs.getPlan(1);
    assert.equal(p.price, USDC(5));
    assert.equal(p.period, BigInt(DAY));
    assert.equal(p.active, true);
    assert.equal(p.name, "Daily news");
    assert.equal(await env.subs.planCount(), 1n);
  });

  test("createPlan rejects zero price, too short period and long names", async () => {
    const env = await newEnv();
    await expectRevert(env.subs.connect(env.merchant).createPlan(0, DAY, "x"), env.iface, "InvalidPrice");
    await expectRevert(env.subs.connect(env.merchant).createPlan(USDC(1), 59, "x"), env.iface, "InvalidPeriod");
    await expectRevert(env.subs.connect(env.merchant).createPlan(USDC(1), DAY, "x".repeat(65)), env.iface, "NameTooLong");
    // boundary values are accepted
    await (await env.subs.connect(env.merchant).createPlan(1, 60, "x".repeat(64))).wait();
  });

  test("only the merchant can pause a plan; unknown plans are rejected", async () => {
    const env = await newEnv();
    await withPlan(env);
    await expectRevert(env.subs.connect(env.alice).setPlanActive(1, false), env.iface, "NotMerchant");
    await expectRevert(env.subs.connect(env.merchant).setPlanActive(99, false), env.iface, "UnknownPlan");
    await (await env.subs.connect(env.merchant).setPlanActive(1, false)).wait();
    assert.equal((await env.subs.getPlan(1)).active, false);
  });
});

describe("subscribe", () => {
  test("charges the first period straight to the merchant and schedules the next one", async () => {
    const env = await newEnv();
    await withPlan(env, USDC(9.99), MONTH);
    await env.fund(env.alice, USDC(100));
    const merchantAddr = await env.merchant.getAddress();

    const tx = await env.subs.connect(env.alice).subscribe(1);
    const rc = await tx.wait();
    const t = (await env.provider.getBlock(rc.blockNumber)).timestamp;

    assert.equal(await env.token.balanceOf(merchantAddr), USDC(9.99));
    assert.equal(await env.token.balanceOf(await env.alice.getAddress()), USDC(100) - USDC(9.99));
    assert.equal(await env.token.balanceOf(env.subsAddr), 0n, "the contract must never hold funds");

    const s = await env.subs.getSubscription(1);
    assert.equal(s.subscriber, await env.alice.getAddress());
    assert.equal(s.nextChargeAt, BigInt(t + MONTH));
    assert.equal(s.charges, 1n);
    assert.equal(s.active, true);
    assert.equal(await env.subs.activeSubscriptionOf(1, await env.alice.getAddress()), 1n);
  });

  test("reverts without allowance or balance, and the failed attempt leaves no trace", async () => {
    const env = await newEnv();
    await withPlan(env);
    await expectRevert(env.subs.connect(env.alice).subscribe(1), env.iface, "TransferFailed");
    await env.fund(env.alice, USDC(5), USDC(100)); // approved but not enough balance
    await expectRevert(env.subs.connect(env.alice).subscribe(1), env.iface, "TransferFailed");
    assert.equal(await env.subs.subscriptionCount(), 0n);
    assert.equal(await env.subs.activeSubscriptionOf(1, await env.alice.getAddress()), 0n);
  });

  test("rejects unknown plans, paused plans and duplicate active subscriptions", async () => {
    const env = await newEnv();
    await withPlan(env);
    await env.fund(env.alice, USDC(100));
    await expectRevert(env.subs.connect(env.alice).subscribe(7), env.iface, "UnknownPlan");
    await (await env.subs.connect(env.alice).subscribe(1)).wait();
    await expectRevert(env.subs.connect(env.alice).subscribe(1), env.iface, "AlreadySubscribed");
    await (await env.subs.connect(env.merchant).setPlanActive(1, false)).wait();
    await env.fund(env.bob, USDC(100));
    await expectRevert(env.subs.connect(env.bob).subscribe(1), env.iface, "PlanInactive");
  });

  test("different subscribers get independent subscriptions", async () => {
    const env = await newEnv();
    await withPlan(env, USDC(2), DAY);
    await env.fund(env.alice, USDC(10));
    await env.fund(env.bob, USDC(10));
    await (await env.subs.connect(env.alice).subscribe(1)).wait();
    await (await env.subs.connect(env.bob).subscribe(1)).wait();
    assert.equal(await env.token.balanceOf(await env.merchant.getAddress()), USDC(4));
    assert.equal((await env.subs.getSubscription(2)).subscriber, await env.bob.getAddress());
  });
});

describe("charge", () => {
  test("cannot be charged before it is due", async () => {
    const env = await newEnv();
    await withPlan(env, USDC(3), MONTH);
    await env.fund(env.alice, USDC(30));
    await (await env.subs.connect(env.alice).subscribe(1)).wait();
    await expectRevert(env.subs.connect(env.keeper).charge(1), env.iface, "NotDue");
    await env.warp(MONTH - 120);
    await expectRevert(env.subs.connect(env.keeper).charge(1), env.iface, "NotDue");
  });

  test("anyone can charge once due; money goes to the merchant; schedule advances by one period", async () => {
    const env = await newEnv();
    await withPlan(env, USDC(3), MONTH);
    await env.fund(env.alice, USDC(30));
    await (await env.subs.connect(env.alice).subscribe(1)).wait();
    const first = (await env.subs.getSubscription(1)).nextChargeAt;

    await env.warp(MONTH + 5);
    await (await env.subs.connect(env.keeper).charge(1)).wait();

    assert.equal(await env.token.balanceOf(await env.merchant.getAddress()), USDC(6));
    assert.equal(await env.token.balanceOf(await env.keeper.getAddress()), 0n, "keeper never receives funds");
    const s = await env.subs.getSubscription(1);
    assert.equal(s.charges, 2n);
    assert.equal(s.nextChargeAt, first + BigInt(MONTH));

    // a second charge in the same period is impossible
    await expectRevert(env.subs.connect(env.keeper).charge(1), env.iface, "NotDue");
  });

  test("a late keeper bills only ONE period and restarts the schedule (no back-billing)", async () => {
    const env = await newEnv();
    await withPlan(env, USDC(3), MONTH);
    await env.fund(env.alice, USDC(300));
    await (await env.subs.connect(env.alice).subscribe(1)).wait();

    await env.warp(MONTH * 5); // five periods overdue
    const rc = await (await env.subs.connect(env.keeper).charge(1)).wait();
    const t = (await env.provider.getBlock(rc.blockNumber)).timestamp;

    assert.equal(await env.token.balanceOf(await env.merchant.getAddress()), USDC(6), "only one extra charge");
    assert.equal((await env.subs.getSubscription(1)).nextChargeAt, BigInt(t + MONTH));
    await expectRevert(env.subs.connect(env.keeper).charge(1), env.iface, "NotDue");
  });

  test("a failed charge (allowance revoked) reverts and leaves state untouched; canCharge explains why", async () => {
    const env = await newEnv();
    await withPlan(env, USDC(3), MONTH);
    await env.fund(env.alice, USDC(30), USDC(3)); // allowance for the first period only
    await (await env.subs.connect(env.alice).subscribe(1)).wait();
    await env.warp(MONTH + 1);

    const before = await env.subs.getSubscription(1);
    let [ok, reason] = await env.subs.canCharge(1);
    assert.equal(ok, false);
    assert.equal(reason, 4n, "allowance too low");
    await expectRevert(env.subs.connect(env.keeper).charge(1), env.iface, "TransferFailed");
    const after = await env.subs.getSubscription(1);
    assert.equal(after.charges, before.charges);
    assert.equal(after.nextChargeAt, before.nextChargeAt);

    await (await env.token.connect(env.alice).approve(env.subsAddr, USDC(3))).wait();
    [ok, reason] = await env.subs.canCharge(1);
    assert.equal(ok, true);
    assert.equal(reason, 0n);
    await (await env.subs.connect(env.keeper).charge(1)).wait();
  });

  test("canCharge reports every reason correctly", async () => {
    const env = await newEnv();
    const cc = async (id) => {
      const r = await env.subs.canCharge(id);
      return [r[0], r[1]];
    };
    await withPlan(env, USDC(3), MONTH);
    assert.deepEqual(await cc(42), [false, 1n]); // unknown
    await env.fund(env.alice, USDC(3), USDC(100)); // balance for exactly one period
    await (await env.subs.connect(env.alice).subscribe(1)).wait();
    assert.deepEqual(await cc(1), [false, 3n]); // not due
    await env.warp(MONTH + 1);
    assert.deepEqual(await cc(1), [false, 5n]); // balance too low
    await (await env.token.mint(await env.alice.getAddress(), USDC(3))).wait();
    assert.deepEqual(await cc(1), [true, 0n]);
    await (await env.subs.connect(env.merchant).setPlanActive(1, false)).wait();
    assert.deepEqual(await cc(1), [false, 2n]); // plan paused
  });

  test("a paused plan stops renewals; resuming restores them", async () => {
    const env = await newEnv();
    await withPlan(env, USDC(3), MONTH);
    await env.fund(env.alice, USDC(30));
    await (await env.subs.connect(env.alice).subscribe(1)).wait();
    await env.warp(MONTH + 1);
    await (await env.subs.connect(env.merchant).setPlanActive(1, false)).wait();
    await expectRevert(env.subs.connect(env.keeper).charge(1), env.iface, "PlanInactive");
    await (await env.subs.connect(env.merchant).setPlanActive(1, true)).wait();
    await (await env.subs.connect(env.keeper).charge(1)).wait();
  });
});

describe("cancel", () => {
  test("subscriber can cancel; billing stops; they can subscribe again later", async () => {
    const env = await newEnv();
    await withPlan(env, USDC(3), MONTH);
    await env.fund(env.alice, USDC(30));
    await (await env.subs.connect(env.alice).subscribe(1)).wait();
    await (await env.subs.connect(env.alice).cancel(1)).wait();

    assert.equal((await env.subs.getSubscription(1)).active, false);
    assert.equal(await env.subs.activeSubscriptionOf(1, await env.alice.getAddress()), 0n);
    await env.warp(MONTH + 1);
    await expectRevert(env.subs.connect(env.keeper).charge(1), env.iface, "NotActive");
    await expectRevert(env.subs.connect(env.alice).cancel(1), env.iface, "NotActive");

    await (await env.subs.connect(env.alice).subscribe(1)).wait();
    assert.equal(await env.subs.activeSubscriptionOf(1, await env.alice.getAddress()), 2n);
  });

  test("the merchant can end a subscription; strangers cannot", async () => {
    const env = await newEnv();
    await withPlan(env);
    await env.fund(env.alice, USDC(30));
    await (await env.subs.connect(env.alice).subscribe(1)).wait();
    await expectRevert(env.subs.connect(env.bob).cancel(1), env.iface, "NotAuthorized");
    await expectRevert(env.subs.connect(env.alice).cancel(9), env.iface, "UnknownSubscription");
    await (await env.subs.connect(env.merchant).cancel(1)).wait();
    assert.equal((await env.subs.getSubscription(1)).active, false);
  });
});

describe("safety", () => {
  test("re-entering charge() from the token is blocked by the guard", async () => {
    const env = await newEnv("ReentrantUSDC");
    await withPlan(env, USDC(3), MONTH);
    await env.fund(env.alice, USDC(30));
    await (await env.subs.connect(env.alice).subscribe(1)).wait();
    await env.warp(MONTH + 1);

    await (await env.token.arm(env.subsAddr, 1)).wait();
    await (await env.subs.connect(env.keeper).charge(1)).wait();

    assert.equal(await env.token.reenterAttempted(), true);
    assert.equal(await env.token.reenterSucceeded(), false, "re-entrant call must fail");
    assert.equal(await env.token.balanceOf(await env.merchant.getAddress()), USDC(6), "charged exactly once");
    assert.equal((await env.subs.getSubscription(1)).charges, 2n);
  });

  test("a token address without code can never 'succeed' silently", async () => {
    const env = await newEnv();
    const { ethers } = require("./helpers");
    const fs = require("fs");
    const a = JSON.parse(fs.readFileSync(require("path").join(__dirname, "..", "build", "ArcSubs.json"), "utf8"));
    const f = new ethers.ContractFactory(a.abi, a.bytecode, env.deployer);
    const bad = await (await f.deploy(await env.bob.getAddress())).waitForDeployment(); // "token" is an EOA
    await (await bad.connect(env.merchant).createPlan(USDC(1), DAY, "x")).wait();
    await expectRevert(bad.connect(env.alice).subscribe(1), env.iface, "TransferFailed");
    assert.equal(await bad.subscriptionCount(), 0n);
  });

  test("the contract never holds USDC and rejects a zero token address", async () => {
    const env = await newEnv();
    await withPlan(env, USDC(3), DAY);
    await env.fund(env.alice, USDC(30));
    await (await env.subs.connect(env.alice).subscribe(1)).wait();
    await env.warp(DAY + 1);
    await (await env.subs.connect(env.keeper).charge(1)).wait();
    assert.equal(await env.token.balanceOf(env.subsAddr), 0n);

    const { ethers } = require("./helpers");
    const fs = require("fs");
    const a = JSON.parse(fs.readFileSync(require("path").join(__dirname, "..", "build", "ArcSubs.json"), "utf8"));
    const f = new ethers.ContractFactory(a.abi, a.bytecode, env.deployer);
    await expectRevert(f.deploy(ethers.ZeroAddress), env.iface, "ZeroAddress");
  });
});

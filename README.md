# ArcSubs: recurring USDC payments on Arc

Pull-based subscriptions for [Arc](https://docs.arc.io): a merchant publishes a plan (price in USDC, billing
period); a subscriber approves USDC once and subscribes; every later period can be charged by **anyone** once it is
due. Money goes straight from the subscriber's wallet to the merchant's wallet. **The contract never holds funds.**

* `contracts/ArcSubs.sol`: the contract (about 220 lines, no dependencies)
* `test/`: 18 tests (Node test runner, solc-js + an in-process EVM)
* `web/index.html`: a single-file web app (create plans, subscribe, cancel, keeper desk); no build step, ethers is vendored
* `scripts/`: compile, gas report, local dev chain

## Why this fits Arc

On Arc both the price **and** the gas fee are denominated in USDC. A merchant or keeper therefore knows in dollars
exactly what a billing cycle costs to run. Measured on a local EVM and priced at the 20 gwei `maxFeePerGas` floor
from the Arc docs (real cost depends on the network's current base fee):

| call | gas | ≈ cost in USDC |
|---|---:|---:|
| deploy | 1,266,862 | 0.0253 |
| `createPlan` | 115,206 | 0.0023 |
| `subscribe` (incl. first payment) | 184,196 | 0.0037 |
| `charge` (a renewal) | 63,667 | 0.0013 |
| `cancel` | 30,310 | 0.0006 |

A renewal costs about a tenth of a cent, so a keeper (or the merchant) can bill thousands of subscribers for a few dollars.

Arc detail worth knowing: native USDC (gas) has 18 decimals, the ERC-20 interface at
`0x3600000000000000000000000000000000000000` has 6. ArcSubs only uses the ERC-20 interface, so all prices are in 6-decimal base units.

## How it works

```
merchant ──createPlan(price, period, name)──▶ ArcSubs
subscriber ─approve(USDC, ArcSubs, amount)─▶ USDC
subscriber ─subscribe(planId)──▶ ArcSubs ──transferFrom(subscriber → merchant, price)──▶ USDC   (first period, immediately)
anyone ─────charge(subId)─────▶ ArcSubs ──transferFrom(subscriber → merchant, price)──▶ USDC   (once due)
subscriber or merchant ─cancel(subId)─▶ ArcSubs
```

Design decisions

* **Pull, not push.** The subscriber is in control: `cancel` is one call, and lowering/revoking the USDC allowance also stops billing.
* **Permissionless keepers.** `charge` can be called by anyone, but funds can only ever move subscriber → plan merchant, so a keeper cannot divert money.
* **No back-billing.** If a keeper is late, only **one** period is billed and the schedule restarts from that moment; nobody is charged for several missed periods at once.
* **Failed charges revert cleanly.** Missing allowance or balance reverts the whole call; state is untouched, and `canCharge(subId)` tells a keeper why (`allowance too low`, `balance too low`, `plan paused`, `not due yet`).
* **Plan paused ⇒ no new subscribers and no renewals.** Existing subscribers can still cancel.
* **Checks-effects-interactions + reentrancy guard.** State is written before the token call; a malicious token that re-enters `charge` is covered by a test.
* **No silent no-ops.** A token address without code can never make a transfer "succeed" while moving no funds.
* **Token-agnostic transfer.** Accepts tokens that return `true` or nothing.

### Contract API

| function | who | what |
|---|---|---|
| `createPlan(uint128 price, uint32 period, string name)` | merchant | publish a plan (period ≥ 60 s, name ≤ 64 bytes) |
| `setPlanActive(planId, bool)` | merchant | pause / resume |
| `subscribe(planId)` | subscriber | needs allowance ≥ price; charges period 1 immediately |
| `charge(subId)` | anyone | charge the next period once due (one period per call) |
| `cancel(subId)` | subscriber or merchant | stop the subscription |
| `getPlan`, `getSubscription`, `canCharge`, `activeSubscriptionOf` | view | |

Events: `PlanCreated`, `PlanStatusChanged`, `Subscribed`, `Charged`, `Cancelled`.

## Run it

```bash
npm install
npm test            # compiles and runs 18 tests
npm run gas         # gas report
npm run devnet      # local chain on :8545 with ArcSubs + a mock USDC (writes devnet.json)
npm run web         # serves web/ on :8088
```

Open `http://localhost:8088/?rpc=http://127.0.0.1:8545&chainId=1337&contract=<address from devnet.json>&usdc=<usdc from devnet.json>`
to try the whole flow locally with throwaway accounts. For Arc mainnet the defaults are already set
(`chainId 5042`, `https://rpc.mainnet.arc.io`, USDC `0x3600…0000`); just add `?contract=<deployed address>`,
or set `CFG.contract` at the top of `web/index.html`.

The tests were also verified end-to-end in a real browser (Chromium, injected wallet) against the local chain:
create plan, subscribe, time passes, a third party charges, the subscriber cancels, balances checked on-chain.

## Deploy to Arc mainnet

Network: chain id **5042**, RPC `https://rpc.mainnet.arc.io`, explorer `https://explorer.arc.io`, gas token USDC.

1. Fund a wallet with a little USDC on Arc (about 0.03 USDC covers a deploy plus a handful of calls).
2. Compile `contracts/ArcSubs.sol` (solc 0.8.28, optimizer 200 runs, EVM `paris`) in Remix, Foundry or Hardhat.
3. Deploy with the constructor argument `0x3600000000000000000000000000000000000000` (USDC).
4. Put the address into `CFG.contract` in `web/index.html` (or pass `?contract=`).

## Live deployment

See `DEPLOYMENT.md` (filled in after the mainnet deployment: contract address, explorer links, example transactions, demo URL).

## Limits and non-goals

No proration or refunds, fixed price per plan, one period charged per call, no `permit` support yet. This is a
small proof of concept built for the Arc Microgrants program and has **not been audited**; do not point it at
significant funds without a review.

## License

MIT

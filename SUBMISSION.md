# DoraHacks submission text (Arc Microgrants)

**Project:** ArcSubs: recurring USDC payments on Arc

**What it does (short):** A pull-based subscription contract for USDC. A merchant publishes a plan (price, billing
period). A subscriber approves USDC once and subscribes; the first period is paid immediately and every later period
can be charged by anyone (a keeper, the merchant, the subscriber) once it is due. Funds move directly from the
subscriber to the merchant; the contract never holds money. The subscriber can cancel in one call.

**What it uses Arc for:** USDC is both the unit of account and the gas token on Arc, so a merchant knows in dollars
exactly what a billing cycle costs: a renewal is about 64k gas (about 0.001 USDC at the 20 gwei floor). The contract
uses Arc's native USDC ERC-20 interface (`0x3600…0000`, 6 decimals) and is deployed on Arc mainnet.

**What is in the repo:** the Solidity contract (about 220 lines, no dependencies), 18 tests (including a re-entrancy
test, and a "late keeper is never back-billed" test), a single-file web app (create plans, subscribe, cancel, keeper
desk) verified end-to-end in a real browser, gas report, README with design notes and limitations.

**Links:** repo `TBD` · contract `TBD` · demo `TBD`

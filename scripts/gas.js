// Prints gas used by each ArcSubs call on a local EVM (used for the README cost table).
const { newEnv, USDC } = require("../test/helpers");
(async () => {
  const env = await newEnv();
  const used = async (tx) => (await (await tx).wait()).gasUsed;
  const out = {};
  const dep = await env.provider.getTransactionReceipt(env.subs.deploymentTransaction().hash);
  out.deploy = dep.gasUsed;
  out.createPlan = await used(env.subs.connect(env.merchant).createPlan(USDC(9.99), 2592000, "Pro plan"));
  await env.fund(env.alice, USDC(100));
  out.subscribe = await used(env.subs.connect(env.alice).subscribe(1));
  await env.warp(2592000 + 1);
  out.charge = await used(env.subs.connect(env.keeper).charge(1));
  out.cancel = await used(env.subs.connect(env.alice).cancel(1));
  for (const [k, v] of Object.entries(out)) console.log(k.padEnd(11), v.toString().padStart(8), "gas", " ≈", (Number(v) * 20e9 / 1e18).toFixed(4), "USDC at 20 gwei");
  process.exit(0);
})();

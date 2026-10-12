const fs = require("fs");
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const art = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "build", `${n}.json`), "utf8"));
const USDC = (n) => BigInt(Math.round(n * 1e6)); // 6-decimals base units

async function build(tokenName) {
  const eip1193 = ganache.provider({
    logging: { quiet: true },
    chain: { hardfork: "shanghai" },
    wallet: { deterministic: true, totalAccounts: 6 },
  });
  const provider = new ethers.BrowserProvider(eip1193);
  const [deployer, merchant, alice, bob, keeper] = await Promise.all([0, 1, 2, 3, 4].map((i) => provider.getSigner(i)));

  const tokArt = art(tokenName);
  const token = await (await new ethers.ContractFactory(tokArt.abi, tokArt.bytecode, deployer).deploy()).waitForDeployment();
  const subsArt = art("ArcSubs");
  const subs = await (await new ethers.ContractFactory(subsArt.abi, subsArt.bytecode, deployer).deploy(await token.getAddress())).waitForDeployment();

  const iface = new ethers.Interface(subsArt.abi);
  const subsAddr = await subs.getAddress();

  async function fund(signer, amount, approve = amount) {
    await (await token.mint(await signer.getAddress(), amount)).wait();
    if (approve) await (await token.connect(signer).approve(subsAddr, approve)).wait();
  }
  async function warp(seconds) {
    await eip1193.request({ method: "evm_increaseTime", params: [seconds] });
    await eip1193.request({ method: "evm_mine", params: [] });
  }
  async function now() {
    return (await provider.getBlock("latest")).timestamp;
  }
  return { eip1193, provider, token, subs, iface, subsAddr, deployer, merchant, alice, bob, keeper, fund, warp, now, snap: null };
}

// One chain per token type, rewound to a clean snapshot before every test (much faster than a new chain).
const cache = {};
async function newEnv(tokenName = "MockUSDC") {
  let env = cache[tokenName];
  if (!env) {
    env = await build(tokenName);
    cache[tokenName] = env;
  } else {
    await env.eip1193.request({ method: "evm_revert", params: [env.snap] });
  }
  env.snap = await env.eip1193.request({ method: "evm_snapshot", params: [] });
  return env;
}

/** Asserts that `promise` reverts with the named custom error. */
async function expectRevert(promise, iface, errorName) {
  try {
    await promise;
  } catch (e) {
    const raw = [
      e.data,
      e.error && e.error.data,
      e.info && e.info.error && e.info.error.data,
      e.info && e.info.error && e.info.error.data && e.info.error.data.result,
      e.error && e.error.data && e.error.data.result,
    ];
    const candidates = raw.filter((x) => typeof x === "string" && x.startsWith("0x") && x.length >= 10);
    for (const data of candidates) {
      const parsed = iface.parseError(data);
      if (parsed) {
        if (parsed.name === errorName) return;
        throw new Error(`expected revert ${errorName}, got ${parsed.name}`);
      }
    }
    if (e.revert && e.revert.name === errorName) return;
    if (String(e.message).includes(errorName)) return;
    throw new Error(`expected revert ${errorName}, got: ${e.shortMessage || e.message}`);
  }
  throw new Error(`expected revert ${errorName}, but the call succeeded`);
}

module.exports = { newEnv, expectRevert, USDC, ethers };

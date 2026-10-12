// Local dev chain with ArcSubs + a mock USDC already deployed, for trying the web app without any real funds.
//   node scripts/devnet.js   (needs `npm run build` first)
const fs = require("fs");
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const art = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "build", `${n}.json`), "utf8"));

(async () => {
  const server = ganache.server({
    logging: { quiet: true },
    chain: { hardfork: "shanghai", chainId: 1337 },
    wallet: { deterministic: true, totalAccounts: 6 },
  });
  await server.listen(8545);
  const provider = new ethers.BrowserProvider(server.provider);
  const signers = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => provider.getSigner(i)));
  const [deployer] = signers;

  const t = art("MockUSDC");
  const token = await (await new ethers.ContractFactory(t.abi, t.bytecode, deployer).deploy()).waitForDeployment();
  const a = art("ArcSubs");
  const subs = await (await new ethers.ContractFactory(a.abi, a.bytecode, deployer).deploy(await token.getAddress())).waitForDeployment();
  for (const s of signers) await (await token.mint(await s.getAddress(), 100_000_000n)).wait(); // 100 USDC each

  const info = {
    rpc: "http://127.0.0.1:8545",
    chainId: 1337,
    usdc: await token.getAddress(),
    contract: await subs.getAddress(),
    accounts: await Promise.all(signers.map((s) => s.getAddress())),
  };
  fs.writeFileSync(process.argv[2] || "devnet.json", JSON.stringify(info, null, 2));
  console.log("devnet ready", info.contract);
})();

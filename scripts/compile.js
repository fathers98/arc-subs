// Compiles every .sol under contracts/ with solc-js and writes build/<Contract>.json {abi, bytecode}.
const fs = require("fs");
const path = require("path");
const solc = require("solc");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".sol") ? [path.join(dir, e.name)] : []
  );
}

const root = path.join(__dirname, "..");
const files = walk(path.join(root, "contracts"));
const sources = {};
for (const f of files) sources[path.relative(root, f)] = { content: fs.readFileSync(f, "utf8") };

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "paris", // widest EVM compatibility; no PUSH0 required
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
let failed = false;
for (const e of out.errors || []) {
  console.error(e.formattedMessage);
  if (e.severity === "error") failed = true;
}
if (failed) process.exit(1);

fs.mkdirSync(path.join(root, "build"), { recursive: true });
for (const [file, contracts] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    fs.writeFileSync(
      path.join(root, "build", `${name}.json`),
      JSON.stringify({ abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 2)
    );
    console.log(`compiled ${name} (${file})`);
  }
}

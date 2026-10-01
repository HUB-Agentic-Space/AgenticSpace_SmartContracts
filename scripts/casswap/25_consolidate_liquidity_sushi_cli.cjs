#!/usr/bin/env node
// Hardhat 2 does not forward script arguments. Keep user-facing flags intact
// by serialising them into the child environment, not into a shell command.
const { spawnSync } = require("node:child_process");
const result = spawnSync("npx", ["hardhat", "run", "scripts/casswap/25_consolidate_liquidity_sushi.ts", "--network", "polygon"], {
  cwd: process.cwd(), stdio: "inherit", env: { ...process.env, CONSOLIDATE_SUSHI_ARGS: JSON.stringify(process.argv.slice(2)) }, shell: false,
});
process.exit(result.status ?? 1);

const { JsonRpcProvider, Wallet, formatEther } = require("ethers");
require("dotenv").config();
(async () => {
  for (const url of ["https://polygon.drpc.org","https://polygon-bor-rpc.publicnode.com"]) {
    try {
      const p = new JsonRpcProvider(url, 137, { staticNetwork: true });
      const w = new Wallet(process.env.POLYGON_PRIVATE_KEY, p);
      console.log(url, w.address, formatEther(await p.getBalance(w.address)), "POL");
      break;
    } catch (e) { console.log(url, "FAIL", (e.shortMessage||e.message||"").slice(0,80)); }
  }
})();

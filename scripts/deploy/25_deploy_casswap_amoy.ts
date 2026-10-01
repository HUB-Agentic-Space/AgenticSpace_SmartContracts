import { ethers, network } from "hardhat";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { IDiamondCut } from "../../typechain-types";

function selectorsOf(contract: any): string[] {
  const selectors: string[] = [];
  contract.interface.forEachFunction((fragment: any) => selectors.push(fragment.selector));
  return [...new Set(selectors)];
}

function log(level: string, message: string, details = ""): void {
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  console.log(`[${timestamp}] [25_deploy_casswap_amoy:main] ${level} ${message}${details ? ` - ${details}` : ""}`);
}

async function deployed(name: string, signer: any, args: any[] = []): Promise<any> {
  const factory = await ethers.getContractFactory(name, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  log("info", "contract_deployed", `name=${name} address=${await contract.getAddress()}`);
  return contract;
}

async function main(): Promise<void> {
  if (network.config.chainId !== 80002) throw new Error("This script only runs on Polygon Amoy (chainId 80002)");

  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  if (balance < ethers.parseEther("0.2")) throw new Error("Amoy deployer requires at least 0.2 POL");
  log("info", "deployment_started", `network=${network.name} deployer=${deployer.address} balance=${ethers.formatEther(balance)}`);

  const cas = await deployed("MockERC20", deployer, ["CAS Token Amoy", "CAS", 18]);
  const usdc = await deployed("MockERC20", deployer, ["USD Coin Amoy", "USDC", 6]);
  const cutFacet = await deployed("DiamondCutFacet", deployer);

  const initialCut: IDiamondCut.FacetCutStruct[] = [{
    facetAddress: await cutFacet.getAddress(),
    action: 0,
    functionSelectors: selectorsOf(cutFacet),
  }];
  const diamond = await deployed("Diamond", deployer, [deployer.address, initialCut]);
  const diamondAddress = await diamond.getAddress();

  const facetNames = [
    "DiamondLoupeFacet",
    "OwnershipFacet",
    "CASSwapUSDCPOLFacet",
    "CASSwapWrapperFacet",
    "TraderGovernanceFacet",
  ];
  const cuts: IDiamondCut.FacetCutStruct[] = [];
  const facetAddresses: Record<string, string> = { DiamondCutFacet: await cutFacet.getAddress() };
  const seen = new Set<string>(selectorsOf(cutFacet));

  for (const name of facetNames) {
    const facet = await deployed(name, deployer);
    const address = await facet.getAddress();
    const selectors = selectorsOf(facet);
    for (const selector of selectors) {
      if (seen.has(selector)) throw new Error(`Selector collision ${selector} in ${name}`);
      seen.add(selector);
    }
    facetAddresses[name] = address;
    cuts.push({ facetAddress: address, action: 0, functionSelectors: selectors });
  }

  const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddress, deployer);
  await diamondCut.diamondCut.staticCall(cuts, ethers.ZeroAddress, "0x");
  const cutTx = await diamondCut.diamondCut(cuts, ethers.ZeroAddress, "0x");
  await cutTx.wait();
  log("info", "diamond_cut_confirmed", `tx=${cutTx.hash} selectors=${seen.size}`);

  const swap = await ethers.getContractAt("CASSwapUSDCPOLFacet", diamondAddress, deployer);
  const casAddress = await cas.getAddress();
  const usdcAddress = await usdc.getAddress();
  await (await swap.initCASSwapUSDCPOL(casAddress, usdcAddress)).wait();
  await (await swap.setMaxImpactBps(0)).wait();
  await (await swap.setSwapRatioUSDC(1_000_000_000_000n, 1n)).wait();
  await (await swap.setSwapRatioUSDCSell(1_000_000_000_000n, 1n)).wait();
  await (await swap.setMaxImpactBps(1000)).wait();

  await (await cas.mint(diamondAddress, ethers.parseEther("100000"))).wait();
  await (await usdc.mint(diamondAddress, 100_000n * 1_000_000n)).wait();
  const fundTx = await deployer.sendTransaction({ to: diamondAddress, value: ethers.parseEther("0.05") });
  await fundTx.wait();

  const deployment = {
    network: network.name,
    chainId: network.config.chainId,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    diamond: diamondAddress,
    casToken: casAddress,
    usdcToken: usdcAddress,
    facets: facetAddresses,
    diamondCutTx: cutTx.hash,
    fundingTx: fundTx.hash,
  };
  const output = resolve(__dirname, "../../deployments/casswap-amoy.json");
  writeFileSync(output, `${JSON.stringify(deployment, null, 2)}\n`, "utf8");
  log("info", "deployment_completed", `diamond=${diamondAddress} output=${output}`);
}

main().catch((error) => {
  log("error", "deployment_failed", `message=${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
});

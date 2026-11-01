import { ethers, network } from "hardhat";
import { impersonateAccount, setBalance, stopImpersonatingAccount, time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * @file claim_facets_fork.ts
 * @description Simula em fork da Polygon mainnet o fluxo completo de governança
 *              dos facets de claim: deploy das implementações, verificação de
 *              colisão de seletores, agendamento em batch no Timelock pela Safe
 *              real (impersonada), avanço de 48h e execução via executeBatch
 *              com o Diamond, owner e Safe de produção. Valida selectors,
 *              inicialização do vault/NFT e suporte ao CAS existente.
 *              Uso: HARDHAT_FORK_URL=<rpc-polygon> npx hardhat run
 *              scripts/fork/claim_facets_fork.ts --network hardhat
 *
 * Author:  Carlos Delfino
 * Email:   consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 */

const DIAMOND = "0x80BD976cB588cD2F9aD9Ac671FB19174E9F3172b";
const TIMELOCK = "0x6e14dA17C2B9df7A5d829897F9c39b61D9E8d4B5";
const SAFE = "0x1743abe1A64DAB3c81e394adb4e3B56ef05F0D26";
const DELAY = 172800n;

const TIMELOCK_ABI = [
  "function scheduleBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt,uint256 delay)",
  "function executeBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt) payable",
  "function hashOperationBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt) view returns(bytes32)",
  "function isOperationPending(bytes32) view returns(bool)",
  "function isOperationReady(bytes32) view returns(bool)",
  "function isOperationDone(bytes32) view returns(bool)",
  "function getTimestamp(bytes32) view returns(uint256)",
];

function log(level: string, message: string, details = ""): void {
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  console.log(`[${timestamp}] [claim_facets_fork:main] ${level} ${message}${details ? ` - ${details}` : ""}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

async function main(): Promise<void> {
  assert(network.config.chainId === 137 && network.config.forking?.enabled, "Execute em fork da Polygon: HARDHAT_FORK_URL definido e chainId=137");
  const casToken = process.env.CAS_TOKEN_ADDRESS;
  assert(casToken && ethers.isAddress(casToken), "CAS_TOKEN_ADDRESS obrigatório e válido");

  const [deployer] = await ethers.getSigners();
  log("info", "fork_start", `block=${await ethers.provider.getBlockNumber()} deployer=${deployer.address} cas=${casToken}`);

  const vaultFactory = await ethers.getContractFactory("ClaimVaultFacet");
  const vaultImpl = await vaultFactory.deploy();
  await vaultImpl.waitForDeployment();
  const vaultAddress = await vaultImpl.getAddress();
  const nftFactory = await ethers.getContractFactory("ClaimNFTFacet");
  const nftImpl = await nftFactory.deploy();
  await nftImpl.waitForDeployment();
  const nftAddress = await nftImpl.getAddress();
  log("info", "facets_deployed", `vault=${vaultAddress} nft=${nftAddress}`);

  const loupe = await ethers.getContractAt("DiamondLoupeFacet", DIAMOND);
  const collect = (contract: { interface: any }) => {
    const list: string[] = [];
    contract.interface.forEachFunction((f: any) => list.push(f.selector));
    return [...new Set(list)];
  };
  const vaultSelectors = collect(vaultFactory);
  const nftSelectors = collect(nftFactory);
  for (const sel of [...vaultSelectors, ...nftSelectors]) {
    const mapped = await loupe.facetAddress(sel);
    assert(mapped === ethers.ZeroAddress, `Colisão de seletor ${sel} -> ${mapped}`);
  }
  log("info", "collision_check_passed", `selectors=${vaultSelectors.length + nftSelectors.length}`);

  const claimSigner = deployer.address;
  const baseURI = "https://hubagentic.space/api/v1/nft/claim/";
  const vaultInit = vaultFactory.interface.encodeFunctionData("initClaimVault", [claimSigner]);
  const cutInterface = new ethers.Interface([
    "function diamondCut((address facetAddress,uint8 action,bytes4[] functionSelectors)[] cut,address init,bytes calldata data)",
  ]);
  const cuts = [
    { facetAddress: vaultAddress, action: 0, functionSelectors: vaultSelectors },
    { facetAddress: nftAddress, action: 0, functionSelectors: nftSelectors },
  ];
  const cutCalldata = cutInterface.encodeFunctionData("diamondCut", [cuts, vaultAddress, vaultInit]);
  const nftInitCalldata = nftFactory.interface.encodeFunctionData("initClaimNFT", ["Rapport Claim", "RCLAIM", baseURI]);
  const assetCalldata = vaultFactory.interface.encodeFunctionData("setClaimAssetSupport", [casToken, true]);

  const targets = [DIAMOND, DIAMOND, DIAMOND];
  const values = [0, 0, 0];
  const payloads = [cutCalldata, nftInitCalldata, assetCalldata];
  const predecessor = ethers.ZeroHash;
  const salt = ethers.keccak256(ethers.toUtf8Bytes(`ClaimFacets:${vaultAddress}:${nftAddress}:v1`));

  const timelock = new ethers.Contract(TIMELOCK, TIMELOCK_ABI, ethers.provider);
  const operationId = await timelock.hashOperationBatch(targets, values, payloads, predecessor, salt);
  assert(!(await timelock.isOperationPending(operationId)), "Operação já pendente no fork — salt conflita com operação real");

  // Agenda no Timelock impersonando a Safe (PROPOSER_ROLE real de produção).
  await impersonateAccount(SAFE);
  await setBalance(SAFE, ethers.parseEther("10"));
  const safeSigner = await ethers.getSigner(SAFE);
  const scheduleTx = await timelock.connect(safeSigner).scheduleBatch(targets, values, payloads, predecessor, salt, DELAY);
  await scheduleTx.wait();
  await stopImpersonatingAccount(SAFE);
  assert(await timelock.isOperationPending(operationId), "Operação não ficou pendente no Timelock");
  const readyAt = await timelock.getTimestamp(operationId);
  log("info", "scheduled", `operationId=${operationId} readyAt=${new Date(Number(readyAt) * 1000).toISOString()}`);

  // Executável somente após 48h reais de delay.
  await time.increase(Number(DELAY) + 60);
  assert(await timelock.isOperationReady(operationId), "Operação não ficou pronta após avanço de tempo");

  const execTx = await timelock.connect(deployer).executeBatch(targets, values, payloads, predecessor, salt);
  await execTx.wait();
  assert(await timelock.isOperationDone(operationId), "Operação não consta como executada");
  log("info", "executed", `tx=${execTx.hash}`);

  // Verificação pós-upgrade no estado real do Diamond.
  for (const sel of vaultSelectors) {
    assert((await loupe.facetAddress(sel)).toLowerCase() === vaultAddress.toLowerCase(), `Seletor vault ${sel} não registrado`);
  }
  for (const sel of nftSelectors) {
    assert((await loupe.facetAddress(sel)).toLowerCase() === nftAddress.toLowerCase(), `Seletor nft ${sel} não registrado`);
  }
  const vaultAtDiamond = await ethers.getContractAt("ClaimVaultFacet", DIAMOND);
  assert((await vaultAtDiamond.getClaimSigner()) === claimSigner, "claimSigner divergente");
  assert(await vaultAtDiamond.isClaimAssetSupported(casToken), "CAS não suportado");
  assert(await vaultAtDiamond.isClaimAssetSupported(ethers.ZeroAddress), "Ativo nativo não suportado");
  const [casBalance, committed] = await vaultAtDiamond.getVaultBalance(casToken);
  const nftAtDiamond = await ethers.getContractAt("ClaimNFTFacet", DIAMOND);
  assert((await nftAtDiamond.name()) === "Rapport Claim", "name divergente");
  assert((await nftAtDiamond.symbol()) === "RCLAIM", "symbol divergente");
  const erc165 = new ethers.Contract(DIAMOND, ["function supportsInterface(bytes4) view returns(bool)"], ethers.provider);
  assert(await erc165.supportsInterface("0x80ac58cd"), "ERC-721 não registrado no ERC-165");
  assert(await erc165.supportsInterface("0xb45a3c0e"), "ERC-5192 não registrado no ERC-165");

  log("info", "fork_passed", `selectors=${vaultSelectors.length + nftSelectors.length} casBalance=${casBalance} committed=${committed} operationId=${operationId}`);
}

main().catch((error) => {
  log("error", "fork_failed", `message=${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
});

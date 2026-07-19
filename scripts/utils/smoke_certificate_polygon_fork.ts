import { ethers, network } from "hardhat";

const CANONICAL_ERC6551_REGISTRY =
  "0x000000006551c19487814612e58FE06813775758";
const MIN_CAS = ethers.parseEther("50");
const BASE_URI =
  "https://agenticspace.rapport.tec.br/api/v1/certificates/token/";

const AUTH_TYPES = {
  CertificateMintAuthorization: [
    { name: "issuanceId", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "nameHash", type: "bytes32" },
    { name: "phaseId", type: "uint256" },
    { name: "metadataHash", type: "bytes32" },
    { name: "casAmount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

async function main() {
  const polygonRpcUrl = process.env.POLYGON_RPC_URL?.trim();
  if (!polygonRpcUrl) {
    throw new Error("POLYGON_RPC_URL is required for the Polygon fork smoke test.");
  }

  await network.provider.request({
    method: "hardhat_reset",
    params: [{ forking: { jsonRpcUrl: polygonRpcUrl } }],
  });

  const registryCode = await ethers.provider.getCode(
    CANONICAL_ERC6551_REGISTRY,
  );
  if (registryCode === "0x") {
    throw new Error("Canonical ERC-6551 registry is absent from the Polygon fork.");
  }

  const [admin, issuer, holder] = await ethers.getSigners();
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const cas = await MockERC20.deploy("Fork CAS", "CAS", 18) as any;
  await cas.waitForDeployment();

  const Account = await ethers.getContractFactory("RapportCertificateAccount");
  const accountImplementation = await Account.deploy() as any;
  await accountImplementation.waitForDeployment();

  const Certificate = await ethers.getContractFactory("RapportCertificate");
  const certificate = await Certificate.deploy(
    admin.address,
    await cas.getAddress(),
    CANONICAL_ERC6551_REGISTRY,
    await accountImplementation.getAddress(),
    BASE_URI,
  ) as any;
  await certificate.waitForDeployment();
  await (await certificate.grantRole(
    await certificate.ISSUER_ROLE(),
    issuer.address,
  )).wait();

  await (await cas.mint(holder.address, MIN_CAS)).wait();
  await (await cas.connect(holder).approve(
    await certificate.getAddress(),
    MIN_CAS,
  )).wait();

  const latestBlock = await ethers.provider.getBlock("latest");
  if (!latestBlock) throw new Error("Fork latest block is unavailable.");
  const authorization = {
    issuanceId: ethers.keccak256(ethers.toUtf8Bytes("polygon-fork-smoke")),
    recipient: holder.address,
    nameHash: ethers.keccak256(ethers.toUtf8Bytes("Titular Fork")),
    phaseId: 1n,
    metadataHash: ethers.keccak256(ethers.toUtf8Bytes("metadata-fork-v1")),
    casAmount: MIN_CAS,
    nonce: 0n,
    deadline: BigInt(latestBlock.timestamp + 3600),
  };
  const forkNetwork = await ethers.provider.getNetwork();
  const signature = await issuer.signTypedData(
    {
      name: "RapportCertificate",
      version: "1",
      chainId: forkNetwork.chainId,
      verifyingContract: await certificate.getAddress(),
    },
    AUTH_TYPES,
    authorization,
  );

  await (await certificate.connect(holder).mintCertificate(
    authorization,
    issuer.address,
    signature,
  )).wait();

  const accountAddress = await certificate.tokenBoundAccount(1);
  const account = await ethers.getContractAt(
    "RapportCertificateAccount",
    accountAddress,
  ) as any;
  const [context, owner, casBalance] = await Promise.all([
    account.token(),
    account.owner(),
    cas.balanceOf(accountAddress),
  ]);
  if (
    context.chainId !== forkNetwork.chainId
    || context.tokenContract.toLowerCase()
      !== (await certificate.getAddress()).toLowerCase()
    || context.tokenId !== 1n
    || owner.toLowerCase() !== holder.address.toLowerCase()
    || casBalance !== MIN_CAS
  ) {
    throw new Error(
      `Canonical registry smoke verification failed: chain=${context.chainId}, `
      + `token=${context.tokenContract}, tokenId=${context.tokenId}, owner=${owner}, `
      + `CAS=${casBalance}.`,
    );
  }

  console.log("[certificate-fork-smoke] Polygon registry code: present");
  console.log("[certificate-fork-smoke] TBA:", accountAddress);
  console.log("[certificate-fork-smoke] Owner/context/CAS: verified");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

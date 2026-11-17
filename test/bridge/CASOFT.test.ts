/**
 * @file CASOFT.test.ts
 * @notice Testes do bridge LayerZero OFT: CASOFTAdapter (Polygon, lock/unlock)
 *         + CASOFT (BSC, mint/burn) usando EndpointV2Mock.
 * @dev    Verifica:
 *           - metadados e ownership (delegate) dos dois contratos;
 *           - acesso restrito de setPeer (onlyOwner);
 *           - send A->B com lock do CAS na origem e mint 1:1 na BSC;
 *           - send reverso B->A (burn na BSC, unlock na Polygon);
 *           - revert quando o CASToken esta pausado;
 *           - quoteSend retorna fee consistente.
 *
 * Author:  Carlos Delfino
 * Email:   consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 */
import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

// EndpointV2Mock vem pre-compilado no test-devtools; o campo "exports" do
// pacote nao expoe ./artifacts, entao lemos o JSON direto do node_modules.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require("path");
const _devtoolsPkg = require.resolve("@layerzerolabs/test-devtools-evm-hardhat/package.json");
const EndpointV2MockArtifact = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(_devtoolsPkg),
      "artifacts/contracts/mocks/EndpointV2Mock.sol/EndpointV2Mock.json",
    ),
    "utf8",
  ),
);

// Bytecode REAL do CASv2 (compilado no branch release/cas-v2) — fixture que
// prova o adapter funcionar com a versao em producao do token.
const CASTokenV2Artifact = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../fixtures/CASTokenV2.json"),
    "utf8",
  ),
);

const COMPLIANCE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("COMPLIANCE_ROLE"));

const EID_A = 30109; // Polygon
const EID_B = 30102; // BSC
const INITIAL_SUPPLY = ethers.parseEther("1000000"); // 1M CAS
const SEND_AMOUNT = ethers.parseEther("500000"); // 500k CAS

/** extraOptions type-3: executor lzReceive(gas, value). */
function lzReceiveOptions(gasLimit: bigint, msgValue = 0n): string {
  const data = ethers.solidityPacked(["uint128", "uint128"], [gasLimit, msgValue]);
  const optionSize = 1 + 32;
  return "0x0003" + "01" + optionSize.toString(16).padStart(4, "0") + "01" + data.slice(2);
}

async function deployFixture() {
  const [owner, delegate, user] = await ethers.getSigners();

  // CASToken (UUPS proxy) — admin = owner
  const CASToken = await ethers.getContractFactory("CASToken");
  const casToken: any = await upgrades.deployProxy(
    CASToken,
    [owner.address, INITIAL_SUPPLY, "Cryptocoin Agentic Space", "CAS"],
    { kind: "uups" },
  );
  await casToken.waitForDeployment();

  // Endpoints mock (A = Polygon, B = BSC)
  const MockFactory = new ethers.ContractFactory(
    EndpointV2MockArtifact.abi,
    EndpointV2MockArtifact.bytecode,
    owner,
  );
  const mockA: any = await MockFactory.deploy(EID_A);
  const mockB: any = await MockFactory.deploy(EID_B);
  const mockAAddr = await mockA.getAddress();
  const mockBAddr = await mockB.getAddress();

  // OApps
  const AdapterFactory = await ethers.getContractFactory("CASOFTAdapter");
  const adapter: any = await AdapterFactory.deploy(
    await casToken.getAddress(),
    mockAAddr,
    delegate.address,
  );
  const OftFactory = await ethers.getContractFactory("CASOFT");
  const oft: any = await OftFactory.deploy(mockBAddr, delegate.address);
  const adapterAddr = await adapter.getAddress();
  const oftAddr = await oft.getAddress();

  // Wiring: endpoints dest + peers
  await mockA.setDestLzEndpoint(oftAddr, mockBAddr);
  await mockB.setDestLzEndpoint(adapterAddr, mockAAddr);
  await adapter.connect(delegate).setPeer(EID_B, ethers.zeroPadValue(oftAddr, 32));
  await oft.connect(delegate).setPeer(EID_A, ethers.zeroPadValue(adapterAddr, 32));

  return { owner, delegate, user, casToken, mockA, mockB, adapter, oft, adapterAddr, oftAddr };
}

function sendParam(dstEid: number, to: string, amount: bigint) {
  return {
    dstEid,
    to: ethers.zeroPadValue(to, 32),
    amountLD: amount,
    minAmountLD: amount,
    extraOptions: lzReceiveOptions(200_000n),
    composeMsg: "0x",
    oftCmd: "0x",
  };
}

describe("CASOFT bridge (LayerZero OFT)", function () {
  it("deploy: metadados e ownership corretos", async function () {
    const { casToken, adapter, oft, delegate } = await loadFixture(deployFixture);

    expect(await adapter.token()).to.equal(await casToken.getAddress());
    expect(await adapter.owner()).to.equal(delegate.address);
    expect(await oft.name()).to.equal("Cryptocoin Agentic Space");
    expect(await oft.symbol()).to.equal("CAS");
    expect(await oft.decimals()).to.equal(18);
    expect(await oft.owner()).to.equal(delegate.address);
    expect(await oft.token()).to.equal(await oft.getAddress());
  });

  it("setPeer: apenas owner (delegate)", async function () {
    const { adapter, user, oftAddr } = await loadFixture(deployFixture);
    await expect(
      adapter.connect(user).setPeer(EID_B, ethers.zeroPadValue(oftAddr, 32)),
    ).to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount");
  });

  it("quoteSend retorna fee nativa", async function () {
    const { adapter, owner } = await loadFixture(deployFixture);
    const param = sendParam(EID_B, owner.address, SEND_AMOUNT);
    const fee = await adapter.quoteSend(param, false);
    expect(fee.nativeFee).to.be.gte(0n);
  });

  it("send A->B: trava CAS na Polygon e minta 1:1 na BSC", async function () {
    const { owner, casToken, adapter, oft, adapterAddr } = await loadFixture(deployFixture);

    const param = sendParam(EID_B, owner.address, SEND_AMOUNT);
    const fee = await adapter.quoteSend(param, false);

    await casToken.connect(owner).approve(adapterAddr, SEND_AMOUNT);
    await adapter.connect(owner).send(
      param,
      { nativeFee: fee.nativeFee, lzTokenFee: 0n },
      owner.address,
      { value: fee.nativeFee },
    );

    // CAS saiu do owner e ficou travado no adapter
    expect(await casToken.balanceOf(owner.address)).to.equal(INITIAL_SUPPLY - SEND_AMOUNT);
    expect(await casToken.balanceOf(adapterAddr)).to.equal(SEND_AMOUNT);
    // OFT mintado 1:1 na BSC
    expect(await oft.balanceOf(owner.address)).to.equal(SEND_AMOUNT);
  });

  it("send B->A: queima OFT na BSC e libera CAS na Polygon", async function () {
    const { owner, casToken, adapter, oft, adapterAddr } = await loadFixture(deployFixture);

    // ida
    const paramAB = sendParam(EID_B, owner.address, SEND_AMOUNT);
    const feeAB = await adapter.quoteSend(paramAB, false);
    await casToken.connect(owner).approve(adapterAddr, SEND_AMOUNT);
    await adapter.connect(owner).send(
      paramAB, { nativeFee: feeAB.nativeFee, lzTokenFee: 0n }, owner.address,
      { value: feeAB.nativeFee },
    );

    // volta
    const paramBA = sendParam(EID_A, owner.address, SEND_AMOUNT);
    const feeBA = await oft.quoteSend(paramBA, false);
    await oft.connect(owner).send(
      paramBA, { nativeFee: feeBA.nativeFee, lzTokenFee: 0n }, owner.address,
      { value: feeBA.nativeFee },
    );

    expect(await oft.balanceOf(owner.address)).to.equal(0n);
    expect(await casToken.balanceOf(adapterAddr)).to.equal(0n);
    expect(await casToken.balanceOf(owner.address)).to.equal(INITIAL_SUPPLY);
  });

  it("send reverte quando CASToken esta pausado", async function () {
    const { owner, casToken, adapter, adapterAddr } = await loadFixture(deployFixture);
    await casToken.connect(owner).pause();

    const param = sendParam(EID_B, owner.address, SEND_AMOUNT);
    const fee = await adapter.quoteSend(param, false);
    await expect(
      adapter.connect(owner).send(
        param, { nativeFee: fee.nativeFee, lzTokenFee: 0n }, owner.address,
        { value: fee.nativeFee },
      ),
    ).to.be.reverted;
  });

  it("send reverte com deployer FROZEN (guarda do CAS dev/main)", async function () {
    const { owner, casToken, adapter, adapterAddr } = await loadFixture(deployFixture);
    await casToken.connect(owner).grantRole(COMPLIANCE_ROLE, owner.address);
    await casToken.connect(owner).freeze(owner.address);

    const param = sendParam(EID_B, owner.address, SEND_AMOUNT);
    const fee = await adapter.quoteSend(param, false);
    await casToken.connect(owner).approve(adapterAddr, SEND_AMOUNT);
    await expect(
      adapter.connect(owner).send(
        param, { nativeFee: fee.nativeFee, lzTokenFee: 0n }, owner.address,
        { value: fee.nativeFee },
      ),
    ).to.be.reverted;
  });

  it("send reverte com votingLock ativo (guarda do CAS dev/main)", async function () {
    const { owner, casToken, adapter, adapterAddr } = await loadFixture(deployFixture);
    await casToken.connect(owner).grantRole(COMPLIANCE_ROLE, owner.address);
    await casToken.connect(owner).setVotingLock(true);

    const param = sendParam(EID_B, owner.address, SEND_AMOUNT);
    const fee = await adapter.quoteSend(param, false);
    await casToken.connect(owner).approve(adapterAddr, SEND_AMOUNT);
    await expect(
      adapter.connect(owner).send(
        param, { nativeFee: fee.nativeFee, lzTokenFee: 0n }, owner.address,
        { value: fee.nativeFee },
      ),
    ).to.be.reverted;
  });

  it("unlock B->A com destinatario FROZEN: entrega falha (CAS seguro no adapter) e retry apos unfreeze libera", async function () {
    const { owner, user, casToken, adapter, oft, adapterAddr, mockA, oftAddr } =
      await loadFixture(deployFixture);

    // ida para a BSC
    const paramAB = sendParam(EID_B, owner.address, SEND_AMOUNT);
    const feeAB = await adapter.quoteSend(paramAB, false);
    await casToken.connect(owner).approve(adapterAddr, SEND_AMOUNT);
    await adapter.connect(owner).send(
      paramAB, { nativeFee: feeAB.nativeFee, lzTokenFee: 0n }, owner.address,
      { value: feeAB.nativeFee },
    );

    // congela o destinatario na Polygon e devolve
    await casToken.connect(owner).grantRole(COMPLIANCE_ROLE, owner.address);
    await casToken.connect(owner).freeze(user.address);

    const paramBA = sendParam(EID_A, user.address, SEND_AMOUNT);
    const feeBA = await oft.quoteSend(paramBA, false);
    // semantica real do endpoint LZ: o send NAO reverte — a entrega falha no
    // destino e a mensagem fica pendente para retry. OFT e queimado na BSC.
    await oft.connect(owner).send(
      paramBA, { nativeFee: feeBA.nativeFee, lzTokenFee: 0n }, owner.address,
      { value: feeBA.nativeFee },
    );

    expect(await oft.balanceOf(owner.address)).to.equal(0n);
    expect(await casToken.balanceOf(user.address)).to.equal(0n);
    // CAS permanece travado no adapter — nao ha perda de fundos
    expect(await casToken.balanceOf(adapterAddr)).to.equal(SEND_AMOUNT);

    // descongela e simula o retry do executor no endpoint A
    await casToken.connect(owner).unfreeze(user.address);
    const amountSD = SEND_AMOUNT / 10n ** 12n; // sharedDecimals = 6
    const message = ethers.solidityPacked(
      ["bytes32", "uint64"],
      [ethers.zeroPadValue(user.address, 32), amountSD],
    );
    const origin = {
      srcEid: EID_B,
      sender: ethers.zeroPadValue(oftAddr, 32),
      nonce: 1n,
    };
    await mockA.receivePayload(
      origin, adapterAddr, ethers.keccak256(message), message, 400_000, 0n,
      ethers.keccak256(ethers.toUtf8Bytes("retry-guid")),
    );

    expect(await casToken.balanceOf(user.address)).to.equal(SEND_AMOUNT);
    expect(await casToken.balanceOf(adapterAddr)).to.equal(0n);
  });

  it("reverte com peer nao configurado", async function () {
    const { owner, casToken, mockA, delegate } = await loadFixture(deployFixture);

    // adapter novo sem setPeer
    const AdapterFactory = await ethers.getContractFactory("CASOFTAdapter");
    const fresh: any = await AdapterFactory.deploy(
      await casToken.getAddress(),
      await mockA.getAddress(),
      delegate.address,
    );
    const freshAddr = await fresh.getAddress();

    const param = sendParam(EID_B, owner.address, SEND_AMOUNT);
    await casToken.connect(owner).approve(freshAddr, SEND_AMOUNT);
    await expect(fresh.connect(owner).quoteSend(param, false)).to.be.reverted;
  });
});

describe("CASOFT bridge — compatibilidade CASv2 (release/cas-v2)", function () {
  /**
   * Deploya o CASv2 REAL (artifact compilado no branch release/cas-v2) como
   * proxy UUPS — impl + ERC1967Proxy + initialize — e verifica que o mesmo
   * CASOFTAdapter/CASOFT funciona com a versao em producao do token.
   */
  async function deployV2Fixture() {
    const [owner, delegate] = await ethers.getSigners();

    // impl CASv2 (bytecode real, nao a versao main)
    const CASV2Factory = new ethers.ContractFactory(
      CASTokenV2Artifact.abi,
      CASTokenV2Artifact.bytecode,
      owner,
    );
    const impl = await CASV2Factory.deploy();
    const initData = CASV2Factory.interface.encodeFunctionData("initialize", [
      owner.address, INITIAL_SUPPLY, "Criptocoin Agentic Space", "CAS",
    ]);
    const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
    const proxy = await ProxyFactory.deploy(await impl.getAddress(), initData);
    const casV2 = CASV2Factory.attach(await proxy.getAddress()) as any;

    const MockFactory = new ethers.ContractFactory(
      EndpointV2MockArtifact.abi,
      EndpointV2MockArtifact.bytecode,
      owner,
    );
    const mockA: any = await MockFactory.deploy(EID_A);
    const mockB: any = await MockFactory.deploy(EID_B);
    const mockAAddr = await mockA.getAddress();
    const mockBAddr = await mockB.getAddress();

    const AdapterFactory = await ethers.getContractFactory("CASOFTAdapter");
    const adapter: any = await AdapterFactory.deploy(
      await casV2.getAddress(), mockAAddr, delegate.address,
    );
    const OftFactory = await ethers.getContractFactory("CASOFT");
    const oft: any = await OftFactory.deploy(mockBAddr, delegate.address);
    const adapterAddr = await adapter.getAddress();
    const oftAddr = await oft.getAddress();

    await mockA.setDestLzEndpoint(oftAddr, mockBAddr);
    await mockB.setDestLzEndpoint(adapterAddr, mockAAddr);
    await adapter.connect(delegate).setPeer(EID_B, ethers.zeroPadValue(oftAddr, 32));
    await oft.connect(delegate).setPeer(EID_A, ethers.zeroPadValue(adapterAddr, 32));

    return { owner, delegate, casV2, adapter, oft, adapterAddr };
  }

  it("CASv2: metadados e supply inicial corretos", async function () {
    const { casV2, owner } = await loadFixture(deployV2Fixture);
    expect(await casV2.symbol()).to.equal("CAS");
    expect(await casV2.decimals()).to.equal(18);
    expect(await casV2.balanceOf(owner.address)).to.equal(INITIAL_SUPPLY);
    expect(await casV2.maxSupply()).to.equal(ethers.parseEther("10000000"));
  });

  it("CASv2: send A->B trava CASv2 e minta OFT 1:1", async function () {
    const { owner, casV2, adapter, oft, adapterAddr } = await loadFixture(deployV2Fixture);

    const param = sendParam(EID_B, owner.address, SEND_AMOUNT);
    const fee = await adapter.quoteSend(param, false);
    await casV2.connect(owner).approve(adapterAddr, SEND_AMOUNT);
    await adapter.connect(owner).send(
      param, { nativeFee: fee.nativeFee, lzTokenFee: 0n }, owner.address,
      { value: fee.nativeFee },
    );

    expect(await casV2.balanceOf(owner.address)).to.equal(INITIAL_SUPPLY - SEND_AMOUNT);
    expect(await casV2.balanceOf(adapterAddr)).to.equal(SEND_AMOUNT);
    expect(await oft.balanceOf(owner.address)).to.equal(SEND_AMOUNT);
  });

  it("CASv2: round-trip B->A queima OFT e libera CASv2", async function () {
    const { owner, casV2, adapter, oft, adapterAddr } = await loadFixture(deployV2Fixture);

    const paramAB = sendParam(EID_B, owner.address, SEND_AMOUNT);
    const feeAB = await adapter.quoteSend(paramAB, false);
    await casV2.connect(owner).approve(adapterAddr, SEND_AMOUNT);
    await adapter.connect(owner).send(
      paramAB, { nativeFee: feeAB.nativeFee, lzTokenFee: 0n }, owner.address,
      { value: feeAB.nativeFee },
    );

    const paramBA = sendParam(EID_A, owner.address, SEND_AMOUNT);
    const feeBA = await oft.quoteSend(paramBA, false);
    await oft.connect(owner).send(
      paramBA, { nativeFee: feeBA.nativeFee, lzTokenFee: 0n }, owner.address,
      { value: feeBA.nativeFee },
    );

    expect(await oft.balanceOf(owner.address)).to.equal(0n);
    expect(await casV2.balanceOf(adapterAddr)).to.equal(0n);
    expect(await casV2.balanceOf(owner.address)).to.equal(INITIAL_SUPPLY);
  });

  it("CASv2: send reverte quando pausado", async function () {
    const { owner, casV2, adapter, adapterAddr } = await loadFixture(deployV2Fixture);
    await casV2.connect(owner).pause();

    const param = sendParam(EID_B, owner.address, SEND_AMOUNT);
    const fee = await adapter.quoteSend(param, false);
    await casV2.connect(owner).approve(adapterAddr, SEND_AMOUNT);
    await expect(
      adapter.connect(owner).send(
        param, { nativeFee: fee.nativeFee, lzTokenFee: 0n }, owner.address,
        { value: fee.nativeFee },
      ),
    ).to.be.reverted;
  });
});

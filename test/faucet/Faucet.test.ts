import { expect } from "chai";
import { ethers, network } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-toolbox/signers";
import { Faucet } from "../typechain-types";

describe("Faucet", function () {
  let faucet: Faucet;
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  const INTERVAL = 3600; // 1 hora
  const AMOUNT = ethers.parseEther("0.1"); // 0.1 POL
  const FUND_AMOUNT = ethers.parseEther("10"); // 10 POL

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();

    const FaucetFactory = await ethers.getContractFactory("Faucet");
    faucet = await FaucetFactory.deploy(INTERVAL, AMOUNT);
    await faucet.waitForDeployment();

    // Alimentar o faucet com POL
    await owner.sendTransaction({
      to: await faucet.getAddress(),
      value: FUND_AMOUNT,
    });
  });

  // -----------------------------------------------------------------------
  // Deploy
  // -----------------------------------------------------------------------

  describe("Deploy", function () {
    it("deve configurar owner, interval e amount corretamente", async function () {
      expect(await faucet.owner()).to.equal(owner.address);
      expect(await faucet.interval()).to.equal(INTERVAL);
      expect(await faucet.amount()).to.equal(AMOUNT);
    });

    it("deve rejeitar interval = 0", async function () {
      const FaucetFactory = await ethers.getContractFactory("Faucet");
      await expect(FaucetFactory.deploy(0, AMOUNT)).to.be.revertedWithCustomError(
        FaucetFactory,
        "InvalidInterval"
      );
    });

    it("deve rejeitar amount = 0", async function () {
      const FaucetFactory = await ethers.getContractFactory("Faucet");
      await expect(FaucetFactory.deploy(INTERVAL, 0)).to.be.revertedWithCustomError(
        FaucetFactory,
        "InvalidAmount"
      );
    });

    it("deve emitir OwnershipTransferred no deploy", async function () {
      const deployTx = faucet.deploymentTransaction();
      await expect(deployTx).to.emit(faucet, "OwnershipTransferred").withArgs(ethers.ZeroAddress, owner.address);
    });
  });

  // -----------------------------------------------------------------------
  // requestTokens
  // -----------------------------------------------------------------------

  describe("requestTokens", function () {
    it("deve transferir POL para o solicitante", async function () {
      const balanceBefore = await ethers.provider.getBalance(alice.address);
      await faucet.connect(alice).requestTokens();
      const balanceAfter = await ethers.provider.getBalance(alice.address);

      // O saldo deve aumentar (descontando o gas)
      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it("deve emitir evento Withdrawn", async function () {
      const tx = await faucet.connect(alice).requestTokens();
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      await expect(tx)
        .to.emit(faucet, "Withdrawn")
        .withArgs(alice.address, AMOUNT, block!.timestamp + INTERVAL);
    });

    it("deve atualizar nextTry após saque", async function () {
      const tx = await faucet.connect(alice).requestTokens();
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      expect(await faucet.nextTry(alice.address)).to.equal(block!.timestamp + INTERVAL);
    });

    it("deve rejeitar segundo saque dentro do cooldown", async function () {
      await faucet.connect(alice).requestTokens();

      await expect(
        faucet.connect(alice).requestTokens()
      ).to.be.revertedWithCustomError(faucet, "CooldownNotElapsed");
    });

    it("deve permitir novo saque após cooldown", async function () {
      await faucet.connect(alice).requestTokens();

      // Avançar o tempo
      await network.provider.send("evm_increaseTime", [INTERVAL + 1]);
      await network.provider.send("evm_mine");

      await expect(faucet.connect(alice).requestTokens()).to.emit(faucet, "Withdrawn");
    });

    it("deve rejeitar se endereço estiver na blacklist", async function () {
      await faucet.setBlacklist(alice.address, true);

      await expect(
        faucet.connect(alice).requestTokens()
      ).to.be.revertedWithCustomError(faucet, "Blacklisted");
    });

    it("deve rejeitar se saldo do faucet for insuficiente", async function () {
      const FaucetFactory = await ethers.getContractFactory("Faucet");
      const emptyFaucet = await FaucetFactory.deploy(INTERVAL, AMOUNT);
      await emptyFaucet.waitForDeployment();

      await expect(
        emptyFaucet.connect(alice).requestTokens()
      ).to.be.revertedWithCustomError(emptyFaucet, "InsufficientFunds");
    });
  });

  // -----------------------------------------------------------------------
  // Admin: setInterval
  // -----------------------------------------------------------------------

  describe("setInterval", function () {
    it("deve atualizar o intervalo", async function () {
      await faucet.setInterval(7200);
      expect(await faucet.interval()).to.equal(7200);
    });

    it("deve emitir IntervalUpdated", async function () {
      await expect(faucet.setInterval(7200))
        .to.emit(faucet, "IntervalUpdated")
        .withArgs(INTERVAL, 7200);
    });

    it("deve rejeitar interval = 0", async function () {
      await expect(faucet.setInterval(0)).to.be.revertedWithCustomError(
        faucet,
        "InvalidInterval"
      );
    });

    it("deve rejeitar chamada de não-owner", async function () {
      await expect(
        faucet.connect(alice).setInterval(7200)
      ).to.be.revertedWithCustomError(faucet, "NotOwner");
    });
  });

  // -----------------------------------------------------------------------
  // Admin: setAmount
  // -----------------------------------------------------------------------

  describe("setAmount", function () {
    it("deve atualizar a quantidade", async function () {
      const newAmount = ethers.parseEther("0.5");
      await faucet.setAmount(newAmount);
      expect(await faucet.amount()).to.equal(newAmount);
    });

    it("deve emitir AmountUpdated", async function () {
      const newAmount = ethers.parseEther("0.5");
      await expect(faucet.setAmount(newAmount))
        .to.emit(faucet, "AmountUpdated")
        .withArgs(AMOUNT, newAmount);
    });

    it("deve rejeitar amount = 0", async function () {
      await expect(faucet.setAmount(0)).to.be.revertedWithCustomError(
        faucet,
        "InvalidAmount"
      );
    });

    it("deve rejeitar chamada de não-owner", async function () {
      await expect(
        faucet.connect(alice).setAmount(ethers.parseEther("0.5"))
      ).to.be.revertedWithCustomError(faucet, "NotOwner");
    });
  });

  // -----------------------------------------------------------------------
  // Admin: setBlacklist
  // -----------------------------------------------------------------------

  describe("setBlacklist", function () {
    it("deve adicionar endereço à blacklist", async function () {
      await faucet.setBlacklist(alice.address, true);
      expect(await faucet.isBlacklisted(alice.address)).to.be.true;
    });

    it("deve remover endereço da blacklist", async function () {
      await faucet.setBlacklist(alice.address, true);
      await faucet.setBlacklist(alice.address, false);
      expect(await faucet.isBlacklisted(alice.address)).to.be.false;
    });

    it("deve emitir BlacklistUpdated", async function () {
      await expect(faucet.setBlacklist(alice.address, true))
        .to.emit(faucet, "BlacklistUpdated")
        .withArgs(alice.address, true);
    });

    it("deve rejeitar chamada de não-owner", async function () {
      await expect(
        faucet.connect(alice).setBlacklist(bob.address, true)
      ).to.be.revertedWithCustomError(faucet, "NotOwner");
    });
  });

  // -----------------------------------------------------------------------
  // Admin: setNextTry
  // -----------------------------------------------------------------------

  describe("setNextTry", function () {
    it("deve definir nextTry manualmente", async function () {
      const timestamp = 9999999999;
      await faucet.setNextTry(alice.address, timestamp);
      expect(await faucet.nextTry(alice.address)).to.equal(timestamp);
    });

    it("deve rejeitar chamada de não-owner", async function () {
      await expect(
        faucet.connect(alice).setNextTry(bob.address, 9999999999)
      ).to.be.revertedWithCustomError(faucet, "NotOwner");
    });
  });

  // -----------------------------------------------------------------------
  // Admin: transferOwnership
  // -----------------------------------------------------------------------

  describe("transferOwnership", function () {
    it("deve transferir ownership", async function () {
      await faucet.transferOwnership(alice.address);
      expect(await faucet.owner()).to.equal(alice.address);
    });

    it("deve emitir OwnershipTransferred", async function () {
      await expect(faucet.transferOwnership(alice.address))
        .to.emit(faucet, "OwnershipTransferred")
        .withArgs(owner.address, alice.address);
    });

    it("deve rejeitar address(0)", async function () {
      await expect(
        faucet.transferOwnership(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(faucet, "OwnerCannotBeZeroAddress");
    });

    it("deve rejeitar chamada de não-owner", async function () {
      await expect(
        faucet.connect(alice).transferOwnership(bob.address)
      ).to.be.revertedWithCustomError(faucet, "NotOwner");
    });
  });

  // -----------------------------------------------------------------------
  // Admin: withdrawFunds
  // -----------------------------------------------------------------------

  describe("withdrawFunds", function () {
    it("deve permitir owner sacar fundos", async function () {
      const balanceBefore = await ethers.provider.getBalance(owner.address);
      await faucet.withdrawFunds(ethers.parseEther("1"));
      const balanceAfter = await ethers.provider.getBalance(owner.address);

      // O saldo deve aumentar (descontando o gas)
      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it("deve emitir FundsWithdrawn", async function () {
      await expect(faucet.withdrawFunds(ethers.parseEther("1")))
        .to.emit(faucet, "FundsWithdrawn")
        .withArgs(owner.address, ethers.parseEther("1"));
    });

    it("deve rejeitar se saldo for insuficiente", async function () {
      await expect(
        faucet.withdrawFunds(ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(faucet, "InsufficientFunds");
    });

    it("deve rejeitar chamada de não-owner", async function () {
      await expect(
        faucet.connect(alice).withdrawFunds(ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(faucet, "NotOwner");
    });
  });

  // -----------------------------------------------------------------------
  // Receive
  // -----------------------------------------------------------------------

  describe("Receive", function () {
    it("deve aceitar depósitos de POL", async function () {
      const depositAmount = ethers.parseEther("1");
      await owner.sendTransaction({
        to: await faucet.getAddress(),
        value: depositAmount,
      });

      expect(await faucet.getBalance()).to.equal(FUND_AMOUNT + depositAmount);
    });

    it("deve emitir FundsDeposited ao receber POL", async function () {
      const depositAmount = ethers.parseEther("1");
      const tx = await owner.sendTransaction({
        to: await faucet.getAddress(),
        value: depositAmount,
      });

      await expect(tx)
        .to.emit(faucet, "FundsDeposited")
        .withArgs(owner.address, depositAmount);
    });
  });

  // -----------------------------------------------------------------------
  // Views
  // -----------------------------------------------------------------------

  describe("Views", function () {
    it("getBalance deve retornar saldo do contrato", async function () {
      expect(await faucet.getBalance()).to.equal(FUND_AMOUNT);
    });

    it("owner deve retornar endereço do owner", async function () {
      expect(await faucet.owner()).to.equal(owner.address);
    });

    it("nextTry deve retornar 0 para endereços novos", async function () {
      expect(await faucet.nextTry(alice.address)).to.equal(0);
    });

    it("isBlacklisted deve retornar false por padrão", async function () {
      expect(await faucet.isBlacklisted(alice.address)).to.be.false;
    });
  });
});

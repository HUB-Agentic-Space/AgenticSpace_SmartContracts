// SPDX-License-Identifier: CC-BY-SA-4.0
// Author:  Carlos Delfino <consultoria@carlosdelfino.eti.br>
// WhatsApp: +55 (85) 98520-5490
//
// FRAGMENTO DE SPEC — nao executavel isoladamente.
// Extraido de test/token/CASSwap.test.ts (describe "withdrawCAS") porque a
// funcao withdrawCAS nao existe no CASSwap em producao (0x9399878C...),
// restaurado neste branch a versao verificada no Polygonscan.
// Reintegrar ao spec principal quando a linha CASv3 (main) for promovida.

  describe("withdrawCAS", () => {
    it("should withdraw CAS to arbitrary address by admin", async () => {
      const withdrawAmount = ethers.parseEther("100");
      const swapAddr = await casSwap.getAddress();
      const recipient = user1.address;

      const swapCasBefore = await casSwap.getCASBalance();
      const recipientBefore = await casToken.balanceOf(recipient);

      await casSwap.withdrawCAS(recipient, withdrawAmount);

      const swapCasAfter = await casSwap.getCASBalance();
      const recipientAfter = await casToken.balanceOf(recipient);

      expect(swapCasBefore - swapCasAfter).to.equal(withdrawAmount);
      expect(recipientAfter - recipientBefore).to.equal(withdrawAmount);
    });
      await expect(casSwap.connect(user1).withdrawCAS(user1.address, ethers.parseEther("1")))
        .to.be.reverted;
    });

    it("should revert with zero address", async () => {
      await expect(casSwap.withdrawCAS(ethers.ZeroAddress, ethers.parseEther("1")))
        .to.be.revertedWithCustomError(casSwap, "ZeroAddress");
    });

    it("should revert with zero amount", async () => {
      await expect(casSwap.withdrawCAS(user1.address, 0))
        .to.be.revertedWithCustomError(casSwap, "ZeroAmount");
    });

    it("should revert when insufficient CAS balance", async () => {
      const casBal = await casSwap.getCASBalance();
      const tooMuch = casBal + 1n;
      await expect(casSwap.withdrawCAS(user1.address, tooMuch))
        .to.be.revertedWithCustomError(casSwap, "InsufficientCASBalance");
    });

    it("should revert when paused", async () => {
      await casSwap.pause();
      await expect(casSwap.withdrawCAS(user1.address, ethers.parseEther("1")))
        .to.be.revertedWithCustomError(casSwap, "EnforcedPause");
    });
  });

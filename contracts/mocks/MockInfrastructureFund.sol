// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockInfrastructureFund
 * @dev Mock do InfrastructureFund para testes locais.
 *      Guarda CAS e permite transferencia para o endereco Rapport.
 *      NAO use em producao.
 */
contract MockInfrastructureFund is Ownable {
    using SafeERC20 for IERC20;

    IERC20 public casToken;
    address public rapportAddress;

    constructor(address admin, address _casToken, address _rapport) Ownable(admin) {
        casToken = IERC20(_casToken);
        rapportAddress = _rapport;
    }

    function setRapportAddress(address _rapport) external onlyOwner {
        require(_rapport != address(0), "Zero address");
        rapportAddress = _rapport;
    }

    function depositCas(uint256 amount) external {
        casToken.safeTransferFrom(msg.sender, address(this), amount);
    }

    function transferCasToRapport(uint256 amount) external onlyOwner {
        require(rapportAddress != address(0), "Rapport not set");
        uint256 bal = casToken.balanceOf(address(this));
        require(bal >= amount, "Insufficient CAS");
        casToken.safeTransfer(rapportAddress, amount);
    }

    function casBalance() external view returns (uint256) {
        return casToken.balanceOf(address(this));
    }
}

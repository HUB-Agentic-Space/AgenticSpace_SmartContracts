// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IInfrastructureFund } from "../interfaces/IInfrastructureFund.sol";

/**
 * @title FundTrackerToken
 * @dev ERC-20 que espelha o saldo de um ativo (CAS ou POL) custodiado
 *      pelo InfrastructureFund. O totalSupply e o balanceOf do admin
 *      refletem dinamicamente o saldo do fundo — sem mint/burn.
 *
 *      Deploy duas instâncias:
 *        1. CAS Tracker  — assetType = 0 (CAS), name = "Agentic CAS Fund"
 *        2. POL Tracker  — assetType = 1 (POL), name = "Agentic POL Fund"
 *
 *      O admin (owner do tracker) vê o saldo do fundo no MetaMask como
 *      se fosse um token na sua carteira. Outros endereços têm saldo 0.
 *
 *      Padrões: Adapter (GoF — adapta InfrastructureFund para ERC-20),
 *               Strategy (CAS vs POL)
 */
contract FundTrackerToken is ERC20, Ownable {

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    uint8 public constant CAS_TRACKER = 0;
    uint8 public constant POL_TRACKER = 1;

    // -----------------------------------------------------------------------
    // Immutable state
    // -----------------------------------------------------------------------

    IInfrastructureFund public immutable fund;
    uint8 public immutable assetType;

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error InvalidAssetType();
    error InvalidFundAddress();

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    /**
     * @param fundAddress Endereço do InfrastructureFund.
     * @param _assetType   0 = CAS, 1 = POL.
     * @param name         Nome do token (ex: "Agentic CAS Fund").
     * @param symbol       Símbolo do token (ex: "aCAS").
     * @param admin        Endereço que verá o saldo no MetaMask.
     */
    constructor(
        address fundAddress,
        uint8 _assetType,
        string memory name,
        string memory symbol,
        address admin
    ) ERC20(name, symbol) Ownable(admin) {
        if (fundAddress == address(0)) revert InvalidFundAddress();
        if (_assetType > POL_TRACKER) revert InvalidAssetType();

        fund = IInfrastructureFund(fundAddress);
        assetType = _assetType;
    }

    // -----------------------------------------------------------------------
    // Overridden ERC-20 view functions
    // -----------------------------------------------------------------------

    /// @dev Retorna o saldo do ativo custodiado pelo fundo.
    function totalSupply() public view override returns (uint256) {
        if (assetType == CAS_TRACKER) {
            return fund.casBalance();
        } else {
            return fund.nativeBalance();
        }
    }

    /// @dev O admin vê o saldo total do fundo; outros endereços têm saldo 0.
    function balanceOf(address account) public view override returns (uint256) {
        if (account == owner()) {
            return totalSupply();
        }
        return 0;
    }

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------

    /// @dev Transfere "propriedade" do tracker. O novo owner passa a ver
    ///      o saldo no MetaMask. Não afeta o InfrastructureFund.
    function transferOwnership(address newOwner) public override onlyOwner {
        if (newOwner == address(0)) revert OwnableInvalidOwner(address(0));
        _transferOwnership(newOwner);
    }

    /// @dev Renúncia desabilitada — um tracker sem owner deixaria o saldo
    ///      do fundo invisível e balanceOf(address(0)) retornaria o total.
    function renounceOwnership() public pure override {
        revert("FundTracker: renounce disabled");
    }

    // -----------------------------------------------------------------------
    // Disabled ERC-20 transfer functions
    // -----------------------------------------------------------------------

    /// @dev Tracker tokens não são transferíveis — apenas espelham o saldo.
    function transfer(address, uint256) public pure override returns (bool) {
        revert("FundTracker: non-transferable");
    }

    function approve(address, uint256) public pure override returns (bool) {
        revert("FundTracker: non-transferable");
    }

    function transferFrom(address, address, uint256) public pure override returns (bool) {
        revert("FundTracker: non-transferable");
    }
}

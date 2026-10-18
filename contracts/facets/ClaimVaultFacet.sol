// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import { LibDiamond } from "../diamond/libraries/LibDiamond.sol";
import { ClaimVaultStorage } from "../diamond/storage/ClaimVaultStorage.sol";
import { IClaimVault } from "../interfaces/IClaimVault.sol";
import { ClaimNFTLib } from "../libs/ClaimNFTLib.sol";
import { SignatureLib } from "../libs/SignatureLib.sol";

/**
 * @title ClaimVaultFacet
 * @dev Custodies campaign assets and atomically transfers each voucher amount while minting one soulbound receipt.
 * @author Carlos Delfino
 * @notice Contact: consultoria@carlosdelfino.eti.br | WhatsApp: +55 (85) 98520-5490
 */
contract ClaimVaultFacet is IClaimVault {
    using SafeERC20 for IERC20;

    string internal constant EIP712_NAME = "RapportClaimVault";
    string internal constant EIP712_VERSION = "1";
    bytes32 internal constant CLAIM_AUTHORIZATION_TYPEHASH = keccak256(
        "ClaimAuthorization(bytes32 voucherId,bytes32 campaignId,address recipient,address asset,uint256 amount,uint256 nonce,uint256 deadline)"
    );
    uint256 internal constant NOT_ENTERED = 1;
    uint256 internal constant ENTERED = 2;

    error AlreadyInitialized();
    error AssetNotSupported(address asset);
    error CampaignAlreadyExists(bytes32 campaignId);
    error CampaignNotActive(bytes32 campaignId);
    error ClaimExpired(uint256 deadline);
    error ClaimsPaused();
    error InsufficientAvailableBalance(address asset, uint256 available, uint256 required);
    error InvalidAmount();
    error InvalidClaimSignature();
    error InvalidRecipient();
    error NativeTransferFailed();
    error NonceAlreadyUsed(uint256 nonce);
    error ReentrantCall();
    error VoucherAlreadyClaimed(bytes32 voucherId);
    error WrongCampaignAsset(address expected, address provided);
    error ZeroAddress();

    event AssetDeposited(address indexed asset, address indexed depositor, uint256 amount);
    event AssetSupportUpdated(address indexed asset, bool enabled);
    event AssetWithdrawn(address indexed asset, address indexed recipient, uint256 amount);
    event CampaignReleased(bytes32 indexed campaignId, address indexed asset, uint256 amount);
    event CampaignReserved(bytes32 indexed campaignId, address indexed asset, uint256 amount);
    event ClaimSignerUpdated(address indexed previousSigner, address indexed newSigner);
    event ClaimsPauseUpdated(bool paused);

    modifier nonReentrant() {
        ClaimVaultStorage.ClaimVaultStorageData storage s = ClaimVaultStorage.claimVaultStorage();
        if (s.reentrancyStatus == ENTERED) revert ReentrantCall();
        s.reentrancyStatus = ENTERED;
        _;
        s.reentrancyStatus = NOT_ENTERED;
    }

    /// @notice Initializes the claim signer and native asset support once.
    function initClaimVault(address claimSigner) external {
        LibDiamond.enforceIsContractOwner();
        if (claimSigner == address(0)) revert ZeroAddress();
        ClaimVaultStorage.ClaimVaultStorageData storage s = ClaimVaultStorage.claimVaultStorage();
        if (s.initialized) revert AlreadyInitialized();
        s.initialized = true;
        s.reentrancyStatus = NOT_ENTERED;
        s.claimSigner = claimSigner;
        s.supportedAssets[address(0)] = true;
        emit ClaimSignerUpdated(address(0), claimSigner);
        emit AssetSupportUpdated(address(0), true);
    }

    function setClaimSigner(address claimSigner) external {
        LibDiamond.enforceIsContractOwner();
        if (claimSigner == address(0)) revert ZeroAddress();
        ClaimVaultStorage.ClaimVaultStorageData storage s = ClaimVaultStorage.claimVaultStorage();
        address previousSigner = s.claimSigner;
        s.claimSigner = claimSigner;
        emit ClaimSignerUpdated(previousSigner, claimSigner);
    }

    function setClaimAssetSupport(address asset, bool enabled) external {
        LibDiamond.enforceIsContractOwner();
        ClaimVaultStorage.claimVaultStorage().supportedAssets[asset] = enabled;
        emit AssetSupportUpdated(asset, enabled);
    }

    function setClaimsPaused(bool paused) external {
        LibDiamond.enforceIsContractOwner();
        ClaimVaultStorage.claimVaultStorage().claimsPaused = paused;
        emit ClaimsPauseUpdated(paused);
    }

    function depositAsset(address asset, uint256 amount) external nonReentrant {
        ClaimVaultStorage.ClaimVaultStorageData storage s = ClaimVaultStorage.claimVaultStorage();
        if (asset == address(0) || !s.supportedAssets[asset]) revert AssetNotSupported(asset);
        if (amount == 0) revert InvalidAmount();
        uint256 beforeBalance = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(asset).balanceOf(address(this)) - beforeBalance;
        if (received == 0) revert InvalidAmount();
        s.vaultBalances[asset] += received;
        emit AssetDeposited(asset, msg.sender, received);
    }

    function depositNative() external payable {
        ClaimVaultStorage.ClaimVaultStorageData storage s = ClaimVaultStorage.claimVaultStorage();
        if (!s.supportedAssets[address(0)]) revert AssetNotSupported(address(0));
        if (msg.value == 0) revert InvalidAmount();
        s.vaultBalances[address(0)] += msg.value;
        emit AssetDeposited(address(0), msg.sender, msg.value);
    }

    function reserveCampaign(bytes32 campaignId, address asset, uint256 amount) external {
        LibDiamond.enforceIsContractOwner();
        ClaimVaultStorage.ClaimVaultStorageData storage s = ClaimVaultStorage.claimVaultStorage();
        if (!s.supportedAssets[asset]) revert AssetNotSupported(asset);
        if (amount == 0) revert InvalidAmount();
        if (s.campaigns[campaignId].active) revert CampaignAlreadyExists(campaignId);
        uint256 available = s.vaultBalances[asset] - s.committedBalances[asset];
        if (available < amount) revert InsufficientAvailableBalance(asset, available, amount);
        s.campaigns[campaignId] = ClaimVaultStorage.CampaignReservation(asset, amount, 0, true);
        s.committedBalances[asset] += amount;
        emit CampaignReserved(campaignId, asset, amount);
    }

    function releaseCampaign(bytes32 campaignId) external {
        LibDiamond.enforceIsContractOwner();
        ClaimVaultStorage.ClaimVaultStorageData storage s = ClaimVaultStorage.claimVaultStorage();
        ClaimVaultStorage.CampaignReservation storage campaign = s.campaigns[campaignId];
        if (!campaign.active) revert CampaignNotActive(campaignId);
        uint256 released = campaign.reserved - campaign.claimed;
        campaign.active = false;
        s.committedBalances[campaign.asset] -= released;
        emit CampaignReleased(campaignId, campaign.asset, released);
    }

    function withdrawUncommitted(address asset, uint256 amount, address payable recipient) external nonReentrant {
        LibDiamond.enforceIsContractOwner();
        if (recipient == address(0)) revert ZeroAddress();
        ClaimVaultStorage.ClaimVaultStorageData storage s = ClaimVaultStorage.claimVaultStorage();
        uint256 available = s.vaultBalances[asset] - s.committedBalances[asset];
        if (amount == 0 || available < amount) revert InsufficientAvailableBalance(asset, available, amount);
        s.vaultBalances[asset] -= amount;
        _transferAsset(asset, recipient, amount);
        emit AssetWithdrawn(asset, recipient, amount);
    }

    /// @inheritdoc IClaimVault
    function claim(
        ClaimAuthorization calldata authorization,
        bytes calldata signature
    ) external nonReentrant returns (uint256 tokenId) {
        LibDiamond.enforceNotPaused();
        ClaimVaultStorage.ClaimVaultStorageData storage s = ClaimVaultStorage.claimVaultStorage();
        if (s.claimsPaused) revert ClaimsPaused();
        if (authorization.recipient == address(0)) revert InvalidRecipient();
        if (authorization.amount == 0) revert InvalidAmount();
        if (block.timestamp > authorization.deadline) revert ClaimExpired(authorization.deadline);
        if (s.claimedVouchers[authorization.voucherId]) revert VoucherAlreadyClaimed(authorization.voucherId);
        if (s.usedNonces[authorization.nonce]) revert NonceAlreadyUsed(authorization.nonce);

        ClaimVaultStorage.CampaignReservation storage campaign = s.campaigns[authorization.campaignId];
        if (!campaign.active) revert CampaignNotActive(authorization.campaignId);
        if (campaign.asset != authorization.asset) revert WrongCampaignAsset(campaign.asset, authorization.asset);
        uint256 remaining = campaign.reserved - campaign.claimed;
        if (remaining < authorization.amount) {
            revert InsufficientAvailableBalance(authorization.asset, remaining, authorization.amount);
        }
        if (!SignatureChecker.isValidSignatureNow(s.claimSigner, _claimDigest(authorization), signature)) {
            revert InvalidClaimSignature();
        }

        s.claimedVouchers[authorization.voucherId] = true;
        s.usedNonces[authorization.nonce] = true;
        campaign.claimed += authorization.amount;
        s.committedBalances[authorization.asset] -= authorization.amount;
        s.vaultBalances[authorization.asset] -= authorization.amount;
        tokenId = ClaimNFTLib.mint(authorization.recipient, authorization.voucherId);
        s.claims[authorization.voucherId] = ClaimVaultStorage.ClaimRecord(
            authorization.campaignId,
            authorization.recipient,
            authorization.asset,
            authorization.amount,
            tokenId
        );

        _transferAsset(authorization.asset, payable(authorization.recipient), authorization.amount);
        emit VoucherClaimed(
            authorization.voucherId,
            authorization.campaignId,
            authorization.recipient,
            authorization.asset,
            authorization.amount,
            tokenId
        );
    }

    function claimAuthorizationDigest(ClaimAuthorization calldata authorization) external view returns (bytes32) {
        return _claimDigest(authorization);
    }

    function getClaimSigner() external view returns (address) {
        return ClaimVaultStorage.claimVaultStorage().claimSigner;
    }

    function getVaultBalance(address asset) external view returns (uint256 balance, uint256 committed) {
        ClaimVaultStorage.ClaimVaultStorageData storage s = ClaimVaultStorage.claimVaultStorage();
        return (s.vaultBalances[asset], s.committedBalances[asset]);
    }

    function getCampaignReservation(bytes32 campaignId)
        external
        view
        returns (ClaimVaultStorage.CampaignReservation memory)
    {
        return ClaimVaultStorage.claimVaultStorage().campaigns[campaignId];
    }

    function getClaim(bytes32 voucherId) external view returns (ClaimVaultStorage.ClaimRecord memory) {
        return ClaimVaultStorage.claimVaultStorage().claims[voucherId];
    }

    function isVoucherClaimed(bytes32 voucherId) external view returns (bool) {
        return ClaimVaultStorage.claimVaultStorage().claimedVouchers[voucherId];
    }

    function isNonceUsed(uint256 nonce) external view returns (bool) {
        return ClaimVaultStorage.claimVaultStorage().usedNonces[nonce];
    }

    function isClaimAssetSupported(address asset) external view returns (bool) {
        return ClaimVaultStorage.claimVaultStorage().supportedAssets[asset];
    }

    function _claimDigest(ClaimAuthorization calldata authorization) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            CLAIM_AUTHORIZATION_TYPEHASH,
            authorization.voucherId,
            authorization.campaignId,
            authorization.recipient,
            authorization.asset,
            authorization.amount,
            authorization.nonce,
            authorization.deadline
        ));
        return SignatureLib.hashTypedData(
            SignatureLib.domainSeparator(EIP712_NAME, EIP712_VERSION),
            structHash
        );
    }

    function _transferAsset(address asset, address payable recipient, uint256 amount) internal {
        if (asset == address(0)) {
            (bool success,) = recipient.call{ value: amount }("");
            if (!success) revert NativeTransferFailed();
        } else {
            IERC20(asset).safeTransfer(recipient, amount);
        }
    }
}

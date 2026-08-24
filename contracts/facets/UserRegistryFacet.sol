// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { LibDiamond } from "../diamond/libraries/LibDiamond.sol";
import { DiamondAccessControl } from "../diamond/access/DiamondAccessControl.sol";
import { UserStorage } from "../diamond/storage/UserStorage.sol";
import { PaymentLib } from "../libs/PaymentLib.sol";
import { PaymentStorage } from "../diamond/storage/PaymentStorage.sol";

/**
 * @title UserRegistryFacet
 * @dev Facet for user registration using Diamond Storage.
 *      Stores only didHash (keccak256 of DID) and publicIdHash on-chain
 *      to preserve user anonymity. The raw DID is kept off-chain.
 *
 *      Users must be registered and active before they can register agents.
 *      Agents are permanently bound to the user who created them —
 *      non-transferable.
 *
 *      Padrões: Diamond Storage (EIP-2535), Registry (GoF)
 */
contract UserRegistryFacet {
    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event UserRegistered(
        bytes32 indexed userId,
        bytes32 indexed didHash,
        address indexed walletAddress,
        bytes32 publicIdHash,
        uint8 paymentAsset
    );
    event UserDeactivated(bytes32 indexed userId, address indexed walletAddress);
    event UserReactivated(bytes32 indexed userId, address indexed walletAddress);
    event FeePaid(address indexed payer, uint256 feeType, uint256 amount, uint8 paymentAsset);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error UserAlreadyRegistered(bytes32 userId);
    error UserNotFound(bytes32 userId);
    error UserNotActive(bytes32 userId);
    error EmptyDIDHash();
    error EmptyPublicIdHash();
    error AddressAlreadyRegistered(address walletAddress);
    error NotUserOwner(bytes32 userId, address caller);
    error InvalidPaymentAsset(uint8 asset);
    error InsufficientPayment(uint256 required, uint256 provided);
    error ExcessivePayment(uint256 required, uint256 provided);
    error PaymentFailed();

    enum PaymentAsset { CAS, POL, WETH }

    // -----------------------------------------------------------------------
    // Registration
    // -----------------------------------------------------------------------

    /**
     * @dev Registers a new user with hashed DID and publicId.
     *      Only the hash is stored on-chain for privacy.
     *      Supports payment in CAS, POL, or WETH (mainnet only for WETH).
     *      Uses CEI pattern: user state is written before external calls.
     * @param didHash keccak256 of the user's DID (e.g. Google DID).
     * @param publicIdHash keccak256 of the user's public ID.
     * @param paymentAsset 0=CAS, 1=POL, 2=WETH
     */
    function registerUser(
        bytes32 didHash,
        bytes32 publicIdHash,
        PaymentAsset paymentAsset
    ) external payable {
        LibDiamond.enforceNotPaused();

        if (didHash == bytes32(0)) revert EmptyDIDHash();
        if (publicIdHash == bytes32(0)) revert EmptyPublicIdHash();

        UserStorage.UserStorageData storage s = UserStorage.userStorage();

        if (s.userByAddress[msg.sender] != bytes32(0)) {
            revert AddressAlreadyRegistered(msg.sender);
        }

        bytes32 userId = keccak256(abi.encodePacked(didHash, msg.sender));

        if (s.users[userId].registeredAt != 0) {
            revert UserAlreadyRegistered(userId);
        }

        // ── Effects: write user state BEFORE external interactions (CEI) ──
        s.users[userId] = UserStorage.User({
            userId: userId,
            didHash: didHash,
            walletAddress: msg.sender,
            publicIdHash: publicIdHash,
            isActive: true,
            registeredAt: block.timestamp
        });

        s.userByAddress[msg.sender] = userId;
        s.userByPublicIdHash[publicIdHash] = userId;
        s.userCount++;
        s.activeUserCount++;

        DiamondAccessControl.grantRole(DiamondAccessControl.USER_ROLE, msg.sender);

        // ── Interactions: process payment AFTER state is committed ──
        uint256 feeAmount = 0;
        if (paymentAsset == PaymentAsset.CAS) {
            if (msg.value != 0) revert ExcessivePayment(0, msg.value);
            feeAmount = PaymentLib.processUserRegistrationPaymentCas(msg.sender);
            emit FeePaid(msg.sender, 3, feeAmount, 0);
        } else if (paymentAsset == PaymentAsset.POL) {
            uint256 requiredPol = PaymentLib.convertCasToPol(PaymentLib.getUserRegistrationFee());
            if (msg.value < requiredPol) revert InsufficientPayment(requiredPol, msg.value);
            if (msg.value > requiredPol) revert ExcessivePayment(requiredPol, msg.value);
            feeAmount = requiredPol;

            PaymentStorage.PaymentStorageData storage ps = PaymentStorage.paymentStorage();
            (bool ok, ) = ps.infrastructureFund.call{value: requiredPol}("");
            if (!ok) revert PaymentFailed();
            emit FeePaid(msg.sender, 3, feeAmount, 1);
        } else if (paymentAsset == PaymentAsset.WETH) {
            if (msg.value != 0) revert ExcessivePayment(0, msg.value);
            PaymentStorage.PaymentStorageData storage ps = PaymentStorage.paymentStorage();
            feeAmount = PaymentLib.processUserRegistrationPaymentWeth(msg.sender, ps.infrastructureFund);
            emit FeePaid(msg.sender, 3, feeAmount, 2);
        } else {
            revert InvalidPaymentAsset(uint8(paymentAsset));
        }

        emit UserRegistered(userId, didHash, msg.sender, publicIdHash, uint8(paymentAsset));
    }

    /**
     * @dev Deactivates a user. Only the user or contract owner can do this.
     * @param userId ID of the user to deactivate.
     */
    function deactivateUser(bytes32 userId) external {
        LibDiamond.enforceNotPaused();

        UserStorage.UserStorageData storage s = UserStorage.userStorage();
        UserStorage.User storage user = s.users[userId];

        if (user.registeredAt == 0) revert UserNotFound(userId);
        if (msg.sender != user.walletAddress && msg.sender != LibDiamond.contractOwner()) {
            revert NotUserOwner(userId, msg.sender);
        }
        if (!user.isActive) revert UserNotActive(userId);

        user.isActive = false;
        s.activeUserCount--;

        emit UserDeactivated(userId, user.walletAddress);
    }

    /**
     * @dev Reactivates a previously deactivated user.
     * @param userId ID of the user to reactivate.
     */
    function reactivateUser(bytes32 userId) external {
        LibDiamond.enforceNotPaused();

        UserStorage.UserStorageData storage s = UserStorage.userStorage();
        UserStorage.User storage user = s.users[userId];

        if (user.registeredAt == 0) revert UserNotFound(userId);
        if (msg.sender != user.walletAddress && msg.sender != LibDiamond.contractOwner()) {
            revert NotUserOwner(userId, msg.sender);
        }
        if (user.isActive) revert UserNotActive(userId);

        user.isActive = true;
        s.activeUserCount++;

        emit UserReactivated(userId, user.walletAddress);
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    /**
     * @dev Returns user data by userId.
     */
    function getUser(bytes32 userId) external view returns (UserStorage.User memory) {
        UserStorage.User storage user = UserStorage.userStorage().users[userId];
        if (user.registeredAt == 0) revert UserNotFound(userId);
        return user;
    }

    /**
     * @dev Returns user data by wallet address.
     */
    function getUserByAddress(address walletAddress) external view returns (UserStorage.User memory) {
        bytes32 userId = UserStorage.userStorage().userByAddress[walletAddress];
        if (userId == bytes32(0)) revert UserNotFound(bytes32(0));
        return UserStorage.userStorage().users[userId];
    }

    /**
     * @dev Returns true if the user is registered and active.
     */
    function isUserActive(address walletAddress) external view returns (bool) {
        bytes32 userId = UserStorage.userStorage().userByAddress[walletAddress];
        if (userId == bytes32(0)) return false;
        return UserStorage.userStorage().users[userId].isActive;
    }

    /**
     * @dev Returns the userId for a given wallet address.
     */
    function getUserIdByAddress(address walletAddress) external view returns (bytes32) {
        return UserStorage.userStorage().userByAddress[walletAddress];
    }

    /**
     * @dev Computes the userId from didHash and wallet address.
     */
    function computeUserId(bytes32 didHash, address walletAddress) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(didHash, walletAddress));
    }
}

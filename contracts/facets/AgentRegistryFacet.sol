// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { LibDiamond } from "../diamond/libraries/LibDiamond.sol";
import { DiamondAccessControl } from "../diamond/access/DiamondAccessControl.sol";
import { AgentStorage } from "../diamond/storage/AgentStorage.sol";
import { UserStorage } from "../diamond/storage/UserStorage.sol";
import { AgentHashLib } from "../libs/AgentHashLib.sol";
import { MerkleLib } from "../libs/MerkleLib.sol";
import { PaymentLib } from "../libs/PaymentLib.sol";

/**
 * @title AgentRegistryFacet
 * @dev Facet for agent registration using Diamond Storage.
 *      Persists didHash, ownerUserId, ownerAddress, publicId, name,
 *      description, parentPublicId and a Merkle root of all prompt hashes
 *      on-chain. Only the hash of the DID is stored for privacy.
 *
 *      Agent composition (immutable metadata):
 *        - DID hash (keccak256 of owner's DID)
 *        - Owner user ID (reference to registered user)
 *        - Owner address (wallet that registered the agent)
 *        - AUID (Agentic Unique ID)
 *        - Public ID (human-readable)
 *        - Name
 *        - Description
 *        - Parent agent's Public ID (if any)
 *        - Merkle root of prompt hashes
 *
 *      The user must be registered and active in UserRegistryFacet
 *      before registering an agent. Agents are non-transferable —
 *      permanently bound to the user who created them.
 *
 *      Immutable prompts (AGENTS.md, IDENTITY.md, SOUL.md) are included
 *      in the initial Merkle root at registration. Secondary prompts can
 *      be added later via updateMerkleRoot, but once a prompt hash is
 *      registered it cannot change — changing it invalidates the agent's
 *      prompt identity.
 *
 *      Individual prompt hashes and content are stored in the backend;
 *      only the Merkle root is persisted on-chain, indexed by agent address.
 *      Private keys are the agent's responsibility — Agentic Space does not
 *      store them.
 *
 *      Padrões: Diamond Storage (EIP-2535), Registry (GoF), Memento (Merkle history)
 */
contract AgentRegistryFacet {

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event AgentRegistered(
        bytes32 indexed agentId,
        bytes32 indexed didHash,
        bytes32 indexed ownerUserId,
        address ownerAddress,
        string publicId,
        string auid,
        string name,
        string description,
        string parentPublicId,
        bytes32 merkleRoot
    );
    event AgentUpdated(bytes32 indexed agentId, string publicId);
    event AgentDeactivated(bytes32 indexed agentId, address indexed ownerAddress);
    event AgentReactivated(bytes32 indexed agentId, address indexed ownerAddress);
    event MerkleRootUpdated(
        bytes32 indexed agentId,
        bytes32 oldRoot,
        bytes32 newRoot,
        uint256 promptCount
    );
    event FeePaid(address indexed payer, uint256 feeType, uint256 amount);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error AgentAlreadyRegistered(bytes32 agentId);
    error AgentNotFound(bytes32 agentId);
    error PublicIdAlreadyTaken(string publicId);
    error NotAgentOwner(bytes32 agentId, address caller);
    error AgentNotActive(bytes32 agentId);
    error EmptyDIDHash();
    error EmptyPublicId();
    error EmptyAUID();
    error EmptyName();
    error EmptyDescription();
    error InvalidMerkleRoot();
    error MerkleRootUnchanged();
    error ParentAgentNotFound(string parentPublicId);
    error UserNotRegistered(address caller);
    error UserNotActive(address caller);

    // -----------------------------------------------------------------------
    // Registration
    // -----------------------------------------------------------------------

    /**
     * @dev Registers a new agent with immutable prompt hashes.
     *      The caller must be a registered and active user.
     * @param didHash keccak256 of the DID of the agent owner.
     * @param publicId Human-readable public ID (unique).
     * @param auid Agentic Unique ID.
     * @param name Display name of the agent (immutable).
     * @param description Description of the agent (immutable, cannot be deleted).
     * @param parentPublicId Public ID of the parent agent (empty if none).
     * @param merkleRoot Merkle root of all initial prompt hashes
     *        (AGENTS.md, IDENTITY.md, SOUL.md and any secondary prompts).
     * @param promptCount Number of prompts included in the Merkle tree.
     */
    function registerAgent(
        bytes32 didHash,
        string calldata publicId,
        string calldata auid,
        string calldata name,
        string calldata description,
        string calldata parentPublicId,
        bytes32 merkleRoot,
        uint256 promptCount
    ) external {
        LibDiamond.enforceNotPaused();

        if (didHash == bytes32(0)) revert EmptyDIDHash();
        if (bytes(publicId).length == 0) revert EmptyPublicId();
        if (bytes(auid).length == 0) revert EmptyAUID();
        if (bytes(name).length == 0) revert EmptyName();
        if (bytes(description).length == 0) revert EmptyDescription();
        if (merkleRoot == bytes32(0)) revert InvalidMerkleRoot();

        // Verify caller is a registered and active user
        UserStorage.UserStorageData storage us = UserStorage.userStorage();
        bytes32 userId = us.userByAddress[msg.sender];
        if (userId == bytes32(0)) revert UserNotRegistered(msg.sender);
        if (!us.users[userId].isActive) revert UserNotActive(msg.sender);

        // Process registration fee payment (CAS tokens)
        uint256 feeAmount = PaymentLib.processFeePayment(msg.sender, PaymentLib.FEE_TYPE_REGISTRATION);
        emit FeePaid(msg.sender, 0, feeAmount);

        // Verify parent agent exists if parentPublicId is provided
        if (bytes(parentPublicId).length > 0) {
            AgentStorage.AgentStorageData storage ps = AgentStorage.agentStorage();
            if (ps.agentByPublicId[parentPublicId] == bytes32(0)) {
                revert ParentAgentNotFound(parentPublicId);
            }
        }

        AgentStorage.AgentStorageData storage s = AgentStorage.agentStorage();

        bytes32 agentId = AgentHashLib.computeAgentId(didHash, msg.sender);

        if (s.agents[agentId].registeredAt != 0) {
            revert AgentAlreadyRegistered(agentId);
        }
        if (s.agentByPublicId[publicId] != bytes32(0)) {
            revert PublicIdAlreadyTaken(publicId);
        }

        s.agents[agentId] = AgentStorage.Agent({
            agentId: agentId,
            didHash: didHash,
            ownerUserId: userId,
            ownerAddress: msg.sender,
            publicId: publicId,
            auid: auid,
            name: name,
            description: description,
            parentPublicId: parentPublicId,
            merkleRoot: merkleRoot,
            promptCount: promptCount,
            isActive: true,
            registeredAt: block.timestamp
        });

        s.agentsByOwner[msg.sender].push(agentId);
        s.agentByPublicId[publicId] = agentId;
        s.activeAgents[agentId] = true;
        s.agentCount++;
        s.activeAgentCount++;
        s.merkleRootHistory[agentId].push(merkleRoot);

        DiamondAccessControl.grantRole(DiamondAccessControl.AGENT_ROLE, msg.sender);

        emit AgentRegistered(
            agentId, didHash, userId, msg.sender, publicId, auid, name, description, parentPublicId, merkleRoot
        );
    }

    /**
     * @dev Updates the Merkle root when new prompts are added.
     *      Existing prompt hashes cannot change — only new prompts can be
     *      appended to the tree. The old root is kept in history for audit.
     * @param agentId ID of the agent.
     * @param newRoot New Merkle root including the new prompt(s).
     * @param newPromptCount Total number of prompts after the update.
     */
    function updateMerkleRoot(
        bytes32 agentId,
        bytes32 newRoot,
        uint256 newPromptCount
    ) external {
        LibDiamond.enforceNotPaused();

        AgentStorage.AgentStorageData storage s = AgentStorage.agentStorage();
        AgentStorage.Agent storage agent = s.agents[agentId];

        if (agent.registeredAt == 0) revert AgentNotFound(agentId);
        if (agent.ownerAddress != msg.sender) revert NotAgentOwner(agentId, msg.sender);
        if (!agent.isActive) revert AgentNotActive(agentId);
        if (newRoot == bytes32(0)) revert InvalidMerkleRoot();
        if (newRoot == agent.merkleRoot) revert MerkleRootUnchanged();
        if (newPromptCount <= agent.promptCount) revert MerkleRootUnchanged();

        bytes32 oldRoot = agent.merkleRoot;
        agent.merkleRoot = newRoot;
        agent.promptCount = newPromptCount;
        s.merkleRootHistory[agentId].push(newRoot);

        emit MerkleRootUpdated(agentId, oldRoot, newRoot, newPromptCount);
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    function updateAgent(bytes32 agentId, string calldata publicId) external {
        LibDiamond.enforceNotPaused();

        AgentStorage.AgentStorageData storage s = AgentStorage.agentStorage();
        AgentStorage.Agent storage agent = s.agents[agentId];

        if (agent.registeredAt == 0) revert AgentNotFound(agentId);
        if (agent.ownerAddress != msg.sender) revert NotAgentOwner(agentId, msg.sender);

        string memory oldPublicId = agent.publicId;
        if (!AgentHashLib.stringsEqual(oldPublicId, publicId)) {
            if (s.agentByPublicId[publicId] != bytes32(0)) {
                revert PublicIdAlreadyTaken(publicId);
            }
            delete s.agentByPublicId[oldPublicId];
            s.agentByPublicId[publicId] = agentId;
            agent.publicId = publicId;
        }

        emit AgentUpdated(agentId, publicId);
    }

    function deactivateAgent(bytes32 agentId) external {
        LibDiamond.enforceNotPaused();

        AgentStorage.AgentStorageData storage s = AgentStorage.agentStorage();
        AgentStorage.Agent storage agent = s.agents[agentId];

        if (agent.registeredAt == 0) revert AgentNotFound(agentId);
        if (agent.ownerAddress != msg.sender && msg.sender != LibDiamond.contractOwner()) {
            revert NotAgentOwner(agentId, msg.sender);
        }
        if (!agent.isActive) revert AgentNotActive(agentId);

        agent.isActive = false;
        s.activeAgents[agentId] = false;
        s.activeAgentCount--;

        if (s.agentsByOwner[agent.ownerAddress].length <= 1) {
            DiamondAccessControl.revokeRole(DiamondAccessControl.AGENT_ROLE, agent.ownerAddress);
        }

        emit AgentDeactivated(agentId, agent.ownerAddress);
    }

    function reactivateAgent(bytes32 agentId) external {
        LibDiamond.enforceNotPaused();

        AgentStorage.AgentStorageData storage s = AgentStorage.agentStorage();
        AgentStorage.Agent storage agent = s.agents[agentId];

        if (agent.registeredAt == 0) revert AgentNotFound(agentId);
        if (agent.ownerAddress != msg.sender && msg.sender != LibDiamond.contractOwner()) {
            revert NotAgentOwner(agentId, msg.sender);
        }

        agent.isActive = true;
        s.activeAgents[agentId] = true;
        s.activeAgentCount++;

        DiamondAccessControl.grantRole(DiamondAccessControl.AGENT_ROLE, agent.ownerAddress);

        emit AgentReactivated(agentId, agent.ownerAddress);
    }

    // -----------------------------------------------------------------------
    // Prompt verification
    // -----------------------------------------------------------------------

    /**
     * @dev Verifies that a prompt hash belongs to the agent's current Merkle root.
     * @param agentId ID of the agent.
     * @param promptName Name of the prompt (e.g. "AGENTS.md").
     * @param promptType 0 = immutable, 1 = secondary.
     * @param contentHash Hash of the prompt content (from wallet).
     * @param proof Merkle proof (sibling hashes from leaf to root).
     * @return True if the prompt is verified against the current root.
     */
    function verifyPrompt(
        bytes32 agentId,
        string calldata promptName,
        uint8 promptType,
        bytes32 contentHash,
        bytes32[] calldata proof
    ) external view returns (bool) {
        AgentStorage.AgentStorageData storage s = AgentStorage.agentStorage();
        AgentStorage.Agent storage agent = s.agents[agentId];
        if (agent.registeredAt == 0) revert AgentNotFound(agentId);

        bytes32 leaf = MerkleLib.computeLeaf(promptName, promptType, contentHash);
        return MerkleLib.verify(agent.merkleRoot, leaf, proof);
    }

    /**
     * @dev Verifies a prompt against a specific historical Merkle root.
     * @param agentId ID of the agent.
     * @param rootIndex Index in the Merkle root history (0 = initial).
     * @param promptName Name of the prompt.
     * @param promptType 0 = immutable, 1 = secondary.
     * @param contentHash Hash of the prompt content.
     * @param proof Merkle proof for that historical root.
     */
    function verifyPromptHistorical(
        bytes32 agentId,
        uint256 rootIndex,
        string calldata promptName,
        uint8 promptType,
        bytes32 contentHash,
        bytes32[] calldata proof
    ) external view returns (bool) {
        AgentStorage.AgentStorageData storage s = AgentStorage.agentStorage();
        if (s.agents[agentId].registeredAt == 0) revert AgentNotFound(agentId);
        require(rootIndex < s.merkleRootHistory[agentId].length, "Registry: invalid root index");

        bytes32 root = s.merkleRootHistory[agentId][rootIndex];
        bytes32 leaf = MerkleLib.computeLeaf(promptName, promptType, contentHash);
        return MerkleLib.verify(root, leaf, proof);
    }

    // -----------------------------------------------------------------------
    // View functions
    // -----------------------------------------------------------------------

    function getAgent(bytes32 agentId) external view returns (AgentStorage.Agent memory) {
        AgentStorage.AgentStorageData storage s = AgentStorage.agentStorage();
        if (s.agents[agentId].registeredAt == 0) revert AgentNotFound(agentId);
        return s.agents[agentId];
    }

    function computeAgentId(bytes32 didHash, address ownerAddress) external pure returns (bytes32) {
        return AgentHashLib.computeAgentId(didHash, ownerAddress);
    }

    function isAgentActive(bytes32 agentId) external view returns (bool) {
        return AgentStorage.agentStorage().activeAgents[agentId];
    }

    function getAgentsByOwner(address ownerAddress) external view returns (bytes32[] memory) {
        return AgentStorage.agentStorage().agentsByOwner[ownerAddress];
    }

    function getAgentByPublicId(string calldata publicId)
        external
        view
        returns (AgentStorage.Agent memory)
    {
        AgentStorage.AgentStorageData storage s = AgentStorage.agentStorage();
        bytes32 agentId = s.agentByPublicId[publicId];
        if (agentId == bytes32(0)) revert AgentNotFound(bytes32(0));
        return s.agents[agentId];
    }

    function getAgentCount() external view returns (uint256) {
        return AgentStorage.agentStorage().agentCount;
    }

    function getActiveAgentCount() external view returns (uint256) {
        return AgentStorage.agentStorage().activeAgentCount;
    }

    function getMerkleRoot(bytes32 agentId) external view returns (bytes32) {
        AgentStorage.AgentStorageData storage s = AgentStorage.agentStorage();
        if (s.agents[agentId].registeredAt == 0) revert AgentNotFound(agentId);
        return s.agents[agentId].merkleRoot;
    }

    function getPromptCount(bytes32 agentId) external view returns (uint256) {
        AgentStorage.AgentStorageData storage s = AgentStorage.agentStorage();
        if (s.agents[agentId].registeredAt == 0) revert AgentNotFound(agentId);
        return s.agents[agentId].promptCount;
    }

    function getMerkleRootHistory(bytes32 agentId) external view returns (bytes32[] memory) {
        return AgentStorage.agentStorage().merkleRootHistory[agentId];
    }
}

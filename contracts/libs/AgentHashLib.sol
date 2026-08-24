// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title AgentHashLib
 * @dev Biblioteca para cálculo de hashes relacionados a agentes e usuários.
 *      Centraliza a lógica de hash para garantir consistência entre contratos.
 */
library AgentHashLib {
    /**
     * @dev Calcula o agentId único a partir de didHash e address do usuário.
     * @param didHash Hash do DID do usuário (keccak256 do DID em texto).
     * @param ownerAddress Endereço da carteira do usuário.
     * @return agentId keccak256(didHash, ownerAddress).
     */
    function computeAgentId(bytes32 didHash, address ownerAddress) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(didHash, ownerAddress));
    }

    /**
     * @dev Calcula o userId único a partir de didHash e walletAddress.
     * @param didHash Hash do DID do usuário.
     * @param walletAddress Endereço da carteira do usuário.
     * @return userId keccak256(didHash, walletAddress).
     */
    function computeUserId(bytes32 didHash, address walletAddress) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(didHash, walletAddress));
    }

    /**
     * @dev Calcula o validationId único a partir de agentId, promptHash e timestamp.
     * @param agentId ID do agente.
     * @param promptHash Hash do prompt armazenado no Agentic Space.
     * @param timestamp Momento da validação.
     * @return validationId keccak256(agentId, promptHash, timestamp).
     */
    function computeValidationId(bytes32 agentId, bytes32 promptHash, uint256 timestamp) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(agentId, promptHash, timestamp));
    }

    /**
     * @dev Calcula o hash de um prompt a partir de seu conteúdo.
     * @param content Conteúdo do prompt (pode ser string ou bytes).
     * @return promptHash keccak256(content).
     */
    function computePromptHash(string memory content) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(content));
    }

    /**
     * @dev Calcula o hash de um prompt a partir de bytes.
     * @param content Conteúdo do prompt em bytes.
     * @return promptHash keccak256(content).
     */
    function computePromptHashFromBytes(bytes memory content) internal pure returns (bytes32) {
        return keccak256(content);
    }

    /**
     * @dev Verifica se duas strings são iguais usando hash comparison.
     * @param a Primeira string.
     * @param b Segunda string.
     * @return True se iguais.
     */
    function stringsEqual(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(abi.encodePacked(a)) == keccak256(abi.encodePacked(b));
    }
}

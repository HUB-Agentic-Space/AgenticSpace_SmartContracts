// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title VotingLib
 * @dev Biblioteca com lógica de votação reutilizável pelas DAOs.
 *      Suporta votação majoritária simples e verificação de quorum.
 */
library VotingLib {
    struct VoteTally {
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;
        uint256 totalVotes;
    }

    /**
     * @dev Registra um voto no tally.
     * @param tally Referência ao tally de votos.
     * @param support Tipo de voto (0=Against, 1=For, 2=Abstain).
     * @param weight Peso do voto.
     */
    function recordVote(VoteTally storage tally, uint8 support, uint256 weight) internal {
        if (support == 0) {
            tally.againstVotes += weight;
        } else if (support == 1) {
            tally.forVotes += weight;
        } else if (support == 2) {
            tally.abstainVotes += weight;
        }
        tally.totalVotes += weight;
    }

    /**
     * @dev Verifica se o quorum foi atingido.
     * @param totalVotes Total de votos depositados.
     * @param quorumPercent Percentual de quorum (em basis points, ex: 400 = 4%).
     * @param totalEligible Total de eleitores elegíveis.
     * @return True se quorum atingido.
     */
    function isQuorumReached(uint256 totalVotes, uint256 quorumPercent, uint256 totalEligible) internal pure returns (bool) {
        if (totalEligible == 0) return false;
        uint256 required = (totalEligible * quorumPercent) / 10000;
        return totalVotes >= required;
    }

    /**
     * @dev Verifica se uma proposta foi aprovada por maioria simples.
     * @param forVotes Votos a favor.
     * @param againstVotes Votos contra.
     * @return True se aprovada (forVotes > againstVotes).
     */
    function isApproved(uint256 forVotes, uint256 againstVotes) internal pure returns (bool) {
        return forVotes > againstVotes;
    }

    /**
     * @dev Verifica se uma proposta foi aprovada com maioria qualificada.
     * @param forVotes Votos a favor.
     * @param againstVotes Votos contra.
     * @param thresholdPercent Percentual necessário (em basis points, ex: 6000 = 60%).
     * @return True se aprovada.
     */
    function isApprovedQualified(
        uint256 forVotes,
        uint256 againstVotes,
        uint256 thresholdPercent
    ) internal pure returns (bool) {
        uint256 totalNonAbstain = forVotes + againstVotes;
        if (totalNonAbstain == 0) return false;
        uint256 required = (totalNonAbstain * thresholdPercent) / 10000;
        return forVotes >= required;
    }

    /**
     * @dev Converte duração em dias para segundos.
     * @param days_ Número de dias.
     * @return Segundos.
     */
    function daysToSeconds(uint256 days_) internal pure returns (uint256) {
        return days_ * 1 days;
    }

    /**
     * @dev Verifica se um prazo de votação já expirou.
     * @param deadline Timestamp do prazo.
     * @return True se expirado.
     */
    function isVotingExpired(uint256 deadline) internal view returns (bool) {
        return block.timestamp >= deadline;
    }
}

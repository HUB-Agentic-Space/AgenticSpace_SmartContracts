"""
CAS GNN — Diagnóstico de integridade e risco de mercado.

Carrega transferências CAS do banco SQLite local, constrói o grafo de
transferências, executa o modelo GNN treinado e emite um diagnóstico
classificado entre:
  Saudável/Orgânico
  Alerta Especulativo
  Anomalia Suspeita / Risco de Golpe

Também computa scores heurísticos explicativos alinhados aos padrões da
matriz fornecida (Pump & Dump, Wash Trading, Rug Pull, etc.).
"""

from __future__ import annotations

import argparse
import json
import math
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import torch

from cas_gnn_model import (
    CARGnn,
    CHECKPOINT_DIR,
    DEFAULT_DB_PATH,
    RISK_LABELS,
    TokenGraph,
    TokenTransfer,
    ZERO,
    build_graph,
    log,
    to_num,
)

# ── Carregamento de dados do SQLite ────────────────────────────────────


def load_address_info(db_path: Path) -> Dict[str, Dict[str, Any]]:
    info: Dict[str, Dict[str, Any]] = {}
    if not db_path.exists():
        log("WARN", "load_address_info", "Banco SQLite não encontrado", {"path": str(db_path)})
        return info
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT address, label, type, is_contract FROM addresses")
    for row in cur.fetchall():
        info[row["address"].lower()] = {
            "label": row["label"] or "",
            "type": row["type"] or "unknown",
            "is_contract": int(row["is_contract"]),
        }
    conn.close()
    return info


def load_transfers(db_path: Path, limit: Optional[int] = None) -> List[TokenTransfer]:
    transfers: List[TokenTransfer] = []
    if not db_path.exists():
        log("ERROR", "load_transfers", "Banco SQLite não encontrado", {"path": str(db_path)})
        return transfers
    conn = sqlite3.connect(str(db_path))
    cur = conn.cursor()
    query = "SELECT tx_hash, block_number, timestamp, from_address, to_address, value, is_mint, is_burn FROM transactions ORDER BY timestamp"
    if limit:
        query += f" LIMIT {int(limit)}"
    cur.execute(query)
    for row in cur.fetchall():
        transfers.append(TokenTransfer(
            tx_hash=row[0],
            block_number=int(row[1]),
            timestamp=int(row[2]),
            from_address=str(row[3]).lower(),
            to_address=str(row[4]).lower(),
            value=str(row[5]),
            is_mint=int(row[6]),
            is_burn=int(row[7]),
        ))
    conn.close()
    return transfers


# ── Scores heurísticos explicativos ───────────────────────────────────


def compute_pattern_scores(graph: TokenGraph) -> Dict[str, float]:
    """Calcula scores normalizados (0-1) para padrões de risco/manipulação."""
    scores: Dict[str, float] = defaultdict(float)
    addr_idx = {a: i for i, a in enumerate(graph.node_addresses)}
    x = graph.node_features.numpy()
    n_nodes = x.shape[0]
    if n_nodes == 0:
        return dict(scores)

    # Índices de features
    BALANCE = 0
    IN_VOL = 1
    OUT_VOL = 2
    IN_TX = 3
    OUT_TX = 4
    IS_INFRA = 10
    IS_TEAM = 11

    balances = x[:, BALANCE]
    in_vols = x[:, IN_VOL]
    out_vols = x[:, OUT_VOL]
    total_bal = balances[balances > 0].sum() or 1.0
    total_vol = (in_vols + out_vols).sum() or 1.0

    # Top holders concentration
    sorted_bal = np.sort(balances)[::-1]
    top1 = sorted_bal[0] / total_bal if len(sorted_bal) > 1 else 0.0
    top10 = sorted_bal[:10].sum() / total_bal
    scores["top1_concentration"] = min(top1, 1.0)
    scores["top10_concentration"] = min(top10, 1.0)

    # Whale dump / pump-dump: endereços grandes com muito outflow recente
    big_threshold = np.percentile(balances[balances > 1], 90) if np.any(balances > 1) else 1.0
    whales = np.where((balances >= big_threshold) & (balances > 1))[0]
    whale_out = out_vols[whales].sum() / max(1.0, in_vols[whales].sum())
    scores["whale_dump_pressure"] = min(whale_out / 3.0, 1.0)

    # Wash trading: ciclos A->B e B->A com volume similar
    edge_index = graph.edge_index.numpy()
    edge_features = graph.edge_features.numpy()
    pair_in = defaultdict(float)
    pair_out = defaultdict(float)
    pair_count = defaultdict(int)
    for e in range(edge_index.shape[1]):
        f = int(edge_index[0, e])
        t = int(edge_index[1, e])
        vol = float(edge_features[e, 1])
        pair_in[(f, t)] += vol
        pair_out[(t, f)] += vol
        pair_count[(f, t)] += 1

    wash_score = 0.0
    for (a, b), out_vol in pair_out.items():
        if (b, a) in pair_in:
            reciprocal = min(out_vol, pair_in[(b, a)]) / max(out_vol, pair_in[(b, a)], 1e-9)
            if reciprocal > 0.8:
                wash_score += pair_count.get((a, b), 0) + pair_count.get((b, a), 0)
    scores["wash_trading"] = min(wash_score / 20.0, 1.0)

    # Rug pull proxy: saídas de infra/team/lp para não-infra grandes
    team_mask = x[:, IS_TEAM] > 0
    infra_mask = x[:, IS_INFRA] > 0
    team_out = out_vols[team_mask].sum() / max(1.0, total_vol)
    scores["team_selling"] = min(team_out * 3.0, 1.0)

    lp_out = out_vols[infra_mask].sum() / max(1.0, total_vol)
    scores["lp_outflow"] = min(lp_out * 3.0, 1.0)

    # Spoofing/layering: transferências grandes para infra seguidas por retorno
    # Proxy simples: grandes arestas para infra
    big_to_infra = 0.0
    for e in range(edge_index.shape[1]):
        t = int(edge_index[1, e])
        if x[t, IS_INFRA] > 0 and float(edge_features[e, 1]) > np.percentile(edge_features[:, 1], 95):
            big_to_infra += float(edge_features[e, 1])
    scores["spoofing_layering"] = min(big_to_infra / max(1.0, total_vol) * 2.0, 1.0)

    # Vesting / staking / buyback: movimentação previsível de team/contratos
    scores["vesting_unlock"] = min(scores["team_selling"] * 0.8, 1.0)

    return dict(scores)


def aggregate_to_diagnosis(probs: np.ndarray, scores: Dict[str, float]) -> Tuple[str, str, List[str]]:
    """Converte probabilidades GNN + scores heurísticos em diagnóstico textual."""
    idx = int(probs.argmax())
    label = RISK_LABELS[idx]
    confidence = float(probs[idx])

    reasons: List[str] = []
    if idx == 0:
        diagnosis = "Saudável/Orgânico"
        trend = "COMPORTAMENTO ORGÂNICO"
        reasons.append("Distribuição e volume não apresentam anomalias significativas.")
    elif idx == 1:
        diagnosis = "Alerta Especulativo"
        trend = "ESPECULAÇÃO / EVENTO ESTRATÉGICO"
        reasons.append("Detectada concentração ou movimentação atípica, mas consistente com trading especulativo.")
    else:
        diagnosis = "Anomalia Suspeita / Risco de Golpe"
        trend = "ANOMALIA / POSSÍVEL MANIPULAÇÃO"
        reasons.append("Padrões compatíveis com manipulação de volume ou retirada de liquidez.")

    top_scores = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)[:4]
    for name, value in top_scores:
        if value > 0.2:
            reasons.append(f"{name}: {value * 100:.1f}%")

    return diagnosis, trend, reasons


# ── Main ───────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="Diagnóstico GNN de risco CAS")
    parser.add_argument("--db", type=str, default=str(DEFAULT_DB_PATH), help="Caminho para cas_tracker.db")
    parser.add_argument("--checkpoint", type=str, default=str(CHECKPOINT_DIR / "cas_gnn_model.pt"), help="Checkpoint do modelo")
    parser.add_argument("--max-nodes", type=int, default=5000, help="Máximo de nós no grafo")
    parser.add_argument("--device", type=str, default="auto", help="cpu ou cuda (auto)")
    parser.add_argument("--limit", type=int, default=None, help="Limitar número de transferências carregadas")
    parser.add_argument("--output", type=str, default=None, help="JSON de saída (opcional)")
    args = parser.parse_args()

    db_path = Path(args.db)
    checkpoint_path = Path(args.checkpoint)

    if not checkpoint_path.exists():
        log("ERROR", "main", "Checkpoint não encontrado. Treine primeiro com train_synthetic.py", {"path": str(checkpoint_path)})
        return

    if args.device == "auto":
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    else:
        device = torch.device(args.device)

    address_info = load_address_info(db_path)
    transfers = load_transfers(db_path, limit=args.limit)
    if not transfers:
        log("ERROR", "main", "Nenhuma transferência encontrada no banco", {"path": str(db_path)})
        return

    log("OK", "main", "Dados carregados", {
        "transfers": len(transfers),
        "addresses": len(address_info),
    })

    graph = build_graph(transfers, address_info, max_nodes=args.max_nodes)
    log("OK", "main", "Grafo construído", {
        "nodes": graph.node_features.shape[0],
        "edges": graph.edge_index.shape[1],
    })

    checkpoint = torch.load(checkpoint_path, map_location=device)
    model = CARGnn(
        node_dim=checkpoint["node_dim"],
        edge_dim=checkpoint["edge_dim"],
        hidden_dim=checkpoint["hidden_dim"],
        num_layers=checkpoint["num_layers"],
    ).to(device)
    model.load_state_dict(checkpoint["model_state_dict"])
    model.eval()

    with torch.no_grad():
        x = graph.node_features.to(device)
        edge_index = graph.edge_index.to(device)
        edge_features = graph.edge_features.to(device)
        logits = model(x, edge_index, edge_features)
        probs = torch.softmax(logits, dim=0).cpu().numpy()

    scores = compute_pattern_scores(graph)
    diagnosis, trend, reasons = aggregate_to_diagnosis(probs, scores)

    result = {
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "db_path": str(db_path),
        "transfers_analyzed": len(transfers),
        "nodes": graph.node_features.shape[0],
        "edges": graph.edge_index.shape[1],
        "gnn_probabilities": {RISK_LABELS[i]: round(float(probs[i]), 4) for i in range(3)},
        "diagnosis": diagnosis,
        "trend": trend,
        "confidence": round(float(probs.max()), 4),
        "pattern_scores": {k: round(float(v), 4) for k, v in scores.items()},
        "reasons": reasons,
    }

    log("INFO", "main", f"Diagnóstico: {diagnosis}", result)

    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "w") as f:
            json.dump(result, f, indent=2)
        log("OK", "main", "Resultado salvo", {"file": str(out_path)})
    else:
        print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()

"""
CAS GNN — Modelo e utilitários de grafo.

Implementa uma rede neural de grafos leve em PyTorch puro (sem
torch-geometric) para classificação de risco de token CAS:
  0 = Saudável/Orgânico
  1 = Alerta Especulativo
  2 = Anomalia Suspeita / Risco de Golpe

Também expõe extratores de features de nós e arestas a partir de
transferências on-chain, permitindo reuso entre treino sintético e
inferência no banco SQLite do CAS.
"""

from __future__ import annotations

import json
import math
import os
import random
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

# ── Configurações ─────────────────────────────────────────────────────

DECIMALS = 18
ZERO = "0x0000000000000000000000000000000000000000"
DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "cas_tracker.db"
CHECKPOINT_DIR = Path(__file__).resolve().parent / "checkpoints"

INFRA_KEYWORDS = {
    "contract", "infra", "dex", "swap", "reserve", "fund", "proxy", "faucet",
    "lock", "migration", "lp", "bridge", "wrapper", "token", "safe", "multisig",
    "router", "manager", "factory", "certificate", "diamond",
}

TEAM_KEYWORDS = {"deployer", "admin", "team", "marketing", "advisor", "dev"}

RISK_LABELS = ["Saudável/Orgânico", "Alerta Especulativo", "Anomalia Suspeita/Risco de Golpe"]

# ── Logging estruturado ───────────────────────────────────────────────


def log(level: str, fn: str, message: str, params: Optional[Dict[str, Any]] = None) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    emoji = {"INFO": "ℹ️", "WARN": "⚠️", "ERROR": "❌", "OK": "✅", "DEBUG": "🔍"}.get(level, "•")
    extra = f" - {json.dumps(params, default=str)}" if params else ""
    print(f"[{ts}] [cas_gnn_model:{fn}] {emoji} {message}{extra}")


# ── Estruturas de dados ───────────────────────────────────────────────


@dataclass
class TokenTransfer:
    tx_hash: str
    block_number: int
    timestamp: int
    from_address: str
    to_address: str
    value: str
    is_mint: int = 0
    is_burn: int = 0


@dataclass
class TokenGraph:
    node_features: torch.Tensor  # [N, F]
    edge_index: torch.Tensor  # [2, E]
    edge_features: torch.Tensor  # [E, Ef]
    node_addresses: List[str]
    node_labels: List[str]
    transfers: List[TokenTransfer]


# ── Helpers ───────────────────────────────────────────────────────────


def to_num(value_str: str) -> float:
    try:
        v = int(value_str)
        return v / (10 ** DECIMALS)
    except (ValueError, TypeError):
        return 0.0


def short_addr(a: str) -> str:
    if not a or len(a) < 12:
        return a or ""
    return f"{a[:6]}…{a[-4:]}"


def is_infra(label: str, type_: str) -> bool:
    for kw in INFRA_KEYWORDS:
        if kw in label.lower() or kw in type_.lower():
            return True
    return False


def is_team(label: str, type_: str) -> bool:
    for kw in TEAM_KEYWORDS:
        if kw in label.lower() or kw in type_.lower():
            return True
    return False


# ── Construção de grafo a partir de transferências ────────────────────


def build_graph(
    transfers: List[TokenTransfer],
    address_info: Optional[Dict[str, Dict[str, Any]]] = None,
    max_nodes: int = 5000,
) -> TokenGraph:
    """
    Constrói um grafo dirigido de transferências.
    - Nós: endereços únicos com saldo e métricas.
    - Arestas: fluxos acumulados entre endereços.

    Limita a `max_nodes` endereços mais ativos para evitar explosão de memória.
    """
    if address_info is None:
        address_info = {}

    addr_stats: Dict[str, Dict[str, Any]] = {}
    pair_stats: Dict[Tuple[str, str], Dict[str, Any]] = {}

    for t in transfers:
        f = t.from_address.lower()
        t_addr = t.to_address.lower()
        v = to_num(t.value)
        if f == ZERO or t_addr == ZERO:
            continue

        for a in (f, t_addr):
            if a not in addr_stats:
                info = address_info.get(a, {})
                addr_stats[a] = {
                    "address": a,
                    "label": info.get("label", ""),
                    "type": info.get("type", "unknown"),
                    "is_contract": int(bool(info.get("is_contract", 0))),
                    "is_infra": int(is_infra(info.get("label", ""), info.get("type", "unknown"))),
                    "is_team": int(is_team(info.get("label", ""), info.get("type", "unknown"))),
                    "in_vol": 0.0,
                    "out_vol": 0.0,
                    "in_tx": 0,
                    "out_tx": 0,
                    "balance": 0.0,
                    "unique_in": set(),
                    "unique_out": set(),
                    "first_ts": t.timestamp,
                    "last_ts": t.timestamp,
                }
            s = addr_stats[a]
            s["first_ts"] = min(s["first_ts"], t.timestamp)
            s["last_ts"] = max(s["last_ts"], t.timestamp)

        addr_stats[f]["out_vol"] += v
        addr_stats[f]["out_tx"] += 1
        addr_stats[f]["unique_out"].add(t_addr)
        addr_stats[f]["balance"] -= v
        addr_stats[t_addr]["in_vol"] += v
        addr_stats[t_addr]["in_tx"] += 1
        addr_stats[t_addr]["unique_in"].add(f)
        addr_stats[t_addr]["balance"] += v

        pair = (f, t_addr)
        if pair not in pair_stats:
            pair_stats[pair] = {"count": 0, "volume": 0.0}
        pair_stats[pair]["count"] += 1
        pair_stats[pair]["volume"] += v

    # Ordenar por atividade total e limitar nós
    sorted_addrs = sorted(
        addr_stats.keys(),
        key=lambda a: addr_stats[a]["in_tx"] + addr_stats[a]["out_tx"],
        reverse=True,
    )[:max_nodes]

    addr_to_idx = {a: i for i, a in enumerate(sorted_addrs)}

    node_addresses = sorted_addrs
    node_labels = [addr_stats[a]["label"] or short_addr(a) for a in sorted_addrs]

    node_features = []
    now = max((s["last_ts"] for s in addr_stats.values()), default=0) or 1
    for a in sorted_addrs:
        s = addr_stats[a]
        in_unique = len(s["unique_in"])
        out_unique = len(s["unique_out"])
        age = max(1, now - s["first_ts"])
        activity_span = max(1, s["last_ts"] - s["first_ts"])
        node_features.append([
            float(s["balance"]),
            float(s["in_vol"]),
            float(s["out_vol"]),
            float(s["in_tx"]),
            float(s["out_tx"]),
            float(in_unique),
            float(out_unique),
            float(s["in_vol"] / max(1, s["in_tx"])),
            float(s["out_vol"] / max(1, s["out_tx"])),
            float(s["is_contract"]),
            float(s["is_infra"]),
            float(s["is_team"]),
            float(s["balance"]) / 1_000_000.0,  # normalized large balance proxy
            math.log1p(s["in_tx"] + s["out_tx"]),
            math.log1p(s["in_vol"] + s["out_vol"]),
            float(activity_span) / age,
        ])

    edges_src = []
    edges_dst = []
    edge_features = []
    for (f, t_addr), p in pair_stats.items():
        if f in addr_to_idx and t_addr in addr_to_idx:
            edges_src.append(addr_to_idx[f])
            edges_dst.append(addr_to_idx[t_addr])
            edge_features.append([float(p["count"]), float(p["volume"]), math.log1p(p["volume"])])

    x = torch.tensor(node_features, dtype=torch.float32)
    edge_index = torch.tensor([edges_src, edges_dst], dtype=torch.long)
    ef = torch.tensor(edge_features, dtype=torch.float32)

    return TokenGraph(
        node_features=x,
        edge_index=edge_index,
        edge_features=ef,
        node_addresses=node_addresses,
        node_labels=node_labels,
        transfers=transfers,
    )


# ── Modelo GNN ────────────────────────────────────────────────────────


class GraphConv(nn.Module):
    """Camada de convolução em grafo esparsa: agrega mensagens das arestas com normalização por grau."""

    def __init__(self, in_features: int, out_features: int):
        super().__init__()
        self.linear = nn.Linear(in_features, out_features)

    def forward(
        self,
        x: torch.Tensor,
        edge_index: torch.Tensor,
        edge_weight: Optional[torch.Tensor] = None,
    ) -> torch.Tensor:
        num_nodes = x.size(0)
        src, dst = edge_index

        # Mensagens a partir dos nós de origem
        messages = self.linear(x)[src]
        if edge_weight is not None:
            messages = messages * edge_weight.unsqueeze(1)

        # Agregar nos destinos
        out = torch.zeros(num_nodes, messages.size(1), device=x.device, dtype=messages.dtype)
        out.index_add_(0, dst, messages)

        # Auto-laços
        out += self.linear(x)

        # Normalização por grau (incluindo auto-laço)
        degree = torch.zeros(num_nodes, device=x.device, dtype=x.dtype)
        degree.index_add_(0, dst, torch.ones_like(dst, dtype=x.dtype))
        degree += 1.0  # self-loop
        degree = degree.clamp(min=1.0)
        return out / degree.unsqueeze(1)


class CARGnn(nn.Module):
    def __init__(
        self,
        node_dim: int,
        edge_dim: int,
        hidden_dim: int = 64,
        num_classes: int = 3,
        num_layers: int = 3,
        dropout: float = 0.2,
    ):
        super().__init__()
        self.edge_proj = nn.Linear(edge_dim, 1)

        layers = []
        layers.append(GraphConv(node_dim, hidden_dim))
        for _ in range(num_layers - 1):
            layers.append(GraphConv(hidden_dim, hidden_dim))
        self.convs = nn.ModuleList(layers)

        self.batch_norms = nn.ModuleList([nn.BatchNorm1d(hidden_dim) for _ in range(num_layers)])
        self.dropout = nn.Dropout(dropout)

        self.classifier = nn.Sequential(
            nn.Linear(hidden_dim * 2, hidden_dim),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim, num_classes),
        )

    def forward(self, x: torch.Tensor, edge_index: torch.Tensor, edge_features: torch.Tensor) -> torch.Tensor:
        edge_weight = self.edge_proj(edge_features).squeeze(-1)
        edge_weight = torch.relu(edge_weight) + 0.1

        h = x
        for conv, bn in zip(self.convs, self.batch_norms):
            h = conv(h, edge_index, edge_weight)
            h = bn(h)
            h = F.relu(h)
            h = self.dropout(h)

        # Pooling global: mean + std
        mean_pool = h.mean(dim=0)
        std_pool = h.std(dim=0)
        graph_repr = torch.cat([mean_pool, std_pool], dim=-1)
        return self.classifier(graph_repr)


# ── Dataset sintético ─────────────────────────────────────────────────


def _random_address() -> str:
    return "0x" + "".join(random.choices("0123456789abcdef", k=40))


def _sample_balanced_value(mode: str) -> float:
    if mode == "whale":
        return 10_000_000 * (0.5 + random.random())
    if mode == "retail":
        return 100 + random.random() * 9_900
    if mode == "min":
        return 0.01 + random.random() * 10
    return 1000 * random.random()


def _generate_label_info(addr: str, kind: str) -> Dict[str, Any]:
    label_map = {
        "deployer": "Deployer/Admin",
        "team": "Team Wallet",
        "dex": "DEX LP",
        "bridge": "Bridge",
        "wallet": "Wallet",
        "contract": "Contract",
    }
    label = label_map.get(kind, kind.capitalize())
    return {"address": addr, "label": label, "type": kind, "is_contract": int(kind in ("dex", "bridge", "contract"))}


def generate_synthetic_graph(class_label: int, num_nodes: int = 80, num_edges: int = 400) -> Tuple[TokenGraph, int]:
    """Gera um grafo sintético rotulado como saudável (0), especulativo (1) ou suspeito (2)."""
    addresses = [_random_address() for _ in range(num_nodes)]
    address_info: Dict[str, Dict[str, Any]] = {}

    # Papéis
    for i, a in enumerate(addresses):
        if i == 0:
            address_info[a] = _generate_label_info(a, "deployer")
        elif i < 4:
            address_info[a] = _generate_label_info(a, "team")
        elif i < 10:
            address_info[a] = _generate_label_info(a, random.choice(["dex", "bridge", "contract"]))
        else:
            address_info[a] = _generate_label_info(a, "wallet")

    transfers: List[TokenTransfer] = []
    ts_start = 1_700_000_000

    for _ in range(num_edges):
        f = random.choice(addresses)
        t_addr = random.choice(addresses)
        if f == t_addr:
            continue
        ts = ts_start + random.randint(0, 7 * 24 * 3600)

        if class_label == 0:
            # Saudável: transferências variadas, pequenas, orgânicas
            value = _sample_balanced_value("retail")
            v_str = str(int(value * 10 ** DECIMALS))
        elif class_label == 1:
            # Especulativo: acumulação/descumulo por baleia, grandes volumes direcionados
            if random.random() < 0.3:
                value = _sample_balanced_value("whale")
            else:
                value = _sample_balanced_value("retail")
            v_str = str(int(value * 10 ** DECIMALS))
        else:
            # Suspeito: wash trading (ciclos), rug-pull (saida do LP), pump/dump (volume concentrado)
            if random.random() < 0.4:
                # ciclos A->B->A
                value = _sample_balanced_value("retail")
            else:
                value = _sample_balanced_value("retail") * (1 + random.random() * 5)
            v_str = str(int(value * 10 ** DECIMALS))

        transfers.append(TokenTransfer(
            tx_hash="0x" + "".join(random.choices("0123456789abcdef", k=64)),
            block_number=random.randint(50_000_000, 60_000_000),
            timestamp=ts,
            from_address=f,
            to_address=t_addr,
            value=v_str,
        ))

    # Injeção de padrões específicos
    if class_label == 1:
        # Baleia acumulando de múltiplos endereços para depois descarregar
        whale = addresses[10]
        targets = random.sample(addresses[20:40], 5)
        for _ in range(20):
            for t in targets:
                ts = ts_start + random.randint(0, 3 * 24 * 3600)
                v = _sample_balanced_value("retail")
                transfers.append(TokenTransfer(
                    tx_hash="0x" + "".join(random.choices("0123456789abcdef", k=64)),
                    block_number=random.randint(50_000_000, 60_000_000),
                    timestamp=ts,
                    from_address=t,
                    to_address=whale,
                    value=str(int(v * 10 ** DECIMALS)),
                ))
        # Descumulo
        for _ in range(15):
            ts = ts_start + 4 * 24 * 3600 + random.randint(0, 24 * 3600)
            v = _sample_balanced_value("whale") / 5
            transfers.append(TokenTransfer(
                tx_hash="0x" + "".join(random.choices("0123456789abcdef", k=64)),
                block_number=random.randint(50_000_000, 60_000_000),
                timestamp=ts,
                from_address=whale,
                to_address=random.choice(addresses[1:10]),  # LP/DEX/team
                value=str(int(v * 10 ** DECIMALS)),
            ))

    if class_label == 2:
        # Wash trading entre 2 contas
        a, b = addresses[20], addresses[21]
        base_ts = ts_start + random.randint(0, 2 * 24 * 3600)
        for i in range(30):
            ts = base_ts + i * 60
            v = 50_000 + random.random() * 5_000
            transfers.append(TokenTransfer(
                tx_hash="0x" + "".join(random.choices("0123456789abcdef", k=64)),
                block_number=random.randint(50_000_000, 60_000_000),
                timestamp=ts,
                from_address=a,
                to_address=b,
                value=str(int(v * 10 ** DECIMALS)),
            ))
            transfers.append(TokenTransfer(
                tx_hash="0x" + "".join(random.choices("0123456789abcdef", k=64)),
                block_number=random.randint(50_000_000, 60_000_000),
                timestamp=ts + 30,
                from_address=b,
                to_address=a,
                value=str(int(v * 10 ** DECIMALS)),
            ))

        # Rug-pull proxy: retirada do LP
        lp = addresses[5]
        for _ in range(10):
            ts = ts_start + 6 * 24 * 3600 + random.randint(0, 3600)
            v = _sample_balanced_value("whale") * 2
            transfers.append(TokenTransfer(
                tx_hash="0x" + "".join(random.choices("0123456789abcdef", k=64)),
                block_number=random.randint(50_000_000, 60_000_000),
                timestamp=ts,
                from_address=lp,
                to_address=addresses[1],
                value=str(int(v * 10 ** DECIMALS)),
            ))

    graph = build_graph(transfers, address_info)
    return graph, class_label


class SyntheticCARGnnDataset(torch.utils.data.Dataset):
    def __init__(self, n_samples: int = 1200, balance: Optional[List[int]] = None):
        super().__init__()
        if balance is None:
            balance = [n_samples // 3, n_samples // 3, n_samples - 2 * (n_samples // 3)]
        self.samples: List[Tuple[TokenGraph, int]] = []
        for cls, count in enumerate(balance):
            for _ in range(count):
                self.samples.append(generate_synthetic_graph(cls))

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, idx: int) -> Tuple[TokenGraph, int]:
        return self.samples[idx]


def collate_graphs(batch: List[Tuple[TokenGraph, int]]) -> List[Tuple[TokenGraph, int]]:
    """Retorna lista de pares; o treino processa um grafo por vez por simplicidade."""
    return batch

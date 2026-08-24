"""
CAS GNN — Treinamento com dados sintéticos.

Gera amostras artificiais de grafos de transferências CAS rotuladas como:
  0 = Saudável/Orgânico
  1 = Alerta Especulativo
  2 = Anomalia Suspeita / Risco de Golpe

Treina o modelo cas_gnn_model.CARGnn e salva checkpoints em:
  scripts/gnn/checkpoints/cas_gnn_model.pt
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
from pathlib import Path
from typing import Tuple

import numpy as np
import torch
import torch.nn.functional as F
from sklearn.metrics import classification_report, confusion_matrix
from torch.utils.data import DataLoader

from cas_gnn_model import (
    CARGnn,
    SyntheticCARGnnDataset,
    CHECKPOINT_DIR,
    RISK_LABELS,
    log,
)


def set_seed(seed: int = 42) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


def train_epoch(model: CARGnn, loader: DataLoader, optimizer: torch.optim.Optimizer, device: torch.device) -> float:
    model.train()
    total_loss = 0.0
    count = 0
    for batch in loader:
        optimizer.zero_grad()
        batch_loss = 0.0
        for graph, label in batch:
            x = graph.node_features.to(device)
            edge_index = graph.edge_index.to(device)
            edge_features = graph.edge_features.to(device)
            y = torch.tensor([label], dtype=torch.long, device=device)
            logits = model(x, edge_index, edge_features).unsqueeze(0)
            loss = F.cross_entropy(logits, y)
            batch_loss += loss
            count += 1
        batch_loss = batch_loss / max(1, len(batch))
        batch_loss.backward()
        optimizer.step()
        total_loss += batch_loss.item()
    return total_loss / max(1, len(loader))


def evaluate(model: CARGnn, loader: DataLoader, device: torch.device) -> Tuple[float, float, np.ndarray, np.ndarray]:
    model.eval()
    all_preds = []
    all_labels = []
    total_loss = 0.0
    correct = 0
    total = 0
    with torch.no_grad():
        for batch in loader:
            for graph, label in batch:
                x = graph.node_features.to(device)
                edge_index = graph.edge_index.to(device)
                edge_features = graph.edge_features.to(device)
                y = torch.tensor([label], dtype=torch.long, device=device)
                logits = model(x, edge_index, edge_features).unsqueeze(0)
                loss = F.cross_entropy(logits, y)
                total_loss += loss.item()
                pred = logits.argmax(dim=1)
                all_preds.append(pred.item())
                all_labels.append(label)
                correct += (pred == y).sum().item()
                total += 1
    accuracy = correct / max(1, total)
    return total_loss / max(1, total), accuracy, np.array(all_labels), np.array(all_preds)


def main():
    parser = argparse.ArgumentParser(description="Treina GNN sintética para diagnóstico de risco CAS")
    parser.add_argument("--samples", type=int, default=1200, help="Número total de amostras sintéticas")
    parser.add_argument("--epochs", type=int, default=30, help="Épocas de treinamento")
    parser.add_argument("--lr", type=float, default=0.001, help="Learning rate")
    parser.add_argument("--hidden", type=int, default=64, help="Dimensão oculta")
    parser.add_argument("--layers", type=int, default=3, help="Camadas GNN")
    parser.add_argument("--seed", type=int, default=42, help="Seed aleatória")
    parser.add_argument("--device", type=str, default="auto", help="cpu ou cuda (auto detecta)")
    args = parser.parse_args()

    set_seed(args.seed)

    if args.device == "auto":
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    else:
        device = torch.device(args.device)
    log("INFO", "main", f"Dispositivo selecionado", {"device": str(device)})

    CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)

    # Dataset balanceado
    balance = [args.samples // 3, args.samples // 3, args.samples - 2 * (args.samples // 3)]
    dataset = SyntheticCARGnnDataset(n_samples=args.samples, balance=balance)

    # Split 80/20
    n_train = int(0.8 * len(dataset))
    n_val = len(dataset) - n_train
    train_set, val_set = torch.utils.data.random_split(dataset, [n_train, n_val])

    train_loader = DataLoader(train_set, batch_size=8, shuffle=True, collate_fn=lambda x: x)
    val_loader = DataLoader(val_set, batch_size=8, shuffle=False, collate_fn=lambda x: x)

    # Inicializar modelo
    sample_graph, _ = dataset[0]
    node_dim = sample_graph.node_features.shape[1]
    edge_dim = sample_graph.edge_features.shape[1]
    model = CARGnn(
        node_dim=node_dim,
        edge_dim=edge_dim,
        hidden_dim=args.hidden,
        num_classes=3,
        num_layers=args.layers,
    ).to(device)

    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr, weight_decay=1e-5)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, mode="min", factor=0.5, patience=5)

    best_val_loss = math.inf
    best_model_path = CHECKPOINT_DIR / "cas_gnn_model.pt"

    for epoch in range(args.epochs):
        train_loss = train_epoch(model, train_loader, optimizer, device)
        val_loss, val_acc, y_true, y_pred = evaluate(model, val_loader, device)
        scheduler.step(val_loss)

        log("INFO", "main", f"Época {epoch + 1}/{args.epochs}", {
            "train_loss": round(train_loss, 4),
            "val_loss": round(val_loss, 4),
            "val_acc": round(val_acc, 4),
        })

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            torch.save({
                "model_state_dict": model.state_dict(),
                "node_dim": node_dim,
                "edge_dim": edge_dim,
                "hidden_dim": args.hidden,
                "num_layers": args.layers,
                "classes": RISK_LABELS,
            }, best_model_path)
            log("OK", "main", "Novo melhor modelo salvo", {"path": str(best_model_path), "val_loss": round(val_loss, 4)})

    # Avaliação final
    checkpoint = torch.load(best_model_path, map_location=device)
    model.load_state_dict(checkpoint["model_state_dict"])
    _, _, y_true, y_pred = evaluate(model, val_loader, device)

    report = classification_report(y_true, y_pred, target_names=RISK_LABELS, output_dict=True)
    matrix = confusion_matrix(y_true, y_pred).tolist()
    log("OK", "main", "Relatório de validação", {
        "accuracy": round(report["accuracy"], 4),
        "confusion_matrix": matrix,
    })

    metrics_path = CHECKPOINT_DIR / "training_metrics.json"
    with open(metrics_path, "w") as f:
        json.dump({"report": report, "confusion_matrix": matrix}, f, indent=2)
    log("OK", "main", "Métricas salvas", {"file": str(metrics_path)})


if __name__ == "__main__":
    main()

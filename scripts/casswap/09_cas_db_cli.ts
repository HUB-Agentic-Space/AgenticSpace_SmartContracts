/**
 * CAS DB CLI — gerenciar endereços e transações no banco SQLite.
 *
 * Comandos:
 *   label <address> <name>       — nomear um endereço (até 100 chars)
 *   notes <address> <text>       — adicionar notas a um endereço
 *   list                         — listar todos os endereços
 *   list --type <type>           — filtrar por tipo (eoa, contract, etc)
 *   search <query>               — buscar por endereço, nome ou nota
 *   txs <address> [limit]        — ver transações de um endereço
 *   stats                        — estatísticas gerais do banco
 *   show <address>               — detalhes de um endereço
 *
 * Uso:
 *   npx hardhat run scripts/casswap/09_cas_db_cli.ts -- label 0x1234... "Alice"
 *   npx hardhat run scripts/casswap/09_cas_db_cli.ts -- list
 *   npx hardhat run scripts/casswap/09_cas_db_cli.ts -- txs 0x1234... 20
 *   npm run cas:db:label -- 0x1234... "Alice"
 *   npm run cas:db:list
 *   npm run cas:db:stats
 */

import { ethers } from "agentic_space_commons";
import {
  getDB, closeDB, setAddressLabel as setLabel, setNotes, getAddress, getAllAddresses,
  getAddressesByType, searchAddresses, getTransactionsByAddress,
  getTransactionCount, getLabelMap, resolveShortAddress,
} from "../utils/cas_database";
import {
  buildHtmlTable, buildHtmlPage, buildSummaryGrid,
  saveAndOpenReport, type TableColumn, type SummaryItem,
} from "../utils/html_report";

function fmt(s: string): string {
  return Number(ethers.formatUnits(BigInt(s || "0"), 18)).toLocaleString("pt-BR");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    printHelp();
    return;
  }

  const cmd = args[0];
  getDB();

  try {
    switch (cmd) {
      case "label": {
        if (args.length < 3) { console.error("Uso: label <address> <name>"); break; }
        const [addrRaw, ...nameParts] = args.slice(1);
        const addr = resolveShortAddress(addrRaw) ?? addrRaw;
        const name = nameParts.join(" ");
        if (name.length > 100) { console.error("Nome excede 100 caracteres"); break; }
        setLabel(addr, name);
        console.log(`✅ Label definido: ${addr} → "${name}"`);
        break;
      }

      case "notes": {
        if (args.length < 3) { console.error("Uso: notes <address> <text>"); break; }
        const [addrRaw, ...textParts] = args.slice(1);
        const addr = resolveShortAddress(addrRaw) ?? addrRaw;
        setNotes(addr, textParts.join(" "));
        console.log(`✅ Notas adicionadas: ${addr}`);
        break;
      }

      case "list": {
        let addresses;
        if (args[1] === "--type" && args[2]) {
          addresses = getAddressesByType(args[2]);
        } else {
          addresses = getAllAddresses();
        }
        if (addresses.length === 0) { console.log("Nenhum endereço. Rode 'npm run sync:cas:db' primeiro."); break; }

        const summary: SummaryItem[] = [
          { label: "Total de endereços", value: String(addresses.length) },
        ];

        const columns: TableColumn[] = [
          { header: "Endereço", key: "address", mono: true, link: (r) => `https://polygonscan.com/address/${r.address}` },
          { header: "Label", key: "label" },
          { header: "Tipo", key: "type", render: (r) => `<span class="badge badge-info">${r.type}</span>` },
          { header: "Recebido (CAS)", key: "received", mono: true },
          { header: "Txs", key: "txs", mono: true },
        ];

        const rows = addresses.map(a => ({
          address: a.address,
          label: a.label || "(sem nome)",
          type: a.type,
          received: fmt(a.total_received),
          txs: String(a.tx_count),
        }));

        const body = buildSummaryGrid(summary) +
          `<div class="card">${buildHtmlTable(columns, rows)}</div>`;
        const html = buildHtmlPage("Endereços CAS — Listagem", `${addresses.length} endereços cadastrados`, body);
        const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
        saveAndOpenReport(`cas_addresses_${ts}.html`, html);
        break;
      }

      case "search": {
        if (args.length < 2) { console.error("Uso: search <query>"); break; }
        const results = searchAddresses(args.slice(1).join(" "));
        if (results.length === 0) { console.log("Nenhum resultado."); break; }

        const columns: TableColumn[] = [
          { header: "Endereço", key: "address", mono: true, link: (r) => `https://polygonscan.com/address/${r.address}` },
          { header: "Label", key: "label" },
          { header: "Tipo", key: "type", render: (r) => `<span class="badge badge-info">${r.type}</span>` },
          { header: "Txs", key: "txs", mono: true },
        ];

        const rows = results.map(a => ({
          address: a.address,
          label: a.label || "(sem nome)",
          type: a.type,
          txs: String(a.tx_count),
        }));

        const body = `<div class="card"><h2>Resultados da busca: "${args.slice(1).join(" ")}"</h2>${buildHtmlTable(columns, rows)}</div>`;
        const html = buildHtmlPage("Busca CAS — Resultados", `${results.length} resultados encontrados`, body);
        const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
        saveAndOpenReport(`cas_search_${ts}.html`, html);
        break;
      }

      case "txs": {
        if (args.length < 2) { console.error("Uso: txs <address> [limit]"); break; }
        const addr = resolveShortAddress(args[1]) ?? args[1];
        const limit = args[2] ? parseInt(args[2], 10) : 20;
        const txs = getTransactionsByAddress(addr, limit);
        if (txs.length === 0) { console.log("Nenhuma transação."); break; }

        const columns: TableColumn[] = [
          { header: "Data", key: "date", mono: true },
          { header: "Direção", key: "dir", render: (r) => r.dir === "OUT" ? '<span class="badge badge-warn">OUT</span>' : '<span class="badge badge-ok">IN</span>' },
          { header: "Valor (CAS)", key: "val", mono: true },
          { header: "Contraparte", key: "other", mono: true, link: (r) => `https://polygonscan.com/address/${r.other}` },
          { header: "TX Hash", key: "hash", mono: true, link: (r) => `https://polygonscan.com/tx/${r.fullHash}` },
          { header: "Tipo", key: "mint", render: (r) => r.mint === "true" ? '<span class="badge badge-info">MINT</span>' : "" },
        ];

        const rows = txs.map(t => {
          const date = new Date(t.timestamp * 1000).toISOString().replace("T", " ").slice(0, 19);
          const isOut = t.from_address === addr.toLowerCase();
          return {
            date,
            dir: isOut ? "OUT" : "IN",
            val: fmt(t.value),
            other: isOut ? t.to_address : t.from_address,
            hash: t.tx_hash.slice(0, 16) + "...",
            fullHash: t.tx_hash,
            mint: t.is_mint ? "true" : "false",
          };
        });

        const body = `<div class="card"><h2>Transações de <code>${addr}</code></h2>${buildHtmlTable(columns, rows)}</div>`;
        const html = buildHtmlPage("Transações CAS", `${txs.length} transações para ${addr}`, body);
        const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
        saveAndOpenReport(`cas_txs_${ts}.html`, html);
        break;
      }

      case "show": {
        if (args.length < 2) { console.error("Uso: show <address>"); break; }
        const resolved = resolveShortAddress(args[1]);
        const a = resolved ? getAddress(resolved) : getAddress(args[1]);
        if (!a) { console.log("Endereço não encontrado."); break; }
        console.log(`\n  Endereço: ${a.address}`);
        console.log(`  Label:    ${a.label || "(sem nome)"}`);
        console.log(`  Tipo:     ${a.type}`);
        console.log(`  Contrato: ${a.is_contract ? "Sim" : "Não"}`);
        console.log(`  Recebido: ${fmt(a.total_received)} CAS`);
        console.log(`  Enviado:  ${fmt(a.total_sent)} CAS`);
        console.log(`  Txs:      ${a.tx_count}`);
        console.log(`  Primeira: ${a.first_seen ?? "-"}`);
        console.log(`  Última:   ${a.last_seen ?? "-"}`);
        console.log(`  Notas:    ${a.notes || "-"}`);
        console.log(`  Criado:   ${a.created_at}`);
        console.log(`  Atualizado: ${a.updated_at}`);
        break;
      }

      case "stats": {
        const db = getDB();
        const addrCount = (db.prepare("SELECT COUNT(*) as c FROM addresses").get() as { c: number }).c;
        const labeledCount = (db.prepare("SELECT COUNT(*) as c FROM addresses WHERE label != ''").get() as { c: number }).c;
        const txCount = getTransactionCount();
        const contractCount = (db.prepare("SELECT COUNT(*) as c FROM addresses WHERE is_contract = 1").get() as { c: number }).c;
        const totalReceivedRows = db.prepare("SELECT total_received FROM addresses").all() as { total_received: string }[];
        let totalReceived = 0n;
        for (const r of totalReceivedRows) totalReceived += BigInt(r.total_received || "0");

        console.log(`\n  Estatísticas do Banco CAS:\n`);
        console.log(`  Endereços cadastrados:  ${addrCount}`);
        console.log(`  Endereços nomeados:     ${labeledCount}`);
        console.log(`  Contratos:              ${contractCount}`);
        console.log(`  Transações:             ${txCount}`);
        console.log(`  Total recebido (sum):   ${fmt(String(totalReceived))} CAS`);
        break;
      }

      case "labels": {
        const map = getLabelMap();
        if (map.size === 0) { console.log("Nenhum label definido."); break; }

        const columns: TableColumn[] = [
          { header: "Endereço", key: "address", mono: true, link: (r) => `https://polygonscan.com/address/${r.address}` },
          { header: "Label", key: "label" },
        ];

        const rows: Record<string, string>[] = [];
        for (const [addr, label] of map) {
          rows.push({ address: addr, label });
        }

        const body = `<div class="card"><h2>Labels cadastrados</h2>${buildHtmlTable(columns, rows)}</div>`;
        const html = buildHtmlPage("Labels CAS", `${map.size} labels definidos`, body);
        const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
        saveAndOpenReport(`cas_labels_${ts}.html`, html);
        break;
      }

      default:
        printHelp();
    }
  } finally {
    closeDB();
  }
}

function printHelp(): void {
  console.log(`
  CAS DB CLI — Gerenciar banco de endereços e transações CAS

  Comandos:
    label <address> <name>     Nomear endereço (até 100 chars, permite espaços)
    notes <address> <text>     Adicionar notas
    list [--type <type>]       Listar endereços
    search <query>             Buscar por endereço/nome/nota
    show <address>             Detalhes de um endereço
    txs <address> [limit]      Transações de um endereço (default: 20)
    stats                      Estatísticas gerais
    labels                     Listar todos os labels

  Exemplos:
    npm run cas:db:label -- 0x1234... "Alice Silva"
    npm run cas:db:list
    npm run cas:db:txs -- 0x1234... 50
    npm run cas:db:stats
  `);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("❌ Erro:", (err as Error).message);
  closeDB();
  process.exit(1);
});

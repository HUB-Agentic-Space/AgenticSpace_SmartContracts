/**
 * Import CSV — todos os arquivos CSV de smartcontracts/data → cas_tracker.db
 *
 * Importação semântica: detecta automaticamente as colunas de nome,
 * endereço, observação/descrição, tipo e moeda de cada CSV, independente
 * de header ou ordem.
 *
 * Uso:
 *   npx tsx scripts/casswap/12_import_contas_csv.ts
 *   npm run import:contas:csv
 */

import * as path from "path";
import dotenv from "dotenv";
import { closeDB } from "../utils/cas_database";
import { importAllCsvs } from "../utils/cas_csv_import";

const SC_ROOT = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(SC_ROOT, ".env") });

function main(): void {
  const dataDir = path.join(SC_ROOT, "data");
  const results = importAllCsvs(dataDir);
  closeDB();

  const totalImported = results.reduce((s, r) => s + r.imported, 0);
  if (totalImported === 0) {
    process.exit(1);
  }
}

main();

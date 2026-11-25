import { JsonRpcProvider } from "ethers";
import { inventory } from "./pools";

// Ponto de entrada de npm run cas:v4:inspect. Este script só precisa de acesso de leitura
// a um nó da Polygon PoS. Você pode executá-lo sem conectar uma carteira.
async function main() {
  // O endereço do nó pode vir do ambiente. O provider detecta a rede e inventory confere a
  // chain 137. O lote de até cinco chamadas reduz as idas ao nó durante as consultas paralelas.
  const provider = new JsonRpcProvider(process.env.POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com",
    undefined, { batchMaxCount: 5 });
  try {
    const snapshot = await inventory(provider);
    // A indentação permite comparar as chaves, os preços e a liquidez de cada pool no terminal.
    console.log(JSON.stringify(snapshot, null, 2));
  } finally {
    // Mesmo se alguma leitura falhar, liberamos os recursos do provider antes de encerrar.
    provider.destroy();
  }
}

// Um código de saída diferente de zero permite que outro script reconheça a falha na consulta.
main().catch(error => { console.error(error); process.exitCode = 1; });

/**
 * Social Sentinel CLI
 * -------------------
 * Testa o módulo SocialSentinel a partir da linha de comando.
 *
 * Uso:
 *   npx tsx scripts/utils/social_sentinel_cli.ts --keywords "CAS,CASToken" --platforms duckduckgo,reddit --minutes 1440
 *   npm run social:sentinel -- --keywords "CAS" --platforms reddit
 */

import * as dotenv from "dotenv";
import * as path from "path";
import { SocialSentinel } from "./social_sentinel";

const SC_ROOT = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(SC_ROOT, ".env") });

function parseArgs(): { keywords: string[]; platforms: string[]; minutes: number; output?: string } {
  const args = process.argv.slice(2);
  const keywordsArg = args.find((_, i) => args[i - 1] === "--keywords");
  const platformsArg = args.find((_, i) => args[i - 1] === "--platforms");
  const minutesArg = Number(args.find((_, i) => args[i - 1] === "--minutes")) || 24 * 60;
  const outputArg = args.find((_, i) => args[i - 1] === "--output");

  const keywords = keywordsArg
    ? keywordsArg.split(",").map((k) => k.trim()).filter(Boolean)
    : ["CAS", "CASToken"];
  const platforms = platformsArg
    ? platformsArg.split(",").map((p) => p.trim()).filter(Boolean)
    : ["duckduckgo", "reddit"];

  return { keywords, platforms, minutes: minutesArg, output: outputArg };
}

async function main(): Promise<void> {
  const { keywords, platforms, minutes, output } = parseArgs();
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}] [social_sentinel_cli:main] ℹ️ Iniciando scan`, { keywords, platforms, minutes });

  const sentinel = new SocialSentinel(keywords, platforms);
  const snapshot = await sentinel.scan(minutes);

  console.log(`[${ts}] [social_sentinel_cli:main] ✅ Scan concluído`);
  console.log(JSON.stringify({
    scannedAt: snapshot.scannedAt,
    keywords: snapshot.keywords,
    platforms: snapshot.platforms,
    negativeScore: snapshot.negativeScore,
    riskKeywordCounts: snapshot.riskKeywordCounts,
    spikeWindows: snapshot.spikeWindows,
    topSources: snapshot.topSources,
    posts: snapshot.posts.map((p) => ({
      platform: p.platform,
      url: p.url,
      author: p.author,
      textHash: p.textHash,
      timestamp: p.timestamp,
      engagement: p.engagement,
      riskKeywords: p.riskKeywords,
    })),
  }, null, 2));

  if (output) {
    const fs = await import("fs");
    fs.writeFileSync(output, JSON.stringify(snapshot, null, 2), "utf-8");
    console.log(`[${ts}] [social_sentinel_cli:main] ✅ Salvo em ${output}`);
  }
}

main().catch((err) => {
  console.error(`[${new Date().toISOString().replace("T", " ").slice(0, 19)}] [social_sentinel_cli:main] ❌ Erro`, err);
  process.exit(1);
});

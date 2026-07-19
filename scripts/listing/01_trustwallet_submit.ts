/**
 * Trust Wallet Assets — PR Submission via gh CLI
 * ------------------------------------------------
 * Prepara arquivos info.json + logo.png no formato Trust Wallet e abre
 * um Pull Request no repo trustwallet/assets usando o GitHub CLI (gh).
 *
 * Vantagens do gh CLI:
 * - Não requer GITHUB_TOKEN no .env
 * - Aproveita autenticação já configurada no `gh auth login`
 * - Mais seguro — nenhum token exposto em arquivo de configuração
 * - Usa git nativo para operações de arquivo
 *
 * Pré-requisitos:
 *   - GitHub CLI instalado: https://cli.github.com/
 *   - Autenticado: `gh auth login`
 *   - Git configurado com user.name e user.email
 *
 * Uso:
 *   npm run listing:trustwallet
 *   (ou) npx hardhat run scripts/listing/01_trustwallet_submit.ts
 *
 * Requisitos de ambiente:
 *   smartcontracts/.env : CAS_TOKEN_ADDRESS
 */

import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as util from "util";
import dotenv from "dotenv";

const execFileAsync = util.promisify(execFile);

const SC_ROOT = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(SC_ROOT, ".env") });

type LogLevel = "INFO" | "WARN" | "ERROR" | "OK" | "DEBUG";

function log(level: LogLevel, fn: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const emoji = { INFO: "ℹ️", WARN: "⚠️", ERROR: "❌", OK: "✅", DEBUG: "🔍" }[level];
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [trustwallet_submit:${fn}] ${emoji} ${message}${extra}`);
}

const CAS_TOKEN_ADDRESS = process.env.CAS_TOKEN_ADDRESS ?? "";
const UPSTREAM_REPO = "trustwallet/assets";
const ASSETS_PATH = `blockchains/polygon/assets/${CAS_TOKEN_ADDRESS}`;

const METADATA = JSON.parse(
  fs.readFileSync(path.join(SC_ROOT, "docs", "coingecko-listing-metadata.json"), "utf-8"),
);

// ── gh CLI helpers ────────────────────────────────────────────────────

async function ghExec(args: string[], options?: { cwd?: string }): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("gh", args, {
    cwd: options?.cwd ?? SC_ROOT,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function ghAuthStatus(): Promise<{ authenticated: boolean; user?: string }> {
  log("INFO", "ghAuthStatus", "Verificando autenticação do gh CLI");
  try {
    const { stdout } = await ghExec(["auth", "status", "--show-token=false"]);
    const userMatch = stdout.match(/account\s+(\S+)\s/is);
    const user = userMatch?.[1]?.replace(/\(|\)/g, "");
    log("OK", "ghAuthStatus", "gh CLI autenticado", { user });
    return { authenticated: true, user };
  } catch {
    log("ERROR", "ghAuthStatus", "gh CLI não autenticado — execute `gh auth login` primeiro");
    return { authenticated: false };
  }
}

async function ghGetCurrentUser(): Promise<string> {
  const { stdout } = await ghExec(["api", "user", "--jq", ".login"]);
  return stdout;
}

async function ghRepoFork(owner: string, repo: string): Promise<{ forked: boolean; cloneUrl: string }> {
  log("INFO", "ghRepoFork", "Verificando/criando fork", { repo: `${owner}/${repo}` });
  const currentUser = await ghGetCurrentUser();

  // GitHub may name the fork as `user/repo` or `user/owner_repo` (replacing / with _)
  const possibleForkNames = [
    `${currentUser}/${repo}`,
    `${currentUser}/${owner}_${repo}`,
    `${currentUser}/${owner}-${repo}`,
  ];

  // Check if fork already exists under any naming variant
  for (const forkFullName of possibleForkNames) {
    try {
      const { stdout } = await ghExec(["api", `repos/${forkFullName}`, "--jq", ".clone_url"]);
      log("OK", "ghRepoFork", "Fork já existe", { fork: forkFullName });
      return { forked: false, cloneUrl: stdout };
    } catch {
      // Try next variant
    }
  }

  // Fork doesn't exist — create it
  log("INFO", "ghRepoFork", "Criando fork", { repo: `${owner}/${repo}` });
  await ghExec(["repo", "fork", `${owner}/${repo}`, "--clone=false"]);

  // Retry loop — GitHub may take several seconds to provision the fork
  // Try all naming variants on each attempt
  let cloneUrl = "";
  let foundForkName = "";
  for (let attempt = 1; attempt <= 5; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
    for (const forkFullName of possibleForkNames) {
      try {
        const result = await ghExec(["api", `repos/${forkFullName}`, "--jq", ".clone_url"]);
        cloneUrl = result.stdout;
        foundForkName = forkFullName;
        break;
      } catch {
        // Try next variant
      }
    }
    if (cloneUrl) break;
    log("DEBUG", "ghRepoFork", `Tentativa ${attempt}/5 — fork ainda não disponível`);
  }
  if (!cloneUrl) throw new Error(`Fork não ficou disponível após 5 tentativas (tentativas: ${possibleForkNames.join(", ")})`);
  log("OK", "ghRepoFork", "Fork criado", { fork: foundForkName });
  return { forked: true, cloneUrl };
}

async function ghPrCreate(
  repo: string,
  title: string,
  body: string,
  headBranch: string,
  baseBranch: string,
): Promise<string> {
  log("INFO", "ghPrCreate", "Criando Pull Request", { title, repo });
  const { stdout } = await ghExec([
    "pr", "create",
    "--repo", repo,
    "--title", title,
    "--body", body,
    "--head", headBranch,
    "--base", baseBranch,
  ]);
  log("OK", "ghPrCreate", "PR criado", { url: stdout });
  return stdout;
}

// ── Git helpers ───────────────────────────────────────────────────────

async function gitClone(cloneUrl: string, targetDir: string): Promise<void> {
  log("INFO", "gitClone", "Clonando fork", { dir: targetDir });
  const repoSlug = cloneUrl.replace("https://github.com/", "").replace(/\.git$/, "");
  await execFileAsync("gh", ["repo", "clone", repoSlug, targetDir, "--", "--depth=1"], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
  });
  log("OK", "gitClone", "Clone concluído", { dir: targetDir });
}

async function gitExec(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60_000,
  });
  return stdout.trim();
}

// ── File preparation ──────────────────────────────────────────────────

async function checkLogoRequirements(): Promise<{ ok: boolean; size: number; reason?: string }> {
  const logoPath = path.join(SC_ROOT, "..", "images", "mainnet", CAS_TOKEN_ADDRESS, "logo-256.png");
  if (!fs.existsSync(logoPath)) {
    return { ok: false, size: 0, reason: `Logo não encontrado em ${logoPath}` };
  }
  const stats = fs.statSync(logoPath);
  const maxBytes = 100 * 1024;
  if (stats.size > maxBytes) {
    return { ok: false, size: stats.size, reason: `Logo excede 100KB (${stats.size} bytes)` };
  }
  return { ok: true, size: stats.size };
}

function buildTrustWalletInfoJson(): string {
  const socialLinks: Array<{ name: string; url: string }> = [
    { name: "github", url: METADATA.links.github },
    { name: "whitepaper", url: METADATA.links.whitepaper },
    { name: "tokenomics", url: METADATA.links.tokenomics },
  ];
  if (METADATA.social.discord) socialLinks.push({ name: "discord", url: METADATA.social.discord });
  if (METADATA.social.instagram) socialLinks.push({ name: "instagram", url: METADATA.social.instagram });
  if (METADATA.social.youtube) socialLinks.push({ name: "youtube", url: METADATA.social.youtube });

  return JSON.stringify({
    name: METADATA.token.name,
    symbol: METADATA.token.symbol,
    type: "ERC20",
    decimals: METADATA.token.decimals,
    description: METADATA.token.description_short,
    website: METADATA.links.website,
    explorer: METADATA.links.explorer,
    status: "active",
    id: CAS_TOKEN_ADDRESS,
    links: socialLinks,
  }, null, 2);
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("INFO", "main", "🚀 Iniciando submissão para Trust Wallet Assets via gh CLI", { token: CAS_TOKEN_ADDRESS });

  if (!CAS_TOKEN_ADDRESS) {
    log("ERROR", "main", "CAS_TOKEN_ADDRESS não configurado no .env");
    process.exitCode = 1;
    return;
  }

  // 1. Check gh CLI auth
  const auth = await ghAuthStatus();
  if (!auth.authenticated) {
    log("ERROR", "main", "gh CLI não autenticado — execute `gh auth login` e tente novamente");
    process.exitCode = 1;
    return;
  }

  // 2. Validate logo
  const logoCheck = await checkLogoRequirements();
  if (!logoCheck.ok) {
    log("ERROR", "main", "Logo não atende aos requisitos", { reason: logoCheck.reason });
    process.exitCode = 1;
    return;
  }
  log("OK", "main", "Logo validado", { size: logoCheck.size });

  // 3. Fork trustwallet/assets (if not already forked)
  const [upstreamOwner, upstreamRepo] = UPSTREAM_REPO.split("/");
  const forkResult = await ghRepoFork(upstreamOwner, upstreamRepo);

  // 4. Clone fork to temp dir
  const tempDir = path.join(os.tmpdir(), `tw-assets-${Date.now()}`);
  await gitClone(forkResult.cloneUrl, tempDir);

  // 5. Sync with upstream master
  log("INFO", "main", "Sincronizando fork com upstream master");
  try {
    await gitExec(["remote", "add", "upstream", `https://github.com/${UPSTREAM_REPO}.git`], tempDir);
  } catch {
    log("DEBUG", "main", "Remote upstream já existe — usando existente");
  }
  await gitExec(["fetch", "upstream", "master"], tempDir);
  await gitExec(["checkout", "master"], tempDir);
  await gitExec(["merge", "upstream/master", "--no-edit"], tempDir);

  // 6. Create branch
  const branchName = `add-cas-token-${Date.now()}`;
  log("INFO", "main", "Criando branch", { branch: branchName });
  await gitExec(["checkout", "-b", branchName], tempDir);

  // 7. Create asset files
  const assetsDir = path.join(tempDir, ASSETS_PATH);
  if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

  const infoJsonContent = buildTrustWalletInfoJson();
  const infoJsonPath = path.join(assetsDir, "info.json");
  fs.writeFileSync(infoJsonPath, infoJsonContent);
  log("OK", "main", "info.json criado", { path: `${ASSETS_PATH}/info.json` });

  const logoSrcPath = path.join(SC_ROOT, "..", "images", "mainnet", CAS_TOKEN_ADDRESS, "logo-256.png");
  const logoDestPath = path.join(assetsDir, "logo.png");
  fs.copyFileSync(logoSrcPath, logoDestPath);
  log("OK", "main", "logo.png copiado", { path: `${ASSETS_PATH}/logo.png` });

  // 8. Commit and push
  await gitExec(["add", ASSETS_PATH], tempDir);
  await gitExec(["commit", "-m", `Add CAS (Agentic Space) token — Polygon

- Token: Cryptocoin Agentic Space
- Symbol: CAS
- Chain: Polygon PoS (137)
- Contract: ${CAS_TOKEN_ADDRESS}
- Website: ${METADATA.links.website}`], tempDir);
  log("OK", "main", "Commit criado");

  log("INFO", "main", "Enviando push para fork");
  await gitExec(["push", "-u", "origin", branchName], tempDir);
  log("OK", "main", "Push concluído");

  // 9. Create PR via gh CLI
  const prTitle = `Add CAS (Agentic Space) — Polygon`;
  const prBody = [
    "## Add CAS Token to Trust Wallet Assets",
    "",
    "**Token**: Cryptocoin Agentic Space",
    "**Symbol**: CAS",
    "**Chain**: Polygon PoS (137)",
    `**Contract**: ${CAS_TOKEN_ADDRESS}`,
    "",
    "### Links",
    `- Website: ${METADATA.links.website}`,
    `- Explorer: ${METADATA.links.explorer}`,
    `- GitHub: ${METADATA.links.github}`,
    `- Whitepaper: ${METADATA.links.whitepaper}`,
    ...(METADATA.social.discord ? [`- Discord: ${METADATA.social.discord}`] : []),
    "",
    "### Description",
    METADATA.token.description_short,
    "",
    "---",
    "Automated submission via Agentic Space listing scripts (gh CLI).",
  ].join("\n");

  const currentUser = await ghGetCurrentUser();
  const headBranch = `${currentUser}:${branchName}`;
  const prUrl = await ghPrCreate(UPSTREAM_REPO, prTitle, prBody, headBranch, "master");
  log("OK", "main", "🏁 Submissão concluída", { prUrl });

  // 10. Cleanup temp dir
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
    log("DEBUG", "main", "Diretório temporário removido", { dir: tempDir });
  } catch {
    log("WARN", "main", "Não foi possível remover diretório temporário", { dir: tempDir });
  }

  // 11. Save result
  const reportsDir = path.join(SC_ROOT, "reports");
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const resultPath = path.join(reportsDir, `trustwallet-submit-${Date.now()}.json`);
  fs.writeFileSync(resultPath, JSON.stringify({
    platform: "trustwallet",
    status: "submitted",
    prUrl,
    branch: branchName,
    fork: `${currentUser}/${upstreamRepo}`,
    timestamp: new Date().toISOString(),
  }, null, 2));
  log("OK", "main", "Relatório salvo", { path: resultPath });
}

main().catch((error) => {
  log("ERROR", "main", "Erro fatal", { error: (error as Error).message });
  process.exitCode = 1;
});

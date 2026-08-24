/**
 * html_report.ts
 * --------------
 * Utility reutilizável para geração de relatórios HTML com a paleta de cores
 * da Rapport Tecnologia e abertura automática no navegador.
 *
 * Fornece:
 * - openBrowser: abre um arquivo HTML no navegador padrão do sistema
 * - buildHtmlTable: gera uma <table> HTML a partir de headers e rows
 * - buildHtmlPage: envolve conteúdo HTML em uma página completa com CSS da paleta
 * - saveAndOpenReport: salva HTML em reports/ e abre no navegador
 * - escapeHtml: escapa caracteres especiais para evitar XSS
 *
 * Padrões: Template Method (buildHtmlPage), Factory (saveAndOpenReport)
 */

import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";

// ── CSS da paleta Rapport ─────────────────────────────────────────────

const RAPPORT_CSS = `
:root {
  --color-primary: #F05F40;
  --color-primary-hover: #eb3812;
  --color-dark: #222222;
  --color-light: #ffffff;
  --color-accent-gold: #fcc650;
  --color-accent-bronze: #cc7501;
  --color-accent-wine: #712d23;
  --color-accent-coral: #ce6e6d;
  --color-accent-peach: #f7d4ca;
  --color-accent-deep-black: #070404;
  --color-bg-main: var(--color-dark);
  --color-bg-card: var(--color-accent-wine);
  --color-text-main: var(--color-light);
  --color-text-muted: var(--color-accent-peach);
  --color-border: rgba(255, 255, 255, 0.15);
  --color-link: var(--color-accent-gold);
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
  background-color: var(--color-bg-main);
  color: var(--color-text-main);
  padding: 24px;
  min-height: 100vh;
}

h1 {
  color: var(--color-primary);
  font-size: 1.6rem;
  margin-bottom: 8px;
}

h2 {
  color: var(--color-primary);
  font-size: 1.2rem;
  margin: 24px 0 12px 0;
}

h3 {
  color: var(--color-link);
  font-size: 1rem;
  margin: 16px 0 8px 0;
}

.subtitle {
  color: var(--color-text-muted);
  font-size: 0.9rem;
  margin-bottom: 24px;
}

.card {
  background-color: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 20px;
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}

th {
  background-color: var(--color-accent-deep-black);
  color: var(--color-accent-gold);
  padding: 10px 12px;
  text-align: left;
  border-bottom: 2px solid var(--color-primary);
  white-space: nowrap;
}

td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-border);
  white-space: nowrap;
}

tr:hover td {
  background-color: rgba(240, 95, 64, 0.08);
}

code, .mono {
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  font-size: 0.85rem;
}

a {
  color: var(--color-link);
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}

.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
}

.badge-ok { background-color: rgba(252, 198, 80, 0.2); color: var(--color-accent-gold); }
.badge-warn { background-color: rgba(235, 56, 18, 0.2); color: var(--color-primary-hover); }
.badge-info { background-color: rgba(247, 212, 202, 0.15); color: var(--color-text-muted); }

.summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
  margin-bottom: 20px;
}

.summary-item {
  background-color: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 12px 16px;
}

.summary-label {
  color: var(--color-text-muted);
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.summary-value {
  color: var(--color-text-main);
  font-size: 1.1rem;
  font-weight: 600;
  margin-top: 4px;
}

.footer {
  color: var(--color-text-muted);
  font-size: 0.75rem;
  margin-top: 32px;
  border-top: 1px solid var(--color-border);
  padding-top: 12px;
}

.text-primary { color: var(--color-primary); }
.text-gold { color: var(--color-accent-gold); }
.text-muted { color: var(--color-text-muted); }
.text-coral { color: var(--color-accent-coral); }
`;

// ── HTML helpers ──────────────────────────────────────────────────────

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export interface TableColumn {
  header: string;
  key: string;
  mono?: boolean;
  link?: (row: Record<string, string>) => string | null;
  render?: (row: Record<string, string>) => string;
}

export function buildHtmlTable(columns: TableColumn[], rows: Record<string, string>[]): string {
  if (rows.length === 0) {
    return '<p class="text-muted">Nenhum resultado.</p>';
  }

  const thead = columns
    .map(c => `<th>${escapeHtml(c.header)}</th>`)
    .join("");

  const tbody = rows
    .map(row => {
      const tds = columns
        .map(c => {
          const raw = row[c.key] ?? "";
          if (c.render) {
            return `<td>${c.render(row)}</td>`;
          }
          if (c.link) {
            const href = c.link(row);
            if (href) {
              return `<td><a href="${escapeHtml(href)}" target="_blank">${c.mono ? `<code>${escapeHtml(raw)}</code>` : escapeHtml(raw)}</a></td>`;
            }
          }
          return `<td>${c.mono ? `<code>${escapeHtml(raw)}</code>` : escapeHtml(raw)}</td>`;
        })
        .join("");
      return `<tr>${tds}</tr>`;
    })
    .join("");

  return `<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`;
}

export interface SummaryItem {
  label: string;
  value: string;
}

export function buildSummaryGrid(items: SummaryItem[]): string {
  const cards = items
    .map(
      i => `<div class="summary-item"><div class="summary-label">${escapeHtml(i.label)}</div><div class="summary-value">${escapeHtml(i.value)}</div></div>`,
    )
    .join("");
  return `<div class="summary-grid">${cards}</div>`;
}

export function buildHtmlPage(
  title: string,
  subtitle: string,
  bodyContent: string,
  extraCss?: string,
): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
${RAPPORT_CSS}
${extraCss ?? ""}
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="subtitle">${escapeHtml(subtitle)}</p>
${bodyContent}
<p class="footer">Gerado em ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC — Rapport Tecnologia</p>
</body>
</html>`;
}

// ── File I/O + browser ────────────────────────────────────────────────

export function openBrowser(filePath: string): void {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  execFile(opener, [filePath], (err) => {
    if (err) {
      console.log(`  [WARN] Não foi possível abrir o navegador: ${err.message}`);
      console.log(`  Arquivo salvo em: ${filePath}`);
    }
  });
}

export function saveAndOpenReport(
  filename: string,
  html: string,
  reportsDir?: string,
): string {
  const dir = reportsDir ?? path.resolve(__dirname, "..", "..", "reports");
  fs.mkdirSync(dir, { recursive: true });
  const fullPath = path.join(dir, filename);
  fs.writeFileSync(fullPath, html, "utf-8");
  console.log(`  [OK] Relatório salvo: ${fullPath}`);
  openBrowser(fullPath);
  return fullPath;
}

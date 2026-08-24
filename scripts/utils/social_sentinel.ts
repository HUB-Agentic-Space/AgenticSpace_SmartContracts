/**
 * Social Sentinel — Módulo reutilizável de monitoramento social/sentimento.
 *
 * Arquitetura Strategy: BaseScraper + implementações para DuckDuckGo, Reddit,
 * Farcaster e Chrome headless (X, Instagram, Facebook, LinkedIn).
 *
 * Uso:
 *   const sentinel = new SocialSentinel(['CAS', 'CASToken', tokenAddress]);
 *   const snapshot = await sentinel.scan();
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

declare const document: any;

type LogLevel = "INFO" | "WARN" | "ERROR" | "OK" | "DEBUG";

function log(level: LogLevel, fn: string, msg: string, p?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const emoji = { INFO: "ℹ️", WARN: "⚠️", ERROR: "❌", OK: "✅", DEBUG: "🔍" }[level];
  const extra = p ? ` - ${JSON.stringify(p)}` : "";
  console.log(`[${ts}] [social_sentinel:${fn}] ${emoji} ${msg}${extra}`);
}

// ── Types ─────────────────────────────────────────────────────────────

export interface SocialPost {
  platform: string;
  url: string;
  author: string;
  textHash: string; // hash do texto, nunca o texto cru
  timestamp: number;
  engagement: number;
  riskKeywords: string[];
}

export interface SentimentSnapshot {
  scannedAt: number;
  keywords: string[];
  platforms: string[];
  negativeScore: number; // 0–1
  riskKeywordCounts: Record<string, number>;
  spikeWindows: { start: number; end: number; postCount: number }[];
  topSources: { platform: string; url: string }[];
  posts: SocialPost[];
}

export interface ScraperOptions {
  keywords: string[];
  minutesBack: number;
}

export interface ScraperConfig {
  name: string;
  enabled: boolean;
  platform: string;
  extra?: Record<string, unknown>;
}

export abstract class BaseScraper {
  constructor(public config: ScraperConfig) {}
  abstract search(opts: ScraperOptions): Promise<SocialPost[]>;

  protected containsRiskKeywords(text: string): string[] {
    const lower = text.toLowerCase();
    const keywords = ["scam", "rugpull", "rug", "dump", "pump", "fud", "fake", "alerta", "fraude", "honeypot"];
    return keywords.filter((k) => lower.includes(k));
  }

  protected textHash(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
  }
}

// ── DuckDuckGo HTML Scraper (web aberta) ───────────────────────────────

export class DuckDuckGoScraper extends BaseScraper {
  async search(opts: ScraperOptions): Promise<SocialPost[]> {
    const posts: SocialPost[] = [];
    const query = opts.keywords.map((k) => encodeURIComponent(k)).join("+");
    const url = `https://html.duckduckgo.com/html/?q=${query}`;
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; SocialSentinel/1.0; research bot)",
          Accept: "text/html",
        },
      });
      if (!res.ok) {
        log("WARN", "DuckDuckGoScraper", "Resposta não-OK", { status: res.status });
        return posts;
      }
      const html = await res.text();
      const resultBlocks = html.match(/<a[^>]+class="result__a"[^>]*>.*?<\/a>/gs) || [];
      for (const block of resultBlocks.slice(0, 15)) {
        const titleMatch = block.match(/<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/s);
        if (!titleMatch) continue;
        const [, rawUrl, title] = titleMatch;
        const snippetMatch = html.split(block)[1]?.match(/class="result__snippet"[^>]*>(.*?)<\/a>/s);
        const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").trim() : "";
        const text = `${title.replace(/<[^>]+>/g, "").trim()}. ${snippet}`;
        const risk = this.containsRiskKeywords(text);
        posts.push({
          platform: "duckduckgo",
          url: rawUrl.startsWith("http") ? rawUrl : `https://duckduckgo.com${rawUrl}`,
          author: "",
          textHash: this.textHash(text),
          timestamp: Math.floor(Date.now() / 1000),
          engagement: 0,
          riskKeywords: risk,
        });
      }
      log("OK", "DuckDuckGoScraper", "Coletado", { count: posts.length });
    } catch (err) {
      log("WARN", "DuckDuckGoScraper", "Falha", { error: (err as Error).message });
    }
    return posts;
  }
}

// ── Reddit JSON Scraper (subreddits de cripto) ─────────────────────────

export class RedditScraper extends BaseScraper {
  async search(opts: ScraperOptions): Promise<SocialPost[]> {
    const posts: SocialPost[] = [];
    const q = opts.keywords.map((k) => encodeURIComponent(k)).join("+");
    const subreddits = ["cryptocurrency", "CryptoMarkets", "SatoshiStreetBets", "altcoin"];
    for (const sub of subreddits) {
      try {
        const url = `https://www.reddit.com/r/${sub}/search.json?q=${q}&restrict_sr=1&sort=new&limit=25`;
        const res = await fetch(url, {
          headers: {
            "User-Agent": "SocialSentinel/1.0 (research; no-auth)",
            Accept: "application/json",
          },
        });
        if (!res.ok) continue;
        const json = (await res.json()) as { data?: { children?: { data: { title: string; selftext?: string; url: string; author: string; created_utc: number; score: number; num_comments: number } }[] } };
        const children = json.data?.children || [];
        for (const c of children) {
          const d = c.data;
          const text = `${d.title} ${d.selftext ?? ""}`;
          const ts = Math.floor(d.created_utc);
          if (Math.floor(Date.now() / 1000) - ts > opts.minutesBack * 60) continue;
          const risk = this.containsRiskKeywords(text);
          posts.push({
            platform: `reddit/${sub}`,
            url: d.url.startsWith("http") ? d.url : `https://www.reddit.com${d.url}`,
            author: d.author,
            textHash: this.textHash(text),
            timestamp: ts,
            engagement: (d.score ?? 0) + (d.num_comments ?? 0),
            riskKeywords: risk,
          });
        }
      } catch (err) {
        log("WARN", "RedditScraper", "Falha no subreddit", { sub, error: (err as Error).message });
      }
    }
    log("OK", "RedditScraper", "Coletado", { count: posts.length });
    return posts;
  }
}

// ── Farcaster Hub Scraper ──────────────────────────────────────────────

export class FarcasterScraper extends BaseScraper {
  async search(opts: ScraperOptions): Promise<SocialPost[]> {
    const posts: SocialPost[] = [];
    const hubUrl = process.env.SOCIAL_SENTINEL_FARCASTER_HUB || "";
    if (!hubUrl) {
      log("INFO", "FarcasterScraper", "Hub não configurado (SOCIAL_SENTINEL_FARCASTER_HUB); pulando");
      return posts;
    }
    const q = opts.keywords.map((k) => encodeURIComponent(k)).join("+");
    try {
      const url = `${hubUrl}/v1/castsByKeyword?keyword=${q}&limit=25`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) {
        log("WARN", "FarcasterScraper", "Resposta não-OK", { status: res.status });
        return posts;
      }
      const json = (await res.json()) as { casts?: { text: string; timestamp: number; author: string; url: string; likes?: number; recasts?: number }[] };
      for (const c of json.casts || []) {
        const risk = this.containsRiskKeywords(c.text);
        posts.push({
          platform: "farcaster",
          url: c.url,
          author: c.author,
          textHash: this.textHash(c.text),
          timestamp: c.timestamp,
          engagement: (c.likes ?? 0) + (c.recasts ?? 0),
          riskKeywords: risk,
        });
      }
      log("OK", "FarcasterScraper", "Coletado", { count: posts.length });
    } catch (err) {
      log("WARN", "FarcasterScraper", "Falha", { error: (err as Error).message });
    }
    return posts;
  }
}

// ── Chrome Headless Scraper (X, Instagram, Facebook, LinkedIn) ─────────

interface HeadlessPlatformConfig {
  name: string;
  searchUrl: (kw: string) => string;
  postSelector?: string;
  linkSelector?: string;
  textSelector?: string;
  needsAuth: boolean;
}

const HEADLESS_PLATFORMS: HeadlessPlatformConfig[] = [
  {
    name: "x",
    searchUrl: (kw) => `https://x.com/search?q=${encodeURIComponent(kw)}&f=live`,
    needsAuth: true,
    linkSelector: "a[href*='/status/']",
    textSelector: "[data-testid='tweetText']",
  },
  {
    name: "instagram",
    searchUrl: (kw) => `https://www.instagram.com/explore/tags/${encodeURIComponent(kw.replace(/#/g, ""))}/`,
    needsAuth: true,
  },
  {
    name: "facebook",
    searchUrl: (kw) => `https://www.facebook.com/search/posts?q=${encodeURIComponent(kw)}`,
    needsAuth: true,
  },
  {
    name: "linkedin",
    searchUrl: (kw) => `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(kw)}`,
    needsAuth: true,
  },
];

export class HeadlessScraper extends BaseScraper {
  private puppeteer: unknown | null = null;

  async search(opts: ScraperOptions): Promise<SocialPost[]> {
    const posts: SocialPost[] = [];
    const enabled = process.env.SOCIAL_SENTINEL_ENABLED?.toLowerCase() === "true";
    const consent = process.env.SOCIAL_SENTINEL_CONSENT?.toLowerCase() === "true";
    if (!enabled || !consent) {
      log("INFO", "HeadlessScraper", "Scraping social desabilitado (SOCIAL_SENTINEL_ENABLED/CONSENT)");
      return posts;
    }
    if (!this.puppeteer) {
      try {
        // @ts-ignore — puppeteer-core é dependência opcional de runtime
        const mod = await import("puppeteer-core");
        this.puppeteer = (mod as { default?: unknown }).default ?? mod;
      } catch (err) {
        log("ERROR", "HeadlessScraper", "puppeteer-core não instalado", { error: (err as Error).message });
        return posts;
      }
    }
    if (!this.puppeteer) return posts;

    const chromePath = process.env.SOCIAL_SENTINEL_CHROME_PATH || "/usr/bin/google-chrome";
    if (!fs.existsSync(chromePath)) {
      log("WARN", "HeadlessScraper", "Chrome não encontrado", { chromePath });
      return posts;
    }

    const platformName = this.config.platform.toLowerCase();
    const platform = HEADLESS_PLATFORMS.find((p) => p.name === platformName);
    if (!platform) {
      log("WARN", "HeadlessScraper", "Plataforma headless não suportada", { platform: platformName });
      return posts;
    }

    const q = opts.keywords.map((k) => encodeURIComponent(k)).join("+");
    let browser: unknown | null = null;
    try {
      const launch = (this.puppeteer as { launch: (opts: Record<string, unknown>) => Promise<unknown> }).launch;
      browser = await launch({
        executablePath: chromePath,
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      } as Record<string, unknown>);
      const page = await (browser as { newPage: () => Promise<unknown> }).newPage();
      await (page as { setViewport: (opts: { width: number; height: number }) => Promise<void> }).setViewport({ width: 1280, height: 800 });
      await (page as { goto: (url: string, opts: { waitUntil: string }) => Promise<unknown> }).goto(platform.searchUrl(q), { waitUntil: "networkidle2" });
      await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000));

      // Se a plataforma exigir autenticação, não prosseguir sem cookies
      if (platform.needsAuth) {
        const cookiePath = process.env[`SOCIAL_SENTINEL_COOKIES_${platform.name.toUpperCase()}`];
        if (cookiePath && fs.existsSync(cookiePath)) {
          const cookies = JSON.parse(fs.readFileSync(cookiePath, "utf-8")) as unknown[];
          await (page as { setCookie: (...c: unknown[]) => Promise<void> }).setCookie(...cookies);
          await (page as { reload: (opts: { waitUntil: string }) => Promise<unknown> }).reload({ waitUntil: "networkidle2" });
        } else {
          log("WARN", "HeadlessScraper", "Plataforma requer autenticação; cookies ausentes", { platform: platform.name });
          return posts;
        }
      }

      const extracted = await (page as any).evaluate(
        (sel: string) => {
          const els = Array.from((document as any).querySelectorAll(sel));
          return els.slice(0, 15).map((el: any) => ({
            text: (el.textContent || "").toString().trim().slice(0, 500),
            href: el.getAttribute ? (el.getAttribute("href") || "") : "",
          }));
        },
        platform.linkSelector || "a",
      ) as { text: string; href: string }[];

      for (const ex of extracted) {
        if (!ex.text) continue;
        const risk = this.containsRiskKeywords(ex.text);
        posts.push({
          platform: platform.name,
          url: ex.href.startsWith("http") ? ex.href : `https://${platform.name === "x" ? "x.com" : platform.name + ".com"}${ex.href}`,
          author: "",
          textHash: this.textHash(ex.text),
          timestamp: Math.floor(Date.now() / 1000),
          engagement: 0,
          riskKeywords: risk,
        });
      }
      log("OK", "HeadlessScraper", "Coletado", { platform: platform.name, count: posts.length });
    } catch (err) {
      log("ERROR", "HeadlessScraper", "Falha na navegação", { platform: platform.name, error: (err as Error).message });
    } finally {
      try {
        if (browser) await (browser as { close: () => Promise<void> }).close();
      } catch { /* noop */ }
    }
    return posts;
  }
}

// ── Orchestrator ───────────────────────────────────────────────────────

export class SocialSentinel {
  private scrapers: BaseScraper[] = [];

  constructor(
    private keywords: string[],
    private platforms: string[] = [],
  ) {
    this.buildScrapers();
  }

  private buildScrapers(): void {
    const defaultPlatforms = ["duckduckgo", "reddit", "farcaster"];
    const list = this.platforms.length ? this.platforms : defaultPlatforms;
    for (const p of list) {
      const name = p.toLowerCase();
      if (["x", "twitter", "instagram", "facebook", "linkedin"].includes(name)) {
        this.scrapers.push(new HeadlessScraper({ name, enabled: true, platform: name === "twitter" ? "x" : name }));
      } else if (name === "duckduckgo") {
        this.scrapers.push(new DuckDuckGoScraper({ name, enabled: true, platform: name }));
      } else if (name === "reddit") {
        this.scrapers.push(new RedditScraper({ name, enabled: true, platform: name }));
      } else if (name === "farcaster") {
        this.scrapers.push(new FarcasterScraper({ name, enabled: true, platform: name }));
      } else {
        log("WARN", "SocialSentinel", "Plataforma desconhecida", { platform: name });
      }
    }
  }

  async scan(minutesBack = 24 * 60): Promise<SentimentSnapshot> {
    const scannedAt = Math.floor(Date.now() / 1000);
    const allPosts: SocialPost[] = [];

    for (const scraper of this.scrapers) {
      try {
        const posts = await scraper.search({ keywords: this.keywords, minutesBack });
        allPosts.push(...posts);
      } catch (err) {
        log("ERROR", "SocialSentinel", "Falha no scraper", { scraper: scraper.config.name, error: (err as Error).message });
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - 30 * 60; // janela de ráfaga de 30 min
    const recentPosts = allPosts.filter((p) => p.timestamp >= now - minutesBack * 60);
    const spike = recentPosts.filter((p) => p.timestamp >= windowStart).length;

    const riskKeywordCounts: Record<string, number> = {};
    for (const p of recentPosts) {
      for (const k of p.riskKeywords) {
        riskKeywordCounts[k] = (riskKeywordCounts[k] || 0) + 1;
      }
    }

    const negativeScore = Math.min(
      1,
      recentPosts.length === 0 ? 0 : Object.values(riskKeywordCounts).reduce((s, c) => s + c, 0) / recentPosts.length,
    );

    const topSources = recentPosts
      .sort((a, b) => b.engagement - a.engagement)
      .slice(0, 10)
      .map((p) => ({ platform: p.platform, url: p.url }));

    const snapshot: SentimentSnapshot = {
      scannedAt,
      keywords: this.keywords,
      platforms: this.scrapers.map((s) => s.config.platform),
      negativeScore,
      riskKeywordCounts,
      spikeWindows: spike > 0 ? [{ start: windowStart, end: now, postCount: spike }] : [],
      topSources,
      posts: recentPosts,
    };

    log("OK", "SocialSentinel", "Snapshot completo", { posts: recentPosts.length, negativeScore: negativeScore.toFixed(3) });
    return snapshot;
  }
}

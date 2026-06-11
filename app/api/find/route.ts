import { NextRequest, NextResponse } from "next/server";
import { renderHtml } from "./render";

export const runtime = "nodejs";
export const maxDuration = 120;

// Matches linkedin URLs with or without protocol / leading slashes.
// The negative lookbehind stops it matching inside e.g. "notlinkedin.com".
const LINKEDIN_RE =
  /(?<![\w.@-])(?:https?:)?(?:\/\/)?(?:[a-z0-9-]+\.)?linkedin\.com\/(company|in|school|showcase|pub|organization)\/[^\s"'<>)\]\\}]+/gi;

// Paths we'll crawl as a fallback when the homepage has no LinkedIn link.
const FALLBACK_PATHS = [
  "about",
  "about-us",
  "company",
  "contact",
  "contact-us",
  "team",
  "impressum", // common on EU sites
  "legal",
];

// Hrefs whose path hints at a page likely to hold social links.
const SUBPAGE_HINT_RE =
  /(about|company|contact|team|impressum|legal|connect|social|follow|kontakt|nosotros|empresa)/i;

const MAX_SUBPAGES = 5;

type Result = {
  domain: string;
  linkedinUrl: string | null;
  type: string | null;
  finalUrl: string | null;
  source: string | null; // which URL the link was found on
  status: "found" | "not_found" | "error";
  error?: string;
};

function normalizeDomain(raw: string): string | null {
  let d = raw.trim();
  if (!d) return null;
  d = d.replace(/^['",\s]+|['",\s]+$/g, "");
  if (!d) return null;
  if (!/^https?:\/\//i.test(d)) d = "https://" + d;
  try {
    const u = new URL(d);
    return u.origin + "/";
  } catch {
    return null;
  }
}

// Undo the common ways a real URL gets mangled inside HTML/JSON/JS blobs so the
// regex can see it: escaped slashes, unicode/hex escapes, HTML entities.
function deobfuscate(html: string): string {
  return html
    .replace(/\\\//g, "/") // JSON: https:\/\/...
    .replace(/\\u002[fF]/g, "/") // JS unicode escape for "/"
    .replace(/\\x2[fF]/g, "/") // JS hex escape for "/"
    .replace(/&#x2[fF];/g, "/") // HTML hex entity for "/"
    .replace(/&#47;/g, "/") // HTML decimal entity for "/"
    .replace(/&#x3[aA];/g, ":") // ":" entity
    .replace(/&#58;/g, ":")
    .replace(/&amp;/g, "&");
}

// Clean a captured URL into a canonical https://... form.
function cleanUrl(raw: string): string {
  let u = raw.trim();
  u = u.split(/["'<>\\\s]/)[0]; // cut at first boundary char
  u = u.replace(/[.,;:!?)\]}'"]+$/, ""); // strip trailing punctuation
  u = u.replace(/^\/\//, "https://"); // protocol-relative
  if (!/^https?:\/\//i.test(u)) u = "https://" + u; // bare
  try {
    const parsed = new URL(u);
    parsed.protocol = "https:";
    parsed.hostname = parsed.hostname.toLowerCase();
    // Normalize host to the canonical www form for dedupe consistency.
    if (parsed.hostname === "linkedin.com") parsed.hostname = "www.linkedin.com";
    parsed.search = "";
    parsed.hash = "";
    let out = parsed.toString();
    if (out.endsWith("/")) out = out.slice(0, -1);
    return out;
  } catch {
    return u;
  }
}

function linkType(u: string): string {
  const m = u.match(/linkedin\.com\/([a-z]+)\//i);
  return m ? m[1].toLowerCase() : "other";
}

function extractLinkedIn(html: string): string[] {
  const text = deobfuscate(html);
  const matches = text.match(LINKEDIN_RE) || [];
  const cleaned = matches
    .map(cleanUrl)
    // Drop linkedin's own utility paths that aren't a company/profile.
    .filter((u) => !/linkedin\.com\/(shareArticle|sharing|cws|uas|login|feed)/i.test(u))
    // Require an actual slug after the type segment.
    .filter((u) => /linkedin\.com\/[a-z]+\/[^/]+/i.test(u));
  const seen = new Set<string>();
  return cleaned.filter((u) => {
    const k = u.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function pickBest(urls: string[]): { url: string; type: string } | null {
  if (urls.length === 0) return null;
  const priority = ["company", "organization", "school", "showcase", "in", "pub"];
  const sorted = [...urls].sort((a, b) => {
    const pa = priority.indexOf(linkType(a));
    const pb = priority.indexOf(linkType(b));
    return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
  });
  return { url: sorted[0], type: linkType(sorted[0]) };
}

const UAS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  // Googlebot — some bot-walls allow it through where they block a generic UA.
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
];

async function fetchHtml(
  url: string,
  timeoutMs = 12000
): Promise<{ html: string; finalUrl: string }> {
  let lastErr: unknown = null;
  for (const ua of UAS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "User-Agent": ua,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      const finalUrl = res.url || url;
      const body = await res.text().catch(() => "");
      // 403/429 with the first UA → retry with the next one.
      if ((res.status === 403 || res.status === 429) && ua !== UAS[UAS.length - 1]) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok && !body) throw new Error(`HTTP ${res.status}`);
      return { html: body, finalUrl };
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Fetch failed");
}

// Find on-site pages worth crawling for social links.
function discoverSubpages(html: string, origin: string): string[] {
  const originHost = new URL(origin).hostname;
  const hrefs = Array.from(
    html.matchAll(/href\s*=\s*["']([^"']+)["']/gi),
    (m) => m[1]
  );
  const found: string[] = [];
  const seen = new Set<string>();
  for (const href of hrefs) {
    if (!SUBPAGE_HINT_RE.test(href)) continue;
    try {
      const abs = new URL(href, origin);
      if (abs.hostname !== originHost) continue; // stay on-site
      abs.hash = "";
      abs.search = "";
      const key = abs.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(key);
    } catch {
      /* ignore malformed href */
    }
    if (found.length >= MAX_SUBPAGES) break;
  }
  // Add a few guessed paths in case nav links are JS-rendered / not in HTML.
  for (const p of FALLBACK_PATHS) {
    if (found.length >= MAX_SUBPAGES) break;
    const guess = origin + p;
    if (!seen.has(guess)) {
      seen.add(guess);
      found.push(guess);
    }
  }
  return found.slice(0, MAX_SUBPAGES);
}

async function processDomain(rawDomain: string): Promise<Result> {
  const origin = normalizeDomain(rawDomain);
  const base: Result = {
    domain: rawDomain.trim(),
    linkedinUrl: null,
    type: null,
    finalUrl: null,
    source: null,
    status: "not_found",
  };
  if (!origin) return { ...base, status: "error", error: "Invalid domain" };

  const candidates = [origin];
  if (origin.startsWith("https://")) {
    candidates.push("http://" + origin.slice("https://".length));
  }

  let homepageHtml = "";
  let finalUrl: string | null = null;
  let reachedSite = false;
  let lastError = "";

  // 1) Homepage.
  for (const url of candidates) {
    try {
      const { html, finalUrl: fu } = await fetchHtml(url);
      homepageHtml = html;
      finalUrl = fu;
      reachedSite = true;
      const best = pickBest(extractLinkedIn(html));
      if (best) {
        return {
          ...base,
          linkedinUrl: best.url,
          type: best.type,
          finalUrl: fu,
          source: fu,
          status: "found",
        };
      }
      break; // reached the site; no need to try http fallback
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  if (!reachedSite) {
    return { ...base, status: "error", error: lastError || "Fetch failed" };
  }

  // 2) Deep-crawl fallback: about/contact/etc.
  const subpages = discoverSubpages(homepageHtml, finalUrl ? new URL(finalUrl).origin + "/" : origin);
  const subResults = await Promise.all(
    subpages.map(async (u) => {
      try {
        const { html } = await fetchHtml(u, 9000);
        const best = pickBest(extractLinkedIn(html));
        return best ? { url: u, best } : null;
      } catch {
        return null;
      }
    })
  );

  // Prefer the highest-priority link across all crawled subpages.
  const hits = subResults.filter(
    (r): r is { url: string; best: { url: string; type: string } } => r !== null
  );
  if (hits.length > 0) {
    const best = pickBest(hits.map((h) => h.best.url))!;
    const source = hits.find((h) => h.best.url === best.url)?.url ?? null;
    return {
      ...base,
      linkedinUrl: best.url,
      type: best.type,
      finalUrl,
      source,
      status: "found",
    };
  }

  // 3) Headless-browser fallback for JS-rendered footers (SPAs).
  try {
    const target = finalUrl ? new URL(finalUrl).origin + "/" : origin;
    const { html, finalUrl: fu } = await renderHtml(target);
    const best = pickBest(extractLinkedIn(html));
    if (best) {
      return {
        ...base,
        linkedinUrl: best.url,
        type: best.type,
        finalUrl: fu || finalUrl,
        source: (fu || finalUrl || target) + " (rendered)",
        status: "found",
      };
    }
  } catch {
    // chromium missing or render failed — fall through to not_found
  }

  return { ...base, finalUrl, status: "not_found" };
}

export async function POST(req: NextRequest) {
  let body: { domains?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const domains = Array.isArray(body.domains) ? body.domains : [];
  const cleaned = domains
    .filter((d): d is string => typeof d === "string")
    .map((d) => d.trim())
    .filter(Boolean)
    .slice(0, 25);

  if (cleaned.length === 0) {
    return NextResponse.json({ error: "No domains provided" }, { status: 400 });
  }

  const results = await Promise.all(cleaned.map(processDomain));
  return NextResponse.json({ results });
}

import type { Browser } from "playwright-core";

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await import("playwright-core");
      return chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
    })();
  }
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    browserPromise = null;
    if (b) await b.close().catch(() => {});
  }
}

export async function renderHtml(
  url: string,
  timeoutMs = 15000
): Promise<{ html: string; finalUrl: string }> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    viewport: { width: 1280, height: 1400 },
  });
  const page = await context.newPage();
  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (type === "image" || type === "media" || type === "font") {
      return route.abort();
    }
    return route.continue();
  });
  try {
    const resp = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await page
      .waitForLoadState("networkidle", { timeout: 4000 })
      .catch(() => {});
    await page
      .evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      .catch(() => {});
    await page.waitForTimeout(500);
    const html = await page.content();
    const finalUrl = resp?.url() || page.url() || url;
    return { html, finalUrl };
  } finally {
    await context.close().catch(() => {});
  }
}

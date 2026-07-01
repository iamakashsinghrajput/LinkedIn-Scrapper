import { chromium } from "playwright-core";
const LI=/linkedin\.com\/(company|in|school|showcase|pub|organization)\/[^\s"'<>)\]\\}]+/gi;
const browser = await chromium.launch({ headless:true, args:["--no-sandbox"] });
for (const d of ["ramp.com","ghost.org","posthog.com","cal.com","instacart.com"]) {
  const page = await browser.newPage();
  try {
    await page.goto("https://"+d+"/", { waitUntil:"domcontentloaded", timeout:20000 });
    await page.waitForLoadState("networkidle",{timeout:4000}).catch(()=>{});
    await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight)).catch(()=>{});
    await page.waitForTimeout(1200);
    const html = await page.content();
    const hits=[...new Set(html.match(LI)||[])];
    console.log(d, "-> rendered linkedin hits:", hits.slice(0,3), "(total mentions", (html.match(/linkedin\.com/gi)||[]).length+")");
  } catch(e){ console.log(d,"ERR",e.message); }
  await page.close();
}
await browser.close();

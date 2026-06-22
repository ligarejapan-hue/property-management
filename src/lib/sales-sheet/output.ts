import { existsSync } from "node:fs";
import { chromium, type Page } from "playwright";

/** chromium 実体が導入済みか（未導入環境では出力テストを skip するために使う）。 */
export function isChromiumAvailable(): boolean {
  try {
    const p = chromium.executablePath();
    return !!p && existsSync(p);
  } catch {
    return false;
  }
}

/** mm → px（96 dpi 基準）。 */
function mmToPx(mm: number): number {
  return Math.round((mm * 96) / 25.4);
}

async function withPage<T>(html: string, fn: (page: Page) => Promise<T>): Promise<T> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    return await fn(page);
  } finally {
    await browser.close();
  }
}

export async function renderHtmlToPdf(
  html: string,
  opts: { widthMm?: number; heightMm?: number } = {},
): Promise<Buffer> {
  const width = `${opts.widthMm ?? 297}mm`;
  const height = `${opts.heightMm ?? 210}mm`;
  return withPage(html, (page) =>
    page.pdf({ width, height, printBackground: true, pageRanges: "1" }),
  );
}

export async function renderHtmlToImage(
  html: string,
  opts: {
    format?: "png" | "jpeg";
    widthMm?: number;
    heightMm?: number;
    scale?: number;
  } = {},
): Promise<Buffer> {
  const type = opts.format ?? "png";
  const widthPx = mmToPx(opts.widthMm ?? 297);
  const heightPx = mmToPx(opts.heightMm ?? 210);
  const deviceScaleFactor = opts.scale ?? 2;

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: widthPx, height: heightPx },
      deviceScaleFactor,
    });
    const page = await context.newPage();
    try {
      await page.setContent(html, { waitUntil: "networkidle" });
      const sheetLocator = page.locator("[data-sales-sheet-page]");
      const count = await sheetLocator.count();
      if (count > 0) {
        return await sheetLocator.first().screenshot({ type });
      }
      return await page.screenshot({ type });
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

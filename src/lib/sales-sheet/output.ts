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
  opts: { format?: "png" | "jpeg" } = {},
): Promise<Buffer> {
  const type = opts.format ?? "png";
  return withPage(html, (page) => page.screenshot({ type, fullPage: true }));
}

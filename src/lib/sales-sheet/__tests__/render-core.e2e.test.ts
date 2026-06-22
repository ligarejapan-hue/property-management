import { describe, it, expect } from "vitest";
import { isChromiumAvailable } from "../output";
import { renderDocumentToPdf, renderDocumentToImage } from "../render-to-output";
import { sampleDocument } from "../__fixtures__/sample-document";

describe("sales-sheet render core (e2e)", () => {
  it.skipIf(!isChromiumAvailable())(
    "fixture → PDF と PNG を生成する",
    async () => {
      const pdf = await renderDocumentToPdf(sampleDocument);
      expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(pdf.length).toBeGreaterThan(1000);

      const png = await renderDocumentToImage(sampleDocument, "png");
      expect(png.length).toBeGreaterThan(1000);
    },
    60_000,
  );
});

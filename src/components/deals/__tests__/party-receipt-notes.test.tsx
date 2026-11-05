import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { PartyReceiptNotes } from "../business-docs-section";

describe("領収書の小窓の知らせ(2026-11-05 発注者)", () => {
  it("空欄で出る部分を並べる・止めない(role=status)", () => {
    const html = renderToStaticMarkup(<PartyReceiptNotes notes={["契約日が未入力のため、日付は空欄で出ます"]} />);
    expect(html).toContain("契約日が未入力のため、日付は空欄で出ます");
    expect(html).toContain('role="status"');
  });
  it("知らせが無ければ何も出さない", () => {
    expect(renderToStaticMarkup(<PartyReceiptNotes notes={[]} />)).toBe("");
  });
  it("自社を発行者に選んでいる間は出さない", () => {
    const src = readFileSync(join(process.cwd(), "src/components/deals/business-docs-section.tsx"), "utf8");
    expect(src).toContain('{values.issuer !== "self" && <PartyReceiptNotes notes={(choices.partyNotes ?? []).map((n) => n.label)} />}');
  });
});

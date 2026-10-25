import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const SECTION = "src/components/deals/business-docs-section.tsx";

describe("書類タブの業務書類(段5a・5b)", () => {
  it("書類タブに出せる書類を並べる(判定はサーバーの一覧表)", () => {
    expect(read("src/components/deals/deal-documents-panel.tsx")).toContain("<BusinessDocsSection dealId={dealId} active={active} refresh={tick} onIssued={reload} />");
    const src = read(SECTION);
    expect(src).toContain("dealsApi.availableDocuments(dealId)");
    expect(src).toContain("d.missing.length");
  });
  it("出す前の確認: 空欄の一覧・「入力に戻る」「空欄のまま出す」", () => {
    const src = read(SECTION);
    expect(src).toContain("入力に戻る");
    expect(src).toContain('doc.missing.length ? "空欄のまま出す" : "発行する"');
    expect(src).toContain("<ModalShell");
  });
  it("個人の発行者は非課税/課税を選ぶまで発行ボタンを押せない", () => {
    const src = read(SECTION);
    expect(src).toContain("const needsDecision = receipt && issuer?.individual === true && values.exempt == null;");
    expect(src).toMatch(/disabled=\{busy \|\| needsDecision \|\| incomplete \|\| doc\.blocking\.length > 0\}/);
    // 「読み込み直す」で出せる書類と版も読み直す
    expect(src).toContain("}, [dealId, active, tick, refresh]);");
  });
  it("書類をまとまり(決済の書類/そのほかの書類/OC の書類)で分けて並べる(段5b)", () => {
    const src = read(SECTION);
    for (const g of ['{ key: "settlement", label: "決済の書類" }', '{ key: "other", label: "そのほかの書類" }', '{ key: "oc", label: "OC の書類" }']) expect(src).toContain(g);
    expect(src).toContain("docs.filter((d) => d.group === g.key)");
  });
  it("委任状は委任する事項・鍵受領書は鍵の行がそろうまで発行ボタンを押せない(段5b)", () => {
    const src = read(SECTION);
    expect(src).toContain('(doc.docType === "power_of_attorney" && !matters.length && !str(values.otherMatter).trim())');
    expect(src).toContain('(doc.docType === "key_receipt" && (!keyRows.length || !keyRows.every(keyRowOk)))');
    expect(src).toMatch(/disabled=\{busy \|\| needsDecision \|\| incomplete \|\| doc\.blocking\.length > 0\}/);
    // 選べる値はサーバーの一覧表のもの
    for (const k of ["choices.principal", "choices.agent", "choices.matters", "choices.receiver"]) expect(src).toContain(k);
  });
  it("発行は、確認を開いたときの取引の版で送る", () => {
    expect(read(SECTION)).toContain("dealsApi.issueDocument(dealId, doc.docType, version, options)");
  });
});

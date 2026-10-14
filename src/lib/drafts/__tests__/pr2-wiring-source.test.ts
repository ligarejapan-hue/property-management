import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

/** 既定の書き出しが、ブラウザで描き直した後に本体を作り直す形か。 */
function expectClientReadyGate(src: string, screen: string) {
  expect(src).toMatch(new RegExp(`const clientReady = useClientReady\\(\\);\\s*return <${screen} key=\\{clientReady \\? "client" : "server"\\} draftEnabled=\\{clientReady\\} />;`));
}

describe("貼り付けて物件化の配線", () => {
  const src = read("src/app/(dashboard)/import/paste/page.tsx");
  it("F5 でも食い違わない: 控えはブラウザで描き直した後だけ読む", () => {
    expectClientReadyGate(src, "PasteImportScreen");
    expect(src).toMatch(/draftEnabled \? draftKey\("paste"\) : null/);
  });
  it("登録の直前に送信中の印・成功で消す・4xx だけ印を外す", () => {
    expect(src).toMatch(/draftSaver\.markSubmitting\(\);[\s\S]{0,400}fetch\("\/api\/import\/paste\/commit"/);
    expect(src).toMatch(/draftSaver\.close\(\);\s*router\.push\(`\/properties\/\$\{result\.propertyId\}`\)/);
    expect(src).toMatch(/if \(isDefiniteSubmitFailure\(e\)\) draftSaver\.unmarkSubmitting\(\);\s*else setPendingBlocked\(true\);/);
    expect(src).toContain("throw httpError(await readApiErrorMessage(res), res.status)");
  });
  it("やり直しは discard・選び直しまで登録を止める", () => {
    expect(src).toMatch(/draftSaver\.discard\(\)/);
    expect(src).toContain("registerBlockedReason={");
    expect(src).toContain("pdfReselectReason(");
  });
});

describe("Excelまとめ取込の配線", () => {
  const src = read("src/app/(dashboard)/import/paste/excel/page.tsx");
  it("F5 でも食い違わない", () => {
    expectClientReadyGate(src, "ExcelLeadImportScreen");
    expect(src).toMatch(/draftEnabled \? draftKey\("paste-excel"\) : null/);
  });
  it("送る行を控えにすぐ書いてから送り、結果が来たら外す", () => {
    expect(src).toMatch(
      /setSendingKey\(key\);\s*draftSaver\.writeNow\(\{ \.\.\.draftDataRef\.current, sendingKey: key \}\);[\s\S]{0,600}fetch\("\/api\/import\/paste\/commit"[\s\S]{0,600}setSendingKey\(null\);/,
    );
  });
  it("画面を離れたら次の行を送らない(§5.2)", () => {
    expect(src).toMatch(/useEffect\(\(\) => \(\) => \{\s*stopRef\.current = true;\s*\}, \[\]\);/);
  });
  it("戻したとき送信中だった行は分からない扱い", () => {
    expect(src).toContain("restoreExcelResults(");
  });
});

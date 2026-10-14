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
  it("送る行を控えにすぐ書いてから送り、結果もすぐ書く(前の行の結果を落とさない・最終点検 Important #2)", () => {
    expect(src).toMatch(
      /setSendingKey\(key\);\s*draftSaver\.writeNow\(\{ \.\.\.draftDataRef\.current, results: \{ \.\.\.sentResults \}, sendingKey: key \}\);[\s\S]{0,800}fetch\("\/api\/import\/paste\/commit"[\s\S]{0,600}sentResults\[key\] = result;\s*draftSaver\.writeNow\(\{ \.\.\.draftDataRef\.current, results: \{ \.\.\.sentResults \}, sendingKey: null \}\);\s*setResults\(\(prev\) => \(\{ \.\.\.prev, \[key\]: result \}\)\);\s*setSendingKey\(null\);/,
    );
    expect(src).toMatch(/const sentResults: Record<string, ExcelLeadResult> = \{ \.\.\.draftDataRef\.current\.results \};/);
  });
  it("画面を離れたら次の行を送らない(§5.2)", () => {
    expect(src).toMatch(/useEffect\(\(\) => \(\) => \{\s*stopRef\.current = true;\s*\}, \[\]\);/);
  });
  it("戻したとき送信中だった行は分からない扱い", () => {
    expect(src).toContain("restoreExcelResults(");
  });
});

describe("謄本PDF取込の配線", () => {
  const src = read("src/app/(dashboard)/import/registry-pdf/page.tsx");
  it("F5 でも食い違わない", () => {
    expectClientReadyGate(src, "RegistryPdfScreen");
    expect(src).toMatch(/draftEnabled \? draftKey\("registry-pdf"\) : null/);
  });
  it("取り込みの直前に送信中の印・成功で消す(続けて取り込めるよう discard)・4xx だけ印を外す", () => {
    expect(src).toMatch(/draftSaver\.markSubmitting\(\);[\s\S]{0,300}importRegistryPdf/);
    expect(src).toMatch(/draftSaver\.discard\(\);\s*setResult\(json as ImportResult\);/);
    expect(src).toMatch(/if \(isDefiniteSubmitFailure\(err\)\) draftSaver\.unmarkSubmitting\(\);\s*else setPendingBlocked\(true\);/);
  });
  it("ファイルを選び直すまで「登録実行」を押せない", () => {
    expect(src).toMatch(/disabled=\{importing \|\| needsReselect \|\| pendingBlocked\}/);
    expect(src).toContain("<DraftReselectFileNotice");
  });
  it("送信途中の確認待ちの間は「キャンセル」で印を消させない(最終点検 Minor #1)", () => {
    expect(src).toMatch(/onClick=\{handleReset\}\s*disabled=\{pendingBlocked\}/);
  });
  it("キャンセル(最初に戻る)で控えを消す", () => {
    expect(src).toMatch(/const handleReset = \(\) => \{\s*draftSaver\.discard\(\);/);
  });
});

describe("取り込み(CSV)の配線", () => {
  const src = read("src/app/(dashboard)/import/page.tsx");
  it("F5 でも食い違わない", () => {
    expectClientReadyGate(src, "ImportScreen");
    expect(src).toMatch(/draftEnabled \? draftKey\("csv-import"\) : null/);
  });
  it("送信中の印が残る控えは書き手に渡さない(印を引き継がず、空で上書きして消す)", () => {
    expect(src).toMatch(/useDraftAutosave\(draftKeyValue, draftData, isCsvImportDraftEmpty, restoreDecision\.start \? restored : null,/);
  });
  it.each([
    ["importCsv(", "main"],
    ["importReceptionOwnerCsv(", "ro"],
    ["importReceptionPropertyCsv(", "rp"],
  ])("%s: 直前に印・済んだ流れを外してから数えて外す・失敗は 4xx か分からないかで分ける", (call, flow) => {
    const at = src.indexOf(`await ${call}`);
    expect(at).toBeGreaterThan(0);
    const before = src.slice(Math.max(0, at - 400), at);
    expect(before).toContain('applyCsvPending("start");');
    const after = src.slice(at, at + 900);
    // 済んだ流れを外した形を先に書いてから数える(画面を離れた後に済んでも再送できる形で残さない)。
    expect(after).toContain(`draftSaver.writeNow(csvDraftAfterImport(draftDataRef.current, "${flow}"));\n      applyCsvPending("ok");`);
    expect(after).toMatch(/applyCsvPending\(isDefiniteSubmitFailure\((e|err)\) \? "definite" : "unknown"\);/);
    // 印の上げ下げは数えた結果だけで行う(1つの流れが済んでも、他の流れの守りを外さない)。
    expect(after).not.toMatch(/draftSaver\.unmarkSubmitting\(\)/);
  });
  it("結果が分からない間は3つの取り込みボタンを押せない", () => {
    expect(src).toMatch(/onClick=\{handleImport\}\s*disabled=\{uploading \|\| importBlocked\}/);
    expect(src).toMatch(/onClick=\{handleRpImport\}\s*disabled=\{[^}]*\|\| importBlocked\}/);
    expect(src).toMatch(/onClick=\{handleRoImport\}\s*disabled=\{[^}]*\|\| importBlocked\}/);
    for (const h of ["handleImport", "handleRoImport", "handleRpImport"]) {
      expect(src).toMatch(new RegExp(`const ${h} = async \\(\\) => \\{\\s*if \\(importBlocked\\) return;`));
    }
  });
});

describe("送っている途中は「最初からやり直す」を出さない(送信中の印を消させない・@codex P1)", () => {
  it("貼り付けて物件化: 登録中は帯を出さない", () => {
    expect(read("src/app/(dashboard)/import/paste/page.tsx")).toMatch(
      /restored && !restoredDismissed && !registering && <DraftRestoredNotice/,
    );
  });
  it("謄本PDF: 取り込み中は帯を出さない", () => {
    expect(read("src/app/(dashboard)/import/registry-pdf/page.tsx")).toMatch(
      /restored && !restoredDismissed && !importing && step !== "result" &&/,
    );
  });
  it("取り込み(CSV): どれかの取り込み中・結果が分からない間は帯を出さない", () => {
    const src = read("src/app/(dashboard)/import/page.tsx");
    expect(src).toMatch(/const importBusy = uploading \|\| roLoading \|\| rpLoading \|\| importBlocked;/);
    expect(src).toMatch(/restoreDecision\.start && restored && !restoredDismissed && !importBusy &&/);
  });
});

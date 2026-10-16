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
  it("通信切れは「登録されたか分からない」(失敗と言い切らない・@codex P1)", () => {
    expect(src).toMatch(/\} catch \{\s*\/\/[^\n]*\n\s*result = \{ kind: "unknown" \};/);
  });
  it("読み取り中・登録中は「最初からやり直す」を出さない(@codex P2)", () => {
    expect(src).toMatch(/restored && !restoredDismissed && !running && !reading && \(/);
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
    expect(src).toMatch(/onClick=\{handleReset\}\s*disabled=\{pendingBlocked \|\| importing\}/);
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
  it("送信中の印が残る控えは、中身は戻さず印だけ引き継ぎ、人が確かめるまで消さない・送れなくする(@codex P1)", () => {
    expect(src).toMatch(/useDraftAutosave\(draftKeyValue, draftData, isCsvImportDraftEmpty, restored,/);
    expect(src).toMatch(/const csvPendingRef = useRef<CsvPendingState>\(\{ inflight: 0, unknown: restoreDecision\.showPending \}\);/);
    expect(src).toMatch(/const \[importBlocked, setImportBlocked\] = useState\(restoreDecision\.showPending\);/);
    expect(src).toContain('onDismiss={() => applyCsvPending("confirm")}');
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
    expect(after).toContain(`finishCsvFlow("${flow}");`);
    expect(after).toMatch(/applyCsvPending\(isDefiniteSubmitFailure\((e|err)\) \? "definite" : "unknown"\);/);
    // 印の上げ下げは数えた結果だけで行う(1つの流れが済んでも、他の流れの守りを外さない)。
    expect(after).not.toMatch(/draftSaver\.unmarkSubmitting\(\)/);
  });
  it("済んだ流れは共有の控えの形に積み重ねて書く(離れた後に2つ済んでも、先に済んだ流れを書き戻さない・@codex P1)", () => {
    expect(src).toMatch(
      /const finishCsvFlow = \(flow: "main" \| "ro" \| "rp"\) => \{\s*draftDataRef\.current = csvDraftAfterImport\(draftDataRef\.current, flow\);\s*draftSaver\.writeNow\(draftDataRef\.current\);\s*applyCsvPending\("ok"\);\s*\};/,
    );
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
      /restored && !restoredDismissed && !registering && !reading && <DraftRestoredNotice/,
    );
  });
  it("謄本PDF: 取り込み中は帯を出さない", () => {
    expect(read("src/app/(dashboard)/import/registry-pdf/page.tsx")).toMatch(
      /restored && !restoredDismissed && !importing && !parsing && step !== "result" &&/,
    );
  });
  it("取り込み(CSV): どれかの取り込み中・結果が分からない間は帯を出さない", () => {
    const src = read("src/app/(dashboard)/import/page.tsx");
    expect(src).toMatch(/const importBusy = uploading \|\| previewLoading \|\| roLoading \|\| rpLoading \|\| importBlocked;/);
    expect(src).toMatch(/restoreDecision\.start && restored && !restoredDismissed && !importBusy &&/);
  });
});

describe("読み取り・下見の返事を待つ間も「最初からやり直す」を出さない(届いた結果が控えを作り直す・@codex P2)", () => {
  it("貼り付けて物件化: 読み取り中", () => {
    expect(read("src/app/(dashboard)/import/paste/page.tsx")).toMatch(
      /restored && !restoredDismissed && !registering && !reading && <DraftRestoredNotice/,
    );
  });
  it("謄本PDF: 解析中", () => {
    expect(read("src/app/(dashboard)/import/registry-pdf/page.tsx")).toMatch(
      /restored && !restoredDismissed && !importing && !parsing && step !== "result" &&/,
    );
  });
  it("取り込み(CSV): 重複の下見中", () => {
    expect(read("src/app/(dashboard)/import/page.tsx")).toMatch(
      /const importBusy = uploading \|\| previewLoading \|\| roLoading \|\| rpLoading \|\| importBlocked;/,
    );
  });
});

describe("取り込み(CSV): やり直した後に届いたファイルの読み込みは使わない(@codex P2)", () => {
  const src = read("src/app/(dashboard)/import/page.tsx");
  it("やり直すと世代を進める", () => {
    expect(src).toMatch(/const handleDiscardDraft = \(\) => \{\s*discardGenRef\.current \+= 1;/);
  });
  it.each(["const processFile = useCallback(async (file: File) => {", "const handleRoFile = async (", "const handleRpFile = async ("])(
    "%s は読み込みの後に世代を確かめる",
    (head) => {
      const at = src.indexOf(head);
      expect(at).toBeGreaterThan(0);
      const body = src.slice(at, at + 1600);
      expect(body).toContain("const gen = discardGenRef.current;");
      expect(body).toMatch(/await [^;]+;\s*(?:\/\/[^\n]*\n\s*)*if \(gen !== discardGenRef\.current\) return;/);
    },
  );
});

describe("取り込み(CSV): 結果が分からないときは履歴を読み直し、読み終わるまで確かめたボタンを押せない(@codex P1)", () => {
  const src = read("src/app/(dashboard)/import/page.tsx");
  it("3つの取り込みの失敗のあとで履歴を読み直す", () => {
    const m = src.match(/applyCsvPending\(isDefiniteSubmitFailure\((e|err)\) \? "definite" : "unknown"\);\s*(?:\/\/[^\n]*\n\s*)?fetchJobs\(\);/g) ?? [];
    expect(m.length).toBe(3);
  });
  it("履歴を読んでいる間は「確かめたので続ける」を押せない", () => {
    expect(src).toContain('reason={importBlockReason} settling={historySettling} confirmDisabled={historySettling || jobsLoading || historyStale} historyError={historyStale && !jobsLoading && !historySettling} onDismiss={() => applyCsvPending("confirm")}');
  });
});

describe("取り込み(CSV): 履歴の読み直しが成功するまで「確かめた」を押せない(@codex P1)", () => {
  const src = read("src/app/(dashboard)/import/page.tsx");
  it("結果が分からなくなったら履歴を古い扱いにし、その後に始めた読み込みが成功したときだけ外す", () => {
    expect(src).toMatch(/const \[historyStale, setHistoryStale\] = useState\(restoreDecision\.showPending\);/);
    expect(src).toMatch(/historyGenRef\.current \+= 1;[\s\S]{0,200}setHistoryStale\(true\);/);
    expect(src).toMatch(/const gen = historyGenRef\.current;\s*const startedAt = Date\.now\(\);\s*const req = \+\+jobsReqRef\.current;\s*setJobsLoading\(true\);/);
    expect(src).toMatch(/setJobPagination\(json\.pagination \?\? null\);\s*(?:\/\/[^\n]*\n\s*)?if \(\s*canTrustJobHistory\(\{\s*sameGen: gen === historyGenRef\.current,\s*defaultView: isDefaultJobView\(jobFilters, jobPage\),[\s\S]{0,120}\}\)\s*\) \{\s*setHistoryStale\(false\);/);
  });
  it("帯のボタンは読み込み中・古いままのとき押せず、読めなかったことを伝える", () => {
    expect(src).toContain("confirmDisabled={historySettling || jobsLoading || historyStale}");
    expect(src).toContain("historyError={historyStale && !jobsLoading && !historySettling}");
  });
});

describe("取り込み(CSV): 履歴は最後に始めた読み込みの結果だけを出す(古い応答で上書きしない・@codex P1)", () => {
  const src = read("src/app/(dashboard)/import/page.tsx");
  it("読み込みごとに番号を振り、最後のもの以外の応答は捨てる", () => {
    expect(src).toMatch(/const req = \+\+jobsReqRef\.current;/);
    expect(src).toMatch(/const json = await fetchImportJobs\(\{[\s\S]*?\}\);\s*if \(req !== jobsReqRef\.current\) return;\s*setJobs\(/);
    expect(src).toMatch(/if \(req === jobsReqRef\.current\) setJobsLoading\(false\);/);
  });
});

describe("取り込み(CSV): 確かめる履歴は絞り込みなしの1ページ目(今回の取り込みが必ず見える・@codex P1)", () => {
  const src = read("src/app/(dashboard)/import/page.tsx");
  it("結果が分からなくなったら絞り込みを外して1ページ目へ戻す", () => {
    expect(src).toMatch(/setHistoryStale\(true\);\s*setJobFilters\(DEFAULT_JOB_FILTERS\);\s*setJobPage\(1\);/);
  });
  it("古い扱いを外すのは、絞り込みなしの1ページ目を読めたときだけ", () => {
    expect(src).toMatch(
      /sameGen: gen === historyGenRef\.current,\s*defaultView: isDefaultJobView\(jobFilters, jobPage\),/,
    );
  });
});

describe("貼り付けて物件化: 成功の返事に物件番号が無ければ「分からない」扱い(印を消さない・@codex P2)", () => {
  it("番号を確かめてから控えを閉じる", () => {
    const src = read("src/app/(dashboard)/import/paste/page.tsx");
    expect(src).toMatch(
      /const result = \(await res\.json\(\)\) as CommitApiResponse;\s*if \(typeof result\?\.propertyId !== "string" \|\| result\.propertyId === ""\) \{\s*throw new Error\(/,
    );
  });
});

describe("貼り付けて物件化: 見直しの間に画面を離れたら登録を送らない(@codex P1)", () => {
  const src = read("src/app/(dashboard)/import/paste/page.tsx");
  it("画面に出ている間だけ true の印を持つ", () => {
    expect(src).toMatch(/useEffect\(\(\) => \{\s*mountedRef\.current = true;\s*return \(\) => \{\s*mountedRef\.current = false;\s*\};\s*\}, \[\]\);/);
  });
  it("見直しの返事の後、離れていたら止める", () => {
    expect(src).toMatch(/const latest = await recheckDuplicates\(\);\s*(?:\/\/[^\n]*\n\s*)*if \(!mountedRef\.current\) return;/);
  });
});

describe("成功でも結果の形が欠けた返事は「分からない」扱い(@codex P2・CSV 3つの流れ+謄本)", () => {
  it("取り込み(CSV): 3つの流れとも、流れを済ませる前に形を確かめる", () => {
    const src = read("src/app/(dashboard)/import/page.tsx");
    expect(src).toMatch(/if \(!hasImportResultShape\(json, IMPORT_RESULT_SHAPE\)\) throw new Error\(UNREADABLE_IMPORT_RESULT\);\s*setResult\(json as ImportResult\);\s*finishCsvFlow\("main"\);/);
    expect(src).toMatch(/if \(!hasImportResultShape\(res, RO_RESULT_SHAPE\)\) throw new Error\(UNREADABLE_IMPORT_RESULT\);\s*setRoResult\(res\);\s*finishCsvFlow\("ro"\);/);
    expect(src).toMatch(/if \(!hasImportResultShape\(res, RP_RESULT_SHAPE\)\) throw new Error\(UNREADABLE_IMPORT_RESULT\);\s*setRpResult\(res\);\s*finishCsvFlow\("rp"\);/);
  });
  it("謄本: 控えを消す前に形を確かめる", () => {
    const src = read("src/app/(dashboard)/import/registry-pdf/page.tsx");
    expect(src).toMatch(/if \(!isRegistryImportResult\(json\)\) \{\s*throw new Error\([^)]*\);\s*\}\s*\/\/[^\n]*\n\s*draftSaver\.discard\(\);/);
  });
});

describe("取り込み(CSV): 結果が分からないときは待ってから読み直した履歴だけで確かめる(@codex P1)", () => {
  const src = read("src/app/(dashboard)/import/page.tsx");
  it("分からなくなった時刻から待つ・前回離れたときは印の時刻から待つ", () => {
    expect(src).toContain("useRef(initialHistoryReadyAt(restored))");
    expect(src).toMatch(/historyReadyAtRef\.current = Date\.now\(\) \+ HISTORY_SETTLE_MS;\s*setHistorySettling\(true\);/);
  });
  it("履歴の読み込みは始めた時刻で判定し、待ち終わったら自動で読み直す", () => {
    expect(src).toMatch(/const startedAt = Date\.now\(\);/);
    expect(src).toMatch(/canTrustJobHistory\(\{[\s\S]{0,200}startedAt,\s*readyAt: historyReadyAtRef\.current,/);
    expect(src).toMatch(/setHistorySettling\(false\);\s*fetchJobsRef\.current\(\);/);
  });
  it("待っている間は「確かめた」を押させない", () => {
    expect(src).toContain("confirmDisabled={historySettling || jobsLoading || historyStale}");
  });
});

describe("貼り付けて物件化: 選び直しで違う名前のPDFを選んでも、控えには元のPDFの名前を残す(@codex P1)", () => {
  it("読み直すまで reselectName を優先する", () => {
    const src = read("src/app/(dashboard)/import/paste/page.tsx");
    expect(src).toContain("pdfFileName: draft ? (reselectName ?? pdfFile?.name ?? null) : null,");
  });
});

describe("謄本: 選び直しの枠は選んだ後も残し、選んだファイルの名前で添付する(@codex P2)", () => {
  const src = read("src/app/(dashboard)/import/registry-pdf/page.tsx");
  it("枠は needsReselect で消さない・取り込み中は押せない・選んだ名前を出す", () => {
    expect(src).not.toMatch(/\{needsReselect && \(\s*<FileDropZone/);
    expect(src).toMatch(/<DraftReselectFileNotice[^>]*\/>\s*\{\/\*[^*]*\*\/\}\s*<FileDropZone\s*accept=".pdf"\s*disabled=\{importing\}[\s\S]{0,200}fileName=\{selectedFile\?\.name \?\? null\}/);
  });
  it("添付の名前は選んだファイルの名前", () => {
    expect(src).not.toContain("fileName ?? selectedFile.name");
    expect(src).toMatch(/importRegistryPdfFile\(\s*selectedFile,\s*propId,\s*(?:\/\/[^\n]*\n\s*)?selectedFile\.name,/);
  });
});

describe("取り込み(CSV): F5 の仮の画面では取りに行かない(初回の取得が2回走らない)", () => {
  const src = read("src/app/(dashboard)/import/page.tsx");
  it("履歴・異常ジョブ・実行者の一覧は draftEnabled のときだけ取りに行く", () => {
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(!draftEnabled\) return;\s*fetchJobs\(\);\s*\}, \[fetchJobs, draftEnabled\]\);/);
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(!draftEnabled\) return;\s*fetchStuck\(\);\s*\}, \[fetchStuck, draftEnabled\]\);/);
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(!draftEnabled\) return;\s*let cancelled = false;[\s\S]{0,200}await fetchUsers\(\)[\s\S]{0,900}\}, \[draftEnabled\]\);/);
  });
});

describe("取り込み(CSV): 下見の読み込み中に離れて戻ったら下見を取り直す", () => {
  const src = read("src/app/(dashboard)/import/page.tsx");
  it("段階3・下見なしの控えから戻ったときだけ、1回取り直す", () => {
    expect(src).toMatch(/if \(!draftEnabled \|\| previewResumedRef\.current\) return;\s*previewResumedRef\.current = true;\s*if \(s0\?\.main\?\.step === 3 && !s0\.main\.duplicatePreview\) void runDuplicatePreview\(\);/);
    expect(src).toContain("onClick={runDuplicatePreview}");
  });
  it("最後に始めた下見の応答だけを使う・やり直しで捨てる", () => {
    expect(src).toMatch(/const req = \+\+previewReqRef\.current;[\s\S]{0,400}if \(req !== previewReqRef\.current\) return;\s*setDuplicatePreview\(/);
    expect(src).toMatch(/const handleReset = \(\) => \{\s*previewReqRef\.current \+= 1;/);
  });
});

describe("取り込み(CSV): 帯から取込履歴へ飛べる", () => {
  it("履歴の枠に id がある", () => {
    expect(read("src/app/(dashboard)/import/page.tsx")).toMatch(/\{\/\* =+ Job History =+ \*\/\}\s*<div id=\{IMPORT_HISTORY_ID\}/);
  });
});

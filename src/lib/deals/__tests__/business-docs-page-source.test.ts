import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const SECTION = "src/components/deals/business-docs-section.tsx";

describe("書類タブの業務書類(段5a・5b・5c)", () => {
  it("書類タブに出せる書類を並べる(判定はサーバーの一覧表)", () => {
    expect(read("src/components/deals/deal-documents-panel.tsx")).toContain("<BusinessDocsSection dealId={dealId} active={active} refresh={tick} onIssued={reload} />");
    const src = read(SECTION);
    expect(src).toContain("dealsApi.availableDocuments(dealId)");
    expect(src).toContain("d.missing.length");
  });
  it("出す前の確認: 空欄の一覧・「入力に戻る」「空欄のまま出す」", () => {
    const src = read(SECTION);
    expect(src).toContain("入力に戻る");
    expect(src).toContain('missing.length ? "空欄のまま出す" : "発行する"');
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
    for (const g of ['{ key: "contract", label: "契約・媒介の書類" }', '{ key: "settlement", label: "決済の書類" }', '{ key: "other", label: "そのほかの書類" }', '{ key: "oc", label: "OC の書類" }']) expect(src).toContain(g);
    expect(src).toContain("docs.filter((d) => d.group === g.key)");
  });
  it("売主様あてのご案内: 諸費用の行を直す・足す・消す、行がそろうまで押せない", () => {
    const src = read(SECTION);
    expect(src).toContain('doc.docType === "settlement_guide_seller"');
    expect(src).toContain("諸費用の行を足す");
    expect(src).toMatch(/costRows\.every\(costRowOk\)/);
    expect(src).toContain("costs: costRows.map((r) => ({ label: r.label.trim(), amount: Number(r.amount.replace(/,/g, \"\")) }))");
  });
  it("書類確認書のまとまりと、持参する金額ごとの払い方の選択(段5c-1)", () => {
    const src = read(SECTION);
    expect(src).toContain('{ key: "checklist", label: "書類確認書" }');
    expect(src).toMatch(/\(choices\.payItems \?\? \[\]\)\.map/);
    expect(src).toMatch(/\(choices\.payMethods \?\? \[\]\)\.map/);
    expect(src).toMatch(/set\("pay", \{ \.\.\.pay, \[it\.value\]: e\.target\.value \}\)/);
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
  it("項目の表のある書類は共通の部品で描き、「すべて空欄に戻す」を一番上に置く(第2段階 段B)", () => {
    const src = read(SECTION);
    expect(src).toContain("<DocFormFields form={doc.form} values={values} onChange={set} />");
    // 全部空欄に戻しても、選んでいるタブ(媒介契約書の型など)はそのまま(第2段階 段D)
    expect(src).toContain("setValues(clearFormValues(doc.form, values))");
    expect(src.indexOf("すべて空欄に戻す")).toBeLessThan(src.indexOf("<DocFormFields"));
    expect(read("src/lib/deals/client.ts")).toContain("form: FormDef | null;");
    expect(read("src/app/api/deals/[id]/documents/available/route.ts")).toContain("form: d.form ?? null,");
  });
  it("発行の小窓の入力を控え、戻ったら続きから・発行したら消す(第2段階 §3.2)", () => {
    const src = read(SECTION);
    expect(src).toContain("const restored = useRestoredDraft(draftKeyValue, parseDealDocumentDraft);");
    expect(src).toContain("useDraftAutosave(draftKeyValue, draftData, isEmpty, restored)");
    // 古い控えは、今の書式に合わない項目だけ初めの値に戻して続きから(書式が変わった後の 422 を防ぐ・2026-10-30)
    expect(src).toContain("restoredValuesOf(doc, restored?.data.values, initial)");
    expect(src).toContain("fitFormValues(doc.form, saved, initial as FormValues)");
    expect(src).toContain("書式が新しくなったため、前回の入力の一部を読み込めませんでした。");
    // 発行に成功したら控えを消してから閉じる(次に開くと前回の発行の入力が初めの値・帯は出ない)
    expect(src).toMatch(/draft\.close\(\);\s*onDone\(/);
    expect(src).toContain("<DraftRestoredNotice");
    expect(src).toContain('<DraftTooLargeNotice kind="input" />');
    // 書類ボタンに「入力の途中」
    expect(src).toContain("useDraftExists(dealDocumentDraftKey(dealId, d.docType))");
    expect(src).toContain("(入力の途中)");
  });
  it("媒介契約書は、選んだ依頼の内容で「依頼者」の空欄の知らせを作り直す(第2段階 段D・最終レビュー)", () => {
    const src = read(SECTION);
    expect(src).toContain('doc.docType === "mediation"');
    expect(src).toContain('(choices.clientMissing ?? []).some((c) => c.value === (values.requestKind === "purchase" ? "buyer" : "seller"))');
  });
  it("両手の取引: 依頼の内容・宛先を切り替えたら、その分の前回の入力(無ければ初めの値)に入れ替える(発注者決定 2026-10-29)", () => {
    const src = read(SECTION);
    expect(src).toContain("doc.rememberBy === k && typeof v === \"string\" ? doc.starts?.[v] : undefined");
    expect(read("src/lib/deals/client.ts")).toContain("starts: Record<string, Record<string, unknown>> | null;");
    expect(read("src/app/api/deals/[id]/documents/available/route.ts")).toContain("rememberBy: d.rememberBy?.key ?? null,");
  });
  it("空欄の選択肢の出方の説明は書類ごと(□ で出す/丸を付けずに出す・2026-10-30)", () => {
    const src = read(SECTION);
    expect(src).toContain('doc.form.blankStyle === "plain"');
    expect(src).toContain("選ばなかった項目は丸を付けずに(書き込み欄は下線のまま)出ます");
    expect(src).toContain("選ばなかった項目は □ を並べた空欄で出ます");
  });
  it("準備チェックリストは種類を選ぶまで発行できない(第2段階 段C)", () => {
    const src = read(SECTION);
    expect(src).toContain('doc.docType === "prep_checklist"');
    expect(src).toContain('aria-label="準備チェックリストの種類"');
    expect(src).toContain("(choices.kind ?? [])");
    expect(src).toContain('(doc.docType === "prep_checklist" && !str(values.kind))');
    // 種類はこの小窓で選ぶので、選んだら出す前の確認から「物件の種別」を外す(最終レビュー)
    expect(src).toContain('doc.missing.filter((m) => m !== "物件の種別" || !str(values.kind))');
  });
  it("契約のご案内・取引完了確認書の入力欄(第2段階 段A)", () => {
    const src = read(SECTION);
    expect(src.indexOf('{ key: "contract", label: "契約・媒介の書類" }')).toBeLessThan(src.indexOf('{ key: "settlement", label: "決済の書類" }'));
    expect(src).toContain('doc.docType === "contract_guide"');
    expect(src).toContain('aria-label="宛先"');
    expect(src).toContain("(choices.addressee ?? [])");
    expect(src).toContain('aria-label="ご連絡事項"');
    expect(src).toContain('doc.docType === "completion_confirmation"');
    expect(src).toContain('aria-label="引き渡した書類など"');
    // 文字数の上限は、書類確認書の項目から作る初めの値が入る長さ(@codex)
    expect(src.match(/maxLength=\{CHECKLIST_TEXT_MAX\}/g)?.length).toBe(2);
    // 宛先を選び直したら、出す前の確認もその宛先で見る(@codex)
    expect(src).toContain("(choices.addresseeMissing ?? []).filter((c) => c.value === values.addressee)");
    expect(src).toContain('{missing.length ? "空欄のまま出す" : "発行する"}');
    expect(src).not.toContain('{doc.missing.length ? "空欄のまま出す" : "発行する"}');
    expect(read("src/lib/deals/client.ts")).toContain('group: "contract" | "settlement" | "other" | "oc" | "checklist";');
  });
});

/**
 * 画面すっきり化 第4回 D(発注者決定 2026-10-16): 受付帳の取り込みを1画面に・受付帳は1回だけ入れる。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const src = read("src/app/(dashboard)/import/page.tsx");

describe("受付帳CSV取込: 受付帳は1回だけ入れる", () => {
  it("受付帳の枠は1つ(共通の欄)で、①②の両方へ同じファイルを渡す", () => {
    // 2026-10-28: ファイルを入れる枠は「ファイルを入れる」1つにまとめた=ここは入れた受付帳を見せる欄が1つ。
    expect(src.match(/<HandedFileSlot fileLabel=\{rpFile\?\.name \?\? receptionFile\?\.name \?\? null\} \/>/g) ?? []).toHaveLength(1);
    expect(src).toContain('data-testid="reception-shared"');
    expect(src).toMatch(/const entry = \{ name: file\.name, csvText: buf\.csvText, xlsxBase64: buf\.xlsxBase64 \};\s*setRpFile\(entry\);\s*setReceptionFile\(entry\);/);
    // 「ファイルを入れる」から持ってきた受付帳は、①②の両方へ同じものを入れる(下見は捨てる)。
    expect(src).toContain("handedReception ?? s0?.ro?.receptionFile ?? (handedOwner ? recallReception() : null)");
    expect(src).toContain("handedReception ?? s0?.rp?.rpFile ?? null");
    expect(src).toContain("handedReception ? null : ((s0?.rp?.rpPreview as never) ?? null)");
    expect(src).toContain("roReplaced ? null : ((s0?.ro?.roPreview as never) ?? null)");
  });
  it("受付帳を入れ直したら①②の下見・結果を捨てる", () => {
    const at = src.indexOf("const handleReceptionFile = async (");
    const body = src.slice(at, at + 700);
    for (const set of ["setRpPreview(null);", "setRpResult(null);", "setRoPreview(null);", "setRoResult(null);"]) {
      expect(body).toContain(set);
    }
  });
  it("取込条件は1組だけで、変えたら①②の両方に効かせて下見を捨てる", () => {
    expect(src.match(/取込物件選択（DL）/g) ?? []).toHaveLength(1);
    expect(src).toMatch(/const changeDlFilter = \(v: "marked" \| "unmarked" \| "all"\) => \{\s*setRpDlFilter\(v\);\s*setDlFilter\(v\);\s*setRpPreview\(null\);\s*setRoPreview\(null\);/);
    expect(src).toMatch(/const changeShinkiFilter = \(v: "existing" \| "new" \| "all"\) => \{\s*setRpShinkiFilter\(v\);\s*setShinkiFilter\(v\);\s*setRpPreview\(null\);\s*setRoPreview\(null\);/);
  });
  it("②は所有者ファイルだけを入れる(着地点の id は残す)", () => {
    expect(src).toContain('id="owner-match"');
    // 所有者ファイルは「ファイルを入れる」の「所有者の突合へ」で持ってくる(2026-10-28)。
    expect(src).toContain("<HandedFileSlot fileLabel={ownerFile?.name ?? null} onClear={() => void handleOwnerFile(null)} />");
    expect(src).toContain("handedOwner ?? s0?.ro?.ownerFile ?? null");
    expect(src).toContain("onClick={handleOwnerClear}");
  });
  it("控えから戻すときは①②を1つのファイル・条件にそろえる", () => {
    expect(src).toContain("const s0 = unifyReceptionDraft(restoreDecision.start);");
  });
  it("画面に出ない古い取り込み手順は消した(hidden の塊・main の流れ)", () => {
    expect(src).not.toContain('<div className="hidden">');
    expect(src).not.toContain("importCsv(");
    expect(src).toContain("main: null,");
  });
});

describe("旧 登記DM取込 = 取得済みPDFを一括添付", () => {
  it("名前を変え、PDFの一括添付だけを残す(URL は据え置き)", () => {
    const dm = read("src/app/(dashboard)/import/registry-dm/page.tsx");
    expect(dm).toContain('<PageHeader title="取得済みPDFを一括添付" />');
    expect(dm).toContain("data-pii-protected");
    expect(read("src/components/layout/sidebar-model.tsx")).toContain('{ label: "取得済みPDFを一括添付", href: "/import/registry-dm"');
    expect(read("src/components/import/import-switcher.tsx")).toContain('{ href: "/import/registry-dm", label: "取得済みPDFを一括添付"');
  });
});

describe("②へ直接着いたとき(メニューの所有者CSV取込=/import#owner-match・@codex #523 P2)", () => {
  it("受付帳が無ければ理由と上の欄へのリンクを出す", () => {
    expect(src).toContain('id="reception-shared"');
    const at = src.indexOf('id="owner-match"');
    const owner = src.slice(at);
    expect(owner).toMatch(/\{!receptionFile && \(\s*<p\s+data-testid="owner-match-needs-reception"/);
    expect(owner).toContain('href="#reception-shared"');
  });
});

describe("①が済んだあと戻ったとき(@codex #523 P2)", () => {
  it("②の控えの受付帳を①へ戻さない(①がもう一度押せる形にしない)", () => {
    // 「ファイルを入れる」から持ってきた受付帳だけは①にも入れる(新しく入れたファイル=①を押してよい)。
    expect(src).toMatch(/\} \| null>\(handedReception \?\? s0\?\.rp\?\.rpFile \?\? null\);/);
    expect(src).not.toContain("s0?.rp?.rpFile ?? s0?.ro?.receptionFile");
  });
  it("①に、受付帳は②のために残していると出す", () => {
    expect(src).toMatch(/\{!rpFile && receptionFile && \(\s*<p\s+data-testid="rp-reception-kept-for-owner"/);
  });
});

describe("②が済んだあと戻ったとき(@codex #523 P2・①と対称)", () => {
  it("①の控えの受付帳を②へ渡さず、②に「①のために残している」と出す", () => {
    // 覚えておいた受付帳(recallReception)は②自身の受付帳(receptionFile)だけ=①の控えからは作らない。
    expect(src).toContain("} | null>(handedReception ?? s0?.ro?.receptionFile ?? (handedOwner ? recallReception() : null));");
    expect(src).toMatch(/useEffect\(\(\) => \{\s*rememberReception\(receptionFile\);\s*\}, \[receptionFile\]\);/);
    const at = src.indexOf('data-testid="owner-match-needs-reception"');
    expect(src.slice(at, at + 900)).toContain("上の受付帳は①（物件を作る）のために残しています。");
  });
});

describe("片方の控えだけが戻っても取込条件は1組のまま", () => {
  it("①②の条件の state は互いの控えから補う(画面の1組と②の取り込みがずれない)", () => {
    expect(src).toContain('(s0?.ro?.dlFilter ?? s0?.rp?.rpDlFilter ?? "marked")');
    expect(src).toContain('(s0?.ro?.shinkiFilter ?? s0?.rp?.rpShinkiFilter ?? "existing")');
    expect(src).toContain('(s0?.rp?.rpDlFilter ?? s0?.ro?.dlFilter ?? "marked")');
    expect(src).toContain('(s0?.rp?.rpShinkiFilter ?? s0?.ro?.shinkiFilter ?? "existing")');
  });
});

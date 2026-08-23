/**
 * UI一貫性 第3弾 (発注者承認 2026-08-23) の再発防止走査。
 *  ⑪ モーダルの器は ModalShell/ConfirmDialog・タブ行は Tabs
 *  フッタ間隔は justify-end gap-2 のみ(gap-3/4 揺れの再発防止)
 *
 * ラチェット方式: 既存の手書きは理由付き allow-list(順次移行待ち)で許し、
 * **新しいファイルに手書きを足すとファイル名指しで落ちる**。
 * allow-list から消す(=移行する)ことはいつでも歓迎・足すには理由が要る。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = [join(process.cwd(), "src", "app"), join(process.cwd(), "src", "components")];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "__tests__") continue;
      walk(full, out);
    } else if (/\.tsx$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}
const files = ROOTS.flatMap((r) => walk(r));
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const rel = (p: string) => relative(process.cwd(), p).replace(/\\/g, "/");

/**
 * ファイル中の文字列リテラルをトークン集合の列にして返す
 * (@codex #406 R2/R5/R6/R7 P2)。
 * - Tailwind のクラスは順序が意味を持たない→隣接部分文字列の一致は並べ替えで素通り
 * - className="…" 限定だと {"…"}(brace包み)等の書き方で素通り
 * - リテラル単位だと clsx("fixed", x && "inset-0") のような**分割合成**で素通り
 * → `…`(複数行可)は1式=1集合、それ以外は**同一行内の "…"/'…' を合算して1集合**
 *   にする(1行に収まる合成はどんな書き方でも捕まる)。
 * ⚠検出境界: **複数行に分けた合成**(clsx の引数を改行で分ける等)はこの走査の
 *   保証外=コードレビューで見る。ここは「うっかりの逆行」を止めるラチェットで
 *   あり、静的解析の完全性は主張しない。${...} は除いて静的トークンだけを見る。
 */
function classTokenSets(src: string): string[][] {
  const out: string[][] = [];
  const push = (text: string) => {
    const tokens = text
      .replace(/\$\{[^}]*\}/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    if (tokens.length > 0) out.push(tokens);
  };
  // 複数行に渡り得る `…` は先に1式ずつ回収し、残りから消す
  const rest = src.replace(/`([^`]*)`/g, (_all, body: string) => {
    push(body);
    return '""';
  });
  // 残りは行ごとに "…"/'…' の中身を合算(同一行の合成を1集合として見る)
  for (const line of rest.split("\n")) {
    const tokens: string[] = [];
    const re = /"([^"]*)"|'([^']*)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      tokens.push(
        ...(m[1] ?? m[2] ?? "").split(/\s+/).filter(Boolean),
      );
    }
    if (tokens.length > 0) out.push(tokens);
  }
  return out;
}

describe("(⑪) モーダルの器の手書き禁止(ラチェット)", () => {
  it("fixed inset-0 の overlay は ModalShell 経由か、理由付き allow-list のみ", () => {
    const ALLOW = new Set([
      // ⚠器(modal-shell)はネイティブ <dialog> 化で fixed inset-0 を持たなくなった
      //   ため allow 不要(@codex #406 R2)。
      // モーダルではないもの
      "src/components/screen-protection/watermark-overlay.tsx", // 透かし(全画面装飾)
      "src/components/layout/sidebar.tsx", // モバイルドロワー
      // 写真の拡大表示(lightbox)= 黒背景の画像ビューア(器の規約対象外)
      "src/components/properties/photo-tab.tsx",
      "src/components/properties/attachment-tab.tsx",
      "src/components/buildings/building-photo-tab.tsx",
      "src/components/sales-sheet/editor/PhotoGalleryPanel.tsx",
      // ── 以下は既存モーダル(順次 ModalShell へ移行待ち)。新規追加は不可 ──
      "src/app/(dashboard)/admin/users/page.tsx",
      "src/app/(dashboard)/buildings/page.tsx",
      "src/app/(dashboard)/buildings/[id]/page.tsx",
      "src/app/(dashboard)/import/jobs/[jobId]/page.tsx",
      "src/components/field-survey/convert-pin-to-property-modal.tsx",
      "src/components/field-survey/location-consent-notice.tsx",
      "src/components/field-survey/pin-create-modal.tsx",
      "src/components/field-survey/trip-controls.tsx",
      "src/components/owners/owner-link-modal.tsx",
      "src/components/owners/OwnerMislinkModal.tsx",
      "src/components/properties/dm-batch-confirm-modal.tsx",
      "src/components/properties/new-property-modal.tsx",
      "src/components/properties/property-edit-form.tsx",
      "src/components/properties/registry-bulk-fetch-button.tsx",
      "src/components/properties/registry-live-panel.tsx",
      "src/components/sales-sheet/editor/TransactionInfoDialog.tsx",
      "src/components/sales-sheet/SalesSheetCreateButton.tsx",
    ]);
    // ⚠隣接一致(includes("fixed inset-0"))は「fixed z-50 inset-0」等の並べ替えで
    //   素通りする(@codex #406 R5 P2)→ トークン集合で fixed と inset-0 の同居を見る。
    const offenders = files.filter(
      (f) =>
        classTokenSets(read(f)).some(
          (tokens) => tokens.includes("fixed") && tokens.includes("inset-0"),
        ) && !ALLOW.has(rel(f)),
    );
    expect(
      offenders.map(rel),
      "手書きの overlay が増えた(ModalShell/ConfirmDialog を使う)",
    ).toEqual([]);
  });

  it("モーダルフッタの間隔は gap-2 のみ(gap-3/4 の揺れを戻さない)", () => {
    // ⚠隣接一致は Tailwind のクラス**順序**に依存し「justify-end items-center gap-3」
    //   「gap-3 justify-end」が素通りする(@codex #406 R2 P2。提出前レビューP1で
    //   一度緩めたが、まだ順序依存だった)→ className 文字列をトークン分解して
    //   「justify-end と gap-N(N≠2) が同居」を順序に関係なく検出する。
    const offenders: string[] = [];
    for (const f of files) {
      for (const tokens of classTokenSets(read(f))) {
        if (
          tokens.includes("justify-end") &&
          tokens.some((t) => /^gap-(?!2$)\d/.test(t))
        ) {
          offenders.push(`${rel(f)}: ${tokens.join(" ").slice(0, 60)}`);
        }
      }
    }
    expect(offenders, "justify-end の gap が 2 以外").toEqual([]);
  });

  it("削除確認4箇所は ConfirmDialog を使っている(逆行防止)", () => {
    for (const f of [
      "src/components/properties/photo-tab.tsx",
      "src/components/properties/attachment-tab.tsx",
      "src/components/buildings/building-photo-tab.tsx",
      "src/app/(dashboard)/admin/templates/page.tsx",
    ]) {
      expect(
        readFileSync(join(process.cwd(), f), "utf8"),
        `${f} が ConfirmDialog を使っていない`,
      ).toContain('from "@/components/ui/confirm-dialog"');
    }
  });
});

describe("(⑪) タブ行の手書き禁止(ラチェット)", () => {
  it("border-b-2 のタブ行は Tabs 経由か、理由付き allow-list のみ", () => {
    const ALLOW = new Set([
      "src/components/ui/tabs.tsx", // 部品そのもの
      // 既存の大型・特殊タブ(順次移行待ち)。新規追加は不可。
      "src/app/(dashboard)/properties/[id]/page.tsx", // 物件詳細の主タブ(件数バッジ+権限出し分けの大物)
      "src/app/(dashboard)/import/registry-pdf/page.tsx", // 取込方式の切替(ウィザード冒頭)
      "src/components/import/import-switcher.tsx", // 取込トップの方式切替
    ]);
    const offenders = files.filter(
      (f) => read(f).includes("border-b-2") && !ALLOW.has(rel(f)),
    );
    expect(offenders.map(rel), "手書きのタブ行が増えた(Tabs を使う)").toEqual([]);
  });

  it("移行済み4画面は Tabs を使っている(逆行防止)", () => {
    for (const f of [
      "src/app/(dashboard)/admin/owners/quality-audit/page.tsx",
      "src/app/(dashboard)/admin/owners/correction/page.tsx",
      "src/app/(dashboard)/admin/postal-code-audit/page.tsx",
      "src/app/(dashboard)/admin/display-name-audit/page.tsx",
    ]) {
      expect(
        readFileSync(join(process.cwd(), f), "utf8"),
        `${f} が Tabs を使っていない`,
      ).toContain('from "@/components/ui/tabs"');
    }
  });

  it("移行済み4画面はパネル側も tabPanelProps で紐付けている(@codex #406 R3 P2)", () => {
    for (const f of [
      "src/app/(dashboard)/admin/owners/quality-audit/page.tsx",
      "src/app/(dashboard)/admin/owners/correction/page.tsx",
      "src/app/(dashboard)/admin/postal-code-audit/page.tsx",
      "src/app/(dashboard)/admin/display-name-audit/page.tsx",
    ]) {
      expect(
        readFileSync(join(process.cwd(), f), "utf8"),
        `${f} が tabPanelProps を使っていない`,
      ).toContain("{...tabPanelProps(");
    }
  });
});

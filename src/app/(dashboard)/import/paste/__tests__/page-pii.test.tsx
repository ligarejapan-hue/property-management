/**
 * 「貼り付けて物件化」画面の PII 保護（@codex PR#414 3巡目）。
 *
 * ScreenProtectionGuard は `[data-pii-protected]` の**内側でしか**
 * コピー・右クリック・印刷を抑止・監査しない。この画面は
 *   ・貼った原文（＝資料まるごと）
 *   ・所有者の氏名・住所・電話・メール
 * が同じ画面に並ぶ＝この機能でいちばん個人情報が濃い。兄弟の取込画面3つ
 * （import / import/registry-dm / import/jobs/[jobId]）は全て印が付いており、
 * この画面だけが保護の外に居た。
 *
 * ⚠**属性が「どこかに在る」だけのテストにしない**。入れ物を間違えると
 *   （例: 貼り付け欄の section にだけ付ける）、外に出た部分は無防備なまま
 *   テストは緑になる。ここでは「**最上位の入れ物**に付いている」ことと
 *   「原文の表示と所有者の欄がその内側にある」ことを見る。
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PasteImportReview } from "@/components/import/paste-import-review";
import { buildPasteDraft } from "@/lib/paste-import/build-draft";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/import/paste",
  useSearchParams: () => new URLSearchParams(),
}));

import PasteImportPage from "../page";

const dir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(dir, "../page.tsx"), "utf8");

const html = renderToStaticMarkup(createElement(PasteImportPage));

/** return( の直後に現れる最初の JSX タグ（＝この画面の最上位の入れ物）。 */
function firstTagOfReturn(src: string): string {
  const at = src.indexOf("\n  return (");
  expect(at).toBeGreaterThanOrEqual(0);
  const tag = /<[A-Za-z][^>]*>/.exec(src.slice(at));
  expect(tag).not.toBeNull();
  return tag![0];
}

describe("画面の最上位の入れ物が PII 保護対象になっている", () => {
  it("★描画した結果の**根っこの要素**が data-pii-protected を持つ", () => {
    // 内側の要素に付け替えると、根っこは素の <div> になり落ちる。
    expect(html.startsWith("<div data-pii-protected")).toBe(true);
    expect(html).toContain('data-pii-surface="import"');
  });

  it("★貼り付け欄が保護領域の内側にある（印より後ろに出る）", () => {
    const protectedAt = html.indexOf("data-pii-protected");
    const textareaAt = html.indexOf('id="paste-raw-text"');
    expect(protectedAt).toBeGreaterThanOrEqual(0);
    expect(textareaAt).toBeGreaterThan(protectedAt);
    // 保護領域は画面の最後まで続く（途中で閉じて残りが外に出ていない）。
    expect(html.trimEnd().endsWith("</div>")).toBe(true);
  });

  it("★兄弟の取込画面と同じ書き方（data-pii-surface=\"import\"）", () => {
    const siblings = [
      "../../page.tsx",
      "../../registry-dm/page.tsx",
    ].map((rel) => readFileSync(join(dir, rel), "utf8"));
    for (const sib of siblings) {
      expect(sib).toContain('data-pii-protected data-pii-surface="import"');
    }
    expect(source).toContain('data-pii-protected data-pii-surface="import"');
  });
});

describe("原文の表示と所有者の欄が保護領域の内側にある", () => {
  it("★確認画面(PasteImportReview)は最上位の入れ物の内側で描かれる", () => {
    // 確認画面は draft が入ってから描かれる（この env では state を動かせない）ので、
    // 「最上位の入れ物＝印の付いた要素」であることと、確認画面がその return の
    // 中で描かれていることを合わせて見る。印を内側の要素へ移すと1つ目で落ちる。
    const rootTag = firstTagOfReturn(source);
    expect(rootTag).toContain("data-pii-protected");
    expect(rootTag).toContain('data-pii-surface="import"');

    const rootAt = source.indexOf(rootTag);
    const reviewAt = source.indexOf("<PasteImportReview");
    const textareaAt = source.indexOf('id="paste-raw-text"');
    expect(reviewAt).toBeGreaterThan(rootAt);
    expect(textareaAt).toBeGreaterThan(rootAt);
  });

  it("★その確認画面が実際に原文と所有者の欄を描いている（守る中身があることの裏取り）", () => {
    const draft = buildPasteDraft(
      "■物件所在地： 東京都A区B1-2-3\n■お名前： 山田太郎\n■電話番号： 09012345678",
    );
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, {
        draft,
        rawText: "■お名前： 山田太郎\n■電話番号： 09012345678",
      }),
    );
    // 原文の表示
    expect(out).toContain("貼った原文");
    expect(out).toContain("09012345678");
    // 所有者の欄
    expect(out).toContain('id="paste-field-owner-name"');
    expect(out).toContain('id="paste-field-owner-phone"');
  });
});

// ===========================================================================
// @codex PR#414 6巡目 ①②③ の画面側の配線。
// ⚠env=node では state を動かせないため、**呼び出しの記述そのもの**を走査して
//   固定する（「id があること」だけを見る空振りにしない）。
// ===========================================================================

describe("査定ナンバーと重複の見直しが画面に配線されている", () => {
  it("★人が直した査定ナンバーを登録に渡す（下書きの値を黙って送らない）", () => {
    // 誤った番号が保存されると、後日その番号の本物の反響が「登録済みです」で
    // 弾かれ、誤りが将来に持ち越される。
    expect(source).toContain("externalLinkKey: externalLinkKey.trim() || null,");
    expect(source).not.toContain("externalLinkKey: draft.externalLinkKey,");
  });

  it("★査定ナンバーの欄を確認画面へ渡している", () => {
    expect(source).toContain("externalLinkKey={externalLinkKey}");
    expect(source).toContain("onExternalLinkKeyChange={setExternalLinkKey}");
  });

  it("★直したあとの見直しを、専用の口へ投げている", () => {
    expect(source).toContain('fetch("/api/import/paste/recheck"');
    // 見直しの結果で警告の状態を差し替えていること（受け取って捨てていない）。
    for (const setter of ["setDuplicates(data.duplicates)", "setSimilar(data.similar)", "setOwnerCandidates(data.ownerCandidates)"]) {
      expect(source).toContain(setter);
    }
    // 欄を直し終えたときに起きること。
    expect(source).toContain("onDuplicateInputBlur={");
  });

  it("★登録の直前にもう一度見直し、止まっていたら送らない", () => {
    // 欄を直した直後にそのまま登録を押される経路がある。
    expect(source).toContain("const latest = await recheckDuplicates();");
    expect(source).toContain("if (latest.duplicates.blocked)");
  });

  it("★見直しに失敗したら、その旨を画面に出す（黙って古い判定のままにしない）", () => {
    expect(source).toContain("setRecheckError(");
    expect(source).toContain("recheckError={recheckError}");
  });
});

describe("登録直前の再判定は、結果を全部見る（7巡目 ②）", () => {
  it("★再判定に失敗したら登録に進まない（確認できなかったのに通すのは、確認しないより悪い）", () => {
    expect(source).toContain("if (latest === null)");
    // 失敗を握り潰して先へ進む書き方（`latest?.` だけを見る形）に戻っていないこと。
    expect(source).not.toContain("if (latest?.duplicates.blocked)");
  });

  it("★似た物件・所有者候補が増減したら、人に見せてから確定させる", () => {
    expect(source).toContain("const beforeSimilar = similar.map((x) => x.id).sort().join(\",\");");
    expect(source).toContain("const beforeOwners = ownerCandidates.map((x) => x.id).sort().join(\",\");");
    expect(source).toContain("const afterSimilar = latest.similar.map((x) => x.id).sort().join(\",\");");
    expect(source).toContain("const afterOwners = latest.ownerCandidates.map((x) => x.id).sort().join(\",\");");
    expect(source).toContain("if (afterSimilar !== beforeSimilar || afterOwners !== beforeOwners)");
    expect(source).toContain("似ている物件／所有者が見つかりました");
  });

  it("★止めた3つの経路は、それぞれ別の文言で伝える（どれで止まったか分かる）", () => {
    for (const msg of [
      "重複の確認ができませんでした。通信の状態を確かめて",
      "この案件は登録済みです",
      "入力の変更により、似ている物件／所有者が見つかりました",
    ]) {
      expect(source).toContain(msg);
    }
  });

  it("★止める判断は、登録APIを呼ぶ前に行う（送ってから気づくのでは遅い）", () => {
    const stopAt = source.indexOf("if (afterSimilar !== beforeSimilar");
    const postAt = source.indexOf('fetch("/api/import/paste/commit"');
    expect(stopAt).toBeGreaterThanOrEqual(0);
    expect(postAt).toBeGreaterThan(stopAt);
  });

  it("★変化を見るための値が依存に入っている（古い値と比べ続けない）", () => {
    const deps = source.slice(source.indexOf("externalLinkKey, recheckDuplicates,"));
    expect(deps.slice(0, 200)).toContain("similar");
    expect(deps.slice(0, 200)).toContain("ownerCandidates");
  });
});

describe("link モードの再判定と、見えない紐付けの排除（8巡目 ①）", () => {
  it("★link のときも氏名で引き直す（空で送って候補を消さない）", () => {
    // 空で送ると候補ゼロが返り、画面から選択肢が消えるのに linkedOwnerId は残る。
    expect(source).toContain('ownerName: ownerMode === "none" ? "" : (ownerValues?.name ?? ""),');
    expect(source).not.toContain('ownerName: ownerMode === "new" ? (ownerValues?.name ?? "") : "",');
  });

  it("★選んでいた相手が候補から消えたら、紐付けも必ず外す", () => {
    expect(source).toContain("!data.ownerCandidates.some((c) => c.id === linkedOwnerId)");
    expect(source).toContain("選んでいた所有者が候補から外れました");
    // 外すのは「理由を出すだけ」ではなく、選択そのもの。
    const at = source.indexOf("!data.ownerCandidates.some((c) => c.id === linkedOwnerId)");
    expect(source.slice(at, at + 300)).toContain("setLinkedOwnerId(null)");
  });

  it("★登録の直前にも、選択が候補に残っているか確かめてから送る", () => {
    expect(source).toContain("!latest.ownerCandidates.some((c) => c.id === linkedOwnerId)");
    const at = source.indexOf("!latest.ownerCandidates.some((c) => c.id === linkedOwnerId)");
    const postAt = source.indexOf('fetch("/api/import/paste/commit"');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(postAt).toBeGreaterThan(at);
    expect(source.slice(at, at + 300)).toContain("setLinkedOwnerId(null)");
  });

  it("★link のまま相手が未選択なら、そもそも登録に進まない", () => {
    expect(source).toContain('if (ownerMode === "link" && !linkedOwnerId)');
    expect(source).toContain("紐付ける所有者が選ばれていません");
  });

  it("★選択の有無を見るための値が依存に入っている", () => {
    expect(source).toContain('externalLinkKey, linkedOwnerId]');
  });
});

describe("備考の生値は、専用欄に値を入れたら取り除いてから送る（11巡目 ②）", () => {
  it("★stripFilledRawLines を通したうえで畳み込んでいる（順序も含めて）", () => {
    expect(source).toContain("stripFilledRawLines(");
    const stripAt = source.indexOf("const noteWithoutFilledRaw = stripFilledRawLines(");
    const foldAt = source.indexOf("foldNoColumnFieldsIntoNote(noteWithoutFilledRaw,");
    expect(stripAt).toBeGreaterThanOrEqual(0);
    expect(foldAt).toBeGreaterThan(stripAt);
  });

  it("★取り除きに使うのは下書きの unreadable と、人が直した値", () => {
    const at = source.indexOf("const noteWithoutFilledRaw = stripFilledRawLines(");
    const block = source.slice(at, at + 200);
    expect(block).toContain("draft.unreadable");
    expect(block).toContain("propertyValues");
  });

  it("★取り除いた結果を登録に渡している（畳み込む前の note を送っていない）", () => {
    expect(source).toContain("note: finalNote || null,");
  });
});

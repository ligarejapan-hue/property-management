/**
 * 売却DM の書き込み tx が守るロック順序（設計 2026-08-08-sale-dm-external-paste-design.md §2.3）:
 *   Owner(代表所有者) → variant → 物件親行 → 子行(draft)
 *
 * ⚠混在するとデッドロックする。PR-D2 で新設する「貼り付け／適用」は凍結判定のために
 * variant を先に掴むため、既存経路が draft を先に掴んだままだと互いに待ち合う。
 * SQL の出現順をソースで固定する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

function src(p: string) {
  return readFileSync(path.resolve(process.cwd(), p), "utf-8");
}

/**
 * コメント行を落としたソース。
 * ⚠ロックの有無を素の本文で走査すると、**コメントアウトされたロック**を「有る」と
 * 誤判定する(`// await tx.$queryRaw\`… FOR UPDATE\`` が正規表現に当たる)。
 * 順序を見るテストは必ずこちらを使う(位置の比較は同じ文字列の中で完結するので影響なし)。
 */
function code(p: string) {
  return src(p)
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

describe("型の設定変更(variant PATCH)のロック順序", () => {
  const s = src(
    "src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/route.ts",
  );

  it("variant 行を FOR UPDATE でロックする", () => {
    expect(s).toMatch(/FROM dm_variants[\s\S]{0,160}FOR UPDATE/);
  });

  it("variant のロックが draft のロックより先に来る", () => {
    const v = s.search(/FROM dm_variants[\s\S]{0,160}FOR UPDATE/);
    const d = s.search(/FROM dm_recipient_drafts[\s\S]{0,160}FOR UPDATE/);
    expect(v).toBeGreaterThan(-1);
    expect(d).toBeGreaterThan(-1);
    expect(v).toBeLessThan(d);
  });
});

describe("宛先の確定(drafts/confirm)のロック順序", () => {
  const s = src("src/app/api/properties/sale-dm/drafts/confirm/route.ts");

  it("所有者 → variant → 物件親行 の順にロックを取る", () => {
    const o = s.indexOf("lockOwnersForShare");
    const v = s.search(/FROM dm_variants[\s\S]{0,200}FOR UPDATE/);
    const p = s.search(/FROM properties[\s\S]{0,200}FOR UPDATE/);
    expect(o).toBeGreaterThan(-1);
    expect(v).toBeGreaterThan(o);
    expect(p).toBeGreaterThan(v);
  });

  it("子行(draft)のロックは最後で、その後に読み直す(先読みの値で確定しない)", () => {
    const v = s.search(/FROM dm_variants[\s\S]{0,200}FOR UPDATE/);
    const d = s.search(/FROM dm_recipient_drafts[\s\S]{0,200}FOR UPDATE/);
    expect(d).toBeGreaterThan(v);
    // ロックの後に読み直し、その値で本文を検査していること。
    // ⚠距離窓(`[\s\S]{0,N}`)で書くと、間に1行足すだけで落ちる(PR-C の教訓)。
    //   出現位置の前後関係だけを見る。
    const reread = s.indexOf("findMany", d);
    const validate = s.indexOf("validateLetterBody", reread);
    expect(reread).toBeGreaterThan(d);
    expect(validate).toBeGreaterThan(reread);
  });

  it("field_staff のときだけ物件親行を取る(admin/office は不要)", () => {
    expect(s).toMatch(
      /field_staff[\s\S]{0,500}FROM properties[\s\S]{0,200}FOR UPDATE/,
    );
  });

  it("ロック後に担当範囲を再検証する(ロック前の判定だけで確定しない)", () => {
    const p = s.search(/FROM properties[\s\S]{0,200}FOR UPDATE/);
    expect(p).toBeGreaterThan(-1);
    expect(s.slice(p)).toMatch(/assignedTo/);
  });
});

describe("型の割当(assign)のロック順序", () => {
  const s = src("src/app/api/properties/sale-dm/campaigns/[id]/assign/route.ts");

  // ⚠割当は draft の variantId を書き換える=PostgreSQL が参照先の型行に
  //   KEY SHARE ロックを**後から**取る。確定側が型を先に掴むため、割当が
  //   「draft を持って型を待つ」状態になり両者が止まる(@codex #375)。
  it("updateMany の前に型行を FOR UPDATE でロックする", () => {
    const v = s.search(/FROM dm_variants[\s\S]{0,200}FOR UPDATE/);
    // ⚠コメント中の updateMany を拾わないよう、実際の呼び出しを探す。
    const u = s.indexOf("tx.dmRecipientDraft.updateMany");
    expect(v).toBeGreaterThan(-1);
    expect(u).toBeGreaterThan(-1);
    expect(v).toBeLessThan(u);
  });

  it("移動元の型もロック対象に含める(@codex #376 R4)", () => {
    // 確定済みを移すときは移動元へ凍結印を立てるので、移動先だけ掴むと
    // 確定側と互い違いになって止まる。両方をまとめて id 順に取る。
    const lockAt = s.search(/FROM dm_variants[\s\S]{0,200}FOR UPDATE/);
    const before = s.slice(0, lockAt);
    expect(before).toContain("sourcesPre");
    expect(before).toMatch(/byVariant\.keys\(\)[\s\S]{0,200}sourcesPre|sourcesPre[\s\S]{0,200}byVariant\.keys\(\)/);
  });

  it("移動元の収集に状態の条件を付けない(@codex #376 R9)", () => {
    // ⚠状態から集合を作ると、先読みのあとに確定された下書きの移動元が漏れる。
    //   漏れた型へ凍結印を立てる＝ロックしていない型を更新することになり、
    //   取得順の保証が崩れる。振る舞いの実測は sale-dm-assign-route.test.ts。
    const start = s.indexOf("const sourcesPre = await");
    expect(start).toBeGreaterThan(-1);
    const query = s.slice(start, s.indexOf("});", start));
    expect(query.length).toBeGreaterThan(40); // 切り出し失敗の空振り検出
    expect(query).not.toContain("status");
  });

  it("型 id を並べ替えてから取る(取得順を全経路でそろえる)", () => {
    expect(s).toMatch(/\.sort\(\)[\s\S]{0,400}FROM dm_variants/);
  });

  // ⚠割当は担当外になった物件の宛先まで書き換え得る(:32 の scope 絞り込みは tx の外の先読み)。
  //   物件親行を掴んでから確かめ直す。順序は dm_variants → dm_lp_variants → properties
  //   (確定 drafts/confirm と同じ並び。違う並びで掴むと互い違いに待つ)。
  const c = code("src/app/api/properties/sale-dm/campaigns/[id]/assign/route.ts");

  it("dm_variants → dm_lp_variants → properties の順にロックを取る(@codex R2 P1)", () => {
    const v = c.search(/FROM dm_variants[\s\S]{0,200}FOR UPDATE/);
    const l = c.search(/FROM dm_lp_variants[\s\S]{0,200}FOR UPDATE/);
    const p = c.search(/FROM properties[\s\S]{0,200}FOR UPDATE/);
    expect(v).toBeGreaterThan(-1);
    expect(l).toBeGreaterThan(v);
    expect(p).toBeGreaterThan(l);
  });

  it("物件親行のロックは updateMany より先に来る", () => {
    const p = c.search(/FROM properties[\s\S]{0,200}FOR UPDATE/);
    const u = c.indexOf("tx.dmRecipientDraft.updateMany");
    expect(p).toBeGreaterThan(-1);
    expect(u).toBeGreaterThan(-1);
    expect(p).toBeLessThan(u);
  });

  it("ロックの下で担当範囲を読み直す(先読みの判定だけで書き換えない)", () => {
    const p = c.search(/FROM properties[\s\S]{0,200}FOR UPDATE/);
    const after = c.slice(p);
    expect(after).toContain("field_staff");
    expect(after).toMatch(/assignedTo/);
  });
});

describe("LP型の設定変更(lp-variants/[lpId] PATCH)のロック順序", () => {
  const s = code(
    "src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/route.ts",
  );

  // ⚠ラベルだけの変更は下書き行に触れない=行ロックが無いと mark-sent と直列化されず、
  //   「送付済み0件」と数えた直後の送付確定を見落とす(@codex R2 P2)。
  it("dm_lp_variants → properties → dm_recipient_drafts の順にロックを取る", () => {
    const l = s.search(/FROM dm_lp_variants[\s\S]{0,200}FOR UPDATE/);
    const p = s.search(/FROM properties[\s\S]{0,200}FOR UPDATE/);
    const d = s.search(/FROM dm_recipient_drafts[\s\S]{0,200}FOR UPDATE/);
    expect(l).toBeGreaterThan(-1);
    expect(p).toBeGreaterThan(l);
    expect(d).toBeGreaterThan(p);
  });

  it("送付済みの件数は draft 行のロックの後で数える", () => {
    const d = s.search(/FROM dm_recipient_drafts[\s\S]{0,200}FOR UPDATE/);
    const sentBefore = s.indexOf("const sentBefore");
    expect(d).toBeGreaterThan(-1);
    expect(sentBefore).toBeGreaterThan(d);
  });
});

describe("宛先の付け替え(drafts/[id] PATCH)のロック順序", () => {
  const s = code("src/app/api/properties/sale-dm/drafts/[id]/route.ts");

  // ⚠V1→V2 と V2→V1 が同時に走ると、片方ずつ掴む書き方では互い違いに待つ(@codex R2 P3)。
  it("いまの型と移動先の型を1文でまとめて id 順に掴む", () => {
    expect(s).toMatch(/FROM dm_variants WHERE id = ANY\([\s\S]{0,80}ORDER BY id FOR UPDATE/);
    const ids = s.indexOf("const variantLockIds");
    const lock = s.search(/FROM dm_variants[\s\S]{0,200}FOR UPDATE/);
    expect(ids).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(ids);
    const decl = s.slice(ids, lock);
    expect(decl).toContain("parsed.variantId");
    expect(decl).toContain(".sort()");
  });

  it("dm_variants のロックが dm_lp_variants より先に来る", () => {
    const v = s.search(/FROM dm_variants[\s\S]{0,200}FOR UPDATE/);
    const l = s.search(/FROM dm_lp_variants[\s\S]{0,200}FOR UPDATE/);
    expect(v).toBeGreaterThan(-1);
    expect(l).toBeGreaterThan(v);
  });
});

describe("LP型の貼り戻し保存(lp-variants/[lpId]/template)のロック順序", () => {
  const s = src(
    "src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/template/route.ts",
  );

  it("dm_lp_variants のロックが properties のロックより先に来る", () => {
    const l = s.search(/FROM dm_lp_variants[\s\S]{0,200}FOR UPDATE/);
    const p = s.search(/FROM properties[\s\S]{0,200}FOR UPDATE/);
    expect(l).toBeGreaterThan(-1);
    expect(p).toBeGreaterThan(-1);
    expect(l).toBeLessThan(p);
  });
});

describe("LP型の写真と図の枠(lp-variants/[lpId]/media PUT)のロック順序", () => {
  const s = code(
    "src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/media/route.ts",
  );

  // ⚠dm_lp_assets はこの route のロック順序の最終段。ロックせずに読むと、管理者の削除
  //   (lp-assets/[assetId] DELETE)がこの PUT の実在確認とコミットの間に割り込み、
  //   削除済み(実ファイルも失った)アセットを指す行がこの PUT のコミットで生き残る。
  it("dm_lp_variants → properties → dm_lp_assets の順にロックを取る", () => {
    const v = s.search(/FROM dm_lp_variants[\s\S]{0,200}FOR UPDATE/);
    const p = s.search(/FROM properties[\s\S]{0,200}FOR UPDATE/);
    const a = s.search(/FROM dm_lp_assets[\s\S]{0,200}FOR UPDATE/);
    expect(v).toBeGreaterThan(-1);
    expect(p).toBeGreaterThan(v);
    expect(a).toBeGreaterThan(p);
  });

  it("dm_lp_assets のロックは行の入れ替え(deleteMany)より先に来る", () => {
    const a = s.search(/FROM dm_lp_assets[\s\S]{0,200}FOR UPDATE/);
    const d = s.indexOf("tx.dmLpVariantMedia.deleteMany");
    expect(a).toBeGreaterThan(-1);
    expect(d).toBeGreaterThan(-1);
    expect(a).toBeLessThan(d);
  });
});

describe("写真ライブラリの削除(lp-assets/[assetId] DELETE)のロック順序", () => {
  const s = code("src/app/api/properties/sale-dm/lp-assets/[assetId]/route.ts");

  // ⚠この route は dm_lp_assets だけを掴む(media PUT のロック順序の末尾と同じ一段)。
  //   ロックの後に参照カウントと論理削除を読み直すことで、media PUT との削除/添付の競合を閉じる。
  it("対象行を FOR UPDATE でロックしてから参照カウントを数える", () => {
    const a = s.search(/FROM dm_lp_assets[\s\S]{0,200}FOR UPDATE/);
    const c = s.indexOf("tx.dmLpVariantMedia.count");
    expect(a).toBeGreaterThan(-1);
    expect(c).toBeGreaterThan(-1);
    expect(a).toBeLessThan(c);
  });

  it("ロックと存在確認・参照カウント・論理削除は1つの tx にまとまっている", () => {
    const tx = s.indexOf("prisma.$transaction");
    const a = s.search(/FROM dm_lp_assets[\s\S]{0,200}FOR UPDATE/);
    const u = s.indexOf("tx.dmLpAsset.update");
    expect(tx).toBeGreaterThan(-1);
    expect(a).toBeGreaterThan(tx);
    expect(u).toBeGreaterThan(a);
  });
});

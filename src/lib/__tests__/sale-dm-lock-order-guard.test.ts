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
    expect(s.slice(d)).toMatch(/findMany[\s\S]{0,900}validateLetterBody/);
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
});

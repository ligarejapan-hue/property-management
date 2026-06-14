/**
 * 表示名監査の純関数 buildDisplayNameAuditGroups の単体テスト。
 *
 * 設計書のテスト項目を網羅:
 *  - 同一キー複数バリアント → 検出
 *  - 単一バリアントのみ → 非検出
 *  - 全半角・空白違いの吸収（normalizeName 経由）
 *  - 建物名の内部空白全除去（normalizeBuildingName 経由）
 *  - 空文字・空白のみ name（正規化後空キー）は群化しない
 *  - 件数・ID 集約の正しさ
 *  - maxGroups 超過時の truncation と件数
 *  - 群 / バリアントの安定ソート
 *
 * 正規化は実物（normalizeName / normalizeBuildingName）を注入して実挙動で検証する。
 */
import { describe, it, expect } from "vitest";
import {
  buildDisplayNameAuditGroups,
  type AuditRecord,
} from "@/lib/display-name-audit";
import { normalizeName, normalizeBuildingName } from "@/lib/normalize";

describe("buildDisplayNameAuditGroups", () => {
  it("同一正規化キーに生 name が2バリアント以上あれば群として検出する", () => {
    const records: AuditRecord[] = [
      { id: "1", name: "田中　太郎" }, // 全角スペース
      { id: "2", name: "田中太郎" }, // 空白なし
    ];
    const { groups, truncated } = buildDisplayNameAuditGroups(
      records,
      normalizeName,
    );
    expect(truncated).toBe(false);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe(normalizeName("田中太郎"));
    expect(groups[0].variants.map((v) => v.name).sort()).toEqual(
      ["田中　太郎", "田中太郎"].sort(),
    );
    expect(groups[0].totalRecords).toBe(2);
  });

  it("単一バリアントのみ（同じ生 name のみ / 別キー）の群は検出しない", () => {
    const records: AuditRecord[] = [
      // 同じ生 name が複数 → バリアント1つ（表記ゆれではない）
      { id: "1", name: "田中太郎" },
      { id: "2", name: "田中太郎" },
      // 別人（別キー）で各1件
      { id: "3", name: "鈴木一郎" },
    ];
    const { groups } = buildDisplayNameAuditGroups(records, normalizeName);
    expect(groups).toHaveLength(0);
  });

  it("全半角・空白違いを normalizeName が吸収して同一群にまとめる", () => {
    const records: AuditRecord[] = [
      { id: "1", name: "山田 花子" }, // 半角スペース
      { id: "2", name: "山田　花子" }, // 全角スペース
      { id: "3", name: "山田花子" }, // 空白なし
    ];
    const { groups } = buildDisplayNameAuditGroups(records, normalizeName);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("山田花子");
    expect(groups[0].variants).toHaveLength(3);
    expect(groups[0].totalRecords).toBe(3);
  });

  it("建物名の内部空白を normalizeBuildingName が全除去して同一群にまとめる", () => {
    const records: AuditRecord[] = [
      { id: "1", name: "ABC マンション" },
      { id: "2", name: "ABCマンション" },
    ];
    const { groups } = buildDisplayNameAuditGroups(
      records,
      normalizeBuildingName,
    );
    expect(groups).toHaveLength(1);
    // normalizeBuildingName は lowercase 化するため key は小文字
    expect(groups[0].key).toBe("abcマンション");
    expect(groups[0].variants).toHaveLength(2);
  });

  it("正規化後が空キーになる name（空文字・空白のみ）は群化しない", () => {
    const records: AuditRecord[] = [
      { id: "1", name: "" },
      { id: "2", name: "   " },
      { id: "3", name: "　" }, // 全角スペースのみ
    ];
    const { groups } = buildDisplayNameAuditGroups(records, normalizeName);
    expect(groups).toHaveLength(0);
  });

  it("空キーは群化しないが、非空キーの群は通常どおり検出する（混在）", () => {
    const records: AuditRecord[] = [
      { id: "1", name: "   " }, // 空キー → 無視
      { id: "2", name: "佐藤 健" },
      { id: "3", name: "佐藤健" },
    ];
    const { groups } = buildDisplayNameAuditGroups(records, normalizeName);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("佐藤健");
    expect(groups[0].totalRecords).toBe(2);
  });

  it("各バリアントの count と ids を正しく集約する", () => {
    const records: AuditRecord[] = [
      { id: "a", name: "田中 太郎" },
      { id: "b", name: "田中 太郎" },
      { id: "c", name: "田中太郎" },
    ];
    const { groups } = buildDisplayNameAuditGroups(records, normalizeName);
    expect(groups).toHaveLength(1);
    const byName = new Map(groups[0].variants.map((v) => [v.name, v]));
    expect(byName.get("田中 太郎")?.count).toBe(2);
    expect(byName.get("田中 太郎")?.ids).toEqual(["a", "b"]);
    expect(byName.get("田中太郎")?.count).toBe(1);
    expect(byName.get("田中太郎")?.ids).toEqual(["c"]);
    expect(groups[0].totalRecords).toBe(3);
  });

  it("バリアントは件数降順 → name 昇順で安定ソートされる", () => {
    const records: AuditRecord[] = [
      { id: "1", name: "あ" }, // 1件
      { id: "2", name: "い" }, // 2件
      { id: "3", name: "い" },
      { id: "4", name: "う" }, // 1件
    ];
    // 「あ」「い」「う」は normalizeName 後も別バリアント。これらを同一キーに揃えるため
    // 正規化を「定数キー」に固定するスタブで群化させる。
    const constKey = (_: string) => "K";
    const { groups } = buildDisplayNameAuditGroups(records, constKey);
    expect(groups).toHaveLength(1);
    // 件数降順: い(2) が先頭。同数の あ(1)/う(1) は name 昇順（あ < う）。
    expect(groups[0].variants.map((v) => v.name)).toEqual(["い", "あ", "う"]);
  });

  it("群は totalRecords 降順 → key 昇順で安定ソートされる", () => {
    // key "b": 3件（2バリアント）、key "a": 2件（2バリアント）、key "c": 2件（2バリアント）
    const records: AuditRecord[] = [
      { id: "1", name: "b-x" },
      { id: "2", name: "b-y" },
      { id: "3", name: "b-y" },
      { id: "4", name: "a-x" },
      { id: "5", name: "a-y" },
      { id: "6", name: "c-x" },
      { id: "7", name: "c-y" },
    ];
    // 生 name の先頭1文字をキーにするスタブ（a/b/c）。
    const firstChar = (s: string) => s.charAt(0);
    const { groups } = buildDisplayNameAuditGroups(records, firstChar);
    // b(3) が先頭、続いて totalRecords 同数 a(2) < c(2) は key 昇順。
    expect(groups.map((g) => g.key)).toEqual(["b", "a", "c"]);
  });

  it("maxGroups 超過時は先頭 maxGroups 群に制限し truncated:true を返す", () => {
    // 5 個の独立した2バリアント群を作る。
    const records: AuditRecord[] = [];
    for (let i = 0; i < 5; i++) {
      records.push({ id: `${i}-a`, name: `g${i} 一` });
      records.push({ id: `${i}-b`, name: `g${i}一` });
    }
    const { groups, truncated } = buildDisplayNameAuditGroups(
      records,
      normalizeName,
      { maxGroups: 3 },
    );
    expect(truncated).toBe(true);
    expect(groups).toHaveLength(3);
  });

  it("群数が maxGroups 以下なら truncated:false", () => {
    const records: AuditRecord[] = [
      { id: "1", name: "田中 太郎" },
      { id: "2", name: "田中太郎" },
    ];
    const { truncated } = buildDisplayNameAuditGroups(records, normalizeName, {
      maxGroups: 1000,
    });
    expect(truncated).toBe(false);
  });

  it("既定 maxGroups は 1000（明示しなくても上限が効く）", () => {
    // 1001 群作る → 既定上限 1000 で truncated:true。
    const records: AuditRecord[] = [];
    for (let i = 0; i < 1001; i++) {
      records.push({ id: `${i}-a`, name: `名${i} 一` });
      records.push({ id: `${i}-b`, name: `名${i}一` });
    }
    const { groups, truncated } = buildDisplayNameAuditGroups(
      records,
      normalizeName,
    );
    expect(groups).toHaveLength(1000);
    expect(truncated).toBe(true);
  });

  it("空の records 入力では空群・truncated:false", () => {
    const { groups, truncated } = buildDisplayNameAuditGroups([], normalizeName);
    expect(groups).toEqual([]);
    expect(truncated).toBe(false);
  });
});

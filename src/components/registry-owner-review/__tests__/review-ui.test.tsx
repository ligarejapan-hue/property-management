/**
 * 謄本の名義の確認の画面(2026-11-08)。
 * - 左右に並べ、外れる人・加わる人に印
 * - DM の初期値: このままでよい=チェックあり/謄本の名義に直す=チェックなし(発注者決定)
 * - CSV を出す口を作らない
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import OwnerComparison from "@/components/registry-owner-review/owner-comparison";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("OwnerComparison", () => {
  const html = renderToStaticMarkup(
    <OwnerComparison
      registryLabel="謄本(所有者事項)_2026-09-15"
      systemOwners={[
        { ownerId: "a", name: "高橋 一郎", address: "東京都見本区一丁目2番3号", isPrimary: true, willBeRemoved: false, hasNote: false },
        { ownerId: "b", name: "佐藤 花子", address: null, isPrimary: false, willBeRemoved: true, hasNote: false },
        { ownerId: "c", name: "鈴木 太郎", address: null, isPrimary: false, willBeRemoved: false, hasNote: false },
      ]}
      registryOwners={[
        { name: "鈴木 太郎", address: null, share: null, willBeAdded: false },
        { name: "髙橋 一郎", address: "東京都見本区一丁目5番3号", share: null, willBeAdded: false },
        { name: "株式会社例示ホーム", address: null, share: "2分の1", willBeAdded: true },
      ]}
    />,
  );
  const rows = html.split("<li").slice(1);

  it("似ている人どうしを横に並べる(謄本の並びが違っても)", () => {
    expect(html).toContain("システムの所有者");
    expect(html).toContain("謄本の名義");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatch(/data-row="differs"[\s\S]*橋 一郎[\s\S]*橋 一郎/);
    expect(rows[2]).toMatch(/data-row="same"[\s\S]*鈴木 太郎[\s\S]*鈴木 太郎[\s\S]*✓ 同じ/);
  });
  it("組の中で違う字だけに色(システム側・謄本側)", () => {
    expect(rows[0]).toContain('data-diff="system">高</span>');
    expect(rows[0]).toContain('data-diff="registry">髙</span>');
    expect(rows[0]).not.toContain('data-diff="system">橋');
    // 色だけに頼らない(波線)
    expect(rows[0]).toMatch(/decoration-wavy[^"]*" data-diff="system"/);
    expect(rows[0]).toContain("≠ 字が違う");
  });
  it("組にならない人は相手を空欄にして、行全体に色と記号", () => {
    expect(rows[1]).toMatch(/data-row="system_only" class="[^"]*bg-red-50[\s\S]*佐藤 花子[\s\S]*（謄本にいない）[\s\S]*− システムだけ/);
    expect(rows[3]).toMatch(/data-row="registry_only" class="[^"]*bg-green-50[\s\S]*（システムにいない）[\s\S]*株式会社例示ホーム[\s\S]*＋ 謄本だけ/);
    expect(rows[3]).toContain("持分 2分の1");
  });
  it("住所は参考に並べ、違う字に色だけ", () => {
    expect(rows[0]).toContain('data-diff="address">2</span>');
    expect(rows[0]).toContain('data-diff="address">5</span>');
  });
  it("物件ごとの違いの種類を1行で出す", () => {
    expect(html).toContain("違いの種類:</span> 漢字の違い（髙／高）・一部が別の人（所有者が変わった可能性）");
  });

  it("謄本を読めないときはそう出す", () => {
    const html = renderToStaticMarkup(<OwnerComparison registryLabel="x" systemOwners={[]} registryOwners={[]} />);
    expect(html).toContain("謄本から名義を読み取れませんでした");
  });
});

describe("OwnerComparison: 外字の組(2026-11-11 昼 実機確認)", () => {
  const G = String.fromCharCode(0xe0a6); // 謄本の外字(私用領域)
  const html = renderToStaticMarkup(
    <OwnerComparison
      registryLabel="x"
      systemOwners={[
        { ownerId: "a", name: "大塚一郎", address: null, isPrimary: true, willBeRemoved: false, hasNote: false },
        { ownerId: "b", name: `大${G}一郎`, address: null, isPrimary: false, willBeRemoved: true, hasNote: false },
      ]}
      registryOwners={[{ name: `大${G}一郎`, address: null, share: null, willBeAdded: false }]}
    />,
  );
  const rows = html.split("<li").slice(1);

  it("外字の組は「入れ替えます」でなく、システムの名前のまま残すと出す", () => {
    expect(rows[0]).toMatch(/data-row="differs"[\s\S]*塚[\s\S]*≠ 外字（読めない字）/);
    expect(rows[0]).toContain("直しても、システムの名前のまま残します");
    expect(rows[0]).not.toContain("この人を入れ替えます");
  });
  it("外字のまま入ったシステムだけの人は「− システムだけ」", () => {
    expect(rows[1]).toMatch(/data-row="system_only"[\s\S]*− システムだけ/);
  });
  it("外字の無い組の「入れ替えます」は今までどおり", () => {
    const swap = renderToStaticMarkup(
      <OwnerComparison
        registryLabel="x"
        systemOwners={[{ ownerId: "a", name: "佐藤一郎", address: null, isPrimary: true, willBeRemoved: true, hasNote: false }]}
        registryOwners={[{ name: "佐藤次郎", address: null, share: null, willBeAdded: true }]}
      />,
    );
    expect(swap).toContain("直すと、この人を入れ替えます");
    expect(swap).not.toContain("システムの名前のまま残します");
  });
});

describe("1件ぶんの操作(ソース)", () => {
  const src = read("src/components/registry-owner-review/review-item.tsx");
  it("DM の初期値: このままでよい=チェックあり・直す=チェックなし", () => {
    expect(src).toMatch(/useState\(true\);\s*\n\s*const \[replaceRestoreDm/);
    expect(src).toContain("const [replaceRestoreDm, setReplaceRestoreDm] = useState(false);");
  });
  it("直す前に外れる人・加わる人を確認画面で見せる", () => {
    expect(src).toContain("物件から外れる人");
    expect(src).toContain("加わる人");
    expect(src).toMatch(/onClick=\{\(\) => setConfirming\(true\)\}/);
  });
  it("外れる人も加わる人もいない(外字の組だけ)ときは、直すボタンを押せず理由を出す", () => {
    expect(src).toContain("removeNames.length === 0 && addNames.length === 0");
    expect(src).toMatch(/disabled=\{[^}]*nothingToReplace\}/);
    expect(src).toContain("外字の人はシステムの名前のまま残します");
  });
  it("確認画面で見せた中身(つながり・外れる人)を送る", () => {
    expect(src).toContain("linkedOwnerIds: detail.plan.linkedOwnerIds");
    expect(src).toContain("removeOwnerIds: detail.plan.removeOwnerIds");
  });
  it("一覧に違いの種類の列と、種類の順の並べ替え(既定)", () => {
    const page = read("src/app/(dashboard)/properties/registry-owner-review/page.tsx");
    expect(page).toContain('useState<RegistryOwnerReviewSort>("kind")');
    expect(page).toContain('<option value="kind">違いの種類の順</option>');
    expect(page).toContain("diffKind={row.diffKind}");
    expect(src).toMatch(/\{diffKind \?\? /);
  });
  it("CSV の口は作らない", () => {
    const page = read("src/app/(dashboard)/properties/registry-owner-review/page.tsx");
    const code = `${src}\n${page}`.replace(/\/\*\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/text\/csv|\.csv|Csv\(|CSV/);
  });
});

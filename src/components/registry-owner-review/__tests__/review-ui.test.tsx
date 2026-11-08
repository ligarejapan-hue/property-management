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
  it("システムの所有者と謄本の名義を並べ、外れる人・加わる人に印を付ける", () => {
    const html = renderToStaticMarkup(
      <OwnerComparison
        registryLabel="謄本(所有者事項)_2026-09-15"
        systemOwners={[
          { ownerId: "a", name: "山田太郎", address: null, isPrimary: true, willBeRemoved: false, hasNote: false },
          { ownerId: "b", name: "佐藤一郎", address: null, isPrimary: false, willBeRemoved: true, hasNote: false },
        ]}
        registryOwners={[
          { name: "山田太郎", address: null, share: null, willBeAdded: false },
          { name: "山田花子", address: null, share: "2分の1", willBeAdded: true },
        ]}
      />,
    );
    expect(html).toContain("システムの所有者");
    expect(html).toContain("謄本の名義");
    expect(html).toMatch(/佐藤一郎<\/span>.*謄本にない/);
    expect(html).toMatch(/山田花子<\/span>.*システムにいない/);
    expect(html).toContain("持分 2分の1");
  });

  it("謄本を読めないときはそう出す", () => {
    const html = renderToStaticMarkup(<OwnerComparison registryLabel="x" systemOwners={[]} registryOwners={[]} />);
    expect(html).toContain("謄本から名義を読み取れませんでした");
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
  it("確認画面で見せた中身(つながり・外れる人)を送る", () => {
    expect(src).toContain("linkedOwnerIds: detail.plan.linkedOwnerIds");
    expect(src).toContain("removeOwnerIds: detail.plan.removeOwnerIds");
  });
  it("CSV の口は作らない", () => {
    const page = read("src/app/(dashboard)/properties/registry-owner-review/page.tsx");
    const code = `${src}\n${page}`.replace(/\/\*\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/text\/csv|\.csv|Csv\(|CSV/);
  });
});

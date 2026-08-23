/**
 * UI一貫性 第1弾 (発注者承認 2026-08-23) の固定。
 *  (1) 物件一覧の検索窓は1本(統合)
 *  (3) 共通 Button 部品が存在する
 *  (4) 主ボタンに bg-blue-600 を使わない(藍=indigoに統一)
 *  (5) 詳細条件は折りたたみ+適用件数表示
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const PAGE = read("src/app/(dashboard)/properties/page.tsx");

describe("(1) 検索窓の統合", () => {
  it("物件一覧の検索 input は1本だけ(3連に戻さない)", () => {
    // placeholder に「検索」を含む input の数で数える。
    const boxes = PAGE.match(/placeholder="[^"]*検索[^"]*"/g) ?? [];
    expect(boxes).toHaveLength(1);
  });

  it("旧・専用窓の状態(searchDraft/mgmtIdDraft)が残っていない", () => {
    expect(PAGE).not.toContain("searchDraft");
    expect(PAGE).not.toContain("mgmtIdDraft");
  });
});

describe("(5) 詳細条件の折りたたみ", () => {
  it("詳細条件トグルがあり、適用件数を表示する", () => {
    expect(PAGE).toContain("詳細条件");
    expect(PAGE).toContain("advancedFilterCount");
    expect(PAGE).toContain("件適用中");
    expect(PAGE).toMatch(/aria-expanded=\{advancedOpen\}/);
  });

  it("⚠詳細条件が適用された状態で開くと、最初から展開されている", () => {
    // 畳んだまま適用されていると「なぜ絞れているのか」が分からない。
    const at = PAGE.indexOf("const [advancedOpen, setAdvancedOpen] = useState(() =>");
    expect(at).toBeGreaterThan(-1);
    const init = PAGE.slice(at, at + 700);
    expect(init).toContain('sp.get("propertyType")');
    expect(init).toContain('sp.get("updatedFrom")');
    expect(init).toContain('sp.get("resendOnly")');
  });

  it("よく使う3つ(検索・DM判断・担当者)は折りたたみの外にある", () => {
    const advancedAt = PAGE.indexOf("{advancedOpen && (");
    expect(advancedAt).toBeGreaterThan(-1);
    const before = PAGE.slice(PAGE.indexOf("よく使う条件"), advancedAt);
    expect(before).toContain("value={dmFilter}");
    expect(before).toContain("value={assigneeFilter}");
    expect(before).toContain("value={searchAllDraft}");
    // 詳細側の代表(種別・更新日)は前半に無い。
    expect(before).not.toContain("value={typeFilter}");
    expect(before).not.toContain("value={updatedFromFilter}");
  });
});

describe("(3)(4) ボタンの統一", () => {
  it("共通 Button 部品が存在する", () => {
    const src = read("src/components/ui/button.tsx");
    expect(src).toContain('primary');
    expect(src).toContain('secondary');
    expect(src).toContain('danger');
  });

  it("⚠bg-blue-600 のボタンをリポに増やさない(バッジ用途の status-badge のみ許可)", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
          if (name === "node_modules" || name === "__tests__" || name === "generated") continue;
          walk(full);
        } else if (/\.tsx$/.test(name) && !full.includes("status-badge")) {
          if (readFileSync(full, "utf8").includes("bg-blue-600")) offenders.push(full);
        }
      }
    };
    walk(join(process.cwd(), "src"));
    expect(offenders, `青いボタンが残っている:\n${offenders.join("\n")}`).toEqual([]);
  });
});

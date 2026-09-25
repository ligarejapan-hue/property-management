/**
 * 「謄本から所有者をまとめて反映」の画面と入口。
 *
 * vitest は env=node(jsdom 無し)なので、出す/出さないの条件はソースの走査で固定する。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/** 手元(CRLF)と CI(LF)で判定が変わらないよう改行を揃える。 */
function readSource(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), "utf-8").replace(/\r\n/g, "\n");
}

const PAGE = readSource("src/app/(dashboard)/import/registry-owners/page.tsx");
const SIDEBAR = readSource("src/components/layout/sidebar-model.tsx");

describe("まとめて反映の画面", () => {
  it("対象件数を取りに行き、画面に出す", () => {
    expect(PAGE).toContain("fetchRegistryOwnerApplyTarget");
    expect(PAGE).toContain("targetCount");
  });

  it("⚠既定の件数は少なめ（100件）にして、増やすのは人の操作に限る", () => {
    expect(PAGE).toContain("defaultLimit");
    // 画面に数字を直書きしない(APIの既定値を使う)
    expect(PAGE).not.toContain("useState(100)");
  });

  it("実行すると、取込の記録の画面へ案内する", () => {
    expect(PAGE).toContain("startRegistryOwnerApply");
    expect(PAGE).toContain("/import/jobs/");
  });

  it("⚠ほかの取込を処理中のときは実行させない", () => {
    expect(PAGE).toContain("busy");
    expect(PAGE).toMatch(/disabled=\{[^}]*busy/);
  });

  it("うまくいかなかった理由を画面に出す（権限が足りない等）", () => {
    expect(PAGE).toContain('role="alert"');
  });

  it("⚠まず少しだけ試す進め方を画面で案内する", () => {
    expect(PAGE).toContain("100件");
  });

  it("全件を入れる操作がある", () => {
    expect(PAGE).toContain("全件");
  });
});

describe("入口", () => {
  it("⚠サイドバーの入口は管理者だけに出す（他の人は押しても403）", () => {
    const entry = SIDEBAR.slice(
      SIDEBAR.indexOf("/import/registry-owners") - 200,
      SIDEBAR.indexOf("/import/registry-owners") + 200,
    );
    expect(entry).toContain("/import/registry-owners");
    expect(entry).toContain('minRole: "admin"');
  });
});

describe("取込の記録の画面（まとめて反映の行）", () => {
  const JOB_PAGE = readSource("src/app/(dashboard)/import/jobs/[jobId]/page.tsx");

  it("⚠PDFを添付する導線は出さない（添付の実体が無いので必ず失敗する）", () => {
    // 「この物件に添付」などはPDFを上げた一括取込だけの導線。
    expect(JOB_PAGE).toContain("isRegistryPdfUploadBulkJob");
    expect(JOB_PAGE).toContain(
      "const isRegistryPdfUploadBulkJob = isRegistryPdfBulkJob && !isRegistryOwnerApplyJob",
    );
    expect(JOB_PAGE).toMatch(/\{isRegistryPdfUploadBulkJob \? "この物件に添付"/);
  });

  it("⚠読み取れなかった物件は、手入力の案内と物件へのリンクを出す", () => {
    expect(JOB_PAGE).toContain("所有者を手入力で登録してください");
    expect(JOB_PAGE).toContain("/properties/${rawData.propertyId}");
  });
});

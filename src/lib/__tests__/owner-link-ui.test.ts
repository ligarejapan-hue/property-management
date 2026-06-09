/**
 * 21-A: 物件詳細「所有者未紐付け時の追加・紐付け導線」+ タブ並べ替え/改名 +
 * ボタン識別性改善の source-assertion テスト（corporate-lookup-ui.test.ts と同方針）。
 *
 * 既存ロック（properties-detail-permissions-provider / permissions-direct-fetch-allowlist /
 * owner-edit / owner-mislink-ui）の権限導出・provider 経由・誤紐づき導線は壊さない。
 * 本テストは追加導線・タブ順・ラベル識別性の「形」を固定する。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// 欠損ファイルは "" を返す（未実装時に collection error にせず、各 assertion を
// 正しい理由で fail させる）。実装後・将来の誤削除時もこの assertion 群が検出する。
const read = (rel: string) => {
  try {
    return fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");
  } catch {
    return "";
  }
};

const apiClientSrc = read("src/lib/api-client.ts");
const modalSrc = read("src/components/owners/owner-link-modal.tsx");
const pageSrc = read("src/app/(dashboard)/properties/[id]/page.tsx");

describe("api-client: 所有者作成・物件紐付け wrapper", () => {
  it("createOwner が POST /api/owners を呼ぶ", () => {
    expect(apiClientSrc).toMatch(/export async function createOwner\(/);
    expect(apiClientSrc).toMatch(/["']\/api\/owners["']/);
  });

  it("linkOwnerToProperty が POST /api/properties/<id>/owners を呼ぶ", () => {
    expect(apiClientSrc).toMatch(/export async function linkOwnerToProperty\(/);
    expect(apiClientSrc).toMatch(/\/api\/properties\/\$\{propertyId\}\/owners/);
  });
});

describe("OwnerLinkModal: 既存検索 / 新規作成の 2 モード", () => {
  it("2 モードの導線がある（既存紐付け・新規作成して紐付け）", () => {
    expect(modalSrc).toMatch(/既存の所有者を紐付け/);
    expect(modalSrc).toMatch(/新規作成して紐付け/);
  });

  it("既存検索は searchOwners を使う", () => {
    expect(modalSrc).toMatch(/searchOwners\(/);
  });

  it("新規作成は createOwner → linkOwnerToProperty を使う", () => {
    expect(modalSrc).toMatch(/createOwner\(/);
    expect(modalSrc).toMatch(/linkOwnerToProperty\(/);
  });

  it("純関数ヘルパー（payload 構築・活性条件・isPrimary 既定）を使う", () => {
    expect(modalSrc).toMatch(/buildCreateOwnerPayload\(/);
    expect(modalSrc).toMatch(/canSubmitOwnerCreate\(/);
    expect(modalSrc).toMatch(/buildLinkOwnerPayload\(/);
    expect(modalSrc).toMatch(/defaultIsPrimaryForLink\(/);
  });

  it("氏名必須マークとエラー表示を持つ", () => {
    expect(modalSrc).toMatch(/氏名/);
    expect(modalSrc).toMatch(/text-red-500/); // 必須マーク
    expect(modalSrc).toMatch(/text-red-600/); // エラーメッセージ
  });

  it("成功時 onLinked / 閉じるで onClose を呼ぶ", () => {
    expect(modalSrc).toMatch(/onLinked/);
    expect(modalSrc).toMatch(/onClose/);
  });
});

describe("page.tsx: タブ並べ替え・改名", () => {
  it("「所有者情報」タブが存在する", () => {
    expect(pageSrc).toMatch(/key:\s*"owner",\s*label:\s*"所有者情報"/);
  });

  it("タブ順は 基本情報 → 所有者情報 → 写真", () => {
    const iBasic = pageSrc.indexOf('key: "basic"');
    const iOwner = pageSrc.indexOf('key: "owner"');
    const iPhotos = pageSrc.indexOf('key: "photos"');
    expect(iBasic).toBeGreaterThanOrEqual(0);
    expect(iOwner).toBeGreaterThan(iBasic);
    expect(iPhotos).toBeGreaterThan(iOwner);
  });
});

describe("page.tsx: 所有者未紐付け・追加導線", () => {
  it("OwnerLinkModal をマウントし「所有者を追加」導線がある", () => {
    expect(pageSrc).toMatch(/OwnerLinkModal/);
    expect(pageSrc).toMatch(/所有者を追加/);
  });

  it("追加導線は canShowAddOwner で owner:write を要求する", () => {
    expect(pageSrc).toMatch(/canShowAddOwner\(/);
  });

  it("owner:read が無い場合は従来どおり閲覧不可メッセージ（ゲート維持）", () => {
    expect(pageSrc).toMatch(/!canRead/);
    expect(pageSrc).toMatch(/閲覧する権限がありません/);
  });
});

describe("page.tsx: ボタン識別性（ラベル / aria-label / title）", () => {
  it("ヘッダの編集/削除が物件対象と分かる（物件を編集 / 物件を削除）", () => {
    expect(pageSrc).toMatch(/物件を編集/);
    expect(pageSrc).toMatch(/物件を削除/);
  });

  it("所有者カードの編集は所有者対象と分かる（所有者情報を編集 + aria-label に所有者識別）", () => {
    expect(pageSrc).toMatch(/所有者情報を編集/);
    expect(pageSrc).toMatch(/の所有者情報を編集/); // aria-label テンプレ末尾（所有者名 + 文脈）
  });

  it("誤紐づき修正に補足 title がある", () => {
    expect(pageSrc).toMatch(/title="この物件と所有者の紐づきを修正"/);
  });
});

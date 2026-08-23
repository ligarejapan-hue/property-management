import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROLE_LABELS } from "@/lib/role-labels";

// env=node(jsdom 無し)のため、UI 文言/配線の回帰はソース文字列で守る。
// B-5 残(UI総点検 2026-07-13): 管理系画面の開発用語・内部コード露出の一掃。
const read = (p: string) => readFileSync(path.resolve(process.cwd(), p), "utf-8");

describe("B-5: 所有者詳細(admin/owners/[id])の英語見出しを日本語化", () => {
  const src = read("src/app/(dashboard)/admin/owners/[id]/page.tsx");
  // コード内コメントは対象外(画面に出る文言のみを対象にする)。
  const withoutComments = src
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  it("Owner 詳細 / Owner 概要 の英語見出しを出さない", () => {
    expect(withoutComments).not.toContain("Owner 詳細");
    expect(withoutComments).not.toContain("Owner 概要");
    expect(src).toContain("所有者詳細");
    expect(src).toContain("所有者概要");
  });

  it("version の生ラベルを出さない", () => {
    expect(src).not.toContain('label="version"');
    expect(src).toContain('label="バージョン"');
  });
});

describe("B-5: 法人番号検索パネルの env 文言を平易化", () => {
  const src = read("src/components/owners/corporate-lookup-panel.tsx");

  it("env 設定の依頼文言を出さない", () => {
    expect(src).not.toContain("env 設定");
    expect(src).not.toContain("法人番号API未設定");
  });

  it("平易な案内を出す", () => {
    expect(src).toContain(
      "法人番号の自動検索は現在利用できません（システム管理者にお問い合わせください）",
    );
  });
});

describe("B-5: 所有者補正候補の開発用語を平易化・事実に合わせる", () => {
  const src = read("src/app/(dashboard)/admin/owners/correction/page.tsx");
  // コメントを除いた JSX テキストを対象にする(コード識別子は現状 UI 文言のみ)。
  const withoutComments = src
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  it("dry-run / dryRun / soft-delete を画面に出さない", () => {
    expect(withoutComments).not.toMatch(/dry-?run/i);
    expect(withoutComments).not.toMatch(/soft-?delete/i);
  });

  it("タイトルは補足なしの「所有者補正候補」(第2弾⑧でPageHeader化)", () => {
    expect(src).toMatch(/title="所有者補正候補"/);
    expect(src).not.toContain("所有者補正候補 (");
  });

  it("実装済みの統合実行を「未実装」と説明しない・Phase 表記を出さない", () => {
    expect(src).not.toContain("未実装です");
    expect(withoutComments).not.toMatch(/Phase\s*2-[AB]/);
    expect(withoutComments).not.toContain("別 phase");
    expect(withoutComments).not.toContain("対応予定です");
  });

  it("Owner 詳細 の英語表記を出さない(リンク文言含む)", () => {
    expect(withoutComments).not.toMatch(/Owner\s+詳細/);
    expect(src).toContain("所有者詳細を開く");
  });
});

describe("B-5: 謄本設定画面から内部設定名・フェーズ表記を排除", () => {
  const src = read("src/app/(dashboard)/admin/registry-settings/page.tsx");

  it("環境変数名 REGISTRY_SETTINGS_ENC_KEY を画面に出さない", () => {
    expect(src).not.toContain("REGISTRY_SETTINGS_ENC_KEY");
  });

  it("フェーズ3 という開発区分を出さない", () => {
    expect(src).not.toContain("フェーズ3");
  });

  it("暗号化未設定時はシステム管理者への依頼として平易に案内する", () => {
    expect(src).toContain(
      "サーバー側の暗号化設定が完了していないため、資格情報は保存できません",
    );
  });
});

describe("B-5: ロール表示名の共有マップ", () => {
  it("3ロールを日本語で持つ", () => {
    expect(ROLE_LABELS.admin).toBe("管理者");
    expect(ROLE_LABELS.office_staff).toBe("事務担当");
    expect(ROLE_LABELS.field_staff).toBe("現地担当");
  });

  it("ユーザー一覧・権限編集の両画面が共有マップを参照する", () => {
    const usersSrc = read("src/app/(dashboard)/admin/users/page.tsx");
    const permsSrc = read(
      "src/app/(dashboard)/admin/users/[id]/permissions/page.tsx",
    );
    expect(usersSrc).toContain('from "@/lib/role-labels"');
    expect(permsSrc).toContain('from "@/lib/role-labels"');
    // 権限編集のロール表示は英語コード生表示ではなくラベル経由。
    expect(permsSrc).not.toContain("{user?.role ?? ");
    expect(permsSrc).toMatch(/ROLE_LABELS\[user\.role\]\s*\?\?\s*user\.role/);
  });
});

describe("B-5: 権限編集のアクション名を日本語化(auto_fetch / generate)", () => {
  const src = read(
    "src/app/(dashboard)/admin/users/[id]/permissions/page.tsx",
  );

  it("謄本自動取得・売却DM生成のアクションラベルを収載する", () => {
    expect(src).toMatch(/auto_fetch:\s*"自動取得"/);
    expect(src).toMatch(/generate:\s*"AI生成"/);
  });
});

describe("B-5: 監査ログの操作種別を日本語化", () => {
  const src = read("src/app/(dashboard)/admin/audit-logs/page.tsx");

  it("物件ワンクリック操作(action:*)の6種を収載する", () => {
    expect(src).toContain('"action:confirm_investigation"');
    expect(src).toContain('"action:set_dm_send"');
    expect(src).toContain('"action:set_dm_no_send"');
    expect(src).toContain('"action:set_dm_hold"');
    expect(src).toContain('"action:mark_registry_obtained"');
    expect(src).toContain('"action:assign_to_me"');
  });

  it("巡回・所有者補正・謄本・売却DM系の主要コードを収載する", () => {
    expect(src).toMatch(/field_survey_session_start:\s*"巡回開始"/);
    expect(src).toMatch(/field_survey_session_end:\s*"巡回終了"/);
    expect(src).toMatch(/owner_correction_merge:\s*"オーナー統合実行"/);
    expect(src).toMatch(/owner_correction_mislink:\s*"誤紐づけ解除"/);
    expect(src).toMatch(/registry_auto_fetch:\s*"謄本自動取得"/);
    expect(src).toMatch(/sale_dm_campaign_create:/);
    expect(src).toMatch(/sale_dm_tracking_hit:/);
    expect(src).toMatch(/sales_sheet_design_create:/);
    expect(src).toMatch(/attachment_search:/);
    expect(src).toMatch(/company_profile_update:/);
  });

  it("巡回一覧の閲覧監査 (総点検P3) も日本語ラベルを収載する", () => {
    // 新 action を足すときはこの辞書も更新する。未収載だと監査画面と
    // フィルタ選択肢に生の内部識別子がそのまま出る (@codex #337)。
    expect(src).toMatch(
      /field_survey_session_list_view:\s*"巡回一覧の閲覧（他スタッフ分）"/,
    );
  });

  it("動的生成 action (三項演算子/ヘルパ経由) も収載する(@codex R3)", () => {
    expect(src).toMatch(/registry_pdf_download:/);
    expect(src).toMatch(/registry_pdf_preview:/);
    expect(src).toMatch(/postal_code_audit_list:/);
    expect(src).toMatch(/postal_code_audit_csv_export:/);
    expect(src).toMatch(/pii_copy_attempt:/);
    expect(src).toMatch(/pii_cut_attempt:/);
    expect(src).toMatch(/pii_contextmenu_attempt:/);
    expect(src).toMatch(/pii_print_attempt:/);
    expect(src).toMatch(/user_deactivate:/);
    expect(src).toMatch(/user_reactivate:/);
    expect(src).toMatch(/complete:\s*"完了"/);
  });

  it("対象テーブル名も日本語ラベルを収載する(@codex R1)", () => {
    expect(src).toMatch(/field_survey_sessions:\s*"巡回記録"/);
    expect(src).toMatch(/dm_campaigns:\s*"売却DMキャンペーン"/);
    expect(src).toMatch(/registry_fetch_config:\s*"謄本取得設定"/);
    expect(src).toMatch(/sales_sheet_designs:\s*"販売図面"/);
    expect(src).toMatch(/company_profile:\s*"会社情報"/);
  });

  it("未知コードの生表示フォールバックは残す(古いログ対策)", () => {
    expect(src).toMatch(/ACTION_LABELS\[[^\]]+\]\s*\?\?/);
  });
});

describe("B-5: 品質チェックのコードバッジを日本語ラベル表示", () => {
  const src = read("src/app/(dashboard)/properties/quality-check/page.tsx");

  it("6コードの日本語ラベルマップを持つ", () => {
    expect(src).toMatch(/NO_OWNER:\s*"所有者未紐づけ"/);
    expect(src).toMatch(/REGISTRY_DM_MISMATCH:\s*"登記とDMの不整合"/);
    expect(src).toMatch(/NO_LOT_NUMBER:\s*"地番未入力"/);
    expect(src).toMatch(/NO_REAL_ESTATE_NUMBER:\s*"不動産番号未入力"/);
    expect(src).toMatch(/INVESTIGATION_NOT_CONFIRMED:\s*"調査未確認"/);
    expect(src).toMatch(/NO_ASSIGNEE:\s*"担当者未設定"/);
  });

  it("バッジは日本語ラベルを優先して表示する(未知コードは生表示)", () => {
    expect(src).toMatch(/CODE_LABELS\[issue\.code\]\s*\?\?\s*issue\.code/);
  });
});

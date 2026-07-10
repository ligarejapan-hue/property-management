/**
 * B / P1: AuditLog.detail 返却安全化ヘルパーの挙動テスト。
 * helper は純粋関数なので mock 不要で直接検証する。
 * route 配線は既存テストと同様の source-assertion で確認する。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  sanitizeAuditDetail,
  REDACTED,
} from "../audit-log-detail-safety";

const read = (p: string) =>
  fs.readFileSync(path.resolve(process.cwd(), p), "utf8");

describe("sanitizeAuditDetail: PII キーのマスク", () => {
  it("1. ownerName / ownerAddress / email / phone を [REDACTED] にする", () => {
    const out = sanitizeAuditDetail("owner_create", {
      ownerName: "山田太郎",
      ownerAddress: "東京都港区1-2-3",
      email: "taro@example.com",
      phone: "09012345678",
    }) as Record<string, unknown>;
    expect(out.ownerName).toBe(REDACTED);
    expect(out.ownerAddress).toBe(REDACTED);
    expect(out.email).toBe(REDACTED);
    expect(out.phone).toBe(REDACTED);
  });

  it("素の name / address もマスクする", () => {
    const out = sanitizeAuditDetail("property_create", {
      name: "山田太郎",
      address: "東京都港区1-2-3",
    }) as Record<string, unknown>;
    expect(out.name).toBe(REDACTED);
    expect(out.address).toBe(REDACTED);
  });

  it("2. token / apiKey / password / secret / env を [REDACTED] にする", () => {
    const out = sanitizeAuditDetail("login", {
      token: "abc.def.ghi",
      apiKey: "sk-123",
      password: "hunter2",
      secret: "s3cr3t",
      env: "DATABASE_URL=postgres://...",
    }) as Record<string, unknown>;
    expect(out.token).toBe(REDACTED);
    expect(out.apiKey).toBe(REDACTED);
    expect(out.password).toBe(REDACTED);
    expect(out.secret).toBe(REDACTED);
    expect(out.env).toBe(REDACTED);
  });

  it("3. rawText / pdfText / text / body を [REDACTED] にする", () => {
    const out = sanitizeAuditDetail("registry_pdf_import", {
      rawText: "登記簿の本文...",
      pdfText: "謄本本文...",
      text: "貼り付けテキスト",
      body: "リクエストボディ",
    }) as Record<string, unknown>;
    expect(out.rawText).toBe(REDACTED);
    expect(out.pdfText).toBe(REDACTED);
    expect(out.text).toBe(REDACTED);
    expect(out.body).toBe(REDACTED);
  });

  it("4. lat / lng / latitude / longitude / coordinates を [REDACTED] にする", () => {
    const out = sanitizeAuditDetail("field_survey_pin", {
      lat: 35.6,
      lng: 139.7,
      latitude: 35.6,
      longitude: 139.7,
      coordinates: [35.6, 139.7],
    }) as Record<string, unknown>;
    expect(out.lat).toBe(REDACTED);
    expect(out.lng).toBe(REDACTED);
    expect(out.latitude).toBe(REDACTED);
    expect(out.longitude).toBe(REDACTED);
    expect(out.coordinates).toBe(REDACTED);
  });
});

describe("sanitizeAuditDetail: 安全キーは残す", () => {
  it("5. count / status / jobId / propertyId / dryRun などは保持する", () => {
    const out = sanitizeAuditDetail("csv_import", {
      jobId: "job-1",
      propertyId: "prop-1",
      count: 10,
      total: 12,
      status: "completed",
      action: "created",
      dryRun: false,
      confidence: 0.8,
    }) as Record<string, unknown>;
    expect(out.jobId).toBe("job-1");
    expect(out.propertyId).toBe("prop-1");
    expect(out.count).toBe(10);
    expect(out.total).toBe(12);
    expect(out.status).toBe("completed");
    expect(out.action).toBe("created");
    expect(out.dryRun).toBe(false);
    expect(out.confidence).toBe(0.8);
  });

  it("PIIフリーな filters（enum/日付）はネストして残す", () => {
    const out = sanitizeAuditDetail("csv_export", {
      filters: {
        dmStatus: "send",
        registryStatus: "obtained",
        caseStatus: "dm_target",
        keyword: "山田", // 検索語は PII の可能性 → マスク
      },
      resultCount: 5,
    }) as Record<string, unknown>;
    const filters = out.filters as Record<string, unknown>;
    expect(filters.dmStatus).toBe("send");
    expect(filters.registryStatus).toBe("obtained");
    expect(filters.caseStatus).toBe("dm_target");
    expect(filters.keyword).toBe(REDACTED);
    expect(out.resultCount).toBe(5);
  });
});

describe("sanitizeAuditDetail: ネスト / 配列 / unknown action", () => {
  it("6. ネスト object / 配列内の危険キーも再帰的にマスクする", () => {
    const out = sanitizeAuditDetail("csv_import", {
      rows: [
        { rowNumber: 1, name: "山田太郎", status: "error" },
        { rowNumber: 2, ownerAddress: "東京都...", status: "success" },
      ],
      summary: { count: 2, owner: { name: "法人A", address: "x" } },
    }) as Record<string, unknown>;
    const rows = out.rows as Array<Record<string, unknown>>;
    expect(rows[0].rowNumber).toBe(1);
    expect(rows[0].name).toBe(REDACTED);
    expect(rows[0].status).toBe("error");
    expect(rows[1].ownerAddress).toBe(REDACTED);
    expect(rows[1].status).toBe("success");
    // summary.owner は危険キー（owner）なので丸ごと [REDACTED]
    const summary = out.summary as Record<string, unknown>;
    expect(summary.count).toBe(2);
    expect(summary.owner).toBe(REDACTED);
  });

  it("7. unknown action でも危険キーは漏れず、未許可キーは [REDACTED]", () => {
    const out = sanitizeAuditDetail("totally_unknown_action", {
      ownerName: "山田太郎",
      token: "abc",
      count: 3, // ALWAYS_SAFE なので残る
      mysteryField: "??", // 未知の許可外キー → [REDACTED]
    }) as Record<string, unknown>;
    expect(out.ownerName).toBe(REDACTED);
    expect(out.token).toBe(REDACTED);
    expect(out.count).toBe(3);
    expect(out.mysteryField).toBe(REDACTED);
  });

  it("null / undefined はそのまま返す", () => {
    expect(sanitizeAuditDetail("x", null)).toBeNull();
    expect(sanitizeAuditDetail("x", undefined)).toBeUndefined();
  });

  it("detail 自体が文字列なら [REDACTED]（安全と判断できないため）", () => {
    expect(sanitizeAuditDetail("x", "山田太郎の住所")).toBe(REDACTED);
  });

  it("未知の許可外キーの値（object/配列）も [REDACTED] になる", () => {
    const out = sanitizeAuditDetail("x", {
      payload: { anything: 1 },
      list: [1, 2, 3],
    }) as Record<string, unknown>;
    expect(out.payload).toBe(REDACTED);
    expect(out.list).toBe(REDACTED);
  });
});

describe("sanitizeAuditDetail: import_job_rollback の rollback metadata 保持", () => {
  it("1/2/3. restoredFields と fieldNames/propertyId/rowNumbers/rowNumber/rowId/count/targetTable/status を保持する", () => {
    const out = sanitizeAuditDetail("import_job_rollback", {
      restoredFields: [
        {
          propertyId: "prop-1",
          fieldNames: ["address", "dmStatus"],
          rowNumbers: [1, 2],
          rowNumber: 1,
          rowId: "row-1",
          count: 2,
          targetTable: "properties",
          status: "rolled_back",
        },
      ],
    }) as Record<string, unknown>;
    expect(Array.isArray(out.restoredFields)).toBe(true);
    const rf = (out.restoredFields as Array<Record<string, unknown>>)[0];
    expect(rf.propertyId).toBe("prop-1");
    expect(rf.fieldNames).toEqual(["address", "dmStatus"]);
    expect(rf.rowNumbers).toEqual([1, 2]);
    expect(rf.rowNumber).toBe(1);
    expect(rf.rowId).toBe("row-1");
    expect(rf.count).toBe(2);
    expect(rf.targetTable).toBe("properties");
    expect(rf.status).toBe("rolled_back");
  });

  it("rollback の非PII件数メタdata deletedCount/restoredPropertyCount/restoredFieldCount/blocked を保持する", () => {
    const out = sanitizeAuditDetail("import_job_rollback", {
      deletedCount: 5,
      restoredPropertyCount: 3,
      restoredFieldCount: 12,
      blocked: false,
      restoredFields: [{ propertyId: "p1", fieldNames: ["address"] }],
    }) as Record<string, unknown>;
    expect(out.deletedCount).toBe(5);
    expect(out.restoredPropertyCount).toBe(3);
    expect(out.restoredFieldCount).toBe(12);
    expect(out.blocked).toBe(false);
    expect(
      (out.restoredFields as Array<Record<string, unknown>>)[0].fieldNames,
    ).toEqual(["address"]);
  });

  it("count メタデータと同階層に PII が混入しても PII は [REDACTED]", () => {
    const out = sanitizeAuditDetail("import_job_rollback", {
      deletedCount: 5,
      blocked: true,
      ownerName: "山田太郎",
      ownerAddress: "東京都港区1-2-3",
      email: "a@b.com",
      phone: "09000000000",
      token: "abc.def",
      rawText: "謄本本文",
      lat: 35.6,
      lng: 139.7,
      mgmtId: "M-123",
    }) as Record<string, unknown>;
    expect(out.deletedCount).toBe(5);
    expect(out.blocked).toBe(true);
    expect(out.ownerName).toBe(REDACTED);
    expect(out.ownerAddress).toBe(REDACTED);
    expect(out.email).toBe(REDACTED);
    expect(out.phone).toBe(REDACTED);
    expect(out.token).toBe(REDACTED);
    expect(out.rawText).toBe(REDACTED);
    expect(out.lat).toBe(REDACTED);
    expect(out.lng).toBe(REDACTED);
    expect(out.mgmtId).toBe(REDACTED);
  });

  it("4. restoredFields 内に混入した ownerName/ownerAddress/email/phone は [REDACTED]", () => {
    const out = sanitizeAuditDetail("import_job_rollback", {
      restoredFields: [
        {
          propertyId: "prop-1",
          fieldNames: ["address"],
          ownerName: "山田太郎",
          ownerAddress: "東京都港区1-2-3",
          email: "a@b.com",
          phone: "09000000000",
        },
      ],
    }) as Record<string, unknown>;
    const rf = (out.restoredFields as Array<Record<string, unknown>>)[0];
    expect(rf.fieldNames).toEqual(["address"]);
    expect(rf.ownerName).toBe(REDACTED);
    expect(rf.ownerAddress).toBe(REDACTED);
    expect(rf.email).toBe(REDACTED);
    expect(rf.phone).toBe(REDACTED);
  });

  it("5. unknown action では rollback専用の count/fieldNames/restoredFields を保持しない", () => {
    const out = sanitizeAuditDetail("totally_unknown_action", {
      restoredFields: [{ fieldNames: ["address"] }],
      fieldNames: ["address"],
      deletedCount: 5,
      restoredPropertyCount: 3,
      restoredFieldCount: 12,
      blocked: false,
    }) as Record<string, unknown>;
    expect(out.restoredFields).toBe(REDACTED);
    expect(out.fieldNames).toBe(REDACTED);
    expect(out.deletedCount).toBe(REDACTED);
    expect(out.restoredPropertyCount).toBe(REDACTED);
    expect(out.restoredFieldCount).toBe(REDACTED);
    expect(out.blocked).toBe(REDACTED);
  });

  it("他 action（csv_export 等）でも fieldNames は危険キーとしてマスクされる", () => {
    const out = sanitizeAuditDetail("csv_export", {
      fieldNames: ["address"],
      resultCount: 3,
    }) as Record<string, unknown>;
    expect(out.fieldNames).toBe(REDACTED);
    expect(out.resultCount).toBe(3);
  });
});

describe("sanitizeAuditDetail: corporateNumber 生値はマスク / summary は保持", () => {
  it("1. corporateNumber（生値）は [REDACTED]", () => {
    const out = sanitizeAuditDetail("owner_corporate_apply", {
      corporateNumber: "1234567890123",
    }) as Record<string, unknown>;
    expect(out.corporateNumber).toBe(REDACTED);
  });

  it("2. corporateNumberCount / *MatchedCount / *HitCount / *AppliedCount / hasCorporateNumber は保持", () => {
    const out = sanitizeAuditDetail("owner_corporate_lookup", {
      corporateNumberCount: 3,
      corporateNumberMatchedCount: 2,
      corporateNumberHitCount: 5,
      corporateNumberAppliedCount: 1,
      hasCorporateNumber: true,
    }) as Record<string, unknown>;
    expect(out.corporateNumberCount).toBe(3);
    expect(out.corporateNumberMatchedCount).toBe(2);
    expect(out.corporateNumberHitCount).toBe(5);
    expect(out.corporateNumberAppliedCount).toBe(1);
    expect(out.hasCorporateNumber).toBe(true);
  });

  it("3. nested object / array 内の corporateNumber 生値も [REDACTED]", () => {
    const out = sanitizeAuditDetail("import_job_rollback", {
      summary: { corporateNumber: "9876543210987" },
      restoredFields: [{ propertyId: "p1", corporateNumber: "1112223334445" }],
    }) as Record<string, unknown>;
    expect((out.summary as Record<string, unknown>).corporateNumber).toBe(
      REDACTED,
    );
    const rf = (out.restoredFields as Array<Record<string, unknown>>)[0];
    expect(rf.propertyId).toBe("p1");
    expect(rf.corporateNumber).toBe(REDACTED);
  });

  it("4. corporateNumber 削除後も rollback metadata は保持される", () => {
    const out = sanitizeAuditDetail("import_job_rollback", {
      deletedCount: 5,
      restoredPropertyCount: 3,
      restoredFieldCount: 12,
      blocked: false,
      restoredFields: [
        { propertyId: "p1", fieldNames: ["address"], rowNumbers: [1] },
      ],
    }) as Record<string, unknown>;
    expect(out.deletedCount).toBe(5);
    expect(out.restoredPropertyCount).toBe(3);
    expect(out.restoredFieldCount).toBe(12);
    expect(out.blocked).toBe(false);
    const rf = (out.restoredFields as Array<Record<string, unknown>>)[0];
    expect(rf.fieldNames).toEqual(["address"]);
    expect(rf.rowNumbers).toEqual([1]);
  });
});

describe("sanitizeAuditDetail: update監査 updatedFields / CSV import counters 保持", () => {
  it("1/2. updatedFields(フィールド名配列)は保持し、oldValue/newValue/value/PII はマスク", () => {
    const out = sanitizeAuditDetail("property_update", {
      updatedFields: ["address", "dmStatus", "registryStatus"],
      oldValue: "旧住所の値",
      newValue: "新住所の値",
      value: "東京都港区1-2-3",
      ownerName: "山田太郎",
      address: "東京都港区1-2-3",
      email: "a@b.com",
      phone: "09000000000",
    }) as Record<string, unknown>;
    expect(out.updatedFields).toEqual(["address", "dmStatus", "registryStatus"]);
    expect(out.oldValue).toBe(REDACTED);
    expect(out.newValue).toBe(REDACTED);
    expect(out.value).toBe(REDACTED);
    expect(out.ownerName).toBe(REDACTED);
    expect(out.address).toBe(REDACTED);
    expect(out.email).toBe(REDACTED);
    expect(out.phone).toBe(REDACTED);
  });

  it("3/4/5. CSV import summary counters (totalRows/successCount/updateCount/errorCount/needsReviewCount) を保持", () => {
    const out = sanitizeAuditDetail("csv_import", {
      totalRows: 100,
      successCount: 90,
      updateCount: 40,
      errorCount: 5,
      needsReviewCount: 5,
    }) as Record<string, unknown>;
    expect(out.totalRows).toBe(100);
    expect(out.successCount).toBe(90);
    expect(out.updateCount).toBe(40);
    expect(out.errorCount).toBe(5);
    expect(out.needsReviewCount).toBe(5);
  });

  it("updatedFields の値が object でも内部の PII キーはマスクされる", () => {
    const out = sanitizeAuditDetail("property_update", {
      updatedFields: { ownerName: "山田太郎", dmStatus: "send" },
    }) as Record<string, unknown>;
    const uf = out.updatedFields as Record<string, unknown>;
    expect(uf.ownerName).toBe(REDACTED);
    expect(uf.dmStatus).toBe("send");
  });
});

describe("postal_code_audit: 郵便番号照合レポートの操作メタデータ allowlist", () => {
  // 郵便番号照合レポート（read-only）の閲覧/CSV 出力監査。detail は件数/真偽/数値
  // メタデータのみ（apiConfigured/truncated/timeBudgetExhausted=bool・processed/
  // notProcessed/maxTargets/timeBudgetMs=数値）+ summary 子キー match/mismatch/
  // indeterminate(数値)。owner名/zip/address 等の PII は route 側で記録しないが、
  // 万一混入しても allowlist 外 + denylist で [REDACTED] を維持する。
  const POSTAL_AUDIT_ACTIONS = [
    "postal_code_audit_list",
    "postal_code_audit_csv_export",
  ];

  it("list/csv: bool/数値メタデータ + summary 子件数を保持する", () => {
    for (const action of POSTAL_AUDIT_ACTIONS) {
      const out = sanitizeAuditDetail(action, {
        apiConfigured: true,
        truncated: false,
        timeBudgetExhausted: false,
        processed: 120,
        notProcessed: 0,
        maxTargets: 200,
        timeBudgetMs: 45000,
        summary: {
          total: 120,
          match: 100,
          mismatch: 15,
          indeterminate: 5,
        },
      }) as Record<string, unknown>;
      expect(out.apiConfigured).toBe(true);
      expect(out.truncated).toBe(false);
      expect(out.timeBudgetExhausted).toBe(false);
      expect(out.processed).toBe(120);
      expect(out.notProcessed).toBe(0);
      expect(out.maxTargets).toBe(200);
      expect(out.timeBudgetMs).toBe(45000);
      const summary = out.summary as Record<string, unknown>;
      expect(summary.total).toBe(120);
      expect(summary.match).toBe(100);
      expect(summary.mismatch).toBe(15);
      expect(summary.indeterminate).toBe(5);
    }
  });

  it("万一 PII（owner名/zip/address/rows）が混入しても [REDACTED]", () => {
    const out = sanitizeAuditDetail("postal_code_audit_list", {
      apiConfigured: true,
      processed: 1,
      ownerName: "山田太郎",
      owner: { name: "山田太郎" },
      zip: "1000001",
      address: "東京都千代田区千代田1-1",
      // route は rows を audit detail に書かないが、万一混入した場合の防御も確認する。
      rows: [{ ownerName: "山田太郎", verdict: "mismatch" }],
    }) as Record<string, unknown>;
    expect(out.apiConfigured).toBe(true);
    expect(out.processed).toBe(1);
    expect(out.ownerName).toBe(REDACTED);
    expect(out.owner).toBe(REDACTED);
    expect(out.zip).toBe(REDACTED);
    expect(out.address).toBe(REDACTED);
    // rows は構造コンテナとして通過するが、内部の ownerName(PII)・verdict(未許可キー)
    // はともにマスクされる（postal action では verdict を allowlist 化していない）。
    const rows = out.rows as Array<Record<string, unknown>>;
    expect(rows[0].ownerName).toBe(REDACTED);
    expect(rows[0].verdict).toBe(REDACTED);
  });

  it("数値キーに非数値が来たら（PII 流入の恐れ）[REDACTED]", () => {
    const out = sanitizeAuditDetail("postal_code_audit_list", {
      processed: "山田太郎",
      notProcessed: { evil: 1 },
      maxTargets: ["x"],
      timeBudgetMs: "45000ms",
      summary: {
        match: "東京都千代田区",
        mismatch: 15,
        indeterminate: 5,
      },
    }) as Record<string, unknown>;
    expect(out.processed).toBe(REDACTED);
    expect(out.notProcessed).toBe(REDACTED);
    expect(out.maxTargets).toBe(REDACTED);
    expect(out.timeBudgetMs).toBe(REDACTED);
    const summary = out.summary as Record<string, unknown>;
    expect(summary.match).toBe(REDACTED);
    expect(summary.mismatch).toBe(15);
    expect(summary.indeterminate).toBe(5);
  });

  it("未登録 action では postal_code_audit メタデータを保持しない", () => {
    const out = sanitizeAuditDetail("some_other_action", {
      apiConfigured: true,
      truncated: false,
      timeBudgetExhausted: false,
      processed: 1,
      notProcessed: 0,
      maxTargets: 200,
      timeBudgetMs: 45000,
    }) as Record<string, unknown>;
    expect(out.apiConfigured).toBe(REDACTED);
    expect(out.truncated).toBe(REDACTED);
    expect(out.timeBudgetExhausted).toBe(REDACTED);
    expect(out.processed).toBe(REDACTED);
    expect(out.notProcessed).toBe(REDACTED);
    expect(out.maxTargets).toBe(REDACTED);
    expect(out.timeBudgetMs).toBe(REDACTED);
  });

  it("route 配線: postal-code-audit route が両 action 名で writeAuditLog する", () => {
    const routeSrc = read("src/app/api/admin/postal-code-audit/route.ts");
    expect(routeSrc).toMatch(/postal_code_audit_csv_export/);
    expect(routeSrc).toMatch(/postal_code_audit_list/);
  });
});

describe("admin/audit-logs route 配線（source-assertion）", () => {
  const routeSrc = read("src/app/api/admin/audit-logs/route.ts");

  it("8. route が sanitizeAuditDetail を import し logs に適用して返す", () => {
    expect(routeSrc).toMatch(
      /import \{ sanitizeAuditDetail \} from "@\/lib\/audit-log-detail-safety"/,
    );
    expect(routeSrc).toMatch(/sanitizeAuditDetail\(log\.action, log\.detail\)/);
    expect(routeSrc).toMatch(/data: safeLogs/);
  });

  it("9. audit_log:read 権限ゲートを維持している", () => {
    expect(routeSrc).toMatch(/hasPermission\(perms, "audit_log", "read"\)/);
    expect(routeSrc).toMatch(/throw new ApiError\(403/);
  });
});

describe("S1b-3: copy/print 監査 action の detail 安全化", () => {
  const S1B3_ACTIONS = [
    "pii_copy_attempt",
    "pii_cut_attempt",
    "pii_contextmenu_attempt",
    "pii_print_attempt",
  ];

  it("surface / trigger は許可キーとして残る", () => {
    for (const action of S1B3_ACTIONS) {
      const out = sanitizeAuditDetail(action, {
        surface: "owner",
        trigger: "clipboard",
      }) as Record<string, unknown>;
      expect(out.surface).toBe("owner");
      expect(out.trigger).toBe("clipboard");
    }
  });

  it("万一 PII / URL / path / 選択テキストが混入しても [REDACTED]", () => {
    const out = sanitizeAuditDetail("pii_copy_attempt", {
      surface: "property",
      trigger: "menu",
      url: "/properties/abc-123",
      path: "/properties/abc-123",
      ownerName: "山田太郎",
      selectedText: "東京都港区1-2-3",
    }) as Record<string, unknown>;
    expect(out.surface).toBe("property");
    expect(out.trigger).toBe("menu");
    expect(out.url).toBe(REDACTED);
    expect(out.path).toBe(REDACTED);
    expect(out.ownerName).toBe(REDACTED);
    expect(out.selectedText).toBe(REDACTED);
  });

  it("surface / trigger は未登録 action では保持しない", () => {
    const out = sanitizeAuditDetail("some_other_action", {
      surface: "owner",
      trigger: "clipboard",
    }) as Record<string, unknown>;
    expect(out.surface).toBe(REDACTED);
    expect(out.trigger).toBe(REDACTED);
  });
});

describe("display_name_audit_view: 操作メタデータ allowlist（Codex P2）", () => {
  // 表示名監査 API（PII/CSV 監査エンドポイント）が書く非PIIメタデータは
  // audit-logs 画面で保持されるべき。owner-prefixed キーは /owner/i denylist に
  // 当たるため、件数(数値)/真偽だけ action 固有で force-safe 化する。
  it("entity / format / *GroupCount / *Truncated / ownerNameVisible / viewedAt を保持する", () => {
    const out = sanitizeAuditDetail("display_name_audit_view", {
      entity: "all",
      format: "csv",
      ownerGroupCount: 3,
      ownerTruncated: true,
      ownerNameVisible: true,
      buildingGroupCount: 5,
      buildingTruncated: false,
      viewedAt: "2026-06-14T00:00:00.000Z",
    }) as Record<string, unknown>;
    expect(out.entity).toBe("all");
    expect(out.format).toBe("csv");
    expect(out.ownerGroupCount).toBe(3);
    expect(out.ownerTruncated).toBe(true);
    expect(out.ownerNameVisible).toBe(true);
    expect(out.buildingGroupCount).toBe(5);
    expect(out.buildingTruncated).toBe(false);
    expect(out.viewedAt).toBe("2026-06-14T00:00:00.000Z");
  });

  it("万一 PII（生 name/owner オブジェクト/住所）が混入しても [REDACTED]", () => {
    const out = sanitizeAuditDetail("display_name_audit_view", {
      entity: "owner",
      ownerGroupCount: 1,
      ownerName: "山田太郎",
      owner: { name: "山田太郎" },
      address: "東京都港区1-2-3",
    }) as Record<string, unknown>;
    expect(out.entity).toBe("owner");
    expect(out.ownerGroupCount).toBe(1);
    expect(out.ownerName).toBe(REDACTED);
    expect(out.owner).toBe(REDACTED);
    expect(out.address).toBe(REDACTED);
  });

  it("ownerGroupCount に非数値が来たら（PII 流入の恐れ）[REDACTED]", () => {
    const out = sanitizeAuditDetail("display_name_audit_view", {
      ownerGroupCount: "山田太郎",
    }) as Record<string, unknown>;
    expect(out.ownerGroupCount).toBe(REDACTED);
  });

  it("未登録 action では entity/format/ownerGroupCount 等を保持しない", () => {
    const out = sanitizeAuditDetail("some_other_action", {
      entity: "all",
      format: "csv",
      ownerGroupCount: 3,
      ownerTruncated: true,
      ownerNameVisible: true,
      buildingGroupCount: 5,
      viewedAt: "2026-06-14T00:00:00.000Z",
    }) as Record<string, unknown>;
    expect(out.entity).toBe(REDACTED);
    expect(out.format).toBe(REDACTED);
    expect(out.ownerGroupCount).toBe(REDACTED);
    expect(out.ownerTruncated).toBe(REDACTED);
    expect(out.ownerNameVisible).toBe(REDACTED);
    expect(out.buildingGroupCount).toBe(REDACTED);
    expect(out.viewedAt).toBe(REDACTED);
  });
});

describe("sanitizeAuditDetail: 売却促進DM の識別子は管理画面で追跡可能に保持", () => {
  it("campaignId / variantId は ALWAYS_SAFE(UUID識別子)として残す", () => {
    const out = sanitizeAuditDetail("sale_dm_variant_update", {
      campaignId: "c-uuid",
      variantId: "v-uuid",
      fields: ["tone"],
    }) as Record<string, unknown>;
    expect(out.campaignId).toBe("c-uuid");
    expect(out.variantId).toBe("v-uuid");
    expect(out.fields).toEqual(["tone"]);
  });

  it("識別子を残しても PII キー(ownerName/address)は引き続き [REDACTED]", () => {
    const out = sanitizeAuditDetail("sale_dm_campaign_create", {
      campaignId: "c-uuid",
      ownerName: "田中 一郎",
      address: "東京都〇〇区",
    }) as Record<string, unknown>;
    expect(out.campaignId).toBe("c-uuid");
    expect(out.ownerName).toBe(REDACTED);
    expect(out.address).toBe(REDACTED);
  });

  it("sale_dm_* の操作メタ(件数/enum/boolean/ISO日時)は action 固有 allowlist で残す", () => {
    const create = sanitizeAuditDetail("sale_dm_campaign_create", {
      campaignId: "c", requested: 10, generated: 9, failed: 1, truncated: false, createdAt: "2026-06-28T00:00:00Z",
    }) as Record<string, unknown>;
    expect(create.requested).toBe(10);
    expect(create.generated).toBe(9);
    expect(create.truncated).toBe(false);
    expect(create.createdAt).toBe("2026-06-28T00:00:00Z");

    const outcome = sanitizeAuditDetail("sale_dm_draft_outcome_update", {
      propertyId: "p", deliveryStatus: "delivered", outcome: "inquiry",
      undeliverableLinked: false, undeliverableCleared: true, updatedAt: "2026-06-28T00:00:00Z",
    }) as Record<string, unknown>;
    expect(outcome.deliveryStatus).toBe("delivered");
    expect(outcome.outcome).toBe("inquiry");
    expect(outcome.undeliverableCleared).toBe(true);
  });

  it("sale_dm_campaign_view(ワークスペース閲覧監査)は campaignId/count/viewedAt を残し PII を [REDACTED]", () => {
    const view = sanitizeAuditDetail("sale_dm_campaign_view", {
      campaignId: "c-uuid",
      count: 12,
      viewedAt: "2026-06-30T00:00:00Z",
      recipientName: "田中 一郎",
      recipientAddress: "東京都〇〇区",
      body: "本文",
    }) as Record<string, unknown>;
    expect(view.campaignId).toBe("c-uuid");
    expect(view.count).toBe(12);
    expect(view.viewedAt).toBe("2026-06-30T00:00:00Z");
    // PII(宛名/住所/本文)は allowlist 外 + denylist で必ずマスク。
    expect(view.recipientName).toBe(REDACTED);
    expect(view.recipientAddress).toBe(REDACTED);
    expect(view.body).toBe(REDACTED);
  });

  it("action 固有 allowlist はスコープされる: 未登録 action では sale_dm の操作メタは残らない", () => {
    const out = sanitizeAuditDetail("unknown_action", { generated: 9, regeneratedAt: "x" }) as Record<string, unknown>;
    expect(out.generated).toBe(REDACTED);
    expect(out.regeneratedAt).toBe(REDACTED);
  });
});

describe("sanitizeAuditDetail: 設定更新監査の target/changed を保持(@codex)", () => {
  it("sale_dm_settings_update は target(singleton)/fields を保持・値混入は [REDACTED]", () => {
    const out = sanitizeAuditDetail("sale_dm_settings_update", {
      target: "singleton",
      fields: ["provider", "anthropicApiKey"],
      provider: "claude",
      anthropicApiKey: "sk-secret",
    }) as Record<string, unknown>;
    expect(out.target).toBe("singleton");
    expect(out.fields).toEqual(["provider", "anthropicApiKey"]);
    expect(out.provider).toBe("claude");
    expect(out.anthropicApiKey).toBe(REDACTED);
  });

  it("registry_settings_update は target(singleton)/changed を保持・値混入は [REDACTED]", () => {
    const out = sanitizeAuditDetail("registry_settings_update", {
      target: "singleton",
      changed: ["loginId", "password"],
      password: "hunter2",
    }) as Record<string, unknown>;
    expect(out.target).toBe("singleton");
    expect(out.changed).toEqual(["loginId", "password"]);
    expect(out.password).toBe(REDACTED);
  });
});

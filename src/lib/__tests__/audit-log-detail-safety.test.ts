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

  it("5. unknown action では fieldNames / restoredFields を保持しない", () => {
    const out = sanitizeAuditDetail("totally_unknown_action", {
      restoredFields: [{ fieldNames: ["address"] }],
      fieldNames: ["address"],
    }) as Record<string, unknown>;
    expect(out.restoredFields).toBe(REDACTED);
    expect(out.fieldNames).toBe(REDACTED);
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

import { describe, it, expect } from "vitest";
import { inquiryAuditDetail } from "@/lib/agent-inquiry/audit-detail";

describe("監査 detail は項目名と状態の値だけ(設計 §4)", () => {
  it("許可された項目名だけ残す・値は入れない", () => {
    expect(inquiryAuditDetail(["status", "contactMobile", "note", "evil<script>"], { status: "done" }))
      .toEqual({ changed: ["contactMobile", "note", "status"], status: "done" });
  });
  it("状態・用件の値も列挙値以外は落とす", () => {
    expect(inquiryAuditDetail([], { status: "090-1234-5678", kind: "viewing" })).toEqual({ changed: [], kind: "viewing" });
  });
});

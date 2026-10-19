import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../material-send-dialog", () => ({
  MaterialSendDialog: () => <div>小窓</div>,
  MaterialSendHistory: () => <div>資料送付の記録</div>,
}));
vi.mock("@/components/ui/modal-shell", () => ({
  ModalShell: ({ children, footer }: { children: React.ReactNode; footer: React.ReactNode }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));
import { InquiryDetailView } from "../inquiry-detail";
import type { InquiryView } from "@/lib/api-client";

const base = {
  id: "i1", status: "open", channel: "phone", receivedAt: "2026-10-18T00:00:00Z", version: 1,
  contactName: "佐藤", contactMobile: null, contactEmail: "sato@agent.jp", note: null, assignee: null,
  agent: { id: "g1", companyName: "△△不動産", branchName: null, phone: "03-1234-5678" }, viewings: [],
  property: { id: "p1", name: "サンプル荘", roomNo: null, town: "品川区", propertyType: "house", adPermissions: {} },
};
const noop = () => {};
const view = (kind: string, canSendMaterial?: boolean) =>
  renderToStaticMarkup(
    <InquiryDetailView
      inquiry={{ ...base, kind } as unknown as InquiryView}
      canOpenProperty
      users={[]}
      busy={false}
      error={null}
      onStatus={noop}
      onAssignee={noop}
      onSaveNote={noop}
      onAddViewing={noop}
      onSaveViewing={noop}
      onClose={noop}
      canSendMaterial={canSendMaterial}
    />,
  );

describe("反響の詳細の「資料を送る」", () => {
  it("資料請求で送れる人にだけボタンが出る", () => {
    expect(view("material_request", true)).toContain(">資料を送る</button>");
    expect(view("material_request", false)).not.toContain(">資料を送る</button>");
    expect(view("material_request")).not.toContain(">資料を送る</button>");
    expect(view("viewing", true)).not.toContain(">資料を送る</button>");
  });
  it("資料請求なら送った記録を出す(送れない人にも)", () => {
    expect(view("material_request", false)).toContain("資料送付の記録");
    expect(view("ad_permission", true)).not.toContain("資料送付の記録");
  });
});

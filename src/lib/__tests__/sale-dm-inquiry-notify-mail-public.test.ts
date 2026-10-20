import { describe, it, expect } from "vitest";
import { buildInquiryNotifyMail, type InquiryNotifyFacts } from "@/lib/sale-dm-letter/inquiry-notify-mail";

/** 広告用の公開ページからの申込(設計 2026-10-20): 宛先・物件・DM型・LP型が無い。 */
const F: InquiryNotifyFacts = {
  inquiryId: "11111111-1111-4111-8111-111111111111",
  submittedAt: new Date("2026-10-20T05:05:00Z"),
  campaignName: "広告ページ(相続)",
  dmVariantLabel: null,
  lpVariantLabel: null,
  location: null,
  propertyTypeLabel: null,
  name: "山田 太郎",
  phone: "090-1234-5678",
  email: "taro@example.jp",
  contactPref: "phone",
  contactTime: "平日夜",
  message: "相談したい",
  source: "public",
  propertyAddress: "世田谷区経堂1-2-3",
  ad: { utmSource: "google", utmMedium: "cpc", utmCampaign: "秋キャンペーン" },
};

describe("buildInquiryNotifyMail(広告ページからの申込)", () => {
  it("件名=【査定申込】広告ページ(相続)(所在地不明の物件とは書かない)", () => {
    expect(buildInquiryNotifyMail(F, { detail: "minimal", appBaseUrl: null }).subject).toBe("【査定申込】広告ページ(相続)");
  });
  it("minimal: 出どころの行はあり・DM型/LP型の行は無し・所在地は「入力あり」とだけ書き中身は出さない・経路も出さない", () => {
    const { text } = buildInquiryNotifyMail(F, { detail: "minimal", appBaseUrl: null });
    expect(text).toContain("広告用のご案内ページから査定のお申込みが届きました。");
    expect(text).toContain("出どころ: 広告ページ(相続)");
    expect(text).not.toContain("キャンペーン:");
    expect(text).not.toContain("DM型:");
    expect(text).toContain("物件の所在地: 入力あり");
    expect(text).not.toContain("世田谷区経堂");
    expect(text).not.toContain("経路:");
    expect(text).not.toContain("google");
  });
  it("full: 所在地の中身と経路(utm_source / utm_medium / utm_campaign)を出す", () => {
    const { text } = buildInquiryNotifyMail(F, { detail: "full", appBaseUrl: null });
    expect(text).toContain("物件の所在地: 世田谷区経堂1-2-3");
    expect(text).toContain("経路: google / cpc / 秋キャンペーン");
    expect(text).toContain("電話: 090-1234-5678");
  });
  it("所在地の入力が無ければ「記入なし」・経路が全部無ければ経路の行を出さない・改行は1行に", () => {
    const { text } = buildInquiryNotifyMail(
      { ...F, propertyAddress: null, ad: { utmSource: null, utmMedium: null, utmCampaign: "a\nb" } },
      { detail: "full", appBaseUrl: null },
    );
    expect(text).toContain("物件の所在地: 記入なし");
    expect(text).toContain("経路: - / - / a b");
    const none = buildInquiryNotifyMail({ ...F, ad: { utmSource: null, utmMedium: null, utmCampaign: null } }, { detail: "full", appBaseUrl: null }).text;
    expect(none).not.toContain("経路:");
  });
  it("DM からの申込(source=dm)の文面は今までどおり(回帰なし)", () => {
    const dm: InquiryNotifyFacts = { ...F, source: "dm", campaignName: "9月 空き家", dmVariantLabel: "A", lpVariantLabel: "安心", location: "世田谷区代沢", propertyTypeLabel: "戸建", propertyAddress: null, ad: null };
    const m = buildInquiryNotifyMail(dm, { detail: "full", appBaseUrl: null });
    expect(m.subject).toBe("【査定申込】世田谷区代沢の戸建(9月 空き家)");
    expect(m.text).toContain("公開LPから査定のお申込みが届きました。");
    expect(m.text).toContain("キャンペーン: 9月 空き家");
    expect(m.text).toContain("DM型: A / LP型: 安心");
    expect(m.text).toContain("物件: 世田谷区代沢の戸建");
    expect(m.text).not.toContain("出どころ:");
    expect(m.text).not.toContain("物件の所在地:");
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "crypto";

vi.mock("@/lib/prisma", () => ({ default: { mailConfig: { findUnique: vi.fn() } } }));
import prisma from "@/lib/prisma";
import { loadMailSendConfig, isMailConfigComplete } from "@/lib/mail/mail-config";
import { encryptSecret } from "@/lib/sale-dm-letter/secret-crypto";

const find = vi.mocked((prisma as unknown as { mailConfig: { findUnique: (a: unknown) => unknown } }).mailConfig.findUnique);
let saved: string | undefined;
beforeEach(() => { saved = process.env.SALE_DM_SETTINGS_ENC_KEY; process.env.SALE_DM_SETTINGS_ENC_KEY = crypto.randomBytes(32).toString("base64"); });
afterEach(() => { if (saved === undefined) delete process.env.SALE_DM_SETTINGS_ENC_KEY; else process.env.SALE_DM_SETTINGS_ENC_KEY = saved; vi.clearAllMocks(); });

const base = () => ({ smtpHost: "sv1.xserver.jp", smtpPort: 465, smtpSecure: true, smtpUser: "info@ligarejapan.com", smtpPassEnc: encryptSecret("pw"), fromAddress: "info@ligarejapan.com", appBaseUrl: "https://pm.example.ts.net", inquiryMailDetail: "minimal" });

describe("loadMailSendConfig", () => {
  it("揃っていれば復号して返す", async () => {
    find.mockResolvedValue(base() as never);
    expect(await loadMailSendConfig()).toEqual({ host: "sv1.xserver.jp", port: 465, secure: true, user: "info@ligarejapan.com", pass: "pw", from: "info@ligarejapan.com", appBaseUrl: "https://pm.example.ts.net", inquiryMailDetail: "minimal" });
  });
  it.each(["smtpHost", "smtpPort", "smtpUser", "smtpPassEnc", "fromAddress"])("%s が無ければ null", async (k) => {
    find.mockResolvedValue({ ...base(), [k]: null } as never);
    expect(await loadMailSendConfig()).toBeNull();
  });
  it("行が無い・復号失敗・DB 例外は null", async () => {
    find.mockResolvedValue(null as never);
    expect(await loadMailSendConfig()).toBeNull();
    find.mockResolvedValue({ ...base(), smtpPassEnc: "v1:broken" } as never);
    expect(await loadMailSendConfig()).toBeNull();
    find.mockRejectedValue(new Error("db down"));
    expect(await loadMailSendConfig()).toBeNull();
  });
  it("未知の inquiryMailDetail は minimal", async () => {
    find.mockResolvedValue({ ...base(), inquiryMailDetail: "everything" } as never);
    expect((await loadMailSendConfig())?.inquiryMailDetail).toBe("minimal");
  });
  it("isMailConfigComplete", () => {
    expect(isMailConfigComplete(null)).toBe(false);
    expect(isMailConfigComplete(base())).toBe(true);
  });
});

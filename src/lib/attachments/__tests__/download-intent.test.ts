import { describe, it, expect } from "vitest";
import { sendsDownloadIntent } from "../download-intent";

describe("sendsDownloadIntent(ダウンロードで保存として受け取らせる書類)", () => {
  it.each(["registry", "referral", "report"])("★%s は download=1 を付ける(@codex PR#500 16巡目)", (type) => {
    expect(sendsDownloadIntent(type)).toBe(true);
  });
  it.each(["general", null, undefined])("%s は付けない(従来どおり)", (type) => {
    expect(sendsDownloadIntent(type)).toBe(false);
  });
});

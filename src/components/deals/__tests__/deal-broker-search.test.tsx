import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { brokerSearchAccess, DealBrokerSearch } from "../deal-broker-search";

const withCode = (code: string) => Object.assign(new Error("x"), { code });

describe("相手方の仲介会社を探す欄", () => {
  it("探す欄を出す・新しく登録の案内は出さない", () => {
    const html = renderToStaticMarkup(<DealBrokerSearch onPick={() => {}} />);
    expect(html).toContain('aria-label="業者を探す"');
    expect(html).not.toContain("新しく登録");
  });
  it("権限なし(403)だけ知らせる", () => {
    const onForbidden = vi.fn();
    const access = brokerSearchAccess(onForbidden);
    expect(access.readDenied(withCode("FORBIDDEN"))).toBe(true);
    expect(onForbidden).toHaveBeenCalledTimes(1);
  });
  it("通信の失敗やログイン切れは今までの検索失敗のまま", () => {
    const onForbidden = vi.fn();
    const access = brokerSearchAccess(onForbidden);
    expect(access.readDenied(new Error("network"))).toBe(false);
    expect(access.readDenied(withCode("UNAUTHORIZED"))).toBe(false);
    expect(onForbidden).not.toHaveBeenCalled();
  });
});

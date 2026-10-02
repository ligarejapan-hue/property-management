import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INQUIRY_SYNC_CHANNEL, notifyInquiryChanged, onInquiryChanged } from "@/lib/agent-inquiry/desk-sync";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

/** 同じ名前の相手(自分以外)へ届ける、最小限の偽物。 */
class FakeChannel {
  static all: FakeChannel[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  closed = false;
  constructor(public name: string) {
    FakeChannel.all.push(this);
  }
  postMessage(data: unknown) {
    for (const c of FakeChannel.all) if (c !== this && !c.closed && c.name === this.name) c.onmessage?.({ data });
  }
  close() {
    this.closed = true;
  }
}
afterEach(() => {
  FakeChannel.all = [];
  vi.unstubAllGlobals();
});

describe("窓どうしの合図", () => {
  it("別の窓が変わったと知らせると、聞いている側が呼ばれる・やめたら呼ばれない", () => {
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    const cb = vi.fn();
    const off = onInquiryChanged(cb);
    new FakeChannel(INQUIRY_SYNC_CHANNEL).postMessage({ type: "changed", from: "other-window" });
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    new FakeChannel(INQUIRY_SYNC_CHANNEL).postMessage({ type: "changed", from: "other-window" });
    expect(cb).toHaveBeenCalledTimes(1);
  });
  it("合図の中身は「変わった」と窓ごとの印だけ(名前・電話・反響の id を載せない)", () => {
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    const seen: unknown[] = [];
    const listener = new FakeChannel(INQUIRY_SYNC_CHANNEL);
    listener.onmessage = (e) => seen.push(e.data);
    notifyInquiryChanged();
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0] as object).sort()).toEqual(["from", "type"]);
    expect((seen[0] as { type: string }).type).toBe("changed");
  });
  it("★同じ窓が出した合図は聞かない(自分の保存で2回読み直さない)", () => {
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    const cb = vi.fn();
    onInquiryChanged(cb);
    notifyInquiryChanged();
    expect(cb).not.toHaveBeenCalled();
  });
  it("知らない合図では呼ばない", () => {
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    const cb = vi.fn();
    onInquiryChanged(cb);
    new FakeChannel(INQUIRY_SYNC_CHANNEL).postMessage({ type: "other" });
    new FakeChannel(INQUIRY_SYNC_CHANNEL).postMessage(null);
    expect(cb).not.toHaveBeenCalled();
  });
  it("知らせた側の通り道は閉じる(開きっぱなしにしない)", () => {
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    notifyInquiryChanged();
    expect(FakeChannel.all).toHaveLength(1);
    expect(FakeChannel.all.every((c) => c.closed)).toBe(true);
  });
  it("★BroadcastChannel が無いブラウザでも何も起きない(落ちない)", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    expect(() => notifyInquiryChanged()).not.toThrow();
    expect(() => onInquiryChanged(() => {})()).not.toThrow();
  });
  it("★作るときに例外を投げる環境でも落ちない", () => {
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        constructor() {
          throw new Error("blocked");
        }
      },
    );
    expect(() => notifyInquiryChanged()).not.toThrow();
    expect(() => onInquiryChanged(() => {})()).not.toThrow();
  });
});

describe("受付の窓は、保存・変更のたびに合図を出す", () => {
  it("reloadAll の中で notifyInquiryChanged を呼ぶ", () => {
    const src = read("src/app/(desk)/inquiry-desk/page.tsx");
    const at = src.indexOf("const reloadAll = useCallback(");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 200)).toContain("notifyInquiryChanged()");
  });
});

describe("窓の名前", () => {
  it("メイン画面の枠は pm-main を名乗る(名前が空のときだけ)", () => {
    const src = read("src/components/layout/dashboard-layout.tsx");
    expect(src).toContain("windowNameFor(window.name, MAIN_WINDOW_NAME)");
  });
  it("受付の窓の枠は pm-inquiry-desk を名乗る(ブックマークから開いても2枚目が増えない)", () => {
    const src = read("src/components/agent-inquiry/desk-shell.tsx");
    expect(src).toContain("windowNameFor(window.name, DESK_WINDOW_NAME)");
  });
  it("メニューの窓の名前と同じ値を使っている", () => {
    expect(read("src/components/layout/sidebar-model.tsx")).toContain('windowName: "pm-inquiry-desk"');
    expect(read("src/components/agent-inquiry/inquiry-detail.tsx")).toContain('target="pm-main"');
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearHandoff,
  peekHandoff,
  peekHandoffEntry,
  peekHandoffFile,
  putHandoff,
  recallReception,
  rememberReception,
} from "../handoff";

const pdf = new File(["%PDF-"], "謄本.pdf", { type: "application/pdf" });

beforeEach(() => {
  clearHandoff("registry_pdf");
  clearHandoff("reception");
  clearHandoff("owner");
  clearHandoff("lead_excel");
  clearHandoff("paste_pdf");
});

describe("handoff(取り込みの画面へファイルを持って進む)", () => {
  it("あての画面だけが読める。読むだけでは消えない(開発時の二重の初期化でも2回目が空にならない)", () => {
    putHandoff({ target: "registry_pdf", file: pdf });
    expect(peekHandoffFile("paste_pdf")).toBeNull();
    expect(peekHandoffFile("registry_pdf")).toBe(pdf);
    expect(peekHandoffFile("registry_pdf")).toBe(pdf);
  });

  it("受け取り終えたら消す(ほかの画面あてのものは消さない)", () => {
    putHandoff({ target: "registry_pdf", file: pdf });
    clearHandoff("paste_pdf");
    expect(peekHandoffFile("registry_pdf")).toBe(pdf);
    clearHandoff("registry_pdf");
    expect(peekHandoffFile("registry_pdf")).toBeNull();
  });

  it("受付帳・所有者は読んだ中身を渡す", () => {
    putHandoff({ target: "owner", entry: { name: "所有者.csv", csvText: "所有者氏名\n山田" } });
    expect(peekHandoffEntry("reception")).toBeNull();
    expect(peekHandoffEntry("owner")).toEqual({ name: "所有者.csv", csvText: "所有者氏名\n山田" });
  });

  it("受付帳の画面の受付帳は、控えとは別に覚えておける(所有者だけ持って戻るとき用・@codex #607 P2)", () => {
    rememberReception({ name: "受付帳.csv", csvText: "a".repeat(10) });
    expect(recallReception()?.name).toBe("受付帳.csv");
    rememberReception(null);
    expect(recallReception()).toBeNull();
  });

  it("置けるのは1つだけ(新しく置くと前のものは捨てる)", () => {
    putHandoff({ target: "registry_pdf", file: pdf });
    putHandoff({ target: "reception", entry: { name: "受付帳.csv", csvText: "a" } });
    expect(peekHandoff("registry_pdf")).toBeNull();
    expect(peekHandoffEntry("reception")?.name).toBe("受付帳.csv");
  });
});

import { describe, it, expect } from "vitest";
import {
  stageOfDriveFolderName,
  stageFolderNameForCreate,
  placementForRelPath,
  skipReasonForDriveFile,
  shouldCopyOut,
  outFileName,
  pickStageFolder,
} from "../sync-plan";

describe("段階のフォルダ名を読む(人が付けた名前はそのまま使う)", () => {
  it.each([
    ["①調査資料等", "pre_contract"],
    ["調査資料", "pre_contract"],
    ["②管理関係", "management"],
    ["契約資料", "contract"],
    ["契約書類関係", "contract"],
    ["③契約関係", "contract"],
    ["決済資料", "settlement"],
    ["④ 決済関係", "settlement"],
    ["⑤賃貸関係", "rental"],
    ["本人確認書類", "identity"],
    ["写真", "photo"],
    ["現地写真", "photo"],
  ])("%s → %s", (name, code) => {
    expect(stageOfDriveFolderName(name)).toBe(code);
  });
  it("「写真」はほかの段階の語が無いときだけ(「契約書類(写真)」は契約)・本人確認がいちばん強い", () => {
    expect(stageOfDriveFolderName("契約書類(写真)")).toBe("contract");
    expect(stageOfDriveFolderName("本人確認(写真)")).toBe("identity");
  });
  it("段階を示さない名前は null", () => {
    expect(stageOfDriveFolderName("その他")).toBeNull();
    expect(stageOfDriveFolderName("ハマイハイライズ 305")).toBeNull();
  });
});

describe("アプリが段階のフォルダを作るときの名前", () => {
  it("番号つきの段階名", () => {
    expect(stageFolderNameForCreate("contract")).toBe("③契約関係");
    expect(stageFolderNameForCreate("pre_contract")).toBe("①調査資料等");
    expect(stageFolderNameForCreate(null)).toBe("その他");
  });
  it("既存の「契約書類」を③として使う(新しく作らない)", () => {
    const subs = [
      { id: "a", name: "写真" },
      { id: "b", name: "契約書類" },
    ];
    expect(pickStageFolder(subs, "contract")).toEqual({ id: "b", name: "契約書類" });
    expect(pickStageFolder(subs, "settlement")).toBeNull();
    expect(pickStageFolder([{ id: "c", name: "その他" }], null)).toEqual({ id: "c", name: "その他" });
  });
});

describe("ドライブのファイルをどこへ入れるか(紐づけたフォルダからの道)", () => {
  it("直下 → 書類の受け取り箱", () => {
    expect(placementForRelPath([], "application/pdf")).toEqual({ kind: "inbox" });
  });
  it("段階のフォルダの中 → 添付(段階の補助つき)・下の階層も最初の段で決める", () => {
    expect(placementForRelPath(["契約資料"], "application/pdf")).toEqual({ kind: "attach", stageHint: "contract" });
    expect(placementForRelPath(["決済関係", "2024"], "application/pdf")).toEqual({ kind: "attach", stageHint: "settlement" });
  });
  it("★道のどこかに「本人確認」があれば本人確認書類として守る(下の階層でも・写真フォルダの下でも)", () => {
    expect(placementForRelPath(["契約関係", "本人確認"], "application/pdf")).toEqual({ kind: "attach", stageHint: "identity" });
    expect(placementForRelPath(["写真", "本人確認書類"], "image/jpeg")).toEqual({ kind: "attach", stageHint: "identity" });
  });
  it("段階を示さないフォルダの中 → 添付(補助なし)", () => {
    expect(placementForRelPath(["その他"], "application/pdf")).toEqual({ kind: "attach", stageHint: null });
  });
  it("「写真」の画像(jpeg/png/webp)は写真タブ・それ以外は添付", () => {
    expect(placementForRelPath(["写真"], "image/jpeg")).toEqual({ kind: "photo" });
    expect(placementForRelPath(["写真"], "image/png")).toEqual({ kind: "photo" });
    expect(placementForRelPath(["写真"], "image/heic")).toEqual({ kind: "attach", stageHint: null });
    expect(placementForRelPath(["写真"], "application/pdf")).toEqual({ kind: "attach", stageHint: null });
  });
});

describe("取り込まないドライブのファイル", () => {
  const base = { id: "f1", mimeType: "application/pdf", size: 1000, md5: "m1", appSource: null as string | null };
  const ctx = { knownMd5: new Set<string>(), maxBytes: 20 * 1024 * 1024 };
  it("ふつうのPDFは取り込む(null)", () => {
    expect(skipReasonForDriveFile(base, ctx)).toBeNull();
  });
  it("アプリが置いた写しは無視(台帳にも書かない)", () => {
    expect(skipReasonForDriveFile({ ...base, appSource: "app" }, ctx)).toBe("app_copy");
  });
  it("同じ中身(md5)が既にある → duplicate", () => {
    expect(skipReasonForDriveFile(base, { ...ctx, knownMd5: new Set(["m1"]) })).toBe("duplicate");
  });
  it("Google ドキュメント形式・許可外の形式・20MB 超 → unsupported", () => {
    expect(skipReasonForDriveFile({ ...base, mimeType: "application/vnd.google-apps.document" }, ctx)).toBe("unsupported");
    expect(skipReasonForDriveFile({ ...base, mimeType: "application/zip" }, ctx)).toBe("unsupported");
    expect(skipReasonForDriveFile({ ...base, size: 21 * 1024 * 1024 }, ctx)).toBe("unsupported");
    expect(skipReasonForDriveFile({ ...base, size: null }, ctx)).toBe("unsupported");
  });
});

describe("アプリ → ドライブに複製するか", () => {
  const att = { type: "general", docKind: null as string | null, isDeleted: false, driveFileId: null as string | null, fileSize: 1000 };
  it("ふつうの添付は複製する", () => {
    expect(shouldCopyOut(att)).toBe(true);
  });
  it("★本人確認書類・反響資料・査定報告書・謄本は複製しない", () => {
    expect(shouldCopyOut({ ...att, docKind: "identity_document" })).toBe(false);
    expect(shouldCopyOut({ ...att, type: "referral" })).toBe(false);
    expect(shouldCopyOut({ ...att, type: "report" })).toBe(false);
    expect(shouldCopyOut({ ...att, type: "registry" })).toBe(false);
  });
  it("削除済み・複製済み・20MB 超は複製しない", () => {
    expect(shouldCopyOut({ ...att, isDeleted: true })).toBe(false);
    expect(shouldCopyOut({ ...att, driveFileId: "x" })).toBe(false);
    expect(shouldCopyOut({ ...att, fileSize: 21 * 1024 * 1024 })).toBe(false);
  });
  it("写しの名前はそろえた名前・無ければ元の名前(使えない文字は _)", () => {
    expect(outFileName({ docTitle: "売買契約書_ハマイ305_20261024.pdf", fileName: "scan.pdf" })).toBe(
      "売買契約書_ハマイ305_20261024.pdf",
    );
    expect(outFileName({ docTitle: null, fileName: "a/b.pdf" })).toBe("a_b.pdf");
  });
});

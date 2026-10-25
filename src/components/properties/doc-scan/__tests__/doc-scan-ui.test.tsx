/**
 * 書類を撮る(第3段)の画面。vitest は env=node なので、描いた HTML と元のソースで確かめる。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DocScanLauncher from "../doc-scan-launcher";
import ScanResultNotice from "../scan-result-notice";
import { TOUCH_ONLY_QUERY } from "../use-touch-device";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const noop = () => {};

describe("「書類を撮る」はスマホ・タブレットだけ(発注者指示 2026-10-25)", () => {
  it("サーバーで描くとき(=パソコンと同じ)はボタンを出さない", () => {
    const html = renderToStaticMarkup(
      <DocScanLauncher propertyId="p-1" onSaved={noop} onPhotosSaved={noop} />,
    );
    expect(html).toBe("");
  });

  it("端末名ではなく、指で操作する画面かどうかで決める(iPad の Safari はパソコンを名乗る)", () => {
    expect(TOUCH_ONLY_QUERY).toBe("(hover: none) and (pointer: coarse)");
    expect(read("src/components/properties/doc-scan/use-touch-device.ts")).not.toMatch(/userAgent/);
  });

  it("物件の添付タブに置く(今のファイルの枠はそのまま)", () => {
    const tab = read("src/components/properties/attachment-tab.tsx");
    const launcher = tab.indexOf("<DocScanLauncher");
    const dropZone = tab.indexOf("<FileDropZone");
    expect(launcher).toBeGreaterThan(-1);
    expect(launcher).toBeLessThan(dropZone);
  });
});

describe("撮影画面", () => {
  const dialog = read("src/components/properties/doc-scan/doc-scan-dialog.tsx");

  it("カメラは閉じるとき・撮った一覧に進んだときに止める", () => {
    expect(dialog).toMatch(/getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/);
    expect(dialog).toMatch(/const cameraWanted = \(phase === "camera" \|\| phase === "adjust"\)/);
  });

  it("映像と写真は縦横比のまま(引き伸ばさない・切り落とさない)", () => {
    expect(dialog).toContain("object-contain");
    expect(dialog).not.toContain("object-cover");
    expect(dialog).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(read("src/components/properties/doc-scan/corner-editor.tsx")).toContain("h-auto w-full");
  });

  it("部品(OpenCV.js)は画面のバンドルに入れず、開いたときに読み込む", () => {
    for (const f of [
      "src/components/properties/doc-scan/doc-scan-dialog.tsx",
      "src/components/properties/doc-scan/doc-scan-launcher.tsx",
      "src/components/properties/attachment-tab.tsx",
      "src/lib/doc-scan/detect.ts",
      "src/lib/doc-scan/opencv-loader.ts",
    ]) {
      expect(read(f), f).not.toMatch(/from\s+["']@techstark\/opencv-js["']/);
    }
  });
});

describe("保存のあとの知らせ", () => {
  it("種類が当たったら、種類と入れた段階を出す", () => {
    const html = renderToStaticMarkup(
      <ScanResultNotice
        notice={{ kind: "saved", pages: 3, kindLabel: "売買契約書", stageLabel: "③契約関係", littleText: false, moving: false }}
        onMoveToPhotos={noop}
        onDismiss={noop}
      />,
    );
    expect(html).toContain("PDFにして添付に入れました(3枚)");
    expect(html).toContain("「売買契約書」と判別し、③契約関係に入れました");
    expect(html).not.toContain("写真タブへ移す");
  });

  it("当たらなかったら「その他」に入れたことと、選び方を出す", () => {
    const html = renderToStaticMarkup(
      <ScanResultNotice
        notice={{ kind: "saved", pages: 1, kindLabel: null, stageLabel: null, littleText: false, moving: false }}
        onMoveToPhotos={noop}
        onDismiss={noop}
      />,
    );
    expect(html).toContain("種類が分かりませんでした。「その他」に入れたので、行の「種類」で選んでください。");
  });

  it("文字がほとんど無ければ「写真タブへ移す」を出す", () => {
    const html = renderToStaticMarkup(
      <ScanResultNotice
        notice={{ kind: "saved", pages: 1, kindLabel: null, stageLabel: null, littleText: true, moving: false }}
        onMoveToPhotos={noop}
        onDismiss={noop}
      />,
    );
    expect(html).toContain("写真タブへ移す");
  });

  it("写真タブへ入れたとき", () => {
    const html = renderToStaticMarkup(
      <ScanResultNotice notice={{ kind: "photos", count: 2 }} onMoveToPhotos={noop} onDismiss={noop} />,
    );
    expect(html).toContain("写真タブへ入れました(2枚)");
  });
});

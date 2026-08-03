/**
 * 物件化 modal の「Googleマップで開く」— 配線のソース静的検証。
 *
 * 業務背景: 住所が自動で入るようになったので、**入った住所が実際の場所と
 * 合っているか**を別タブの地図で見比べて確かめたい (2026-08-03 発注者要望
 * 「『ピンの位置から住所を入力』ボタンの横に、座標点を中心とした googlemap に
 * 別ブラウザで飛ばすボタンを作成してほしい」)。
 *
 * SSR (renderToStaticMarkup) では useEffect が走らず座標が入らないため、
 * リンク自体は描画されない。よって配線はここで固定する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf-8");
const MODAL_SRC = read(
  "src/components/field-survey/convert-pin-to-property-modal.tsx",
);
const QUEUE_SRC = read("src/components/field-survey/candidate-queue.tsx");
const API_SRC = read("src/lib/api-client.ts");

describe("物件化 modal — Googleマップで開く", () => {
  it("完成待ち一覧と同じ組み立てを使う (課金されない一般向けマップ)", () => {
    // ⚠アプリ内に地図を描く Maps Platform は有料。リンクを開くだけの
    // external-maps-url.ts を使う (完成待ち一覧の「Googleマップ」と同じ)。
    expect(MODAL_SRC).toMatch(
      /import \{ buildExternalMapUrl \} from "@\/lib\/external-maps-url"/,
    );
    // 有料 API を直に叩く形が紛れ込んでいないこと (一覧側と同じ表明)
    expect(MODAL_SRC).not.toContain("maps.googleapis.com");
  });

  it("素の <a target=\"_blank\"> で開く (window.open を使わない)", () => {
    const anchor =
      MODAL_SRC.match(
        /data-testid="convert-external-map-link"[\s\S]{0,600}?<\/a>/,
      )?.[0] ?? "";
    expect(anchor).not.toBe("");
    expect(anchor).toMatch(/target="_blank"/);
    // 開いた先から window.opener 経由でこの画面を触られないようにする
    expect(anchor).toMatch(/rel="noopener noreferrer"/);
    expect(MODAL_SRC).not.toMatch(/window\.open\(/);
  });

  it("⚠座標は modal を開いた時点で取る (押してから取るとポップアップブロックに掛かる)", () => {
    // 押下 → await → open だと利用者の操作から離れた open と見なされ、
    // ブラウザに塞がれる。座標が揃ってからリンクを出す形にする。
    const eff =
      MODAL_SRC.match(
        /useEffect\(\(\) => \{[\s\S]*?fetchPinLocation\(pinId\)[\s\S]*?\}, \[pinId\]\);/,
      )?.[0] ?? "";
    expect(eff).not.toBe("");
    // 取得中に閉じられた / pin が変わったら setState しない
    expect(eff).toMatch(/cancelled = true/);
    expect(eff).toMatch(/if \(cancelled\) return;/);
  });

  it("座標が取れないときはリンクを出さない (fail-closed)", () => {
    expect(MODAL_SRC).toMatch(/\{externalMapUrl && \(/);
  });

  it("⚠取得した座標を pin に紐づけ、別の pin のものは使わない", () => {
    // modal が unmount されずに pinId だけ差し替わると、cancel は新しい取得の
    // 書き込みを止めるだけで**前の pin の座標が残る**。その間リンクは別の家を
    // 指し、住所を確かめる導線が確かめる相手を間違える。
    expect(MODAL_SRC).toMatch(/setPinCoords\(c \? \{ pinId, lat: c\.lat/);
    expect(MODAL_SRC).toMatch(
      /pinCoords && pinCoords\.pinId === pinId \? pinCoords : null/,
    );
    expect(MODAL_SRC).toMatch(
      /buildExternalMapUrl\(\s*coordsForCurrentPin\?\.lat,\s*coordsForCurrentPin\?\.lng,\s*\)/,
    );
  });

  it("⚠詳細パネルは pin ごとに modal を作り直す (入力値の持ち越しを根で止める)", () => {
    // パネルは pinId が変わっても unmount されず showConvert もリセットしない。
    // key が無いと前の pin に入力した住所・種別・地番が次の pin に残る。
    const PANEL_SRC = read("src/components/field-survey/pin-detail-panel.tsx");
    expect(PANEL_SRC).toMatch(
      /<ConvertPinToPropertyModal\s+key=\{pinId\}\s+pinId=\{pinId\}/,
    );
  });

  it("⚠住所の自動入力が無効な構成でも地図リンクは出す (別条件で出し分ける)", () => {
    // 逆ジオコーディング未設定でも、座標さえ取れれば地図は開ける。
    expect(MODAL_SRC).toMatch(/\(reverseGeocodeEnabled \|\| externalMapUrl\)/);
  });

  it("⚠座標を画面にも console にも出さない", () => {
    expect(MODAL_SRC).not.toMatch(/console\./);
    // 座標そのものを描画していないこと (URL 組み立て以外で lat/lng を出さない)
    expect(MODAL_SRC).not.toMatch(/\{pinCoords\.lat\}|\{pinCoords\?\.lat\}/);
    expect(MODAL_SRC).not.toMatch(/\{pinCoords\.lng\}|\{pinCoords\?\.lng\}/);
  });
});

describe("座標取得の共通化", () => {
  it("fetchPinLocation は api-client の 1 本だけ (2 か所に置かない)", () => {
    expect(API_SRC).toMatch(/export async function fetchPinLocation\(/);
    // 一覧側は自前の実装を持たず import して使う
    expect(QUEUE_SRC).not.toMatch(/async function fetchPinLocation\(/);
    expect(QUEUE_SRC).toMatch(/fetchPinLocation,/);
    expect(MODAL_SRC).toMatch(/fetchPinLocation,/);
  });

  it("位置だけ見る操作で詳細 GET (memo 本文つき) を使わない", () => {
    const fn =
      API_SRC.match(
        /export async function fetchPinLocation\([\s\S]*?\n\}/,
      )?.[0] ?? "";
    expect(fn).not.toBe("");
    expect(fn).toMatch(/\/location`/);
    // 失敗理由を持ち出さない・ログにも出さない
    expect(fn).toMatch(/return null/);
    expect(fn).not.toMatch(/console\./);
  });
});

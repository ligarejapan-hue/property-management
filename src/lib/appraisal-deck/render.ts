/**
 * お客様向け資料「査定のご報告」の HTML を作る(2026-11-10)。1つのファイルで完結(外の読み込みなし)。
 *
 * - 見た目と動きは assets/deck.css・deck.js(発注者が承認した「池尻4丁目 査定のご報告」と同じ)。
 * - 数字は <script type="application/json"> に入れ、deck.js が textContent で描く(HTML として解釈しない)。
 * ⚠依頼者の氏名・番地は入れない(MergedAppraisal は町丁目まで・氏名を持たない)。
 * ⚠外へ通信しない(RENDER_HEADERS の CSP で connect-src 'none')。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { defaultHeadlines, isUnconnectedCase, KIND_LABEL, type HeadlineKey, type MergedAppraisal } from "./headlines";

const ASSET_DIR = path.join(process.cwd(), "src", "lib", "appraisal-deck", "assets");
let assets: { css: string; js: string } | null = null;
function loadAssets() {
  assets ??= {
    css: readFileSync(path.join(ASSET_DIR, "deck.css"), "utf8"),
    js: readFileSync(path.join(ASSET_DIR, "deck.js"), "utf8"),
  };
  return assets;
}

export const RENDER_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
};

const escHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** JSON を <script> の中に置いても要素を閉じない形にする。 */
export function jsonForScript(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function buildDeckData(m: MergedAppraisal, opts: { draft: boolean }) {
  const defaults = defaultHeadlines(m);
  const custom = (m.headlines ?? {}) as Partial<Record<HeadlineKey, string>>;
  const headlines = Object.fromEntries(
    (Object.keys(defaults) as HeadlineKey[]).map((k) => [k, custom[k]?.trim() ? custom[k]!.trim() : defaults[k]]),
  ) as Record<HeadlineKey, string>;
  return {
    draft: opts.draft,
    kind: m.kind,
    kindLabel: (m.kind && KIND_LABEL[m.kind]) || "",
    appraisedOn: m.appraisedOn,
    area: m.area,
    railLine: m.railLine,
    station: m.station,
    walkMinutes: m.walkMinutes,
    landSqm: m.landSqm,
    landTsubo: m.landTsubo,
    floorSqm: m.floorSqm,
    exclusiveSqm: m.exclusiveSqm,
    builtYearMonth: m.builtYearMonth,
    structure: m.structure,
    layout: m.layout,
    floorInfo: m.floorInfo,
    roadAccess: m.roadAccess,
    roadDetail: m.roadDetail,
    expected: m.expected,
    ai: m.ai,
    adjustment: m.adjustment,
    plans: m.plans,
    range: m.range,
    unconnected: isUnconnectedCase(m),
    headlines,
    headlineFundCustom: !!custom.fund?.trim(),
  };
}

export function deckTitle(m: MergedAppraisal): string {
  return `${m.area ? m.area.replace(/^(東京都|北海道|(?:京都|大阪)府|.{2,3}県)/, "") + " " : ""}査定のご報告`;
}

export function renderAppraisalDeck(m: MergedAppraisal, opts: { draft: boolean }): string {
  const { css, js } = loadAssets();
  const data = buildDeckData(m, opts);
  const isRange = !(m.plans && m.plans.length) && !!m.range;
  const planWord = isRange ? "売出しの価格" : "売出しの3案";
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escHtml(deckTitle(m))}</title>
<style>${css}</style></head><body>
<div id="vp"><div id="stage">

<section class="page" data-k="result" data-sec="査定結果">
  <div class="sec" data-r>査定結果<span id="sec1sub"></span></div>
  <h1 data-r style="--d:120"></h1>
  <div class="band">
    <div class="key" data-r style="--d:500"><div class="lab">成約想定価格</div><div class="v"><span id="nE"></span><u>万円</u></div><div class="sub" id="nEsub"></div></div>
    <div data-r style="--d:620"><div class="lab">AI査定価格</div><div class="v"><span id="nA"></span><u>万円</u></div><div class="sub" id="nAsub"></div></div>
    <div data-r style="--d:740"><div class="lab" id="nClab"></div><div class="v"><span id="nC"></span><u id="nCu"></u></div><svg id="cutbar" width="420" height="30" viewBox="0 0 420 30" aria-hidden="true"></svg><div class="sub" id="nCsub"></div></div>
  </div>
  <div class="flow" id="flow">
    <button class="step" data-r style="--d:1100" data-panel="p1"><span class="t">① 物件</span><span class="n"></span><span class="d"></span><span class="go">物件の概要 ›</span></button>
    <button class="step" data-r style="--d:1250" data-go="1"><span class="t">② AI査定</span><span class="n"></span><span class="d"></span><span class="go">査定の根拠 p.2 ›</span></button>
    <button class="step" data-r style="--d:1400" data-go="1"><span class="t"></span><span class="n"></span><span class="d"></span><span class="go">査定の根拠 p.2 ›</span></button>
    <button class="step" data-r style="--d:1550" data-go="2"><span class="t"></span><span class="n"></span><span class="d"></span><span class="go"></span></button>
  </div>
  <div class="base" data-r style="--d:2000"><span id="base1"></span><button class="more" data-go="3" style="margin:0">お住み替えの資金を計算する p.4 ›</button></div>
</section>

<section class="page" data-k="basis" data-sec="査定の根拠">
  <div class="sec" data-r>査定の根拠</div>
  <h1 data-r style="--d:120"></h1>
  <div class="body">
    <div class="fig" data-r style="--d:300"><div class="ftitle" id="wT"></div><div class="pick vt" role="tablist" aria-label="見せ方"><button type="button" class="pk" role="tab" aria-checked="true" aria-selected="true" data-v="bk">土地を並べて見る</button><button type="button" class="pk" role="tab" aria-checked="false" aria-selected="false" data-v="wf">金額の棒で見る</button></div><svg id="bk" width="1080" height="580" viewBox="0 0 1080 640"></svg><svg id="wf" width="1080" height="580" viewBox="0 0 1080 640" hidden></svg></div>
    <aside class="side" data-r style="--d:2200">
      <div class="big"><span id="b2big"></span><u>%</u></div>
      <div class="what" id="b2what"></div>
      <p id="b2tx"></p>
      <div class="cmp"><span id="b2cmp"></span><br><span class="eq" id="b2eq"></span></div>
      <button class="more" data-panel="adj">評価の補正を見る ›</button>
    </aside>
  </div>
</section>

<section class="page" data-k="plans" data-sec="${planWord}">
  <div class="sec" data-r>${planWord}</div>
  <h1 data-r style="--d:120"></h1>
  <div class="body">
    <div class="fig" data-r style="--d:300"><div class="ftitle">売却代金の行き先<small>万円・帯の太さ＝金額・案を押すと切り替わる</small></div>
      <div class="pick" id="pickP" role="radiogroup" aria-label="売出しの案"></div>
      <div class="ins">
        <label for="iC">ご希望の売出価格</label><span class="box"><input id="iC" type="text" inputmode="numeric" placeholder="例 1,350" autocomplete="off"><span>万円</span></span>
        <label for="iL">ローン残高（ある場合）</label><span class="box"><input id="iL" type="text" inputmode="numeric" placeholder="例 300" autocomplete="off"><span>万円</span></span>
        <label for="iX">その他の費用（測量・解体など）</label><span class="box xbox" id="xBox"><input id="iX" type="text" readonly placeholder="押して内訳を入力" autocomplete="off" aria-haspopup="dialog" aria-expanded="false" aria-controls="xPop"><span>万円</span><span class="xcar" aria-hidden="true">▾</span></span>
        <div class="xpop" id="xPop" role="dialog" aria-label="その他の費用の内訳" hidden>
          <div class="xhd">その他の費用の内訳<small>万円・わかる項目だけ入れてください</small></div>
          <div class="xgrid" id="xGrid"></div>
          <div class="xsum"><span>合計</span><b id="xSum">0</b><span>万円</span></div>
          <span class="err xerr" id="xErr" role="alert"></span>
          <p class="xnt">抵当権の抹消費用と売買契約書の印紙税は、「お住み替えの資金」のページで別に入れます。</p>
          <div class="xbt"><button type="button" class="xclr" id="xClr">すべて消す</button><button type="button" class="xok" id="xOk">閉じる</button></div>
        </div>
        <span class="err" id="iErr" role="alert"></span>
      </div>
      <svg id="pl" width="1080" height="415" viewBox="0 0 1080 470"></svg>
    </div>
    <aside class="side" data-r style="--d:2200">
      <div class="big" id="bN"></div>
      <div class="what" id="bW"></div>
      <p id="bTx"></p>
      <div class="cmp">売出価格 <b id="bP"></b>万円（成約想定<span id="bExp"></span>万円との差 <span id="bD"></span>万円）<br><span class="eq" id="bEq"></span><span id="bLoan"></span></div>
      <button class="more" data-panel="net">手取りの計算 ›</button>
    </aside>
  </div>
</section>

<section class="page" data-k="fund" data-sec="お住み替えの資金">
  <div class="sec" data-r>お住み替えの資金</div>
  <h1 data-r style="--d:120" id="h4"></h1>
  <div class="body">
    <div class="fig" data-r style="--d:300">
      <div class="ftitle">数字を入れると計算します<small>万円・空欄は0として計算</small></div>
      <div class="frm">
        <fieldset><legend>ご売却</legend>
          <label for="jPlan">売却の案</label><select id="jPlan"></select>
          <label for="jL">ローン残高</label><span class="box"><input id="jL" type="text" inputmode="numeric" placeholder="0" autocomplete="off"><span>万円</span></span>
          <label for="jM">抵当権の抹消費用</label><span class="box"><input id="jM" type="text" inputmode="decimal" placeholder="例 3" autocomplete="off"><span>万円</span></span>
          <label for="jS">売買契約書の印紙税</label><span class="box"><input id="jS" type="text" inputmode="decimal" autocomplete="off"><span>万円</span></span>
        </fieldset>
        <fieldset><legend>ご購入</legend>
          <label for="jB">購入予算（物件価格）</label><span class="box"><input id="jB" type="text" inputmode="numeric" placeholder="例 6,000" autocomplete="off"><span>万円</span></span>
          <label for="jC">購入時の諸費用</label><span class="box"><input id="jC" type="text" inputmode="numeric" placeholder="例 400" autocomplete="off"><span>万円</span></span>
          <label for="jO">自己資金（預貯金から）</label><span class="box"><input id="jO" type="text" inputmode="numeric" placeholder="0" autocomplete="off"><span>万円</span></span>
          <label for="jN">新しい住宅ローン</label><span class="box"><input id="jN" type="text" inputmode="numeric" placeholder="0" autocomplete="off"><span>万円</span></span>
        </fieldset>
      </div>
      <span class="err" id="jErr" role="alert"></span>
      <svg id="fd" width="1080" height="300" viewBox="0 0 1080 300"></svg>
    </div>
    <aside class="side" data-r style="--d:2200">
      <div class="big" id="cG"></div>
      <div class="what" id="cW"></div>
      <p id="cTx"></p>
      <div class="cmp"><span class="eq" id="cEq"></span></div>
      <button class="more" data-panel="cost">諸費用と税金について ›</button>
    </aside>
  </div>
</section>

<div class="hint">→ / Space 次へ　← 前へ　O 一覧</div>
<div class="nav"><button id="prev" aria-label="前のページ">‹</button><button id="next" aria-label="次のページ">›</button></div>
<div class="foot"><span id="src"></span><span id="pg">1 / 4</span></div>
<div id="dimmer"></div>
<aside id="panel" aria-hidden="true"><button class="x" aria-label="閉じる">×</button><div id="pbody"></div></aside>
<div id="ov"><h2>全ページ一覧<small>見出しだけを縦に読むと話の流れがわかります。押すとそのページへ</small></h2><div class="g" id="ovg"></div></div>
</div></div>
<script id="deck-data" type="application/json">${jsonForScript(data)}</script>
<script>${js}</script>
</body></html>`;
}

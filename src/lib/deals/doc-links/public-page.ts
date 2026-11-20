import crypto from "crypto";
import { DOC_FILE_MAX_BYTES, DOC_PDF_UPLOAD_MAX_BYTES, type DocRequestStatus } from "./constants";
import type { DocLinkHint } from "./catalog";

/**
 * お客様のページ(/submit/<トークン>)の HTML。
 * ⚠表示するのは会社名・書類名・提出状況だけ(発注者依頼)。物件の住所・氏名・金額・期限・ほかの取引は渡さない=引数に無い。
 *   いちばん下に会社のロゴと連絡先(会社の情報・2026-11-20 発注者)。
 * ⚠外部のフォント・画像・スクリプトを読まない(URL のトークンが外へ漏れない)。ロゴは data: で埋め込む。公開の入口では Next の部品も配っていない。
 * トークンは HTML に入れない。送信先はスクリプトが今の URL から作る。
 * 見た目は 2026-11-20 の承認済みのイメージ(進み具合・状態の色とアイコン・差し戻しを上に・大きいボタン・開いたときの動き)。
 */

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/** スクリプトに値を埋め込む(「<」を逃がして </script> で切れないように)。 */
const jsonForScript = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\" + "u003c");

/** /submit/ の応答すべてに付けるヘッダ。nonce があるページだけスクリプトとスタイルを許す。画像は埋め込み(data:)と描き直し(blob:)だけ。 */
export function submitHeaders(contentType: string, nonce?: string): Record<string, string> {
  const pageSources = nonce ? ` img-src blob: data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self';` : "";
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": `default-src 'none';${pageSources} form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
  };
}

/** 書類ごとの状態の文言(お客様向け)。差し戻しの理由は出さない(担当者が再案内の文面で伝える)。 */
export function publicStatusText(status: DocRequestStatus, fileCount: number): string {
  if (status === "submitted") return `届きました${fileCount > 0 ? `(${fileCount}点)` : ""}・担当者が確認します`;
  if (status === "received") return "確認しました";
  if (status === "rejected") return "もう一度提出してください。担当者からのご連絡をご確認ください";
  return "未提出";
}

export const SUBMIT_INTRO = "書類ごとに、写真を撮るかファイルを選んでください。写真とPDFを送れます。PDFは30MBまでです。大きいファイルは自動で圧縮します。";
export const SUBMIT_SENDING = "送信しています…";
export const SUBMIT_SENDING_PDF = "送信しています…(大きいPDFは圧縮するため、1〜2分かかることがあります)";
export const SUBMIT_ALL_DONE = "すべてご提出いただきました";

const svg = (body: string, width = "2.4") =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON_CHECK = svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', "2.6");
const ICONS: Record<DocRequestStatus | "sending", string> = {
  pending: svg('<circle cx="12" cy="12" r="8"/>'),
  submitted: ICON_CHECK,
  received: ICON_CHECK,
  rejected: svg('<path d="M12 6.5v7"/><path d="M12 17.5h.01"/>', "2.8"),
  sending: svg('<path d="M12 16V5M7 10l5-5 5 5"/><path d="M5 19h14"/>'),
};
const ICON_CAMERA = svg('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>', "2");
const ICON_FILE = svg('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>', "2");

/* 色: 灰=未提出・青=届きました・緑=確認しました・赤=もう一度お願い。お客様のページは明るい表示だけ。 */
const STYLE = `*{box-sizing:border-box}[hidden]{display:none!important}
body{margin:0;background:#f4f5f3;color:#1c2420;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif}
main{max-width:34rem;margin:0 auto;padding:18px 14px 28px}
.co{font-size:.85rem;color:#5a645f;margin:0}h1{font-size:1.25rem;margin:2px 0 10px}.intro{font-size:.9rem;color:#5a645f;margin:0 0 14px}
.prog{background:#fff;border:1px solid #dfe3df;border-radius:14px;padding:12px 14px;margin-bottom:14px}
.prog-n{font-size:1.05rem;font-weight:700}.prog-n b{font-size:1.5rem}.prog-n .of{font-weight:400;color:#5a645f}
.bar{height:10px;border-radius:99px;background:#f1f2f1;overflow:hidden;margin:8px 0}.bar i{display:block;height:100%;width:0;background:#17733f;border-radius:99px;transition:width .5s ease}
.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{font-size:.8rem;padding:2px 10px;border-radius:99px;font-weight:600}
.chip.pending{background:#f1f2f1;color:#5b6370}.chip.submitted{background:#e8f1fb;color:#1d5fa8}.chip.received{background:#e7f4ec;color:#17733f}.chip.rejected{background:#fdecea;color:#b42318}
.done{display:flex;gap:10px;align-items:flex-start;background:#e7f4ec;border:1px solid #b7dfc6;border-radius:14px;padding:14px;margin-bottom:14px;color:#17733f}
.done strong{display:block;font-size:1.1rem}.done span.t{color:#1c2420;font-size:.9rem}.done .ic{background:#17733f;color:#fff}
.sec{font-size:.8rem;font-weight:700;color:#5a645f;letter-spacing:.04em;margin:16px 2px 6px}.sec.ng{color:#b42318}
.doc{background:#fff;border:1px solid #dfe3df;border-radius:14px;padding:12px;margin-bottom:10px}
.doc[data-status=rejected]{border:2px solid #b42318;background:#fdecea}
.row{display:flex;gap:10px;align-items:flex-start}.tx{min-width:0}
.ic{flex:none;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:#f1f2f1;color:#5b6370}.ic svg{width:18px;height:18px}
.doc[data-status=submitted] .ic,.doc.busy .ic{background:#e8f1fb;color:#1d5fa8}.doc[data-status=received] .ic{background:#e7f4ec;color:#17733f}.doc[data-status=rejected] .ic{background:#b42318;color:#fff}
.nm{font-weight:700;line-height:1.4;overflow-wrap:anywhere}.hint{font-size:.8rem;color:#5a645f;margin-top:2px}
.howto{margin:6px 0 0;padding:8px 10px 8px 1.6em;background:#fff8e6;border:1px solid #f0dca8;border-radius:8px;color:#6b4e00}.howto li+li{margin-top:2px}
.doc[data-status=submitted] .hint,.doc[data-status=received] .hint{display:none}
.st{font-size:.85rem;font-weight:600;margin-top:4px;color:#5b6370}.doc[data-status=submitted] .st{color:#1d5fa8}.doc[data-status=received] .st{color:#17733f}.doc[data-status=rejected] .st{color:#b42318}
.btns{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
label.btn{position:relative;min-height:52px;border-radius:12px;border:1px solid #c9cfca;background:#fff;color:#1c2420;font-size:1rem;font-weight:700;display:flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;text-align:center;padding:6px}
label.btn svg{width:20px;height:20px;flex:none}label.btn.main{background:#1f3d34;border-color:#1f3d34;color:#fff}
.doc[data-status=rejected] label.btn.main{background:#b42318;border-color:#b42318}
label.btn:focus-within{outline:3px solid #1d5fa8;outline-offset:2px}.doc.busy label.btn{opacity:.45;pointer-events:none}
input[type=file]{position:absolute;width:1px;height:1px;opacity:0}
.addnote{display:none;font-size:.8rem;color:#5a645f;margin:6px 0 0;text-align:center}.doc[data-status=submitted] .addnote{display:block}
.sending{display:none;gap:8px;align-items:flex-start;margin-top:10px;padding:10px 12px;border-radius:10px;background:#e8f1fb;color:#1d5fa8;font-size:.875rem;font-weight:600}.doc.busy .sending{display:flex}
.spin{flex:none;width:18px;height:18px;border-radius:50%;border:3px solid rgba(29,95,168,.25);border-top-color:#1d5fa8;animation:sp .9s linear infinite;margin-top:2px}
@keyframes sp{to{transform:rotate(360deg)}}
.msg{font-size:.875rem;color:#b42318;font-weight:600;min-height:0;margin:6px 0 0}.msg:empty{display:none}
.note{font-size:.8rem;color:#5a645f;margin:14px 2px 0}
.prog,.done,.doc{animation:rise .45s cubic-bezier(.2,.7,.2,1) both}
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.prog,.done,.doc{animation:none}.spin{animation:none}.bar i{transition:none}}
.ft{margin-top:22px;padding-top:16px;border-top:1px solid #dfe3df;text-align:center;display:grid;gap:4px;justify-items:center}
.ft img{max-height:40px;max-width:60%;height:auto;width:auto}.ft-name{font-weight:700;font-size:.9rem}.ft-tel{font-size:.9rem}
.ft-tel a{font-weight:700;font-size:1.05rem;color:#1f3d34;text-underline-offset:3px;margin-left:4px}.ft-note{font-size:.75rem;color:#5a645f}`;

/**
 * スマホで画像を描き直してから送る。向きを画素に焼き込むので、サーバーでメタデータを全部落としても向きが保たれる。
 * PDF はそのまま送り、8MB を超えるものはサーバーが圧縮する(30MB まで・2026-11-06 発注者)。
 * 送ったあとは、その書類の状態と、上の進み具合・「すべてご提出いただきました」を出し直す(並び替えはしない)。
 */
const SCRIPT = `(function(){
var MAX=${DOC_FILE_MAX_BYTES},PDF_MAX=${DOC_PDF_UPLOAD_MAX_BYTES},EDGE=2560,ICONS=${jsonForScript(ICONS)};
var SENDING=${jsonForScript(SUBMIT_SENDING)},SENDING_PDF=${jsonForScript(SUBMIT_SENDING_PDF)};
var CHIP_LABELS={rejected:"もう一度お願い",pending:"未提出",submitted:"確認中",received:"確認済み"};
function statusText(s,n){if(s==="submitted")return"届きました"+(n>0?"("+n+"点)":"")+"・担当者が確認します";if(s==="received")return"確認しました";if(s==="rejected")return"もう一度提出してください。担当者からのご連絡をご確認ください";return"未提出"}
var docs=[].slice.call(document.querySelectorAll(".doc"));
function summary(){
 var c={pending:0,submitted:0,received:0,rejected:0},total=docs.length;
 docs.forEach(function(d){var s=d.getAttribute("data-status");if(c[s]!==undefined)c[s]++});
 var sent=c.submitted+c.received;
 var pn=document.getElementById("pn");if(pn)pn.textContent=String(sent);
 var bar=document.getElementById("pbar");if(bar)bar.style.width=(total?Math.round(sent*100/total):0)+"%";
 var chips=document.getElementById("chips");
 if(chips){chips.textContent="";["rejected","pending","submitted","received"].forEach(function(k){if(!c[k])return;var e=document.createElement("span");e.className="chip "+k;e.textContent=CHIP_LABELS[k]+" "+c[k];chips.appendChild(e)})}
 var done=document.getElementById("done");
 if(done){done.hidden=!(total>0&&c.pending===0&&c.rejected===0);var t=done.querySelector(".t");if(t)t.textContent=c.received===total?"ありがとうございました。すべての書類を確認しました。":"ありがとうございました。担当者が確認します。追加で送るものがあれば、下から送れます。"}
}
[].slice.call(document.querySelectorAll(".done,.prog,.doc")).forEach(function(e,i){e.style.animationDelay=(i*0.06)+"s"});
summary();
function isPdf(f){return f.type==="application/pdf"||/\\.pdf$/i.test(f.name||"")}
function toJpeg(file){return new Promise(function(res,rej){
 var url=URL.createObjectURL(file),img=new Image();
 img.onload=function(){
  var r=Math.min(1,EDGE/Math.max(img.naturalWidth,img.naturalHeight)),c=document.createElement("canvas");
  c.width=Math.round(img.naturalWidth*r);c.height=Math.round(img.naturalHeight*r);
  var x=c.getContext("2d");x.fillStyle="#fff";x.fillRect(0,0,c.width,c.height);x.drawImage(img,0,0,c.width,c.height);URL.revokeObjectURL(url);
  (function tryQ(q){c.toBlob(function(b){if(!b)return rej(new Error("x"));if(b.size>MAX&&q>0.5)return tryQ(q-0.15);res(b)},"image/jpeg",q)})(0.85);
 };
 img.onerror=function(){URL.revokeObjectURL(url);rej(new Error("x"))};
 img.src=url;
});}
function send(id,blob,name){var fd=new FormData();fd.append("requestId",id);fd.append("file",blob,name);
 return fetch(location.pathname+"/upload",{method:"POST",body:fd,credentials:"omit"}).then(function(r){return r.json().catch(function(){return{ok:false}})});}
function setIcon(doc,key){var ic=doc.querySelector(".ic");if(ic)ic.innerHTML=ICONS[key]||""}
function row(doc,status,count){doc.setAttribute("data-status",status);doc.querySelector(".st").textContent=statusText(status,count);setIcon(doc,doc.classList.contains("busy")?"sending":status);
 if(status==="received"){var b=doc.querySelector(".btns");if(b)b.remove()}summary()}
function busy(doc,on,text){doc.classList.toggle("busy",on);doc.querySelectorAll("input[type=file]").forEach(function(i){i.disabled=on});
 var t=doc.querySelector(".sending-t");if(t)t.textContent=text||"";setIcon(doc,on?"sending":doc.getAttribute("data-status"))}
document.querySelectorAll(".doc input[type=file]").forEach(function(input){input.addEventListener("change",function(){
 var doc=input.closest(".doc"),msg=doc.querySelector(".msg"),files=[].slice.call(input.files||[]);input.value="";
 if(!files.length)return;msg.textContent="";busy(doc,true,files.some(function(f){return isPdf(f)&&f.size>MAX})?SENDING_PDF:SENDING);
 files.reduce(function(p,f){return p.then(function(){
  var ready=isPdf(f)?Promise.resolve(f):toJpeg(f);
  return ready.then(function(b){if(b.size>(isPdf(f)?PDF_MAX:MAX))throw new Error("ファイルが大きすぎます。写真は8MBまで、PDFは30MBまでです。");return send(doc.dataset.id,b,isPdf(f)?"document.pdf":"photo.jpg")},function(){throw new Error("このファイルは読み込めませんでした。写真かPDFを選んでください。")})
  .then(function(r){if(!r.ok)throw new Error(r.error||"送信できませんでした。もう一度お試しください。");row(doc,r.status,r.count)});
 })},Promise.resolve()).then(function(){busy(doc,false)},function(e){busy(doc,false);msg.textContent=e.message||"送信できませんでした。もう一度お試しください。"});
})});
})();`;

export interface PublicRequestView { id: string; label: string; status: DocRequestStatus; fileCount: number; hint?: DocLinkHint | null }

const docRow = (r: PublicRequestView): string => {
  const label = esc(r.label);
  const hint = r.hint
    ? `<div class="hint">${esc(r.hint.text)}${r.hint.howto.length ? `<ul class="howto">${r.hint.howto.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>` : ""}</div>`
    : "";
  const buttons = r.status === "received" ? "" : `<div class="btns">
<label class="btn main">${ICON_CAMERA}写真を撮る<input type="file" accept="image/*" capture="environment" aria-label="${label}を撮影"></label>
<label class="btn">${ICON_FILE}ファイルを選ぶ<input type="file" accept="image/*,application/pdf" multiple aria-label="${label}のファイルを選ぶ"></label>
</div><p class="addnote">足りないページがあれば、追加で送れます</p>`;
  return `<section class="doc" data-id="${esc(r.id)}" data-status="${esc(r.status)}"><div class="row"><span class="ic">${ICONS[r.status]}</span><div class="tx"><div class="nm">${label}</div>${hint}<div class="st">${esc(publicStatusText(r.status, r.fileCount))}</div></div></div>${buttons}<div class="sending" role="status"><span class="spin"></span><span class="sending-t"></span></div><p class="msg" role="alert"></p></section>`;
};

/** 差し戻し → まだ → お送りいただいた の順に分ける(差し戻しをいちばん上・2026-11-20 発注者)。空の組は出さない。 */
export function groupRequests(requests: readonly PublicRequestView[]): { key: "rejected" | "todo" | "sent"; title: string; items: PublicRequestView[] }[] {
  const groups = [
    { key: "rejected" as const, title: "もう一度お送りください", items: requests.filter((r) => r.status === "rejected") },
    { key: "todo" as const, title: "ご提出をお願いする書類", items: requests.filter((r) => r.status === "pending") },
    { key: "sent" as const, title: "お送りいただいた書類", items: requests.filter((r) => r.status === "submitted" || r.status === "received") },
  ];
  return groups.filter((g) => g.items.length > 0);
}

const telHref = (tel: string): string => `tel:${tel.replace(/[^0-9+]/g, "")}`;

export function renderSubmitPage(input: {
  companyName: string; companyTel?: string | null; logo?: string | null; requests: PublicRequestView[]; nonce: string;
}): string {
  const total = input.requests.length;
  const count = (s: DocRequestStatus) => input.requests.filter((r) => r.status === s).length;
  const sent = count("submitted") + count("received");
  const allDone = total > 0 && count("pending") === 0 && count("rejected") === 0;
  const chips = (["rejected", "pending", "submitted", "received"] as const)
    .filter((s) => count(s) > 0)
    .map((s) => `<span class="chip ${s}">${{ rejected: "もう一度お願い", pending: "未提出", submitted: "確認中", received: "確認済み" }[s]} ${count(s)}</span>`)
    .join("");
  const sections = groupRequests(input.requests)
    .map((g) => `<h2 class="sec${g.key === "rejected" ? " ng" : ""}">${g.title}</h2>\n${g.items.map(docRow).join("\n")}`)
    .join("\n");
  // ロゴは取引の設定の画像(PNG・JPEG を data: で埋め込む)。それ以外の形は出さない。
  const logo = input.logo && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(input.logo)
    ? `<img src="${esc(input.logo)}" alt="${esc(input.companyName)}">` : "";
  const tel = input.companyTel?.trim()
    ? `<div class="ft-tel">お問い合わせ <a href="${esc(telHref(input.companyTel))}">${esc(input.companyTel.trim())}</a></div>` : "";
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer"><title>書類のご提出</title><style nonce="${input.nonce}">${STYLE}</style></head><body><main>
<p class="co">${esc(input.companyName)}</p>
<h1>書類のご提出</h1>
<p class="intro">${SUBMIT_INTRO}</p>
<div class="done" id="done"${allDone ? "" : " hidden"}><span class="ic">${ICON_CHECK}</span><div><strong>${SUBMIT_ALL_DONE}</strong><span class="t">ありがとうございました。担当者が確認します。追加で送るものがあれば、下から送れます。</span></div></div>
<section class="prog" aria-label="提出の進み具合"><div class="prog-n"><b id="pn">${sent}</b>点 提出済み <span class="of">／ ${total}点中</span></div><div class="bar"><i id="pbar"></i></div><div class="chips" id="chips">${chips}</div></section>
${sections}
<p class="note">送っていただいたファイルは、このページでは見られません。届いたことだけを表示します。</p>
<noscript><p>このページを使うには JavaScript を有効にしてください。</p></noscript>
<footer class="ft">${logo}<div class="ft-name">${esc(input.companyName)}</div>${tel}<div class="ft-note">ご不明な点は、担当者までお気軽にご連絡ください。</div></footer>
</main><script nonce="${input.nonce}">${SCRIPT}</script></body></html>`;
}

/** 使えないリンク。期限切れ・無効・存在しないを見分けられないよう、同じ画面にする。 */
export function renderSubmitMessage(message: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer"><title>書類のご提出</title></head><body><p>${esc(message)}</p></body></html>`;
}

export const SUBMIT_UNAVAILABLE_MESSAGE = "このリンクは使えません。お手数ですが、担当者へご連絡ください。";
export const SUBMIT_THROTTLED_MESSAGE = "アクセスが集中しています。しばらくしてからもう一度お試しください。";
export const newPageNonce = (): string => crypto.randomBytes(16).toString("base64");

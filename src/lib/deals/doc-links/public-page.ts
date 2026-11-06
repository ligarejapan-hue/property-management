import crypto from "crypto";
import { DOC_FILE_MAX_BYTES, DOC_PDF_UPLOAD_MAX_BYTES, DOC_REQUEST_PUBLIC_LABELS, type DocRequestStatus } from "./constants";

/**
 * お客様のページ(/submit/<トークン>)の HTML。
 * ⚠表示するのは会社名・書類名・提出状況だけ(発注者依頼)。物件の住所・氏名・金額・期限・ほかの取引は渡さない=引数に無い。
 * ⚠外部のフォント・画像・スクリプトを読まない(URL のトークンが外へ漏れない)。公開の入口では Next の部品も配っていない。
 * トークンは HTML に入れない。送信先はスクリプトが今の URL から作る。
 */

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** /submit/ の応答すべてに付けるヘッダ。nonce があるページだけスクリプトとスタイルを許す。 */
export function submitHeaders(contentType: string, nonce?: string): Record<string, string> {
  const pageSources = nonce ? ` img-src blob:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self';` : "";
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": `default-src 'none';${pageSources} form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
  };
}

const STYLE = `*{box-sizing:border-box}body{margin:0;background:#f5f5f4;color:#1c1917;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif}
main{max-width:34rem;margin:0 auto;padding:1rem}h1{font-size:1.1rem;margin:.5rem 0}p{margin:.5rem 0}
.doc{background:#fff;border:1px solid #e7e5e4;border-radius:.5rem;padding:.75rem;margin:.75rem 0}.name{font-weight:600}.st{font-size:.875rem;color:#57534e}
.st[data-status=rejected]{color:#b91c1c;font-weight:600}.st[data-status=received]{color:#15803d}
.btns{display:flex;gap:.5rem;margin-top:.5rem}label.btn{flex:1;text-align:center;padding:.65rem .5rem;border-radius:.5rem;border:1px solid #d6d3d1;background:#fafaf9;font-size:.95rem;cursor:pointer}
label.btn.main{background:#1c1917;border-color:#1c1917;color:#fff}input[type=file]{position:absolute;width:1px;height:1px;opacity:0}
.msg{font-size:.875rem;color:#b91c1c;min-height:1.2em;margin:.25rem 0 0}.note{font-size:.8rem;color:#57534e}`;

/**
 * スマホで画像を描き直してから送る。向きを画素に焼き込むので、サーバーでメタデータを全部落としても向きが保たれる。
 * PDF はそのまま送り、8MB を超えるものはサーバーが縮める(30MB まで・2026-11-06 発注者)。
 */
const SCRIPT = `(function(){
var MAX=${DOC_FILE_MAX_BYTES},PDF_MAX=${DOC_PDF_UPLOAD_MAX_BYTES},EDGE=2560,LABELS=${JSON.stringify(DOC_REQUEST_PUBLIC_LABELS).replace(/</g, "\\u003c")};
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
function row(doc,status,count){var st=doc.querySelector(".st");st.dataset.status=status;st.textContent=LABELS[status]+(count>0?"("+count+"点)":"");
 if(status==="received"){var b=doc.querySelector(".btns");if(b)b.remove()}}
document.querySelectorAll(".doc input[type=file]").forEach(function(input){input.addEventListener("change",function(){
 var doc=input.closest(".doc"),msg=doc.querySelector(".msg"),files=[].slice.call(input.files||[]);input.value="";
 if(!files.length)return;msg.textContent=files.some(function(f){return isPdf(f)&&f.size>MAX})?"送信しています…(大きいPDFは縮めるので1〜2分かかることがあります)":"送信しています…";
 files.reduce(function(p,f){return p.then(function(){
  var ready=isPdf(f)?Promise.resolve(f):toJpeg(f);
  return ready.then(function(b){if(b.size>(isPdf(f)?PDF_MAX:MAX))throw new Error("ファイルが大きすぎます。写真は8MBまで、PDFは30MBまでです。");return send(doc.dataset.id,b,isPdf(f)?"document.pdf":"photo.jpg")},function(){throw new Error("このファイルは読み込めませんでした。写真かPDFを選んでください。")})
  .then(function(r){if(!r.ok)throw new Error(r.error||"送信できませんでした。もう一度お試しください。");row(doc,r.status,r.count)});
 })},Promise.resolve()).then(function(){msg.textContent=""},function(e){msg.textContent=e.message||"送信できませんでした。もう一度お試しください。"});
})});
})();`;

const docRow = (r: PublicRequestView): string => {
  const status = esc(r.status);
  const label = DOC_REQUEST_PUBLIC_LABELS[r.status] + (r.fileCount > 0 ? `(${r.fileCount}点)` : "");
  const buttons = r.status === "received" ? "" : `<div class="btns">
<label class="btn main">写真を撮る<input type="file" accept="image/*" capture="environment" aria-label="${esc(r.label)}を撮影"></label>
<label class="btn">ファイルを選ぶ<input type="file" accept="image/*,application/pdf" multiple aria-label="${esc(r.label)}のファイルを選ぶ"></label>
</div>`;
  return `<section class="doc" data-id="${esc(r.id)}"><div class="name">${esc(r.label)}</div><div class="st" data-status="${status}">${esc(label)}</div>${buttons}<p class="msg" role="status"></p></section>`;
};

export interface PublicRequestView { id: string; label: string; status: DocRequestStatus; fileCount: number }

export function renderSubmitPage(input: { companyName: string; requests: PublicRequestView[]; nonce: string }): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer"><title>書類のご提出</title><style nonce="${input.nonce}">${STYLE}</style></head><body><main>
<h1>${esc(input.companyName)} 書類のご提出</h1>
<p>書類ごとに、写真を撮るかファイルを選んでください。写真とPDFを送れます(写真は自動で縮めます。PDFは30MBまでで、8MBを超えるものは自動で縮めます)。</p>
${input.requests.map(docRow).join("\n")}
<p class="note">送っていただいたファイルは、このページでは見られません。届いたことだけを表示します。</p>
<noscript><p>このページを使うには JavaScript を有効にしてください。</p></noscript>
</main><script nonce="${input.nonce}">${SCRIPT}</script></body></html>`;
}

/** 使えないリンク。期限切れ・無効・存在しないを見分けられないよう、同じ画面にする。 */
export function renderSubmitMessage(message: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer"><title>書類のご提出</title></head><body><p>${esc(message)}</p></body></html>`;
}

export const SUBMIT_UNAVAILABLE_MESSAGE = "このリンクは使えません。お手数ですが、担当者へご連絡ください。";
export const SUBMIT_THROTTLED_MESSAGE = "アクセスが集中しています。しばらくしてからもう一度お試しください。";
export const newPageNonce = (): string => crypto.randomBytes(16).toString("base64");

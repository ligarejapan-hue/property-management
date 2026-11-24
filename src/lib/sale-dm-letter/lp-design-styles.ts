/**
 * 売却の代表LP 5つの見た目の CSS(設計 docs/superpowers/specs/2026-11-24-lp-design-ab)。見本の CSS をそのまま写し、次だけ変えた。
 *  - 書体: 外部の書体は読まない(CSP default-src 'none')=今の LP と同じ端末の明朝体(LP_SERIF)・ゴシック体。
 *  - スクリプトが動くとき(html.rv)だけ、現れる前の状態に隠す・畳む。スクリプトが無い・止まったときは最初から全部見える。
 *  - 本番の申込フォームの注意・完了の表示(.fld-err / .inq-msg / .inq-done)は見本の .err / .done と同じ見た目。
 *  - 電話番号が無いときの下の固定バー(.bar div.one)。
 */
import { LP_SERIF } from "./lp-page";

/** 本文のゴシック体(今の LP の本文と同じ並び)。 */
export const LP_GOTHIC = "-apple-system,BlinkMacSystemFont,'Hiragino Kaku Gothic ProN','Yu Gothic UI','Noto Sans JP',sans-serif";

/** 5案で共通の CSS(色・書体・動き・下半分の節・フォーム)。 */
export const LP_DESIGN_COMMON_CSS = `:root{
  --ink:#0c1420; --ink2:#131e2e; --paper:#f6f3ee; --paper2:#ece7df;
  --brass:#b8985a; --brass-l:#d9c08a; --brass-d:#7d6432;
  --on-ink:#efe9dd; --on-ink-2:#b9b5aa; --on-paper:#161b24; --on-paper-2:#4a4f58;
  --line-ink:rgba(217,192,138,.28); --line-paper:rgba(22,27,36,.18);
  --mincho:${LP_SERIF};
  --goth:${LP_GOTHIC};
  --latin:'Times New Roman',Times,${LP_SERIF};
  --out:cubic-bezier(.23,1,.32,1); --inout:cubic-bezier(.77,0,.175,1);
  --gl:max(22px,env(safe-area-inset-left,0px)); --gr:max(22px,env(safe-area-inset-right,0px));
  color-scheme:dark;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{background:var(--ink);color:var(--on-ink);font-family:var(--goth);font-size:16px;line-height:1.9;-webkit-font-smoothing:antialiased;overflow-x:hidden}
body::before{content:"";position:fixed;inset:0 0 auto;height:env(safe-area-inset-top,0px);background:var(--ink);z-index:30}
h1,h2,h3,p{margin:0}
a{color:inherit}
.wrap{max-width:560px;margin:0 auto;padding-left:var(--gl);padding-right:var(--gr)}
.sec{padding-block:88px}
.dark{background:var(--ink);color:var(--on-ink)}
.light{background:var(--paper);color:var(--on-paper)}
.h2{font-family:var(--mincho);font-weight:700;font-size:clamp(26px,7.2vw,34px);line-height:1.55;letter-spacing:.04em;text-wrap:balance}
.lede{font-size:15.5px;line-height:2;margin-top:22px}
.dark .lede{color:var(--on-ink-2)} .light .lede{color:var(--on-paper-2)}
.rule{height:1px;background:var(--brass);width:56px;margin-bottom:26px;transform-origin:left}
.nb{white-space:nowrap}

/* ---------- reveal (one-shot) ---------- */
.m{display:block;overflow:hidden}
.m>span{display:block;transition:transform .9s var(--out)}
.rv .m>span{transform:translateY(108%)}
.in .m>span,.m.in>span{transform:none}
.m:nth-child(2)>span{transition-delay:.09s}.m:nth-child(3)>span{transition-delay:.18s}.m:nth-child(4)>span{transition-delay:.27s}
.f{transition:opacity .7s ease,transform .8s var(--out)}
.rv .f{opacity:0;transform:translateY(22px)}
.f.in{opacity:1;transform:none}
.f.d1{transition-delay:.1s}.f.d2{transition-delay:.2s}.f.d3{transition-delay:.3s}.f.d4{transition-delay:.4s}
.rule{transition:transform 1s var(--inout)}
.rv .rule{transform:scaleX(0)}
.rule.in{transform:none}
.wipe{transition:clip-path 1.1s var(--inout)}
.rv .wipe{clip-path:inset(0 100% 0 0)}
.wipe.in{clip-path:inset(0 0 0 0)}
.wipe.r{transition-delay:.15s}.rv .wipe.r{clip-path:inset(0 0 0 100%)}.wipe.r.in{clip-path:inset(0 0 0 0)}

/* ---------- header ---------- */
.top{position:fixed;inset:env(safe-area-inset-top,0px) 0 auto;z-index:20;transition:background-color .4s ease,border-color .4s ease;border-bottom:1px solid transparent}
.top.solid{background:rgba(12,20,32,.9);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-color:var(--line-ink)}
.top .wrap{display:flex;justify-content:space-between;align-items:center;height:58px}
.logo{display:block;height:21px;width:auto}
.toptel{font-family:var(--mincho);font-weight:600;font-variant-numeric:lining-nums tabular-nums;font-size:16px;letter-spacing:.06em;text-decoration:none;color:var(--on-ink)}

/* ---------- hero ---------- */
.hero{position:relative;min-height:100svh;display:flex;flex-direction:column;justify-content:flex-end;padding-block:96px 34px;overflow:hidden}
.sky{position:absolute;left:0;right:0;top:64px;height:25svh;max-height:210px;pointer-events:none}
.sky svg{width:100%;height:100%;display:block}
.sky path,.sky circle{fill:none;stroke:var(--brass);stroke-width:1.1;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1;stroke-dashoffset:1;animation:draw 2.6s var(--inout) forwards}
.sky .s2{animation-delay:.35s}.sky .s3{animation-delay:.7s}.sky .s4{animation-delay:1.05s}.sky .s5{animation-delay:1.4s}.sky .s6{animation-delay:1.75s}
.sky .thin{stroke-width:.6;stroke:var(--brass-d)}
@keyframes draw{to{stroke-dashoffset:0}}
.hero .veil{position:absolute;inset:auto 0 0;height:66%;background:linear-gradient(to top,var(--ink) 78%,rgba(12,20,32,0));pointer-events:none}
.hero .wrap{position:relative;width:100%}
.kicker{font-family:var(--mincho);font-size:14px;letter-spacing:.34em;color:var(--brass-l);margin-bottom:20px}
.h1{font-family:var(--mincho);font-weight:600;font-size:clamp(30px,9.3vw,46px);line-height:1.42;letter-spacing:.06em}
.h1 .m>span{transition-duration:1.15s}
.hero .m:nth-child(1)>span{transition-delay:.5s}.hero .m:nth-child(2)>span{transition-delay:.66s}.hero .m:nth-child(3)>span{transition-delay:.82s}
.hero .lede{max-width:30em}
.cta{position:relative;display:flex;align-items:center;justify-content:center;gap:12px;min-height:62px;margin-top:32px;border:1px solid var(--brass);color:var(--on-ink);text-decoration:none;font-family:var(--mincho);font-size:17px;font-weight:600;letter-spacing:.2em;overflow:hidden;transition:transform .16s var(--out),color .5s ease;background:transparent;width:100%;cursor:pointer}
.cta::before{content:"";position:absolute;inset:0;background:var(--brass);transform:scaleX(0);transform-origin:left;transition:transform .6s var(--inout)}
.cta>span{position:relative}
.cta .ar{width:26px;height:1px;background:currentColor;position:relative;transition:transform .5s var(--out)}
.cta .ar::after{content:"";position:absolute;right:0;top:-3px;width:7px;height:7px;border-top:1px solid currentColor;border-right:1px solid currentColor;transform:rotate(45deg)}
.cta:active{transform:scale(.975)}
.cta.fill{color:var(--ink)}.cta.fill::before{transform:none}
@media (hover:hover) and (pointer:fine){.cta:hover{color:var(--ink)}.cta:hover::before{transform:none}.cta:hover .ar{transform:translateX(6px)}}
.light .cta{color:var(--on-paper);border-color:var(--on-paper)}
.light .cta::before{background:var(--on-paper)}
.light .cta.fill{color:var(--paper)}
@media (hover:hover) and (pointer:fine){.light .cta:hover{color:var(--paper)}}
.note{font-size:13.5px;line-height:1.8;margin-top:14px;text-align:center}
.dark .note{color:var(--on-ink-2)}.light .note{color:var(--on-paper-2)}
.scrollcue{display:flex;align-items:center;gap:12px;margin-top:30px;font-family:var(--latin);font-size:14px;letter-spacing:.24em;color:var(--on-ink-2)}
.scrollcue b{display:block;width:1px;height:38px;background:var(--line-ink);position:relative;overflow:hidden}
.scrollcue b::after{content:"";position:absolute;inset:0;background:var(--brass-l);animation:cue 2.2s var(--inout) infinite}
@keyframes cue{0%{transform:translateY(-100%)}60%,100%{transform:translateY(100%)}}

/* ---------- marquee ---------- */
.mq{border-block:1px solid var(--line-ink);overflow:hidden;padding-block:20px;position:relative}
.mq .track{display:flex;width:max-content;animation:mq 46s linear infinite}
.mq.paused .track{animation-play-state:paused}
.mq span{font-family:var(--mincho);font-size:26px;letter-spacing:.2em;padding:0 22px;white-space:nowrap;color:var(--on-ink)}
.mq span:nth-child(even){color:transparent;-webkit-text-stroke:1px var(--brass-d);font-family:var(--latin);font-size:30px;letter-spacing:.12em;padding:0 6px}
@keyframes mq{to{transform:translateX(-50%)}}
.mqbtn{position:absolute;right:8px;bottom:6px;min-width:44px;min-height:30px;font:500 12px var(--goth);color:var(--on-ink-2);background:var(--ink);border:1px solid var(--line-ink);border-radius:15px;cursor:pointer}

/* ---------- statement (scroll linked) ---------- */
.say{font-family:var(--mincho);font-weight:600;font-size:clamp(25px,7vw,33px);line-height:1.85;letter-spacing:.05em}
.say span{display:inline-block;white-space:nowrap;transition:opacity .35s ease}
.rv .say span{opacity:.16}
.say span.on{opacity:1}

/* ---------- options scroller ---------- */
.ways{display:flex;gap:14px;overflow-x:auto;scroll-snap-type:x mandatory;padding:6px var(--gr) 10px var(--gl);margin-top:36px;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.ways::-webkit-scrollbar{display:none}
.way{flex:0 0 76%;max-width:320px;scroll-snap-align:center;border:1px solid var(--line-ink);background:var(--ink2);padding:26px 22px 28px;display:flex;flex-direction:column;gap:14px;min-height:300px;min-width:0}
.way .no{font-family:var(--latin);font-size:44px;line-height:1;color:var(--brass-l)}
.way h3{font-family:var(--mincho);font-size:25px;font-weight:700;letter-spacing:.1em}
.way p{font-size:14.5px;line-height:1.95;color:var(--on-ink-2)}
.way svg{width:54px;height:54px;margin-top:auto;stroke:var(--brass);fill:none;stroke-width:1.1;stroke-linecap:round;stroke-linejoin:round}
.dots{display:flex;gap:8px;justify-content:center;margin-top:16px}
.dots i{width:22px;height:2px;background:var(--line-ink);transition:background-color .3s ease,transform .4s var(--out);transform-origin:center}
.dots i.on{background:var(--brass-l);transform:scaleX(1.5)}

/* ---------- two ways ---------- */
.duo{display:grid;gap:16px;margin-top:38px}
.pane{padding:28px 22px 30px;display:flex;flex-direction:column;gap:12px}
.pane.a{background:var(--on-paper);color:var(--paper)}
.pane.b{background:var(--paper2);color:var(--on-paper);border:1px solid var(--line-paper)}
.pane small{font-size:13.5px;letter-spacing:.14em}
.pane.a small{color:var(--brass-l)}.pane.b small{color:var(--brass-d)}
.pane h3{font-family:var(--mincho);font-size:29px;font-weight:700;letter-spacing:.12em}
.pane p{font-size:14.5px;line-height:1.95}
.pane .c{font-size:13.5px;line-height:1.8;padding-top:12px;border-top:1px solid currentColor;opacity:.82}

/* ---------- flow (scroll linked line) ---------- */
.flow{position:relative;margin-top:44px;padding-left:34px;display:flex;flex-direction:column;gap:38px}
.flow .rail{position:absolute;left:7px;top:8px;bottom:8px;width:1px;background:var(--line-ink)}
.flow .rail i{position:absolute;inset:0;background:var(--brass-l);transform-origin:top}
.rv .flow .rail i{transform:scaleY(0)}
.step{position:relative}
.step::before{content:"";position:absolute;left:-34px;top:9px;width:15px;height:15px;border-radius:50%;border:1px solid var(--brass);background:var(--ink);transition:background-color .5s ease,transform .5s var(--out)}
.step.on::before{background:var(--brass-l);transform:scale(1.15)}
.step h3{font-family:var(--mincho);font-size:21px;font-weight:700;letter-spacing:.08em}
.step p{font-size:14.5px;line-height:1.95;color:var(--on-ink-2);margin-top:6px}
.step em{font-style:normal;font-family:var(--latin);font-size:15px;letter-spacing:.2em;color:var(--brass-l);display:block;margin-bottom:2px}

/* ---------- cases ---------- */
.cases{margin-top:40px;display:flex;flex-direction:column;gap:18px}
.case{background:#fffdf9;border:1px solid var(--on-paper);padding:24px 22px 22px;display:flex;flex-direction:column;gap:12px}
.case small{font-size:13px;letter-spacing:.1em;color:var(--brass-d)}
.case h3{font-family:var(--mincho);font-size:20px;line-height:1.65;font-weight:700;letter-spacing:.04em}
.case .body{display:grid;transition:grid-template-rows .6s var(--out)}
.rv .case .body{grid-template-rows:0fr}
html:not(.rv) .case .more,html:not(.rv) .mqbtn{display:none}
.case.open .body{grid-template-rows:1fr}
.case .body>div{overflow:hidden;min-height:85px}
.case p{font-size:14.5px;line-height:1.95;color:var(--on-paper-2)}
.case .more{all:unset;box-sizing:border-box;cursor:pointer;min-height:44px;display:flex;align-items:center;gap:10px;font-family:var(--mincho);font-size:14.5px;font-weight:600;letter-spacing:.14em;color:var(--on-paper);border-top:1px solid var(--line-paper);padding-top:8px}
.case .more:focus-visible{outline:2px solid var(--brass-d);outline-offset:3px}
.case .more i{width:18px;height:1px;background:currentColor;position:relative}
.case .more i::after{content:"";position:absolute;left:8.5px;top:-8.5px;width:1px;height:18px;background:currentColor;transition:transform .5s var(--out)}
.case.open .more i::after{transform:rotate(90deg)}

/* ---------- faq ---------- */
.faq{margin-top:34px;border-top:1px solid var(--line-ink)}
.q{border-bottom:1px solid var(--line-ink)}
.q button{all:unset;box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr) 24px;gap:14px;align-items:center;width:100%;padding:22px 0;cursor:pointer;font-family:var(--mincho);font-size:17.5px;line-height:1.7;font-weight:600;letter-spacing:.04em}
.q button:focus-visible{outline:2px solid var(--brass-l);outline-offset:4px}
.q .x{position:relative;width:18px;height:18px;justify-self:end}
.q .x::before,.q .x::after{content:"";position:absolute;left:0;right:0;top:50%;height:1px;background:var(--brass-l);transition:transform .5s var(--out)}
.q .x::after{transform:rotate(90deg)}
.q.open .x::after{transform:rotate(0deg)}
.q .a{display:grid;transition:grid-template-rows .5s var(--out)}
.rv .q .a{grid-template-rows:0fr}
.q.open .a{grid-template-rows:1fr}
.q .a>div{overflow:hidden;min-height:0}
.q .a p{font-size:14.5px;line-height:2;color:var(--on-ink-2);padding-bottom:24px;transition:opacity .4s ease,transform .5s var(--out)}
.rv .q .a p{opacity:0;transform:translateY(-6px)}
.q.open .a p{opacity:1;transform:none}

/* ---------- form ---------- */
.form{margin-top:36px;display:flex;flex-direction:column;gap:26px}
.fld{position:relative}
.fld input{width:100%;height:60px;border:0;border-bottom:1px solid var(--on-paper);background:transparent;font:500 18px var(--goth);color:var(--on-paper);padding:22px 0 4px;border-radius:0;outline:none}
.fld label{position:absolute;left:0;top:20px;font-size:16px;color:var(--on-paper-2);transform-origin:left top;transition:transform .35s var(--out),color .3s ease;pointer-events:none}
.fld input:focus+label,.fld input:not(:placeholder-shown)+label{transform:translateY(-18px) scale(.78);color:var(--brass-d)}
.fld::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--brass-d);transform:scaleX(0);transform-origin:left;transition:transform .5s var(--inout)}
.fld:focus-within::after{transform:none}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.pv{margin-top:-10px}
.pv summary{font-size:13.5px;text-decoration:underline;text-underline-offset:4px;cursor:pointer;min-height:44px;display:flex;align-items:center;list-style:none}
.pv summary::-webkit-details-marker{display:none}
.pv p{font-size:13px;line-height:1.8;padding-bottom:6px}
.consent{display:flex;gap:12px;align-items:center;font-size:14.5px;min-height:44px;cursor:pointer;margin-top:-14px}
.consent input{width:22px;height:22px;margin:0;accent-color:var(--brass-d);flex:none}
.err{font-size:14px;line-height:1.7;color:#a3261c;margin-top:-10px}
.dark .err{color:#ffb4a8}
.done,.inq-done{font-size:14.5px;line-height:1.9;border:1px solid var(--brass-d);padding:14px 16px;color:var(--on-paper)}
.fld-err,.inq-msg{font-size:14px;line-height:1.7;color:#a3261c}
.fld-err{margin-top:-14px}
.inq-msg ul{margin:0;padding-left:1.2em}
.dark .fld-err,.dark .inq-msg{color:#ffb4a8}
.dark .inq-done{color:var(--on-ink);border-color:var(--brass)}
.fld input.invalid{border-bottom-color:#a3261c}
.pv a{text-decoration:underline}
.telbig{font-family:var(--mincho);font-weight:600;font-variant-numeric:lining-nums tabular-nums;font-size:clamp(32px,9.4vw,44px);letter-spacing:.06em;line-height:1.2;text-decoration:none;display:block;margin-top:8px;color:var(--on-paper)}

/* ---------- footer / bar ---------- */
.foot{padding-block:44px calc(120px + env(safe-area-inset-bottom,0px));font-size:13px;line-height:2;color:var(--on-ink-2);border-top:1px solid var(--line-ink)}
.bar{position:fixed;left:0;right:0;bottom:0;z-index:25;background:rgba(12,20,32,.94);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-top:1px solid var(--line-ink);padding:10px var(--gr) calc(10px + env(safe-area-inset-bottom,0px)) var(--gl);transition:transform .6s var(--out)}
.rv .bar{transform:translateY(110%)}
.rv .bar.show{transform:none}
.bar div{max-width:560px;margin:0 auto;display:grid;grid-template-columns:minmax(0,1fr) 104px;gap:10px}
.bar a{min-height:50px;display:flex;align-items:center;justify-content:center;text-decoration:none;font-family:var(--mincho);font-weight:600;font-size:15.5px;letter-spacing:.14em;transition:transform .16s var(--out)}
.bar a:active{transform:scale(.97)}
.bar .p{background:var(--brass);color:var(--ink)}
.bar .s{border:1px solid var(--brass);color:var(--on-ink)}
.bar div.one{grid-template-columns:minmax(0,1fr)}

@media (min-width:760px){.duo{grid-template-columns:1fr 1fr}.way{flex-basis:300px}}
@media (prefers-reduced-motion:reduce){
  html{scroll-behavior:auto}
  .m>span,.f,.rule,.wipe,.wipe.r{transform:none!important;opacity:1!important;clip-path:none!important;transition:none!important}
  .sky path,.sky circle{animation:none;stroke-dashoffset:0}
  .scrollcue b::after,.mq .track{animation:none}
  .say span{opacity:1!important}
  .flow .rail i{transform:none!important}
  .bar,.cta::before,.q .a,.q .a p,.fld label,.fld::after,.case .body{transition:none}
}
.dark .fld input{border-bottom-color:var(--on-ink-2);color:var(--on-ink)}
.dark .fld label{color:var(--on-ink-2)}
.dark .fld input:focus+label,.dark .fld input:not(:placeholder-shown)+label{color:var(--brass-l)}
.dark .fld::after{background:var(--brass-l)}
.dark .done{color:var(--on-ink);border-color:var(--brass)}`;

/** 案ごとに足す CSS(見本で base に足されている分)。 */
export const LP_DESIGN_EXTRA_CSS = {
  base: "",
  form: "",
  question: `.prog{display:flex;justify-content:space-between;align-items:center;font-family:var(--mincho);font-size:14px;letter-spacing:.14em;color:var(--on-ink-2);margin-bottom:10px}
.pl{height:1px;background:var(--line-ink);position:relative;margin-bottom:32px}
.pl b{position:absolute;left:0;top:-1px;height:3px;width:100%;background:var(--brass-l);transform-origin:left;transform:scaleX(.3333);transition:transform .8s var(--inout)}
.qh{font-family:var(--mincho);font-weight:600;font-size:clamp(22px,6.5vw,32px);line-height:1.6;letter-spacing:.05em}
.rv .stp{display:none}.rv .stp.on{display:block}.stp.on{animation:stin .6s var(--out) both}
@keyframes stin{from{opacity:0;transform:translateX(26px)}to{opacity:1;transform:none}}
.tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:24px}
.tile{all:unset;box-sizing:border-box;cursor:pointer;min-height:88px;padding:14px 16px;border:1px solid var(--line-ink);display:flex;flex-direction:column;justify-content:center;gap:5px;transition:background-color .35s ease,color .35s ease,border-color .35s ease,transform .16s var(--out)}
.tile:active{transform:scale(.975)}
.tile b{font-family:var(--mincho);font-size:19px;font-weight:700;letter-spacing:.08em}
.tile small{font-size:13px;color:var(--on-ink-2);transition:color .35s ease}
.tile[aria-pressed=true]{background:var(--on-ink);color:var(--ink);border-color:var(--on-ink)}
.tile[aria-pressed=true] small{color:var(--on-paper-2)}
.tile:focus-visible{outline:2px solid var(--brass-l);outline-offset:3px}
.back{all:unset;cursor:pointer;min-height:44px;display:inline-flex;align-items:center;font-size:14px;color:var(--on-ink-2);text-decoration:underline;text-underline-offset:4px;margin-top:8px}
@media (prefers-reduced-motion:reduce){.stp.on{animation:none}.pl b,.tile{transition:none}}`,
  compare: `.duo.dk .pane.a{background:var(--on-ink);color:var(--ink)}
.duo.dk .pane.a small{color:var(--brass-d)}
.duo.dk .pane.b{background:transparent;color:var(--on-ink);border:1px solid var(--brass)}
.duo.dk .pane.b small{color:var(--brass-l)}
.cmp{width:100%;border-collapse:collapse;font-size:14.5px;line-height:1.5;margin-top:30px}
.cmp th,.cmp td{padding:13px 6px;text-align:left;border-bottom:1px solid var(--line-paper);font-weight:500}
.cmp thead th{border-bottom:1px solid var(--on-paper);font-family:var(--mincho);font-weight:700;letter-spacing:.1em}`,
  editorial: `.vhero{justify-content:center;padding-block:100px 40px}
.vh{display:flex;flex-direction:row-reverse;justify-content:space-between;gap:14px;min-height:74svh}
.vt{writing-mode:vertical-rl;font-family:var(--mincho);font-weight:600;font-size:clamp(33px,10vw,48px);line-height:1.7;letter-spacing:.14em;margin:0}
.vc{display:block;animation:vdrop 1.5s var(--out) both}
.vc:nth-child(1){animation-delay:.3s}.vc:nth-child(2){animation-delay:.6s}.vc:nth-child(3){animation-delay:.9s}
@keyframes vdrop{from{opacity:0;transform:translateY(-30px)}to{opacity:1;transform:none}}
.vside{display:flex;flex-direction:column;justify-content:flex-end;gap:16px;width:8.4em;font-size:13.5px;line-height:2;color:var(--on-ink-2)}
.vr{display:block;width:1px;height:84px;background:var(--brass);transform-origin:top;animation:vgrow 1.6s var(--inout) 1.1s both}
@keyframes vgrow{from{transform:scaleY(0)}to{transform:none}}
.vside p{animation:vfade 1.2s ease 1.5s both}
@keyframes vfade{from{opacity:0}to{opacity:1}}
.ch+.ch{margin-top:68px}
.chno{font-family:var(--mincho);font-size:14px;letter-spacing:.3em;color:var(--brass-d);margin-bottom:10px}
.mn{font-family:var(--mincho);font-size:16px;line-height:2.15;color:var(--on-paper)!important}
@media (prefers-reduced-motion:reduce){.vc,.vr,.vside p{animation:none}}`,
} as const;

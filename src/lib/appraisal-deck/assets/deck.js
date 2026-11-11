/* お客様向け資料「査定のご報告」の動き(2026-11-10)。数字は <script id="deck-data" type="application/json"> から読む。
 * ⚠データ由来の文字は textContent か esc() を通して入れる(担当者が書いた見出しを HTML として解釈しない)。
 * ⚠外への通信はしない(CSP connect-src 'none')。 */
(()=>{
const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const D=JSON.parse($('#deck-data').textContent);
const f=n=>Math.round(n).toLocaleString('ja-JP'), f1=n=>(Math.round(n*10)/10).toFixed(1);
const fx=n=>Number.isInteger(n)?f(n):String(n);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const STATIC=location.hash==='#static'||matchMedia('(prefers-reduced-motion: reduce)').matches;
const stage=$('#stage'), pages=$$('.page');
if(STATIC) stage.classList.add('static');
const setT=(sel,t)=>{const e=typeof sel==='string'?$(sel):sel;if(e)e.textContent=t;};

/* ---- 査定書の数字 ---- */
const E=D.expected, A=D.ai, ADJ=D.adjustment||{};
const EXP=E.total, AI=A.total;
const PNAME={speed:'スピード',standard:'スタンダード',challenge:'チャレンジ'};
const PLANS=(D.plans&&D.plans.length)?D.plans.map(p=>[PNAME[p.name]+'プラン',p.price]):D.range?[['価格の幅の下限',D.range.min],['価格の幅の上限',D.range.max]]:[];
const IS_RANGE=!(D.plans&&D.plans.length)&&!!D.range;
const DESC={'スピードプラン':'早期の売却を優先される方にお勧めする案です。早めの成約を見込める価格に置いています。','スタンダードプラン':'市場で反響がある現実的な価格で、早期の成約を目指す案です。','チャレンジプラン':'成約までの時期が遅くなる恐れはありますが、より高値での売却を目指す案です。','価格の幅の下限':'ご提案する価格の幅のうち、早めの成約を見込める側の価格です。','価格の幅の上限':'ご提案する価格の幅のうち、より高値での売却を目指す側の価格です。'};
const DESC_C='ご希望の価格で売り出した場合の目安です。成約想定価格との差を見ながら、売出しの時期とあわせてご相談ください。';
const FEE=P=>P<=200?P*0.05*1.1:P<=400?(P*0.04+2)*1.1:(P*.03+6)*1.1, NET=P=>P-FEE(P);
let sel=Math.min(1,Math.max(0,PLANS.length-1)), cv=null, loan=0, xc=0; const NX=P=>NET(P)-xc;
const num=v=>{const t=String(v).replace(/[,，\s万円]/g,'').replace(/[０-９．]/g,c=>c==='．'?'.':String.fromCharCode(c.charCodeAt(0)-65248));return t===''?null:(/^\d+(\.\d+)?$/.test(t)?+t:NaN);};
const rowsOf=()=>cv?[...PLANS,['ご希望の価格',cv]]:PLANS;
const ymd=s=>{if(!s)return '';const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(s);return m?`${+m[1]}年${+m[2]}月${+m[3]}日`:'';};
const SRC='出所：不動産価格査定報告書'+(D.appraisedOn?`（${ymd(D.appraisedOn)}査定）`:'');

/* ---- 見出し・出所 ---- */
const H=D.headlines;
pages.forEach(p=>{const k=p.dataset.k;if(H[k]){p.dataset.h=H[k];setT($('h1',p),H[k]);}});
setT('#src',SRC+'。手取りは仲介手数料と入力した費用を差し引いた目安');
if(D.draft){const d=document.createElement('div');d.id='draft';d.textContent='確認前（社内確認用）';stage.appendChild(d);}

/* ---- キャンバスの縮小 ---- */
function fit(){const vp=$('#vp'),w=vp.clientWidth,h=vp.clientHeight,s=Math.min(w/1920,h/1080);
  stage.style.transform=`translate(${(w-1920*s)/2}px,${(h-1080*s)/2}px) scale(${s})`;}
addEventListener('resize',fit); fit();

const NS='http://www.w3.org/2000/svg';
const el=(t,a={},p)=>{const e=document.createElementNS(NS,t);for(const k in a)e.setAttribute(k,a[k]);p&&p.appendChild(e);return e};
const tx=(p,x,y,s,a={})=>{const t=el('text',{x,y,...a},p);t.textContent=s;return t;};
/* ---- 動きの部品(STATIC のときは何もしない=最終状態) ---- */
const EZ='cubic-bezier(.2,.8,.2,1)';
const AN=(e,kf,o)=>{if(STATIC||!e||!e.animate)return null;return e.animate(kf,{fill:'backwards',easing:EZ,...o});};
const drawIn=(e,dur,delay=0)=>{if(STATIC)return;const L=e.getTotalLength?e.getTotalLength():0;if(!L)return;AN(e,[{strokeDasharray:`${L} ${L}`,strokeDashoffset:L},{strokeDasharray:`${L} ${L}`,strokeDashoffset:0}],{duration:dur,delay});};
const riseIn=(e,delay=0,dur=520,dy=18)=>AN(e,[{transform:`translateY(${dy}px)`,opacity:0},{transform:'none',opacity:1}],{duration:dur,delay});
// 終わりの値は to から作る(表示中の文字から取らない)。同じ要素で走っているものは止める(@codex #694)。
const countUp=(e,from,to,dur,delay,fm=f)=>{if(STATIC||!e)return;const id=(e._cu||0)+1;e._cu=id;const fin=fm(to);e.textContent=fm(from);const t0=performance.now()+delay;const st=t=>{if(e._cu!==id)return;const k=Math.min(1,Math.max(0,(t-t0)/dur));e.textContent=k>=1?fin:fm(from+(to-from)*(1-Math.pow(1-k,3)));if(k<1)requestAnimationFrame(st);};requestAnimationFrame(st);};
const flowDots=(p,w,delay)=>{if(STATIC)return;const q=p.cloneNode();q.removeAttribute('stroke-opacity');q.setAttribute('stroke','var(--canvas)');q.setAttribute('stroke-width',Math.max(2,Math.min(9,w*.16)));q.setAttribute('stroke-dasharray','2 26');q.setAttribute('stroke-linecap','round');q.setAttribute('opacity','.85');q.style.pointerEvents='none';p.after(q);AN(q,[{opacity:0},{opacity:0}],{duration:delay});q.animate([{strokeDashoffset:0},{strokeDashoffset:-56}],{duration:1100,iterations:Infinity});};
const tx2=(p,x,y,lab,val,a={})=>{const t=el('text',{x,y,...a},p);const s1=document.createElementNS(NS,'tspan');s1.textContent=lab+' ';s1.setAttribute('class','nt');s1.setAttribute('font-size','18');const s2=document.createElementNS(NS,'tspan');s2.textContent=val;s2.setAttribute('class','num');s2.setAttribute('font-size','26');t.append(s1,s2);return t;};
function sankey(s,{L,R,x0,x1,top,H,gap=14,anim=false,delay=0,lw=12,cb='R',minSlot=34}){
  const tot=Math.max(L.reduce((a,n)=>a+n.v,0),R.reduce((a,n)=>a+n.v,0),1);
  const k=(H-gap*(Math.max(L.length,R.length)-1))/tot;
  const lay=(arr,x)=>{let y=top;return arr.map(n=>{const h=Math.max(3,n.v*k);const o={...n,x,y,h};y+=Math.max(h,minSlot)+gap;return o;});};
  const LL=lay(L,x0), RR=lay(R,x1);
  let i=0,j=0,ai=0,aj=0; const bands=[];
  while(i<LL.length&&j<RR.length){const l=LL[i],r=RR[j];const take=Math.min(l.v-ai,r.v-aj);if(take>1e-9){const w=Math.max(1,take*k);bands.push({y0:l.y+ai*k+w/2,y1:r.y+aj*k+w/2,w,c:cb==='L'?l.c:r.c});}ai+=take;aj+=take;if(ai>=l.v-1e-9){i++;ai=0;}if(aj>=r.v-1e-9){j++;aj=0;}}
  const mx=(x0+lw+x1)/2;
  bands.forEach((b,n)=>{const p=el('path',{d:`M${x0+lw} ${b.y0} C${mx} ${b.y0} ${mx} ${b.y1} ${x1} ${b.y1}`,fill:'none',stroke:b.c,'stroke-width':b.w,'stroke-opacity':.4},s);if(anim)drawIn(p,900,delay+300+n*140);flowDots(p,b.w,anim?delay+1200+n*140:0);});
  const node=(n,side,d)=>{const g=el('g',{},s);el('rect',{x:n.x,y:n.y,width:lw,height:n.h,fill:n.c},g);const xx=side?n.x+lw+14:n.x-14;tx2(g,xx,n.y+Math.max(n.h,20)/2+9,n.lab,f(n.v),{'text-anchor':side?'start':'end'});if(anim)riseIn(g,d);return g;};
  LL.forEach((n,i)=>node(n,false,delay+i*100)); RR.forEach((n,i)=>node(n,true,delay+1100+i*140));
}
const hitKey=(g,fn)=>{g.addEventListener('click',fn);g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();fn();}});};

/* ---- p1 査定結果 ---- */
const PCT=ADJ.landPercent, HAS_PCT=PCT!=null&&PCT!==0;
const RATIO=AI?EXP/AI*100:null;
(function buildResult(){
  setT('#sec1sub',[D.area,D.kindLabel].filter(Boolean).join('・'));
  setT('#nE',f(EXP));
  setT('#nEsub',E.land!=null&&E.building!=null?`土地${f(E.land)}万円＋建物${f(E.building)}万円`:E.tsubo!=null?`坪${fx(E.tsubo)}万円`:'');
  setT('#nA',AI!=null?f(AI):'—');
  setT('#nAsub',A.land!=null&&A.building!=null?`土地${f(A.land)}万円＋建物${f(A.building)}万円`:A.tsubo!=null?`坪${fx(A.tsubo)}万円・周辺の取引事例から算出`:'周辺の取引事例から算出');
  if(HAS_PCT){setT('#nClab',`土地の評価の補正${ADJ.landReason?'（'+ADJ.landReason+'）':''}`);setT('#nC',(PCT<0?'−':'+')+Math.abs(PCT));setT('#nCu','%');setT('#nCsub','土地の評価に反映');}
  else if(AI!=null){setT('#nClab','成約想定 ÷ AI査定');setT('#nC',f1(RATIO));setT('#nCu','%');setT('#nCsub',EXP===AI?'補正はありません':'物件の評価・流通性を反映');$('#cutbar').style.display='none';}
  // 流れの4枚
  const area=D.kind==='mansion'?D.exclusiveSqm:D.landSqm;
  const st=$$('#flow .step');
  setT($('.n',st[0]),area!=null?fx(area):'—'); $('.n',st[0]).insertAdjacentHTML('beforeend','<u>㎡</u>');
  setT($('.d',st[0]),[D.kind==='mansion'?(D.exclusiveSqm!=null?`専有${fx(D.exclusiveSqm)}㎡`:''):(D.landSqm!=null?`土地${fx(D.landSqm)}㎡`:''),D.floorSqm!=null?`延床${fx(D.floorSqm)}㎡`:'',D.builtYearMonth?D.builtYearMonth.replace(/^(\d{4})-0?(\d+)$/,'$1年$2月築'):'',D.layout||''].filter(Boolean).join('・'));
  setT($('.n',st[1]),AI!=null?f(AI):'—'); $('.n',st[1]).insertAdjacentHTML('beforeend','<u>万円</u>');
  setT($('.d',st[1]),A.landTsubo!=null?`周辺の事例から土地を坪${fx(A.landTsubo)}万円と評価`:A.tsubo!=null?`周辺の事例から坪${fx(A.tsubo)}万円と評価`:'周辺の取引事例から算出');
  setT($('.t',st[2]),HAS_PCT?'③ 土地の評価の補正':'③ 物件の評価');
  setT($('.n',st[2]),f(EXP)); $('.n',st[2]).insertAdjacentHTML('beforeend','<u>万円</u>');
  setT($('.d',st[2]),HAS_PCT?`土地の評価を${Math.abs(PCT)}%${PCT<0?'減額':'増額'}`:ADJ.liquidityPercent?`流通性比率 ${ADJ.liquidityPercent>0?'+':''}${ADJ.liquidityPercent}%を反映`:'成約の見込みを反映');
  const mid=IS_RANGE?(D.range.min+D.range.max)/2:(PLANS.find(p=>p[0]==='スタンダードプラン')||PLANS[0]||[0,0])[1];
  setT($('.t',st[3]),IS_RANGE?'④ 売出しの価格の幅':'④ 売出しの3案');
  setT($('.n',st[3]),PLANS.length?f(IS_RANGE?D.range.min:mid):'—'); $('.n',st[3]).insertAdjacentHTML('beforeend','<u>万円</u>');
  const lo=Math.min(...PLANS.map(p=>p[1])), hi=Math.max(...PLANS.map(p=>p[1]));
  setT($('.d',st[3]),PLANS.length?(IS_RANGE?`${f(lo)}〜${f(hi)}万円`:`スタンダードの場合・${f(lo)}〜${f(hi)}万円`):'');
  setT($('.go',st[3]),IS_RANGE?'売出しの価格 p.3 ›':'売出しの3案 p.3 ›');
  setT('#base1',D.appraisedOn?`査定日 ${ymd(D.appraisedOn)}。本書の有効期限はご報告日から1か月です`:'本書の有効期限はご報告日から1か月です');
})();
function drawCut(anim){
  const s=$('#cutbar'); s.innerHTML=''; if(!HAS_PCT)return;
  const keep=Math.max(0,Math.min(1,(100+PCT)/100)), w=420*keep;
  el('rect',{x:0,y:6,width:w,height:18,fill:'var(--main)'},s);
  if(PCT<0){el('rect',{x:w,y:6,width:420-w,height:18,fill:'none',stroke:'var(--s2)','stroke-dasharray':'5 4'},s);
    if(anim&&!STATIC){const f2=el('rect',{x:w,y:6,width:420-w,height:18,fill:'var(--s2)'},s);f2.style.transformBox='fill-box';f2.style.transformOrigin='0 0';
      f2.animate([{transform:'none',opacity:1,offset:0},{transform:'none',opacity:1,offset:.35},{transform:'translateY(90px) rotate(8deg)',opacity:0,offset:1}],{duration:2600,delay:900,fill:'both',easing:'cubic-bezier(.5,0,.75,0)'});
      const kn=el('line',{x1:w,x2:w,y1:-8,y2:38,stroke:'var(--ink)','stroke-width':3},s);kn.animate([{opacity:0},{opacity:1,offset:.2},{opacity:1,offset:.6},{opacity:0}],{duration:1700,delay:1300,fill:'both'});}}
}
function sceneResult(){
  if(AI!=null)countUp($('#nA'),0,AI,1300,700);
  if(HAS_PCT)countUp($('#nC'),0,PCT,900,1700,v=>(v<0?'−':'+')+Math.round(Math.abs(v)));
  countUp($('#nE'),AI!=null?AI:0,EXP,1200,2600);
  drawCut(true);
}

/* ---- p2 根拠 ---- */
const UNCON=!!D.unconnected&&A.landTsubo!=null&&E.landTsubo!=null&&D.landTsubo!=null;
let wview=UNCON?'bk':'wf';
function drawBlocks(anim){
  const s=$('#bk'); s.innerHTML=''; if(!UNCON)return; const An=anim&&!STATIC;
  const ti=tx(s,40,40,'同じ広さの土地を、接道の条件を満たすかどうかで比べました',{'font-size':22,'font-weight':700}); if(anim)riseIn(ti,0);
  const defs=el('defs',{},s);
  const pat=el('pattern',{id:'hzbk',width:12,height:12,patternUnits:'userSpaceOnUse',patternTransform:'rotate(45)'},defs);
  el('rect',{width:12,height:12,fill:'var(--canvas)'},pat); el('line',{x1:0,y1:0,x2:0,y2:12,stroke:'var(--amber)','stroke-width':3.5,opacity:.45},pat);
  const g=el('g',{class:'hit',tabindex:0,role:'button','aria-label':'土地の評価の補正の根拠',transform:'translate(30,0)'},s);
  const up=e=>{e.style.transformBox='fill-box';e.style.transformOrigin='50% 100%';};
  const TL=A.landTsubo, TR=E.landTsubo, base=330, k=180/Math.max(TL,TR,1), hL=TL*k, hR=TR*k, cL=130, cR=420, bw=104;
  el('line',{x1:10,y1:base,x2:560,y2:base,stroke:'var(--rule)','stroke-width':2},g);
  const bL=el('rect',{x:cL-bw/2,y:base-hL,width:bw,height:hL,fill:'var(--s2)'},g);
  const gh=el('rect',{x:cR-bw/2,y:base-hL,width:bw,height:hL,fill:'none',stroke:'var(--s2)','stroke-width':2.5,'stroke-dasharray':'8 6'},g);
  const bR=el('rect',{x:cR-bw/2,y:base-hR,width:bw,height:hR,fill:'var(--main)'},g);
  up(bL);up(bR);
  tx(g,cL,base-hL-58,'坪単価（万円）',{'font-size':16,'text-anchor':'middle',class:'nt'});
  const vL=tx(g,cL,base-hL-14,fx(TL),{'font-size':42,class:'num','text-anchor':'middle'});
  const vR=tx(g,cR,base-hR-14,fx(TR),{'font-size':42,class:'num','text-anchor':'middle',style:'fill:var(--main)'});
  const nt=el('g',{},g); const r=Math.round(TR/TL*10);
  el('path',{d:`M${cR+bw/2+12} ${base-hL+6} C${cR+bw/2+64} ${base-hL+40} ${cR+bw/2+64} ${base-hR-40} ${cR+bw/2+12} ${base-hR-6}`,fill:'none',stroke:'var(--amber)','stroke-width':2.5},nt);
  tx(nt,cR+bw/2+70,base-110,`約${r}割`,{'font-size':28,'font-weight':700,style:'fill:var(--amber)'});
  tx(nt,cR+bw/2+70,base-80,'の評価',{'font-size':17,'font-weight':700,style:'fill:var(--amber)'});
  const ry=520;
  el('rect',{x:0,y:ry,width:560,height:46,fill:'var(--panel)',stroke:'var(--rule)'},g);
  tx(g,280,ry+30,'道　路',{'font-size':18,'font-weight':700,'text-anchor':'middle',class:'nt'});
  const Lg=el('g',{},g);
  el('rect',{x:30,y:410,width:200,height:110,fill:'var(--s3)',stroke:'var(--s1)','stroke-width':2},Lg);
  tx(Lg,130,458,'接道の条件を',{'font-size':18,'font-weight':700,'text-anchor':'middle'});
  tx(Lg,130,484,'満たす土地',{'font-size':18,'font-weight':700,'text-anchor':'middle'});
  el('line',{x1:36,y1:ry,x2:224,y2:ry,stroke:'var(--green)','stroke-width':6},Lg);
  const Rg=el('g',{},g);
  el('rect',{x:320,y:410,width:200,height:68,fill:'var(--main)'},Rg);
  tx(Rg,420,452,'本物件',{'font-size':20,'font-weight':700,'text-anchor':'middle',style:'fill:var(--canvas)'});
  el('rect',{x:320,y:478,width:200,height:42,fill:'url(#hzbk)'},Rg);
  tx(Rg,420,507,'？',{'font-size':22,'font-weight':700,'text-anchor':'middle',style:'fill:var(--amber)'});
  const cap=el('g',{},g);
  tx(cap,0,596,'✓ 建築基準法の道路に2m以上接する',{'font-size':15,'font-weight':700,style:'fill:var(--green)'});
  tx(cap,560,596,'✕ 建築基準法の道路に2m以上接していない',{'font-size':15,'font-weight':700,'text-anchor':'end',style:'fill:var(--amber)'});
  tx(cap,560,620,'（接し方は物件により異なるため、形は特定していません）',{'font-size':13,'text-anchor':'end',class:'nt'});
  if(An){
    riseIn(Lg,150);riseIn(Rg,350);riseIn(cap,800);
    AN(bL,[{transform:'scaleY(0)'},{transform:'scaleY(1)'}],{duration:900,delay:900});
    countUp(vL,0,TL,900,900,v=>Number.isInteger(TL)?String(Math.round(v)):(Math.round(v*10)/10).toFixed(1));
    AN(gh,[{opacity:0},{opacity:1}],{duration:400,delay:1900});
    AN(bR,[{transform:'scaleY(0)'},{transform:'scaleY(1)'}],{duration:800,delay:2400});
    AN(vR,[{opacity:0},{opacity:1}],{duration:300,delay:2300});
    countUp(vR,TL,TR,900,2400,v=>Number.isInteger(TR)?String(Math.round(v)):(Math.round(v*10)/10).toFixed(1));
    riseIn(nt,3300);
  }
  const X0=680, T=D.landTsubo;
  const L1=el('g',{},s); tx(L1,X0,130,'接道地なら',{'font-size':18,class:'nt'});
  const e1=tx(L1,X0,166,`${fx(TL)}万円 × ${fx(T)}坪 ＝ ${f(A.land)}万円`,{'font-size':22,class:'num',style:'fill:var(--note)'});
  let sw=372; try{sw=e1.getBBox().width;}catch(e){}
  const strike=el('line',{x1:X0,x2:X0+sw,y1:158,y2:158,stroke:'var(--note)','stroke-width':2},s);
  const L2=el('g',{},s); tx(L2,X0,250,'本物件',{'font-size':18,class:'nt'});
  tx(L2,X0,290,`${fx(TR)}万円 × ${fx(T)}坪 ＝ ${f(E.land)}万円`,{'font-size':27,class:'num',style:'fill:var(--main)'});
  const L3=el('g',{class:'hit',tabindex:0,role:'button','aria-label':'成約想定価格の内訳'},s);
  if(E.building!=null){tx(L3,X0,370,`＋ 建物 ${f(E.building)}万円`,{'font-size':24,class:'num'});}
  el('line',{x1:X0,x2:X0+380,y1:400,y2:400,stroke:'var(--rule)','stroke-width':2},L3);
  tx(L3,X0,446,'＝ 成約想定価格',{'font-size':18,class:'nt'});
  tx(L3,X0,510,`${f(EXP)}万円`,{'font-size':56,class:'num',style:'fill:var(--main)'});
  if(An){riseIn(L1,1300);AN(strike,[{opacity:0},{opacity:0,offset:.99},{opacity:1}],{duration:2600});riseIn(L2,3700);riseIn(L3,4300);}
  hitKey(g,()=>openPanel('adj')); hitKey(L3,()=>openPanel('exp'));
}
const nice=v=>{const p=Math.pow(10,Math.floor(Math.log10(Math.max(v,1))));const m=v/p;return (m<=1?1:m<=2?2:m<=5?5:10)*p;};
function drawWF(){
  const s=$('#wf'); s.innerHTML='';
  const vals=[AI||0,EXP||0,...PLANS.map(p=>p[1])], max=nice(Math.max(...vals,1)*1.08), step=max/5;
  const top=40,Hh=500,y=v=>top+Hh-(v/max)*Hh, bw=PLANS.length>2?112:130, x0=70;
  for(let v=0;v<=max+1e-9;v+=step){el('line',{x1:x0-10,x2:1070,y1:y(v),y2:y(v),stroke:'var(--rule)'},s);tx(s,x0-18,y(v)+7,f(v),{'text-anchor':'end','font-size':18,class:'nt'});}
  const items=[];
  if(AI!=null)items.push({k:'ai',lab:['AI査定'],from:0,to:AI,c:'var(--s3)',v:f(AI)});
  if(AI!=null&&AI!==EXP)items.push({k:'adj',lab:EXP<AI?['評価の','補正']:['評価の','加算'],from:Math.min(EXP,AI),to:Math.max(EXP,AI),c:'var(--grey)',v:(EXP<AI?'−':'+')+f(Math.abs(AI-EXP))});
  items.push({k:'exp',lab:['成約想定'],from:0,to:EXP,c:'var(--main)',v:f(EXP)});
  const nBase=items.length;
  PLANS.forEach(([n,v],i)=>items.push({k:'plans',lab:IS_RANGE?[i?'上限':'下限']:[n.replace('プラン',''),'プラン'],from:0,to:v,c:i===PLANS.length-1?'var(--s1)':'var(--s2)',v:f(v)}));
  const gapX=(1000-x0)/(items.length+0.6);
  items.forEach((it,i)=>{
    const x=x0+20+i*gapX+(i>=nBase?gapX*0.6:0), g=el('g',{class:'hit gb',tabindex:0,role:'button','aria-label':it.lab.join('')+'の根拠',style:`--d:${600+i*60}`},s);
    const yt=y(it.to), hh=Math.max(3,y(it.from)-yt);
    el('rect',{class:'bar',x,y:yt,width:bw,height:hh,fill:it.c},g);
    tx(g,x+bw/2,yt-12,it.v,{'text-anchor':'middle','font-size':26,class:'num'});
    it.lab.forEach((l,j)=>tx(g,x+bw/2,top+Hh+34+j*24,l,{'text-anchor':'middle','font-size':20}));
    hitKey(g,()=>openPanel(it.k));
  });
  if(PLANS.length){const xs=x0+20+nBase*gapX+gapX*0.3;el('line',{x1:xs,x2:xs,y1:top+60,y2:top+Hh,stroke:'var(--rule)','stroke-width':2},s);
    tx(s,xs+((PLANS.length)*gapX)/2,top+40,IS_RANGE?'査定書の売出し価格の幅':'査定書の売出しの3案',{'text-anchor':'middle','font-size':20,'font-weight':700});}
}
function setView(v){wview=v;$$('.vt .pk').forEach(b=>{const on=b.dataset.v===v;b.setAttribute('aria-checked',on);b.setAttribute('aria-selected',on);});
  $('#bk').toggleAttribute('hidden',v!=='bk'); $('#wf').toggleAttribute('hidden',v!=='wf'); // SVG は .hidden が効かない
  $('#wT').innerHTML=v==='bk'?'接道の条件で比べる<small>柱の高さ＝坪単価・押すと根拠</small>':'AI査定から成約想定価格まで、と売出しの価格<small>万円・棒を押すと根拠</small>';
  if(v==='bk')drawBlocks(true); else {drawWF(); if(!STATIC)$$('#wf g.hit').forEach((g,i)=>{g.style.transformBox='fill-box';g.style.transformOrigin='50% 100%';AN(g,[{transform:'scaleY(0)'},{transform:'scaleY(1)'}],{duration:600,delay:i*110});});}}
$$('.vt .pk').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.v)));
if(!UNCON)$('.vt').hidden=true;
(function buildBasisSide(){
  if(HAS_PCT){setT('#b2big',(PCT<0?'−':'+')+Math.abs(PCT));setT('#b2what',`土地の評価の補正${ADJ.landReason?'（'+ADJ.landReason+'）':''}`);}
  else {setT('#b2big',AI!=null?f1(RATIO):'—');setT('#b2what','成約想定価格 ÷ AI査定価格');}
  setT('#b2tx',UNCON?`建築基準法の道路に2m以上接していないため、新築・増改築ができず、金融機関の融資も受けにくくなります。買える人が限られるため、土地は坪${fx(A.landTsubo)}万円から坪${fx(E.landTsubo)}万円の評価に下がります。`:
    HAS_PCT?`周辺の取引事例から出したAI査定価格に、物件ごとの条件による土地の評価の補正を反映しました。`:
    (ADJ.items&&ADJ.items.length)?`周辺の取引事例から出したAI査定価格に、${ADJ.items.map(i=>i.label).join('・')}の評価と流通性を反映しました。`:
    `周辺の取引事例から出したAI査定価格をもとに、成約の見込みを反映しました。`);
  setT('#b2cmp',AI!=null?`成約想定 ÷ AI査定 ${f1(RATIO)}%`:''); setT('#b2eq',AI!=null?`＝ ${f(EXP)} ÷ ${f(AI)}`:'');
})();

/* ---- p3 売出し ---- */
function drawPlans(anim){
  const box=$('#pickP'); box.innerHTML='';
  const rows=rowsOf(); if(sel>=rows.length)sel=Math.max(0,rows.length-1);
  rows.forEach(([n,v],i)=>{const b=document.createElement('button');b.type='button';b.className='pk';b.setAttribute('role','radio');b.setAttribute('aria-checked',i===sel);
    b.append(n);const sp=document.createElement('span');sp.textContent=f(v)+'万円';const em=document.createElement('em');em.textContent='手取り '+f(NX(v));b.append(sp,em);
    b.addEventListener('click',()=>{sel=i;drawPlans(true);$('#jPlan').value=String(i);calcFund();});box.appendChild(b);});
  const s=$('#pl'); s.innerHTML='';
  if(!rows.length)return;
  const [n0,v0]=rows[sel], fee=FEE(v0), avail=v0-fee-xc, short=Math.max(0,loan-avail), keep=Math.max(0,avail-loan);
  const Lx=[{lab:n0+'で売却',v:v0,c:'var(--main)'}]; if(short)Lx.push({lab:'ローンの不足分',v:short,c:'var(--amber)'});
  const Rx=[{lab:'仲介手数料',v:fee,c:'var(--grey)'}]; if(xc>0)Rx.push({lab:'その他の費用',v:xc,c:'var(--s3)'}); if(loan>0)Rx.push({lab:'ローン返済',v:loan,c:'var(--s2)'}); if(keep>0)Rx.push({lab:'手取り',v:keep,c:'var(--s1)'});
  sankey(s,{L:Lx,R:Rx,x0:330,x1:660,top:24,H:380,anim:!!anim,delay:300});
  tx(s,0,458,xc>0?'帯の太さは金額に比例。手取りは仲介手数料・その他の費用（とローン返済）を差し引いた目安です。':'帯の太さは金額に比例。税金などの費用は「その他の費用」に入れると手取りから差し引きます。',{'font-size':16,class:'nt'});
  const [n,v]=rows[sel], d=v-EXP;
  $('#bN').innerHTML=''; $('#bN').append((NX(v)<0?'−':'')+f(Math.abs(NX(v)))); $('#bN').insertAdjacentHTML('beforeend','<u>万円</u>');
  setT('#bW',`${n}で成約した場合の手取りの目安`);
  setT('#bTx',n==='ご希望の価格'?DESC_C:(DESC[n]||''));
  setT('#bP',f(v)); setT('#bD',(d>=0?'+':'−')+f(Math.abs(d))); setT('#bExp',f(EXP));
  setT('#bEq',`＝ 売出価格${f(v)} − 仲介手数料${f1(FEE(v))}（税込の上限額）`+(xc>0?` − その他の費用${f(xc)}`:''));
  const bl=$('#bLoan'); bl.innerHTML='';
  if(loan>0){const r=NX(v)-loan;bl.insertAdjacentHTML('beforeend','<br>ローン返済後の手取り <b></b>万円<br><span class="eq"></span>');$('b',bl).textContent=(r<0?'−':'')+f(Math.abs(r));$('.eq',bl).textContent=`＝ 手取り${f(NX(v))} − ローン残高${f(loan)}${r<0?'（売却代金だけでは返済に足りません）':''}`;}
}
function readIns(){
  const c=num($('#iC').value), l=num($('#iL').value); let msg='';
  if(c===null)cv=null; else if(isNaN(c)||c<100||c>99999){msg='ご希望の売出価格は100〜99,999万円の数字で入れてください。';cv=null;} else {const was=cv;cv=Math.round(c);if(!was)sel=PLANS.length;}
  if(l===null)loan=0; else if(isNaN(l)||l>99999){msg+=(msg?' ':'')+'ローン残高は数字で入れてください。';loan=0;} else loan=Math.round(l);
  const x=num($('#iX').value); if(x===null)xc=0; else if(isNaN(x)||x>99999){msg+=(msg?' ':'')+'その他の費用は数字で入れてください。';xc=0;} else xc=Math.round(x);
  setT('#iErr',msg); drawPlans();
  if(document.activeElement!==$('#jL'))$('#jL').value=$('#iL').value; calcFund();
}
['iC','iL'].forEach(id=>$('#'+id).addEventListener('input',readIns));
const XITEMS=['測量費（境界の確定）','建物の解体費用','残置物の処分費','引越し代','ハウスクリーニング','譲渡所得税・住民税','仮住まいの費用','そのほか'];
(()=>{const grid=$('#xGrid'),pop=$('#xPop'),box=$('#xBox'),ix=$('#iX');
  XITEMS.forEach((t,i)=>{grid.insertAdjacentHTML('beforeend',`<label for="xi${i}">${esc(t)}</label><span class="box"><input id="xi${i}" type="text" inputmode="numeric" placeholder="0" autocomplete="off"><span>万円</span></span>`);});
  const sum=()=>{let t=0,bad=[];XITEMS.forEach((n,i)=>{const v=num($('#xi'+i).value);if(v===null)return;if(isNaN(v)||v>99999)bad.push(n);else t+=v;});
    setT('#xErr',bad.length?bad.join('・')+'は数字で入れてください。':'');
    setT('#xSum',f(t)); ix.value=t>0?f(t):''; readIns();};
  XITEMS.forEach((n,i)=>$('#xi'+i).addEventListener('input',sum));
  const open=()=>{pop.hidden=false;ix.setAttribute('aria-expanded','true');setTimeout(()=>$('#xi0').focus(),0);};
  const close=(back)=>{if(pop.hidden)return;pop.hidden=true;ix.setAttribute('aria-expanded','false');if(back)ix.focus();};
  box.addEventListener('click',e=>{e.stopPropagation();pop.hidden?open():close();});
  ix.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '||e.key==='ArrowDown'){e.preventDefault();open();}});
  pop.addEventListener('click',e=>e.stopPropagation());
  pop.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close(true);}});
  $('#xOk').addEventListener('click',()=>close(true));
  $('#xClr').addEventListener('click',()=>{XITEMS.forEach((n,i)=>$('#xi'+i).value='');sum();$('#xi0').focus();});
  document.addEventListener('click',()=>close(false));
})();

/* ---- p4 お住み替えの資金 ---- */
const stamp=P=>P<=1000?0.5:P<=5000?1:P<=10000?3:P<=50000?6:16; // 売買契約書の印紙税(2027年3月31日までの軽減税率)
function fillPlanSel(){const o=$('#jPlan'),cur=o.value;o.innerHTML='';rowsOf().forEach(([n,v],i)=>{const op=document.createElement('option');op.value=String(i);op.textContent=`${n} ${f(v)}`;o.appendChild(op);});o.value=cur&&+cur<rowsOf().length?cur:String(sel);}
const FUND_CUSTOM=!!D.headlineFundCustom;
function calcFund(anim){
  fillPlanSel(); if(!rowsOf().length)return;
  const ids=['jL','jM','jS','jB','jC','jO','jN'], v={}; const bad=[];
  ids.forEach(id=>{const x=num($('#'+id).value); if(x!==null&&(isNaN(x)||x>99999)){bad.push($(`label[for=${id}]`).textContent);v[id]=0;} else v[id]=x;});
  setT('#jErr',bad.length?bad.join('・')+'は数字で入れてください。':'');
  const [n,P]=rowsOf()[+$('#jPlan').value], fee=FEE(P), st=v.jS===null?stamp(P):v.jS;
  $('#jS').placeholder=String(stamp(P));
  const L=v.jL||0, M=v.jM||0, net=P-fee-M-st-L-xc, B=v.jB||0, C=v.jC||0, O=v.jO||0, N=v.jN||0;
  const have=Math.max(0,net)+O+N, need=B+C+(net<0?-net:0), gap=have-need;
  const s=$('#fd'); s.innerHTML='';
  const head=$('#h4');
  if(!B){
    $('#cG').className='big'; $('#cG').textContent=f(net); $('#cG').insertAdjacentHTML('beforeend','<u>万円</u>'); setT('#cW',`${n}で売却したときの手取り（諸費用・ローン返済後）`);
    setT('#cTx','購入予算を入れると、お住み替えの資金の過不足を計算します。');
    setT('#cEq',`＝ 売却${f(P)} − 仲介手数料${f1(fee)} − 抹消費用${f1(M)} − 印紙税${f1(st)}`+(xc>0?` − その他の費用${f(xc)}（p.3で入力）`:'')+` − ローン残高${f(L)}`);
    if(!FUND_CUSTOM)head.textContent=head.closest('section').dataset.h;
    const et=tx(s,20,120,'購入予算を入れると、用意できる資金が新居の購入へ流れる様子を帯で表示します。',{'font-size':22,class:'nt'}); if(anim)riseIn(et,300);
    return;
  }
  const Lf=[]; if(net>0)Lf.push({lab:'売却の手取り',v:net,c:'var(--main)'}); if(O>0)Lf.push({lab:'自己資金',v:O,c:'var(--s1)'}); if(N>0)Lf.push({lab:'新しい借入',v:N,c:'var(--s2)'}); if(gap<0)Lf.push({lab:'不足',v:-gap,c:'var(--amber)'});
  const Rf=[{lab:'購入価格',v:B,c:'var(--grey)'}]; if(C>0)Rf.push({lab:'購入時の諸費用',v:C,c:'var(--s3)'}); if(net<0)Rf.push({lab:'返しきれない残債',v:-net,c:'var(--amber)'}); if(gap>0)Rf.push({lab:'余り',v:gap,c:'var(--s1)'});
  if(!Lf.length)Lf.push({lab:'用意できる資金',v:0.0001,c:'var(--s3)'});
  sankey(s,{L:Lf,R:Rf,x0:300,x1:700,top:14,H:250,anim:!!anim,delay:200,cb:'L',minSlot:30,gap:10});
  const pos=gap>=0;
  $('#cG').className='big'+(pos?'':' neg'); $('#cG').textContent=(pos?'+':'−')+f(Math.abs(gap)); $('#cG').insertAdjacentHTML('beforeend','<u>万円</u>');
  setT('#cW',pos?'お住み替えの資金の余り':'お住み替えの資金の不足');
  setT('#cTx',pos?`${n}で売却し、入力した自己資金と借入で購入すると、資金に余りが出ます。`:`${n}で売却し、入力した自己資金と借入で購入すると、資金が足りません。売出しの価格、購入予算、借入額の見直しで埋める方法をご相談ください。`);
  setT('#cEq',`＝（売却の手取り${f(net)} ＋ 自己資金${f(O)} ＋ 借入${f(N)}）−（購入価格${f(B)} ＋ 諸費用${f(C)}）`);
  if(!FUND_CUSTOM)head.textContent=pos?`${n}で売却すると、お住み替えの資金は${f(gap)}万円の余りが出る見込みです`:`${n}で売却すると、お住み替えの資金が${f(-gap)}万円不足するため、借入か自己資金での補てんが必要です`;
}
['jPlan','jL','jM','jS','jB','jC','jO','jN'].forEach(id=>$('#'+id).addEventListener('input',()=>{if(id==='jL'){$('#iL').value=$('#jL').value;readIns();}calcFund();}));

/* ---- 根拠パネル ---- */
const tbl=(rows,tot)=>`<table>${rows.map(r=>`<tr>${r.map((c,i)=>`<td${i>0?' class="r"':''}>${esc(c)}</td>`).join('')}</tr>`).join('')}${tot?`<tr class="tot">${tot.map((c,i)=>`<td${i>0?' class="r"':''}>${esc(c)}</td>`).join('')}</tr>`:''}</table>`;
const P_=t=>`<p style="margin-top:12px">${esc(t)}</p>`;
const vrows=(v)=>v.land!=null&&v.building!=null?[[`土地${v.landTsubo!=null?'（坪'+fx(v.landTsubo)+'万円）':''}`,f(v.land)],[`建物${v.buildingTsubo!=null?'（坪'+fx(v.buildingTsubo)+'万円）':''}`,f(v.building)]]:v.land!=null?[[`土地${v.landTsubo!=null?'（坪'+fx(v.landTsubo)+'万円）':''}`,f(v.land)]]:v.tsubo!=null?[['坪単価',fx(v.tsubo)]]:[];
const prop=[['所在',D.area],['交通',[D.railLine,D.station,D.walkMinutes!=null?`徒歩${D.walkMinutes}分`:''].filter(Boolean).join(' ')],
  ['種類',D.kindLabel],['土地',D.landSqm!=null?`${fx(D.landSqm)}㎡${D.landTsubo!=null?'（約'+fx(D.landTsubo)+'坪）':''}`:''],
  ['専有面積',D.exclusiveSqm!=null?`${fx(D.exclusiveSqm)}㎡`:''],['所在階',D.floorInfo],['延床面積',D.floorSqm!=null?`${fx(D.floorSqm)}㎡`:''],
  ['構造',D.structure],['間取り',D.layout],['築年月',D.builtYearMonth?D.builtYearMonth.replace(/^(\d{4})-0?(\d+)$/,'$1年$2月'):''],
  ['接道',[D.roadAccess,D.roadDetail].filter(Boolean).join(' ')]].filter(r=>r[1]);
const adjRows=[];
if(HAS_PCT)adjRows.push([`土地の評価${ADJ.landReason?'（'+ADJ.landReason+'）':''}`,`${PCT>0?'+':''}${PCT}%`]);
if(ADJ.landAmount)adjRows.push(['土地の評価',`${ADJ.landAmount>0?'+':''}${f(ADJ.landAmount)}万円`]);
(ADJ.items||[]).filter(i=>i.amount!=null).forEach(i=>adjRows.push([`${i.category}・${i.label}`,`${i.amount>0?'+':''}${f(i.amount)}万円`]));
if(ADJ.liquidityPercent!=null)adjRows.push(['流通性比率',`${ADJ.liquidityPercent>0?'+':ADJ.liquidityPercent<0?'':'±'}${ADJ.liquidityPercent}%`]);
const PANELS={
  p1:{c:'査定結果 › 物件の概要',h:'査定した物件の概要です',tabs:[['物件',tbl(prop)]]},
  ai:{c:'査定の根拠 › AI査定',h:'周辺の取引事例から算出した価格です',tabs:[['内訳',tbl(vrows(A),AI!=null?['AI査定（万円）',f(AI)]:null)]]},
  adj:{c:'査定の根拠 › 評価の補正',h:adjRows.length?'AI査定価格に、次の評価を反映しました':'AI査定価格に追加の補正はありません',tabs:[['補正',adjRows.length?tbl(adjRows):P_('補正はありません。')]]},
  exp:{c:'査定の根拠 › 成約想定価格',h:`成約想定価格は${f(EXP)}万円です`,tabs:[['内訳',tbl(vrows(E),['成約想定（万円）',f(EXP)])]]},
  plans:{c:'査定の根拠 › 売出しの価格',h:IS_RANGE?'成約想定価格をもとに、売出しの価格の幅をご用意しました':'成約想定価格をもとに、売却の時期と価格の優先度に応じた3つの価格をご用意しました',tabs:[[IS_RANGE?'価格の幅':'3案',tbl(PLANS.map(([n,v])=>[n,f(v)]))+(IS_RANGE?'':P_('スピード：早期売却を優先 ／ スタンダード：反響がある現実的な価格で早期成約 ／ チャレンジ：成約が遅れる恐れはあるが、より高値を目指す'))]]},
  cost:{c:'お住み替えの資金 › 諸費用と税金',h:'入力欄のほかに、状況によって次の費用がかかります',tabs:[
    ['ご売却',P_('仲介手数料：宅地建物取引業法の上限額（400万円を超える部分は売却価格×3%＋6万円、税込）。印紙税：売買契約書の金額に応じて決まり、空欄のときは軽減税率（2027年3月31日まで）の額を入れています。抵当権の抹消費用：登録免許税と司法書士の報酬です。譲渡所得税・住民税：売却益が出た場合にかかり、取得費や特例の有無で大きく変わるため、ここでは計算していません。')],
    ['ご購入',P_('購入時の諸費用には、仲介手数料、登記費用、住宅ローンの手数料・保証料、火災保険、不動産取得税、印紙税などが含まれます。物件や借入の条件によって変わるため、見積をもとに入れてください。')]]},
  // 開いた時点の「ご希望の価格」「その他の費用」で計算する(主画面と同じ手取り・@codex #694)
  net:()=>({c:'売出しの価格 › 手取りの計算',h:xc>0?`売出価格から仲介手数料と、入力したその他の費用（${f(xc)}万円）を差し引いた目安です`:'売出価格から仲介手数料を差し引いた目安です。「その他の費用」を入れると、さらにその分を差し引きます',tabs:[
    ['手取り',tbl(rowsOf().map(([n,v])=>[`${n}（${f(v)}）`,'手取り '+f(NX(v))]))+P_('単位は万円。仲介手数料は宅地建物取引業法の上限額（税込）で計算しています。'+(xc>0?'その他の費用も差し引いています。':''))]]})
};
let lastFocus=null;
function openPanel(key){
  const p=typeof PANELS[key]==='function'?PANELS[key]():PANELS[key]; if(!p)return; lastFocus=document.activeElement;
  $('#pbody').innerHTML=`<div class="crumb">${esc(p.c)}</div><h2>${esc(p.h)}</h2><div class="tabs" role="tablist">${p.tabs.map((t,i)=>`<button role="tab" aria-selected="${i===0}" data-t="${i}">${esc(t[0])}</button>`).join('')}</div><div id="tb">${p.tabs[0][1]}</div><div class="src">${esc(SRC)}</div>`;
  $$('.tabs button',$('#pbody')).forEach(b=>b.addEventListener('click',()=>{$$('.tabs button').forEach(x=>x.setAttribute('aria-selected',x===b));$('#tb').innerHTML=p.tabs[+b.dataset.t][1];}));
  if(p.tabs.length<2)$('.tabs',$('#pbody')).hidden=true;
  stage.classList.add('pan'); $('#panel').setAttribute('aria-hidden','false'); $('#panel .x').focus();
}
function closePanel(){if(!stage.classList.contains('pan'))return;stage.classList.remove('pan');$('#panel').setAttribute('aria-hidden','true');lastFocus&&lastFocus.focus&&lastFocus.focus();}
$('#panel .x').addEventListener('click',closePanel); $('#dimmer').addEventListener('click',closePanel);
$$('[data-panel]').forEach(b=>b.addEventListener('click',()=>openPanel(b.dataset.panel)));

/* ---- 物件の場所と周りの様子(周辺地図・2026-11-11) ----
 * 地図のデータは id が deck-map の JSON の要素(物件を原点にしたメートル・0.5m 単位の差分)。
 * 平面の地図(SVG)を描き、ページを開いたときに 3D の街(three)で空から物件へ降りていく動きを重ねる。
 * three が使えない・動きを減らす設定のときは平面の地図だけ。 */
const MAPEL=$('#deck-map'); const MAP=MAPEL?JSON.parse(MAPEL.textContent):null; const MAPON=!!(MAP&&$('#mp'));
const MW=1080, MH=620, MM=2*(MAP?MAP.ex:1000)/MW; // MM: 1px あたりのメートル
const mdec=(a,s)=>{const o=[];let x=0,y=0;for(let i=s;i<a.length;i+=2){x+=a[i];y+=a[i+1];o.push([x/2,y/2]);}return o;};
const MX=x=>MW/2+x/MM, MY=y=>MH/2-y/MM;
const mpath=(pts,close)=>pts.length?'M'+pts.map(([x,y])=>MX(x).toFixed(1)+' '+MY(y).toFixed(1)).join('L')+(close?'Z':''):'';
const RW=[3,5,9,16,26]; // 道路の幅の区分ごとの見た目の幅(m)
let mapDrawn=false;
function drawMap(anim){
  if(!MAPON)return;
  const s=$('#mp');
  if(!mapDrawn){mapDrawn=true; s.innerHTML='';
    el('rect',{x:0,y:0,width:MW,height:MH,fill:'#ECE7DD'},s);
    el('path',{d:MAP.w.map(r=>mpath(mdec(r,0),true)).join(''),fill:'#A8CAE4'},s);
    el('path',{d:MAP.v.map(r=>mpath(mdec(r,0))).join(''),fill:'none',stroke:'#93BEDF','stroke-width':5/MM,'stroke-linecap':'round','stroke-linejoin':'round'},s);
    const roads=[...MAP.r].sort((a,b)=>a[0]-b[0]);
    for(const pass of [0,1]){
      for(let w=0;w<RW.length;w++){
        const rs=roads.filter(r=>r[0]===w); if(!rs.length)continue;
        for(const mw of [0,1]){const q=rs.filter(r=>r[1]===mw); if(!q.length)continue;
          el('path',{d:q.map(r=>mpath(mdec(r,2))).join(''),fill:'none','stroke-linecap':'round','stroke-linejoin':'round',
            stroke:pass?(mw?'#F3E3C3':'#FFFFFF'):'#D3CABB','stroke-width':Math.max(.8,(RW[w]+(pass?0:2.4))/MM)},s);}
      }
    }
    const rl=MAP.t.filter(r=>r[0]!=='トンネル').map(r=>mpath(mdec(r,1))).join('');
    el('path',{d:rl,fill:'none',stroke:'#8E9CAB','stroke-width':3.2},s);
    el('path',{d:rl,fill:'none',stroke:'#FFFFFF','stroke-width':1.6,'stroke-dasharray':'6 6'},s);
    el('path',{d:MAP.b.filter((b,i)=>i!==MAP.p).map(b=>mpath(mdec(b,2),true)).join(''),fill:'#DCD5CB',stroke:'#C9C0B3','stroke-width':.5},s);
    if(MAP.p>=0)el('path',{d:mpath(mdec(MAP.b[MAP.p],2),true),fill:'var(--main)'},s);
    el('rect',{x:0,y:0,width:MW,height:MH,fill:'var(--canvas)',opacity:.18,'pointer-events':'none'},s);
    const cx=MX(0), cy=MY(0);
    const rg=el('g',{id:'mprings'},s);
    [[400,'徒歩5分'],[800,'徒歩10分']].forEach(([m,l])=>{const r=m/MM;
      el('circle',{cx,cy,r,fill:'none',stroke:'var(--main)','stroke-width':2.4,'stroke-dasharray':'8 6'},rg);
      const ly=cy-r-8; if(ly>24)tx(rg,cx,ly,l,{'font-size':18,'font-weight':700,'text-anchor':'middle',style:'fill:var(--main);paint-order:stroke;stroke:var(--canvas);stroke-width:5px'});});
    const pin=el('g',{id:'mppin'},s); el('path',{d:`M${cx} ${cy} c-16 -20 -21 -30 -21 -39 a21 21 0 1 1 42 0 c0 9 -5 19 -21 39z`,fill:'var(--main)',stroke:'var(--canvas)','stroke-width':2},pin); el('circle',{cx,cy:cy-39,r:8,fill:'var(--canvas)'},pin);
    const nb=el('g',{},s); el('path',{d:`M${MW-40} 40 l12 30 l-12 -8 l-12 8z`,fill:'var(--ink)'},nb); tx(nb,MW-40,32,'N',{'font-size':16,'text-anchor':'middle','font-weight':700});
    const L200=200/MM, sy=MH-30; const sb=el('g',{},s); el('path',{d:`M20 ${sy+4} v-8 M20 ${sy} H${20+L200} M${20+L200} ${sy+4} v-8`,fill:'none',stroke:'var(--ink)','stroke-width':2},sb); tx(sb,20+L200/2,sy-12,'200m',{'font-size':15,'text-anchor':'middle',style:'paint-order:stroke;stroke:var(--canvas);stroke-width:5px'});
    const at=el('g',{},s); el('rect',{x:MW-500,y:MH-22,width:500,height:22,fill:'var(--canvas)',opacity:.85},at); tx(at,MW-8,MH-6,'地図：国土地理院ベクトルタイルを加工して作成',{'font-size':13,'text-anchor':'end',class:'nt'});
  }
  if(!anim||STATIC)return;
  stopCity();
  const DV=city3d($('.mapw'))?6900:0;
  const rg=$('#mprings'), pin=$('#mppin');
  if(rg)[...rg.querySelectorAll('circle')].forEach((c,i)=>{c.style.transformBox='fill-box';c.style.transformOrigin='center';AN(c,[{transform:'scale(0)',opacity:0},{transform:'none',opacity:1}],{duration:700,delay:DV+300+i*250});});
  if(pin)AN(pin,[{transform:'translateY(-160px)',opacity:0},{transform:'translateY(0)',opacity:1,offset:.7},{transform:'translateY(-12px)',offset:.85},{transform:'none',opacity:1}],{duration:850,delay:DV?DV-1100:200,easing:'ease-out'});
}
function stopCity(){$$('.mapw .city3d').forEach(c=>c._stop&&c._stop()); $$('.mapw .dcap').forEach(c=>c.remove());}
/* 3D の街(国土地理院ベクトルタイルから作成・建物の高さはイメージ)で、空から物件へ降りる。最後は真上=平面の地図と同じ見え方 */
function city3d(wrap){
  const T=window.THREE; if(!T||!MAP||!wrap)return false;
  const cv=document.createElement('canvas'); cv.className='city3d'; wrap.appendChild(cv);
  let R; try{R=new T.WebGLRenderer({canvas:cv,antialias:true});}catch(e){cv.remove();return false;}
  if(T.ColorManagement)T.ColorManagement.enabled=false; R.outputColorSpace=T.LinearSRGBColorSpace;
  const W=MW*1.5,H=MH*1.5; R.setPixelRatio(1); R.setSize(W,H,false);
  const BG=0xF4F1EC; R.setClearColor(BG,1);
  const scene=new T.Scene(); scene.fog=new T.Fog(BG,2600,6200);
  const EX=MAP.ex, EY=MAP.ey;
  const tc=document.createElement('canvas'),TW=2048,TH=Math.round(2048*EY/EX); tc.width=TW; tc.height=TH;
  const g=tc.getContext('2d'), sx=TW/(2*EX), sy=TH/(2*EY), X=x=>(x+EX)*sx, Y=y=>(EY-y)*sy;
  const path=(r,s0)=>{const p=mdec(r,s0);g.beginPath();p.forEach(([x,y],i)=>i?g.lineTo(X(x),Y(y)):g.moveTo(X(x),Y(y)));};
  g.fillStyle='#ECE7DD'; g.fillRect(0,0,TW,TH);
  g.fillStyle='#A8CAE4'; MAP.w.forEach(r=>{path(r,0);g.closePath();g.fill();});
  g.lineCap='round'; g.lineJoin='round';
  g.strokeStyle='#93BEDF'; g.lineWidth=5*sx; MAP.v.forEach(r=>{path(r,0);g.stroke();});
  const roads=[...MAP.r].sort((a,b)=>a[0]-b[0]);
  roads.forEach(r=>{path(r,2);g.strokeStyle='#D3CABB';g.lineWidth=(RW[r[0]]+2.4)*sx;g.stroke();});
  roads.forEach(r=>{path(r,2);g.strokeStyle=r[1]?'#F3E3C3':'#FFFFFF';g.lineWidth=RW[r[0]]*sx;g.stroke();});
  MAP.t.forEach(r=>{if(r[0]==='トンネル')return;path(r,1);g.strokeStyle='#8E9CAB';g.lineWidth=3.2*sx;g.stroke();g.strokeStyle='#FFFFFF';g.lineWidth=1.6*sx;g.setLineDash([6*sx,6*sx]);g.stroke();g.setLineDash([]);});
  const tex=new T.CanvasTexture(tc); tex.anisotropy=R.capabilities.getMaxAnisotropy();
  const ground=new T.Mesh(new T.PlaneGeometry(2*EX,2*EY),new T.MeshLambertMaterial({map:tex})); scene.add(ground);
  const base=new T.Mesh(new T.BoxGeometry(2*EX,2*EY,60),new T.MeshLambertMaterial({color:0xC9BCA8})); base.position.z=-30.5; scene.add(base);
  const pos=[],nor=[],col=[], C=[[[1,1,1],[.98,.95,.9],[.95,.93,.97],[.99,.97,.93]],[[.84,.89,.95],[.8,.87,.93]],[[.74,.82,.9]],[[.93,.92,.9]]], PC=[.12,.23,.37];
  const push=(a,n,c)=>{pos.push(a[0],a[1],a[2]);nor.push(n[0],n[1],n[2]);col.push(c[0],c[1],c[2]);};
  let ptop=[0,0,0]; const ol=[];
  MAP.b.forEach((b,bi)=>{const h=b[0],cs=C[b[1]]||C[0],c=bi===MAP.p?PC:cs[bi%cs.length],p=mdec(b,2);if(p.length<3)return;
    let tris; try{tris=T.ShapeUtils.triangulateShape(p.map(([x,y])=>new T.Vector2(x,y)),[]);}catch(e){return;}
    tris.forEach(t=>{for(let k=0;k<3;k++){const q=p[t[k]];push([q[0],q[1],h],[0,0,1],c);}});
    for(let i=0;i<p.length;i++){const a=p[i],bb=p[(i+1)%p.length],dx=bb[0]-a[0],dy=bb[1]-a[1],L=Math.hypot(dx,dy)||1,n=[dy/L,-dx/L,0];
      push([a[0],a[1],0],n,c);push([bb[0],bb[1],0],n,c);push([bb[0],bb[1],h],n,c);push([a[0],a[1],0],n,c);push([bb[0],bb[1],h],n,c);push([a[0],a[1],h],n,c);}
    for(let i=0;i<p.length;i++){const a=p[i],bb=p[(i+1)%p.length];ol.push(a[0],a[1],h+.15,bb[0],bb[1],h+.15);}
    if(bi===MAP.p){ptop=[0,0,h];}});
  const bg=new T.BufferGeometry(); bg.setAttribute('position',new T.Float32BufferAttribute(pos,3)); bg.setAttribute('normal',new T.Float32BufferAttribute(nor,3)); bg.setAttribute('color',new T.Float32BufferAttribute(col,3));
  scene.add(new T.Mesh(bg,new T.MeshLambertMaterial({vertexColors:true,side:T.DoubleSide})));
  const og=new T.BufferGeometry(); og.setAttribute('position',new T.Float32BufferAttribute(ol,3)); scene.add(new T.LineSegments(og,new T.LineBasicMaterial({color:0x6B7685,transparent:true,opacity:.42})));
  const pinG=new T.Group(); const pm=new T.MeshLambertMaterial({color:0x1F3A5F,emissive:0x0c1a2c});
  const cone=new T.Mesh(new T.ConeGeometry(9,30,24),pm); cone.rotation.x=-Math.PI/2; cone.position.z=15; pinG.add(cone);
  const ball=new T.Mesh(new T.SphereGeometry(13,24,16),pm); ball.position.z=38; pinG.add(ball);
  const dot=new T.Mesh(new T.SphereGeometry(5.5,16,12),new T.MeshBasicMaterial({color:0xffffff})); dot.position.set(0,-10,40); pinG.add(dot);
  pinG.position.set(ptop[0],ptop[1],ptop[2]+4); pinG.scale.setScalar(1.6); scene.add(pinG);
  const ringM=new T.Mesh(new T.RingGeometry(22,28,48),new T.MeshBasicMaterial({color:0x1F3A5F,transparent:true,opacity:.8,side:T.DoubleSide})); ringM.position.set(0,0,1.5); scene.add(ringM);
  // 明るさは平面の地図の色に近くなるよう合わせた(three r155 以降の光の強さの単位)
  scene.add(new T.HemisphereLight(0xffffff,0x9aa6b4,2.2)); const sun=new T.DirectionalLight(0xfff6e8,1.6); sun.position.set(-0.55,-0.75,1); scene.add(sun);
  // カメラの道すじ:遠くの斜め上 → 物件の近くを低く → 真上(平面の地図と同じ画角)
  const FOV=30, ZEND=(MH/2*MM)/Math.tan(FOV/2*Math.PI/180);
  const cam=new T.PerspectiveCamera(FOV,W/H,10,12000);
  const curve=new T.CatmullRomCurve3([new T.Vector3(-1700,-3300,2600),new T.Vector3(-520,-1500,1050),new T.Vector3(160,-560,330),new T.Vector3(420,-150,560),new T.Vector3(0,-0.02,ZEND)],false,'centripetal');
  const ease=t=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2, DUR=6000, t0=performance.now(); let raf, done=false, stopped=false;
  const up0=new T.Vector3(0,0,1), up1=new T.Vector3(0,1,0);
  const cleanup=()=>{if(stopped)return;stopped=true;cancelAnimationFrame(raf);R.dispose();bg.dispose();og.dispose();tex.dispose();cv.remove();};
  function frame(now){if(stopped)return; const t=Math.max(0,Math.min(1,(now-t0)/DUR)), e=ease(t);
    cam.position.copy(curve.getPoint(e));
    const k=Math.max(0,(e-.78)/.22); cam.up.copy(up0).lerp(up1,k*k).normalize();
    cam.lookAt(0,0,0);
    pinG.position.z=ptop[2]+4+Math.sin(now/260)*4; pinG.rotation.z=now/900;
    ringM.scale.setScalar(1+((now/1400)%1)*2.4); ringM.material.opacity=.8*(1-((now/1400)%1));
    R.render(scene,cam);
    if(t<1)raf=requestAnimationFrame(frame);
    else if(!done){done=true; const a=cv.animate([{opacity:1},{opacity:0}],{duration:800,delay:250,fill:'forwards'}); a.onfinish=cleanup;}}
  raf=requestAnimationFrame(frame);
  cv._stop=cleanup;
  const cap=document.createElement('div'); cap.className='dcap'; cap.textContent=D.area||'物件の周辺'; wrap.appendChild(cap);
  cap.animate([{opacity:0},{opacity:1,offset:.06},{opacity:1,offset:.9},{opacity:0}],{duration:6300,fill:'forwards'}).onfinish=()=>cap.remove();
  setTimeout(()=>{if(cap.isConnected)cap.textContent='物件の場所へ';},3800);
  return true;
}

/* ---- ページ送り ---- */
let cur=0;
const SCN={map:()=>drawMap(true),result:sceneResult,basis:()=>{if(wview==='bk')drawBlocks(true);else setView('wf');},plans:()=>drawPlans(true),fund:()=>calcFund(true)};
/* ページは番号か data-k(map・result・basis・plans・fund)で指す(地図のページがある資料では番号がずれるため)。 */
const PIDX=k=>{const i=pages.findIndex(p=>p.dataset.k===k);return i<0?0:i;};
function go(i,from){
  if(typeof i==='string')i=PIDX(i);
  i=Math.max(0,Math.min(pages.length-1,i)); closePanel(); stage.classList.remove('ovr');
  if(MAPON&&pages[i].dataset.k!=='map')stopCity();
  const prev=pages[cur], dir=i>=cur?1:-1;
  pages.forEach((p,j)=>{p.classList.toggle('on',j===i);p.classList.remove('enter');});
  const p=pages[i]; cur=i; setT('#pg',`${i+1} / ${pages.length}`);
  if(!STATIC){
    const CAM='cubic-bezier(.6,0,.3,1)';
    if(prev&&prev!==p){prev.classList.add('leaving');let a;
      if(from){const r=from.getBoundingClientRect(),sr=stage.getBoundingClientRect(),k=sr.width/1920;prev.style.transformOrigin=`${(r.left+r.width/2-sr.left)/k}px ${(r.top+r.height/2-sr.top)/k}px`;a=prev.animate([{transform:'none',opacity:1},{transform:'scale(2.6)',opacity:0}],{duration:650,easing:CAM});}
      else a=prev.animate([{transform:'none',opacity:1},{transform:`translateX(${-dir*24}%) scale(.82)`,opacity:0}],{duration:650,easing:CAM});
      a.onfinish=a.oncancel=()=>{prev.classList.remove('leaving');prev.style.transformOrigin='';};
      p.animate(from?[{transform:'scale(.4)',opacity:0},{transform:'none',opacity:1}]:[{transform:`translateX(${dir*24}%) scale(.82)`,opacity:0},{transform:'none',opacity:1}],{duration:650,easing:CAM});}
    void p.offsetWidth;p.classList.add('enter');clearTimeout(go.t);go.t=setTimeout(()=>p.classList.remove('enter'),3400);
    const sc=SCN[p.dataset.k]; sc&&sc();
  }
}
$$('[data-go]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.go,b)));
$('#prev').addEventListener('click',()=>go(cur-1)); $('#next').addEventListener('click',()=>go(cur+1));
function overview(){
  closePanel();
  const g=$('#ovg'); g.innerHTML='';
  pages.forEach((p,i)=>{const b=document.createElement('button');b.dataset.i=String(i);b.innerHTML='<span class="pn"></span><span class="sc"></span><div class="hd"></div>';
    setT($('.pn',b),'p.'+(i+1));setT($('.sc',b),p.dataset.sec);setT($('.hd',b),p.dataset.h);
    b.addEventListener('click',()=>go(i,b));AN(b,[{transform:'scale(.5)',opacity:0},{transform:'none',opacity:1}],{duration:480,delay:i*80});g.appendChild(b);});
  stage.classList.add('ovr');
}
addEventListener('keydown',e=>{
  if(e.target.matches('input[type=text],select'))return;
  if(e.key==='Escape'){if(stage.classList.contains('pan'))closePanel();else if(stage.classList.contains('ovr'))stage.classList.remove('ovr');else go(0);}
  else if(e.key==='ArrowRight'||(e.key===' '&&!e.target.matches('button,[role=button]'))){e.preventDefault();go(cur+1);}
  else if(e.key==='ArrowLeft')go(cur-1);
  else if(/^[1-9]$/.test(e.key)&&+e.key<=pages.length)go(+e.key-1);
  else if(e.key==='o'||e.key==='O')overview();
});

drawCut(); if(UNCON)drawBlocks(); drawWF(); setView(wview); drawPlans(); calcFund(); if(MAPON)drawMap(false); go(0);
})();

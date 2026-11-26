import {cards,metrics,addCard,review,removeCard,resetMetrics} from "./learning-data.js";
const $=id=>document.getElementById(id);
function node(tag,text){const n=document.createElement(tag);n.textContent=text;return n;}
function button(text,fn){const b=node("button",text);b.type="button";b.className="btn btn--outline";b.onclick=fn;return b;}
function render(){
 const list=cards(), due=list.filter(c=>c.due<=Date.now()).sort((a,b)=>a.due-b.due);
 const panel=$("learning-review");panel.replaceChildren(node("h3",due.length+" due / "+list.length+" saved"),node("p",list.reduce((n,c)=>n+c.reviews,0)+" reviews on saved cards"));
 const c=due[0];
 if(c){
  const answer=node("p",c.back);answer.hidden=true;
  const again=button("Again",()=>{review(c.id,false);render();}), remembered=button("Remembered",()=>{review(c.id,true);render();});
  again.disabled=remembered.disabled=true;
  panel.append(node("h3",c.front),answer,button("Reveal answer",()=>{answer.hidden=false;again.disabled=remembered.disabled=false;}),again,remembered);
 }else panel.append(node("p","No cards due now."));
 const library=$("learning-library");library.replaceChildren();
 for(const item of list){const row=node("article","");row.append(node("p",item.front+" — "+item.back),node("small","Next review: "+new Date(item.due).toLocaleString()),button("Remove",()=>{removeCard(item.id);render();}));library.append(row);}
 const data=metrics(), good=data.filter(x=>x.ok), timed=good.filter(x=>Number.isFinite(x.elapsed));
 const summary=$("learning-metrics");summary.replaceChildren();
 const stats=[["Recorded outcomes",data.length],["Successful",good.length],["Failed",data.length-good.length],["Cached successes",good.filter(x=>x.cached).length],["Mean successful request time",timed.length?Math.round(timed.reduce((n,x)=>n+x.elapsed,0)/timed.length)+" ms":"No samples"]];
 for(const key of ["target","provider"]){const counts=new Map();for(const e of good)counts.set(e[key],(counts.get(e[key])||0)+1);stats.push([key==="target"?"Target languages":"Providers",Array.from(counts).sort((a,b)=>b[1]-a[1]).map(([k,v])=>k+": "+v).join(" · ")||"No samples"]);}
 for(const [name,value] of stats){const item=node("article","");item.append(node("h3",name),node("p",String(value)));summary.append(item);}
}
$("learning-form").onsubmit=e=>{e.preventDefault();const ok=addCard($("learning-front").value,$("learning-back").value);$("learning-status").textContent=ok?"Card saved.":"Card invalid, duplicate or library full.";if(ok)e.target.reset();render();};
$("learning-reset").onclick=()=>{if(confirm("Clear local analytics?")){resetMetrics();render();}};
$("learning-export").onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify({scope:"standard translation workspace",outcomes:metrics()},null,2)],{type:"application/json"}));const a=document.createElement("a");a.href=url;a.download="lingua-analytics.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
document.addEventListener("lingua-learning-update",render);
render();

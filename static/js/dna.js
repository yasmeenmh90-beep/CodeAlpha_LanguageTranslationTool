const get = id => document.getElementById(id);
const form = get("dna-form"), results = get("dna-results"), helix = get("dna-helix"), run = get("dna-run");
function renderHelix(checks = []) {
  helix.replaceChildren();
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns,"svg");
  svg.setAttribute("viewBox","0 0 160 240");
  function shape(tag, attrs) {
    const el = document.createElementNS(ns,tag);
    for (const [k,v] of Object.entries(attrs)) el.setAttribute(k,v);
    svg.append(el);
  }
  for(let i=0;i<35;i++){
    const a=80+48*Math.sin(i*.28), b=160-a, y=14+i*6;
    const status=checks[Math.floor(i/7)]?.status;
    const color=status==="review"?"#e9a25b":status==="match"?"#d4af37":"#777";
    shape("line",{x1:a,x2:b,y1:y,y2:y,stroke:color,opacity:".5"});
    shape("circle",{cx:a,cy:y,r:3,fill:color});
    shape("circle",{cx:b,cy:y,r:3,fill:color});
  }
  helix.append(svg);
}
function card(title, detail) {
  const article=document.createElement("article"), h=document.createElement("h3"), p=document.createElement("p");
  h.textContent=title; p.textContent=detail; article.append(h,p); results.append(article);
}
function checks(items) {
  for(const c of items) card(c.name+" · "+({"match":"Check matched","review":"Review needed","not_applicable":"Not applicable"}[c.status]), [c.note,c.missing?.length?"Missing: "+c.missing.join(", "):"",c.added?.length?"Added: "+c.added.join(", "):""].filter(Boolean).join("\n"));
}
renderHelix();
fetch("/api/languages").then(r=>{if(!r.ok) throw Error();return r.json();}).then(data=>{
  for(const [code,name] of Object.entries(data)){
    get("dna-source-lang").add(new Option(name,code));
    if(code!=="auto") get("dna-target-lang").add(new Option(name,code));
  }
  get("dna-source-lang").value="en"; get("dna-target-lang").value="fr"; run.disabled=false;
}).catch(()=>{results.textContent="Languages unavailable.";});
form.addEventListener("submit",async e=>{
  e.preventDefault(); if(run.disabled) return;
  run.disabled=true; results.textContent="Analysing…"; renderHelix();
  try{
    const body={text:get("dna-source").value,translated_text:get("dna-target").value,source:get("dna-source-lang").value,target:get("dna-target-lang").value,required_terms:get("dna-terms").value.split("\n").map(t=>t.trim()).filter(Boolean),back_translate:get("dna-back").checked};
    const r=await fetch("/api/translation-dna",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const data=await r.json(); if(!r.ok) throw Error(typeof data.detail==="string"?data.detail:"Check input lengths and language selection.");
    results.replaceChildren(); renderHelix(data.checks); checks(data.checks);
    card("Evaluation scope",data.limitations);
    if(data.back_translation){
      const back=data.back_translation;
      card("Back translation",back.error||back.text+"\nProvider: "+back.provider);
      if(back.checks) checks(back.checks.map(c=>({...c,name:"Back translation / "+c.name})));
    }
  }catch(e){results.textContent=e.message;}
  finally{run.disabled=false;}
});

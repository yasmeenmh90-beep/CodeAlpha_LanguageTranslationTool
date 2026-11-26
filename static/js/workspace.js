const main=document.getElementById("main");
const panels=[...main.querySelectorAll(":scope > [data-workspace]")];
const links=[...document.querySelectorAll(".rail-nav a")];
const valid=new Set(panels.map(p=>p.dataset.workspace));
let current="";
function route(){
 const hash=location.hash.slice(1);
 const key=valid.has(hash)?hash:"translator";
 if(current===key)return;
 current=key;
 for(const panel of panels)panel.hidden=panel.dataset.workspace!==key;
 for(const link of links){
  if(link.hash==="#"+key)link.setAttribute("aria-current","page");
  else link.removeAttribute("aria-current");
 }
 main.dataset.workspaceActive=key;
 window.scrollTo({top:0,behavior:"instant"});
}
if(panels.length&&links.length){
 document.documentElement.classList.add("workspace-routed");
 window.addEventListener("hashchange",route);
 route();
}

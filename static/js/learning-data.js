import {store,getArray} from "./storage.js";
export const cards=()=>getArray("learning-vocab");
export const metrics=()=>getArray("learning-metrics");
export function recordUsage({target,provider,elapsed,cached,ok}){
  store.set("learning-metrics",[{at:Date.now(),target,provider,elapsed:Number.isFinite(elapsed)?elapsed:null,cached:Boolean(cached),ok:Boolean(ok)},...metrics()].slice(0,1000));
  document.dispatchEvent(new Event("lingua-learning-update"));
}
export function addCard(front,back){
  front=front.trim();back=back.trim();
  const list=cards();
  if(!front||!back||front.length>500||back.length>500||list.length>=500||list.some(c=>c.front===front&&c.back===back))return false;
  store.set("learning-vocab",[...list,{id:crypto.randomUUID(),front,back,due:Date.now(),interval:0,reviews:0}]);
  return true;
}
export function review(id,remembered,now=Date.now()){
  store.set("learning-vocab",cards().map(c=>{
    if(c.id!==id)return c;
    const interval=remembered?Math.min(90,Math.max(1,c.interval*2)):0;
    return {...c,interval,due:now+(remembered?interval*86400000:600000),reviews:c.reviews+1};
  }));
}
export function removeCard(id){store.set("learning-vocab",cards().filter(c=>c.id!==id));}
export function resetMetrics(){store.set("learning-metrics",[]);}

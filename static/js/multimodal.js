import { VoiceInput, supported } from "./voice.js";
import * as speech from "./speech.js";
const $ = id => document.getElementById(id);
const status = $("studio-voice-status");
const message = $("studio-message");
const turns = $("studio-turns");
const send = $("studio-send");
const mic = $("studio-mic");
let busy = false;
let session = 0;
const languages = () => $("studio-direction").value === "a"
  ? [$("studio-lang-a").value, $("studio-lang-b").value]
  : [$("studio-lang-b").value, $("studio-lang-a").value];
async function request(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Request failed");
  return data;
}
$("studio-extract").onclick = async () => {
  const file = $("studio-file").files[0];
  const notice = $("studio-file-status");
  if (!file || file.size > 5*1024*1024) { notice.textContent = "Choose a file up to 5 MB."; return; }
  const kind = file.name.split(".").pop().toLowerCase();
  if (!["txt","pdf","docx","png","jpg","jpeg"].includes(kind)) { notice.textContent = "Unsupported format."; return; }
  $("studio-extract").disabled = true;
  $("studio-extracted").value = "";
  notice.textContent = "Extracting…";
  try {
    const data = await request("/api/extract/" + kind, {method:"POST",body:file});
    $("studio-extracted").value = data.text;
    notice.textContent = data.characters + " characters extracted.";
  } catch(e) { notice.textContent = e.message; }
  finally { $("studio-extract").disabled = false; }
};
$("studio-transfer").onclick = () => {
  const text = $("studio-extracted").value;
  if (!text.trim()) return;
  const input = $("input");
  input.value = text;
  input.dispatchEvent(new Event("input", {bubbles:true}));
  input.focus();
  $("translator").scrollIntoView({block:"start"});
};
const voice = new VoiceInput({
  onText: text => { message.value = text.slice(0,5000); },
  onState: active => { mic.textContent = active ? "Stop speech recognition" : "Speak message"; status.textContent = active ? "Listening…" : "Ready"; },
  onError: error => { status.textContent = error; }
});
mic.disabled = !supported;
mic.onclick = () => voice.toggle(languages()[0]);
$("studio-clear").onclick = () => { session++; turns.replaceChildren(); speech.stop(); };
send.onclick = async () => {
  if (busy || !message.value.trim()) return;
  const text = message.value, [source,target] = languages(), epoch = session;
  busy = true; send.disabled = true; status.textContent = "Translating…";
  try {
    const data = await request("/api/translate", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text,source,target})});
    if (epoch !== session) return;
    const article = document.createElement("article");
    const title = document.createElement("h3");
    title.textContent = source + " → " + target;
    const original = document.createElement("p"); original.textContent = text;
    const translated = document.createElement("p"); translated.textContent = data.translated_text;
    const listen = document.createElement("button"); listen.type = "button"; listen.className = "btn btn--outline"; listen.textContent = "Listen"; listen.setAttribute("aria-label","Listen to translation");
    listen.disabled = !speech.supported;
    listen.onclick = () => speech.toggle(data.translated_text,target,listen,notice => { status.textContent = notice; });
    article.append(title, original, translated, listen); turns.append(article);
    while (turns.children.length > 30) turns.firstElementChild.remove();
    if (message.value === text) message.value = "";
    status.textContent = "Translation ready.";
  } catch(e) { status.textContent = e.message; }
  finally { busy = false; send.disabled = false; }
};
let stream, audio, frame, meterPending = false, meterEpoch = 0;
const meter = $("studio-meter");
function stopMeter() {
  meterEpoch++;
  cancelAnimationFrame(frame);
  stream?.getTracks().forEach(track => track.stop());
  audio?.close().catch(()=>{});
  stream = audio = null;
  $("studio-level").value = 0;
  meter.textContent = "Enable microphone level meter";
}
meter.onclick = async () => {
  if (stream) { stopMeter(); return; }
  if (meterPending) return;
  meterPending = true; meter.disabled = true;
  const epoch = meterEpoch;
  try {
    const acquired = await navigator.mediaDevices.getUserMedia({audio:true});
    if (epoch !== meterEpoch) { acquired.getTracks().forEach(t=>t.stop()); return; }
    stream = acquired;
    audio = new (window.AudioContext || window.webkitAudioContext)();
    await audio.resume();
    if (epoch !== meterEpoch) return;
    const analyser = audio.createAnalyser(); analyser.fftSize = 1024;
    audio.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const tick = () => {
      analyser.getFloatTimeDomainData(samples);
      $("studio-level").value = Math.min(1, Math.sqrt(samples.reduce((sum,v)=>sum+v*v,0)/samples.length)*3);
      frame = requestAnimationFrame(tick);
    };
    meter.textContent = "Stop microphone level meter"; tick();
  } catch(e) { stopMeter(); status.textContent = "Microphone meter unavailable."; }
  finally { meterPending = false; meter.disabled = false; }
};
window.addEventListener("pagehide",()=>{stopMeter();voice.stop();});
document.addEventListener("visibilitychange",()=>{if(document.hidden) stopMeter();});
request("/api/languages").then(data=>{
  for(const [code,name] of Object.entries(data)) if(code !== "auto") {
    $("studio-lang-a").add(new Option(name,code)); $("studio-lang-b").add(new Option(name,code));
  }
  $("studio-lang-a").value="en"; $("studio-lang-b").value="fr"; send.disabled=false;
}).catch(()=>{status.textContent="Languages unavailable.";});

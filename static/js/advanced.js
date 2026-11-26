const get = id => document.getElementById(id);
const form = get("advanced-form");
const results = get("advanced-results");
const mode = get("advanced-mode");
const run = get("advanced-run");
let busy = false;
let contextual = false;
let agentic = false;
async function request(url, body) {
  const response = await fetch(url, body ? {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)} : {});
  if (!response.ok) throw new Error("Request failed (" + response.status + ")");
  return response.json();
}
function sync() {
  const ai = mode.value !== "compare";
  get("advanced-context").hidden = !ai;
  get("advanced-engines").hidden = ai;
  run.disabled = busy || (mode.value === "contextual" && !contextual) || (mode.value === "agentic" && !agentic);
  mode.disabled = busy;
}
function show(title, text) {
  const card = document.createElement("article");
  const heading = document.createElement("h3");
  const body = document.createElement("p");
  heading.textContent = title;
  body.textContent = text;
  card.append(heading, body);
  results.append(card);
}
async function init() {
  try {
    const [languages, providers, capabilities] = await Promise.all([
      request("/api/languages"), request("/api/providers"), request("/api/advanced/capabilities")
    ]);
    for (const [code, name] of Object.entries(languages)) {
      get("advanced-source").add(new Option(name, code));
      if (code !== "auto") get("advanced-target").add(new Option(name, code));
    }
    get("advanced-source").value = "auto";
    get("advanced-target").value = "fr";
    for (const provider of providers.providers) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = provider.name;
      input.disabled = !provider.configured;
      input.checked = provider.configured;
      label.append(input, document.createTextNode(" " + provider.label + (provider.configured ? "" : " (not configured)")));
      get("advanced-engines").append(label);
    }
    contextual = capabilities.contextual;
    agentic = capabilities.agentic;
    if (!agentic) { mode.options[2].disabled = true; mode.options[2].textContent += " (not enabled)"; }
    if (!contextual) {
      mode.options[1].disabled = true;
      mode.options[1].textContent += " (server configuration required)";
    }
    mode.addEventListener("change", sync);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (busy) return;
      results.replaceChildren();
      const body = {text:get("advanced-text").value, source:get("advanced-source").value, target:get("advanced-target").value};
      const ai = mode.value !== "compare";
      if (!ai) {
        body.engines = Array.from(get("advanced-engines").querySelectorAll("input:checked"), el => el.value);
        if (!body.engines.length) { show("Select a provider", "Choose at least one configured engine."); return; }
      } else Object.assign(body, {tone:get("advanced-tone").value, style:get("advanced-style").value, context:get("advanced-background").value});
      busy = true; sync(); results.setAttribute("aria-busy","true");
      try {
        const data = await request("/api/translate/" + mode.value, body);
        if (ai) {
          show(data.provider + " · " + (data.tone || "Reviewed translation"), data.translated_text);
          if (data.trace) {
            for (const step of data.trace) show(step.agent, step.status + " · " + step.elapsed_ms + " ms" + (step.tokens == null ? "" : " · " + step.tokens + " tokens"));
            show("Review findings", data.review);
            show("Review limitations", data.quality_note);
          }
        }
        else for (const item of data.results) show(item.engine + (item.ok ? " · " + item.elapsed_ms + " ms" + (item.result.cached ? " (cached)" : "") : ""), item.ok ? item.result.translated_text : item.error);
      } catch (error) { show("Translation failed", error.message); }
      finally { busy = false; sync(); results.setAttribute("aria-busy","false"); }
    });
    sync();
  } catch (error) { show("Studio unavailable", error.message); }
}
if (form) init();

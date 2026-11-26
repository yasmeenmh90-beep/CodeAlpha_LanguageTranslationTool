// DOM helpers. Text is always set via textContent — never innerHTML — so user
// input and API responses can't inject markup.

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/**
 * Create an element.
 *   el("button", { class: "btn", text: "Hi", "aria-label": "Say hi" }, [child])
 * `text` sets textContent; null/false attributes are skipped.
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** An inline SVG that references a <symbol id="i-NAME"> from the sprite in index.html. */
export function icon(name, className = "icon") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

/** Swap the sprite symbol used by the first icon inside `host`. */
export function setIcon(host, name) {
  const use = host.querySelector("svg.icon use");
  if (use) use.setAttribute("href", `#i-${name}`);
}

export const isMac = /Mac|iPhone|iPad|iPod/i.test(
  (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent
);

export const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** True when keyboard focus is somewhere the user types text. */
export function isTypingTarget(node) {
  if (!node) return false;
  const tag = node.tagName;
  return tag === "TEXTAREA" || tag === "SELECT" || (tag === "INPUT" && node.type !== "button") || node.isContentEditable;
}

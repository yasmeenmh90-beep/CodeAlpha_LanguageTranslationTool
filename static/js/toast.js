// Stacked toast notifications (top-right). The container is an aria-live region,
// so screen readers announce each toast as it is added.
import { $, el, icon } from "./dom.js";

const ICONS = { success: "check-circle", error: "alert-circle", info: "info" };
const MAX_VISIBLE = 4;

/**
 * toast("Copied", { type: "success" })
 * toast("Cleared", { action: { label: "Undo", onClick() {...} } })
 */
export function toast(message, { type = "info", duration = 3500, action = null } = {}) {
  const container = $("#toasts");
  if (!container) return;

  const node = el("div", { class: `toast toast--${type}` }, [
    icon(ICONS[type] || ICONS.info, "icon toast__icon"),
    el("p", { class: "toast__msg", text: message }),
  ]);

  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    if (!node.isConnected || node.classList.contains("is-out")) return;
    node.classList.remove("is-in");
    node.classList.add("is-out");
    // transitionend may not fire (reduced motion / hidden tab), so also use a timeout.
    setTimeout(() => node.remove(), 260);
  };

  if (action) {
    const btn = el("button", { type: "button", class: "toast__action", text: action.label });
    btn.addEventListener("click", () => {
      action.onClick();
      dismiss();
    });
    node.append(btn);
  }

  const close = el("button", { type: "button", class: "toast__close", "aria-label": "Dismiss notification" }, [
    icon("x", "icon icon--sm"),
  ]);
  close.addEventListener("click", dismiss);
  node.append(close);

  const start = () => {
    clearTimeout(timer);
    timer = setTimeout(dismiss, duration);
  };
  // Pause auto-dismiss while the user is hovering or focused on the toast.
  node.addEventListener("mouseenter", () => clearTimeout(timer));
  node.addEventListener("mouseleave", start);
  node.addEventListener("focusin", () => clearTimeout(timer));
  node.addEventListener("focusout", start);

  container.append(node);
  const live = container.querySelectorAll(".toast:not(.is-out)");
  if (live.length > MAX_VISIBLE) live[0].remove();

  requestAnimationFrame(() => node.classList.add("is-in"));
  start();
  return dismiss;
}

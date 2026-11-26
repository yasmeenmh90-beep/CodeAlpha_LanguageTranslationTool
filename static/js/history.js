// Rendering for the "Recent" / "Starred" history cards. Pure view code: all
// state changes go through the callbacks supplied by app.js.
import { el, icon } from "./dom.js";

/** "just now", "2 min ago", "3 hr ago", "yesterday", "4 days ago", or a date. */
export function relativeTime(ts, now = Date.now()) {
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 7) return `${day} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function truncate(text, max) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * @param {HTMLElement} list  <ul> to fill
 * @param {object[]} items    history entries { id, text, translation, source, detected, target, provider, ts }
 * @param {object} h          helpers: name(code), dirOf(text, code), isStarred(item), onRestore(item), onDelete(item), onToggleStar(item)
 */
export function renderHistory(list, items, h) {
  const frag = document.createDocumentFragment();

  for (const item of items) {
    const srcCode = item.source === "auto" ? item.detected : item.source;
    const srcName = srcCode ? h.name(srcCode) : "Auto-detected";
    const starred = h.isStarred(item);

    const main = el(
      "button",
      {
        type: "button",
        class: "hcard__main",
        "aria-label": `Restore ${srcName} to ${h.name(item.target)} translation: ${truncate(item.text, 80)}`,
      },
      [
        el("span", { class: "hcard__langs" }, [
          el("span", { text: item.romanized ? `Roman ${srcName === "Hindi" ? "Hindi" : "Urdu"}` : srcName }),
          icon("arrow-right", "icon icon--xs"),
          el("span", { text: h.name(item.target) }),
        ]),
        el("span", { class: "hcard__src", text: item.text, dir: h.dirOf(item.text, srcCode) }),
        el("span", { class: "hcard__out", text: item.translation, dir: h.dirOf(item.translation, item.target), lang: item.target }),
        el("time", {
          class: "hcard__time",
          datetime: new Date(item.ts).toISOString(),
          "data-ts": item.ts,
          text: relativeTime(item.ts),
        }),
      ]
    );
    main.addEventListener("click", () => h.onRestore(item));

    const star = el(
      "button",
      {
        type: "button",
        class: `icon-btn icon-btn--sm${starred ? " is-starred" : ""}`,
        "aria-pressed": String(starred),
        "aria-label": starred ? "Remove from starred" : "Add to starred",
        "data-tooltip": starred ? "Unstar" : "Star",
      },
      [icon("star")]
    );
    star.addEventListener("click", () => h.onToggleStar(item));

    const del = el(
      "button",
      { type: "button", class: "icon-btn icon-btn--sm", "aria-label": "Delete this translation", "data-tooltip": "Delete", "data-tooltip-align": "end" },
      [icon("trash")]
    );
    del.addEventListener("click", () => h.onDelete(item));

    frag.append(el("li", { class: "hcard" }, [main, el("div", { class: "hcard__actions" }, [star, del])]));
  }

  list.replaceChildren(frag);
}

/** Refresh the "x min ago" labels without re-rendering the list. */
export function refreshTimes(root) {
  for (const t of root.querySelectorAll("time[data-ts]")) t.textContent = relativeTime(Number(t.dataset.ts));
}

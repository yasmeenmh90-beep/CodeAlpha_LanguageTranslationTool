// Engine selector in the header: a button + listbox popup (ARIA "select-only combobox"
// style). Shows "Auto (fallback chain)" plus every engine with a status dot —
// green when configured on the server, grey (and disabled) when it isn't.
import { el } from "./dom.js";

export class EngineMenu {
  /**
   * @param {object} o
   * @param {HTMLElement} o.root   wrapper containing #engine-btn and #engine-list
   * @param {(name: string) => void} o.onSelect
   */
  constructor({ root, onSelect }) {
    this.root = root;
    this.onSelect = onSelect;
    this.button = root.querySelector("#engine-btn");
    this.labelEl = root.querySelector(".engine-pill__label");
    this.list = root.querySelector("#engine-list");
    this.engines = [];
    this.chain = [];
    this.value = "auto";
    this.used = null; // engine that answered the last "auto" request
    this.options = [];
    this.active = -1;
    this.#bind();
  }

  get isOpen() {
    return !this.list.hidden;
  }

  label(name) {
    if (name === "auto") return "Auto";
    return this.engines.find((e) => e.name === name)?.label || name;
  }

  shortLabel(name) {
    return { microsoft: "Microsoft", google: "Google Cloud", mymemory: "MyMemory", free: "Google (free)" }[name] || this.label(name);
  }

  setEngines({ providers, chain }, value) {
    this.engines = providers;
    this.chain = chain || providers.filter((p) => p.configured).map((p) => p.name);
    this.button.disabled = false;
    this.setValue(value);
  }

  setValue(name) {
    this.value = name;
    this.used = null;
    this.render();
  }

  /** Remember which engine actually answered (shown as "Auto · MyMemory"). */
  setUsed(name) {
    this.used = name && name !== "none" ? name : null;
    this.renderLabel();
  }

  renderLabel() {
    const text = this.value === "auto" && this.used ? `Auto · ${this.shortLabel(this.used)}` : this.value === "auto" ? "Auto" : this.shortLabel(this.value);
    this.labelEl.textContent = text;
    this.button.setAttribute("aria-label", `Translation engine: ${text}. Change engine`);
  }

  render() {
    this.renderLabel();
    const items = [
      {
        name: "auto",
        label: "Auto (fallback chain)",
        hint: this.chain.length ? this.chain.map((n) => this.shortLabel(n)).join(" → ") : "No engine available",
        configured: this.chain.length > 0,
      },
      ...this.engines.map((e) => ({
        name: e.name,
        label: e.label,
        hint: e.configured ? (e.requires ? "API key configured" : "Free, no key needed") : `Not configured — set ${e.requires}`,
        configured: e.configured,
      })),
    ];
    this.options = items.map((item) =>
      el(
        "li",
        {
          role: "option",
          id: `engine-opt-${item.name}`,
          class: "engine-option",
          "data-name": item.name,
          "aria-selected": String(item.name === this.value),
          "aria-disabled": item.configured ? null : "true",
        },
        [
          el("span", { class: `status-dot ${item.configured ? "status-dot--on" : "status-dot--off"}`, "aria-hidden": "true" }),
          el("span", { class: "engine-option__text" }, [
            el("span", { class: "engine-option__label", text: item.label }),
            el("span", { class: "engine-option__hint", text: item.hint }),
          ]),
          el("span", { class: "sr-only", text: item.configured ? ", available" : ", not configured" }),
        ]
      )
    );
    this.list.replaceChildren(...this.options);
  }

  open() {
    if (this.button.disabled) return;
    this.list.hidden = false;
    this.button.setAttribute("aria-expanded", "true");
    const selected = this.options.findIndex((o) => o.dataset.name === this.value);
    this.setActive(Math.max(selected, 0));
    this.list.focus({ preventScroll: true });
  }

  close(returnFocus = false) {
    if (!this.isOpen) return;
    this.list.hidden = true;
    this.button.setAttribute("aria-expanded", "false");
    this.list.removeAttribute("aria-activedescendant");
    if (returnFocus) this.button.focus({ preventScroll: true });
  }

  setActive(i) {
    this.options[this.active]?.classList.remove("is-active");
    this.active = i;
    const opt = this.options[i];
    if (!opt) return;
    opt.classList.add("is-active");
    this.list.setAttribute("aria-activedescendant", opt.id);
    opt.scrollIntoView({ block: "nearest" });
  }

  /** Move to the next enabled option in `dir` (+1 / -1). */
  step(dir) {
    let i = this.active;
    for (let n = 0; n < this.options.length; n++) {
      i = (i + dir + this.options.length) % this.options.length;
      if (this.options[i].getAttribute("aria-disabled") !== "true") return this.setActive(i);
    }
  }

  choose(option) {
    if (!option || option.getAttribute("aria-disabled") === "true") return;
    const name = option.dataset.name;
    this.close(true);
    if (name !== this.value) {
      this.setValue(name);
      this.onSelect(name);
    }
  }

  #bind() {
    this.button.addEventListener("click", () => (this.isOpen ? this.close(true) : this.open()));
    this.button.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        this.open();
      }
    });
    this.list.addEventListener("keydown", (e) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          this.step(1);
          break;
        case "ArrowUp":
          e.preventDefault();
          this.step(-1);
          break;
        case "Home":
          e.preventDefault();
          this.setActive(0);
          break;
        case "End":
          e.preventDefault();
          this.setActive(this.options.length - 1);
          if (this.options[this.active].getAttribute("aria-disabled") === "true") this.step(-1);
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          this.choose(this.options[this.active]);
          break;
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          this.close(true);
          break;
        case "Tab":
          this.close(false);
          break;
      }
    });
    this.list.addEventListener("click", (e) => this.choose(e.target.closest('[role="option"]')));
    document.addEventListener("pointerdown", (e) => {
      if (this.isOpen && !this.root.contains(e.target)) this.close(false);
    });
  }
}

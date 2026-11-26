// Accessible, searchable language picker (ARIA 1.2 combobox + listbox pattern).
//
// Markup it expects inside `root` (see index.html):
//   .lang-trigger > .lang-trigger__label    button that opens the popover
//   .chips                                   quick-pick buttons for recent languages
//   .picker > .picker__input[role=combobox]  search box (keeps focus while open)
//            [role=listbox]                  options; active one tracked via aria-activedescendant
import { el, icon } from "./dom.js";

const openPickers = new Set();
const CHIP_COUNT = 3;

// Esc closes any open picker even if focus wandered outside it.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") for (const p of [...openPickers]) p.close(true);
});

export class LanguagePicker {
  /**
   * @param {object} o
   * @param {string} o.id           unique prefix for option ids
   * @param {HTMLElement} o.root    container holding the trigger, chips and popover
   * @param {{code:string,name:string}[]} o.languages
   * @param {boolean} o.includeAuto whether "Detect language" is offered (source side)
   * @param {string} o.value        initially selected code
   * @param {string} o.label        accessible label, e.g. "Source language"
   * @param {() => string[]} o.getRecents  most-recent-first language codes
   * @param {(code:string) => void} o.onSelect
   */
  constructor({ id, root, languages, includeAuto, value, label, getRecents, onSelect }) {
    this.id = id;
    this.root = root;
    this.includeAuto = includeAuto;
    this.label = label;
    this.getRecents = getRecents;
    this.onSelect = onSelect;
    this.value = value;
    this.detectedName = null;
    // Multi-select mode (target side, "Translate to multiple"): options toggle
    // membership of getSelected() and the trigger shows `labelOverride`.
    this.multi = false;
    this.getSelected = () => [];
    this.labelOverride = null;

    this.autoLang = languages.find((l) => l.code === "auto") || { code: "auto", name: "Detect language" };
    this.languages = languages
      .filter((l) => l.code !== "auto")
      .sort((a, b) => a.name.localeCompare(b.name));

    this.trigger = root.querySelector(".lang-trigger");
    this.labelEl = root.querySelector(".lang-trigger__label");
    this.chipsEl = root.querySelector(".chips");
    this.popover = root.querySelector(".picker");
    this.search = root.querySelector(".picker__input");
    this.listbox = root.querySelector('[role="listbox"]');

    this.options = [];
    this.activeIndex = -1;

    this.#bind();
    this.updateLabel();
    this.renderChips();
  }

  get isOpen() {
    return !this.popover.hidden;
  }

  name(code) {
    if (code === "auto") return this.autoLang.name;
    const lang = this.languages.find((l) => l.code === code);
    return lang ? lang.name : code;
  }

  has(code) {
    return code === "auto" ? this.includeAuto : this.languages.some((l) => l.code === code);
  }

  setValue(code) {
    this.value = code;
    this.updateLabel();
    this.renderChips();
  }

  /** Switch multi-select mode on/off. `getSelected` returns the selected codes. */
  setMulti(on, { getSelected = () => [], label = null } = {}) {
    this.multi = on;
    this.getSelected = getSelected;
    this.labelOverride = on ? label : null;
    this.listbox.setAttribute("aria-multiselectable", String(on));
    this.updateLabel();
    this.renderChips();
  }

  isSelected(code) {
    return this.multi ? this.getSelected().includes(code) : code === this.value;
  }

  /** Show "English — detected" on the trigger while source is "auto". */
  setDetected(name) {
    this.detectedName = name;
    this.updateLabel();
  }

  updateLabel() {
    if (this.labelOverride) {
      this.labelEl.textContent = this.labelOverride;
      this.trigger.setAttribute("aria-label", `${this.label}: ${this.labelOverride}`);
      return;
    }
    const detected = this.value === "auto" && this.detectedName;
    const text = detected ? `${this.detectedName} — detected` : this.name(this.value);
    // The " — detected" suffix is its own span so narrow layouts can hide it (the badge still says so).
    if (detected) {
      this.labelEl.replaceChildren(this.detectedName, el("span", { class: "lang-trigger__suffix", text: " — detected" }));
    } else {
      this.labelEl.textContent = text;
    }
    this.trigger.setAttribute("aria-label", `${this.label}: ${text}. Change language`);
  }

  renderChips() {
    if (this.multi) {
      this.chipsEl.replaceChildren();
      return;
    }
    const codes = this.getRecents()
      .filter((c) => c !== this.value && this.has(c))
      .slice(0, CHIP_COUNT);
    const chips = codes.map((code) =>
      el("button", {
        type: "button",
        class: "chip",
        "data-code": code,
        text: code === "auto" ? "Detect" : this.name(code),
        "aria-label": `${this.label}: switch to ${this.name(code)}`,
      })
    );
    this.chipsEl.replaceChildren(...chips);
  }

  open() {
    for (const p of [...openPickers]) if (p !== this) p.close(false);
    openPickers.add(this);
    this.popover.hidden = false;
    this.root.classList.add("is-open");
    this.trigger.setAttribute("aria-expanded", "true");
    this.search.setAttribute("aria-expanded", "true");
    this.search.value = "";
    this.render("");
    this.search.focus({ preventScroll: true });
  }

  close(returnFocus = false) {
    if (!this.isOpen) return;
    openPickers.delete(this);
    this.popover.hidden = true;
    this.root.classList.remove("is-open");
    this.trigger.setAttribute("aria-expanded", "false");
    this.search.setAttribute("aria-expanded", "false");
    this.search.removeAttribute("aria-activedescendant");
    if (returnFocus) this.trigger.focus({ preventScroll: true });
  }

  choose(code) {
    this.close(true);
    if (this.multi || code !== this.value) this.onSelect(code);
  }

  /** Build the grouped option list: pinned "Detect", recent, then all (or search results). */
  render(query) {
    const q = query.trim().toLowerCase();
    const matches = (l) => !q || l.name.toLowerCase().includes(q) || l.code.toLowerCase().startsWith(q);
    const groups = [];

    if (!q) {
      if (this.includeAuto) groups.push({ key: "pinned", label: null, items: [this.autoLang] });
      const recent = this.getRecents()
        .filter((c) => c !== "auto")
        .map((c) => this.languages.find((l) => l.code === c))
        .filter(Boolean)
        .slice(0, 5);
      if (recent.length) groups.push({ key: "recent", label: "Recently used", items: recent });
      groups.push({ key: "all", label: "All languages", items: this.languages });
    } else {
      const items = [
        ...(this.includeAuto && matches(this.autoLang) ? [this.autoLang] : []),
        ...this.languages.filter(matches),
      ];
      if (items.length) groups.push({ key: "results", label: `${items.length} result${items.length === 1 ? "" : "s"}`, items });
    }

    this.options = [];
    const frag = document.createDocumentFragment();
    for (const group of groups) {
      const groupEl = el("div", { role: "group", class: "picker__group" });
      if (group.label) {
        const labelId = `${this.id}-grp-${group.key}`;
        groupEl.setAttribute("aria-labelledby", labelId);
        groupEl.append(el("div", { id: labelId, class: "picker__label", role: "presentation", text: group.label }));
      } else {
        groupEl.setAttribute("aria-label", "Automatic");
      }
      for (const lang of group.items) {
        const option = el(
          "div",
          {
            role: "option",
            id: `${this.id}-opt-${group.key}-${lang.code}`,
            class: "picker__option",
            "data-code": lang.code,
            "aria-selected": String(this.isSelected(lang.code)),
          },
          [
            lang.code === "auto"
              ? el("span", { class: "picker__code picker__code--auto", "aria-hidden": "true" }, [icon("sparkles", "icon icon--sm")])
              : el("span", { class: "picker__code", "aria-hidden": "true", text: lang.code.split("-")[0].toUpperCase() }),
            el("span", { class: "picker__name", text: lang.name }),
            icon("check", "icon icon--sm picker__check"),
          ]
        );
        this.options.push(option);
        groupEl.append(option);
      }
      frag.append(groupEl);
    }
    if (!this.options.length) {
      frag.append(el("p", { class: "picker__empty", text: `No languages match “${query.trim()}”` }));
    }
    this.listbox.replaceChildren(frag);

    const selected = this.options.findIndex((o) => this.isSelected(o.dataset.code));
    this.setActive(q ? 0 : Math.max(selected, 0));
  }

  setActive(index, scroll = true) {
    this.options[this.activeIndex]?.classList.remove("is-active");
    this.activeIndex = index;
    const option = this.options[index];
    if (!option) {
      this.search.removeAttribute("aria-activedescendant");
      return;
    }
    option.classList.add("is-active");
    this.search.setAttribute("aria-activedescendant", option.id);
    if (scroll) option.scrollIntoView({ block: "nearest" });
  }

  #onSearchKey(e) {
    const last = this.options.length - 1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        this.setActive(Math.min(this.activeIndex + 1, last));
        break;
      case "ArrowUp":
        e.preventDefault();
        this.setActive(Math.max(this.activeIndex - 1, 0));
        break;
      case "PageDown":
        e.preventDefault();
        this.setActive(Math.min(this.activeIndex + 8, last));
        break;
      case "PageUp":
        e.preventDefault();
        this.setActive(Math.max(this.activeIndex - 8, 0));
        break;
      case "Enter": {
        e.preventDefault();
        const option = this.options[this.activeIndex];
        if (option) this.choose(option.dataset.code);
        break;
      }
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        this.close(true);
        break;
      case "Tab":
        this.close(false);
        break;
    }
  }

  #bind() {
    this.trigger.addEventListener("click", () => (this.isOpen ? this.close(true) : this.open()));
    this.trigger.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        this.open();
      }
    });

    this.search.addEventListener("input", () => this.render(this.search.value));
    this.search.addEventListener("keydown", (e) => this.#onSearchKey(e));

    // Keep focus in the search box when clicking options (so the combobox stays "open").
    this.listbox.addEventListener("mousedown", (e) => e.preventDefault());
    this.listbox.addEventListener("click", (e) => {
      const option = e.target.closest('[role="option"]');
      if (option) this.choose(option.dataset.code);
    });
    this.listbox.addEventListener("mousemove", (e) => {
      const option = e.target.closest('[role="option"]');
      const index = option ? this.options.indexOf(option) : -1;
      if (index >= 0 && index !== this.activeIndex) this.setActive(index, false);
    });

    this.chipsEl.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-code]");
      if (!chip) return;
      // Chips re-render after selection, so move focus to the stable trigger.
      this.trigger.focus({ preventScroll: true });
      if (chip.dataset.code !== this.value) this.onSelect(chip.dataset.code);
    });

    // Close on outside click.
    document.addEventListener("pointerdown", (e) => {
      if (this.isOpen && !this.root.contains(e.target)) this.close(false);
    });
  }
}

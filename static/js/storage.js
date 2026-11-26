// Small, fail-safe wrapper around localStorage. Every read/write is guarded because
// storage can throw (private mode, quota exceeded, disabled cookies).

const PREFIX = "tx:";

export const KEYS = Object.freeze({
  theme: "theme",
  prefs: "prefs", // { source, target, provider }
  history: "history",
  favorites: "favorites",
  recentSource: "recent-source",
  recentTarget: "recent-target",
  multi: "multi", // { enabled, targets }
});

export const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* ignore — persistence is a convenience, not a requirement */
    }
  },
  has(key) {
    try {
      return localStorage.getItem(PREFIX + key) != null;
    } catch {
      return false;
    }
  },
};

/** Read an array from storage, discarding anything that isn't one. */
export function getArray(key, fallback = []) {
  const value = store.get(key, fallback);
  return Array.isArray(value) ? value : fallback;
}

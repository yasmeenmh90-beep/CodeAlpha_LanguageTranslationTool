// Runs synchronously in <head> so the correct theme is applied before first paint
// (prevents a light→dark flash). Kept dependency-free on purpose.
(function () {
  var theme = null;
  try {
    theme = JSON.parse(localStorage.getItem("tx:theme"));
  } catch (e) {
    /* storage unavailable or malformed — fall through to system preference */
  }
  if (theme !== "light" && theme !== "dark") {
    theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.documentElement.setAttribute("data-theme", theme);
})();

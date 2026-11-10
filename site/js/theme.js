// theme.js — light / dark / system, remembered per browser (storage may be unavailable: that's fine).
const KEY = "fm1-inspect-theme";
const root = document.documentElement;
function get() { try { return localStorage.getItem(KEY) || "system"; } catch { return "system"; } }
function apply(mode) {
  if (mode === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", mode);
  document.querySelectorAll("[data-theme-set]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeSet === mode)));
}
apply(get());
document.addEventListener("DOMContentLoaded", () => {
  apply(get());
  document.querySelectorAll("[data-theme-set]").forEach((b) => b.addEventListener("click", () => {
    const m = b.dataset.themeSet; try { localStorage.setItem(KEY, m); } catch {} apply(m);
  }));
});

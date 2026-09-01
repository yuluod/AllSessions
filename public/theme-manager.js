export const THEMES = [
  "greenbar",
  "tui",
  "standard",
  "hdweb",
  "blind",
  "pixel",
];
export const SCHEMES = ["light", "dark", "system"];

const THEME_KEY = "allsessions_theme";
const SCHEME_KEY = "allsessions_scheme";
const DEFAULT_THEME = "greenbar";
const DEFAULT_SCHEME = "system";

let theme = DEFAULT_THEME;
let scheme = DEFAULT_SCHEME;
let systemSchemeQuery = null;
let systemListenerBound = false;

function readPreference(key, allowed, fallback) {
  try {
    const value = localStorage.getItem(key);
    return allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writePreference(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 存储不可用时仍允许当前窗口切换主题。
  }
}

function getSystemScheme() {
  if (!systemSchemeQuery && typeof window?.matchMedia === "function") {
    systemSchemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
  }
  return systemSchemeQuery?.matches ? "dark" : "light";
}

function resolvedScheme() {
  return scheme === "system" ? getSystemScheme() : scheme;
}

function notifyThemeChanged(state) {
  if (typeof document?.dispatchEvent !== "function") return;
  if (typeof CustomEvent === "function") {
    document.dispatchEvent(
      new CustomEvent("allsessions:themechange", { detail: state })
    );
  }
}

function applyTheme() {
  const root = document?.documentElement;
  const actualScheme = resolvedScheme();
  if (root) {
    root.dataset.theme = theme;
    root.dataset.scheme = actualScheme;
    root.style.colorScheme = actualScheme;
  }
  const state = getThemeState();
  notifyThemeChanged(state);
  return state;
}

function bindSystemScheme() {
  getSystemScheme();
  if (systemListenerBound || !systemSchemeQuery?.addEventListener) return;
  systemSchemeQuery.addEventListener("change", () => {
    if (scheme === "system") applyTheme();
  });
  systemListenerBound = true;
}

export function getThemeState() {
  return {
    theme,
    scheme,
    resolvedScheme: resolvedScheme(),
  };
}

export function initTheme() {
  theme = readPreference(THEME_KEY, THEMES, DEFAULT_THEME);
  scheme = readPreference(SCHEME_KEY, SCHEMES, DEFAULT_SCHEME);
  bindSystemScheme();
  return applyTheme();
}

export function setTheme(name) {
  if (!THEMES.includes(name)) return getThemeState();
  theme = name;
  writePreference(THEME_KEY, theme);
  return applyTheme();
}

export function setScheme(mode) {
  if (!SCHEMES.includes(mode)) return getThemeState();
  scheme = mode;
  writePreference(SCHEME_KEY, scheme);
  bindSystemScheme();
  return applyTheme();
}

export function toggleScheme() {
  return setScheme(resolvedScheme() === "dark" ? "light" : "dark");
}

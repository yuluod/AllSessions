export const THEMES = [
  "greenbar",
  "tui",
  "standard",
  "hdweb",
  "blind",
  "pixel",
];
export const SCHEMES = ["light", "dark", "system"];
export const DENSITIES = ["compact", "standard", "comfortable"];

const THEME_KEY = "allsessions_theme";
const SCHEME_KEY = "allsessions_scheme";
const DENSITY_KEY = "allsessions_density";
const DEFAULT_THEME = "standard";
const DEFAULT_SCHEME = "system";
const DEFAULT_DENSITY = "standard";
// 密度作为 html 根字号的乘数：rem 体系整体随之缩放，不只放大正文。
const DENSITY_SCALE = {
  compact: "0.95",
  standard: "1",
  comfortable: "1.12",
};

let theme = DEFAULT_THEME;
let scheme = DEFAULT_SCHEME;
let density = DEFAULT_DENSITY;
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
    root.style.setProperty("--density-scale", DENSITY_SCALE[density]);
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
    density,
    resolvedScheme: resolvedScheme(),
  };
}

export function initTheme() {
  theme = readPreference(THEME_KEY, THEMES, DEFAULT_THEME);
  scheme = readPreference(SCHEME_KEY, SCHEMES, DEFAULT_SCHEME);
  density = readPreference(DENSITY_KEY, DENSITIES, DEFAULT_DENSITY);
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

export function setDensity(name) {
  if (!DENSITIES.includes(name)) return getThemeState();
  density = name;
  writePreference(DENSITY_KEY, density);
  return applyTheme();
}

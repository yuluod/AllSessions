import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const storage = new Map([
  ["allsessions_theme", "tui"],
  ["allsessions_scheme", "system"],
]);
let systemListener = null;
const mediaQuery = {
  matches: true,
  addEventListener(_event, listener) {
    systemListener = listener;
  },
};
const root = { dataset: {}, style: {} };

globalThis.localStorage = {
  getItem(key) {
    return storage.get(key) ?? null;
  },
  setItem(key, value) {
    storage.set(key, value);
  },
};
globalThis.window = {
  matchMedia() {
    return mediaQuery;
  },
};
globalThis.document = {
  documentElement: root,
  dispatchEvent() {},
};

const {
  SCHEMES,
  THEMES,
  getThemeState,
  initTheme,
  setScheme,
  setTheme,
  toggleScheme,
} = await import("../public/theme-manager.js");

test("主题管理器声明六套主题和三种明暗偏好", () => {
  assert.deepEqual(THEMES, [
    "greenbar",
    "tui",
    "standard",
    "hdweb",
    "blind",
    "pixel",
  ]);
  assert.deepEqual(SCHEMES, ["light", "dark", "system"]);
});

test("每套主题为浅色和深色完整实现 token 契约", async () => {
  const sharedTokens = [
    "--font-ui",
    "--font-mono",
    "--font-display",
    "--radius",
    "--radius-small",
    "--density",
  ];
  const schemeTokens = [
    "--bg",
    "--surface",
    "--surface-raised",
    "--surface-sunken",
    "--stripe-a",
    "--stripe-b",
    "--line",
    "--line-strong",
    "--line-accent",
    "--text",
    "--text-secondary",
    "--muted",
    "--text-inverse",
    "--accent",
    "--accent-strong",
    "--accent-soft",
    "--signal",
    "--signal-soft",
    "--info",
    "--info-soft",
    "--warning",
    "--warning-soft",
    "--success",
    "--success-soft",
    "--src-codex",
    "--src-claude",
    "--src-gemini",
    "--src-pi",
    "--src-kimi",
    "--src-opencode",
    "--shadow-raised",
    "--focus-ring",
  ];

  for (const theme of THEMES) {
    const source = await fs.readFile(
      path.join(rootDir, `public/styles/themes/${theme}.css`),
      "utf8"
    );
    for (const token of sharedTokens) assert.match(source, new RegExp(token));
    for (const mode of ["light", "dark"]) {
      const block = source.match(
        new RegExp(
          `\\[data-theme="${theme}"\\]\\[data-scheme="${mode}"\\] \\{([\\s\\S]*?)\\n\\}`
        )
      )?.[1];
      assert.ok(block, `${theme}/${mode} 缺少 token 块`);
      for (const token of schemeTokens) {
        assert.match(
          block,
          new RegExp(token),
          `${theme}/${mode} 缺少 ${token}`
        );
      }
    }
  }
});

test("主题管理器恢复持久化偏好并解析系统明暗", () => {
  const state = initTheme();

  assert.deepEqual(state, {
    theme: "tui",
    scheme: "system",
    resolvedScheme: "dark",
  });
  assert.equal(root.dataset.theme, "tui");
  assert.equal(root.dataset.scheme, "dark");
  assert.equal(root.style.colorScheme, "dark");
  assert.equal(typeof systemListener, "function");
});

test("主题和明暗切换立即生效并持久化", () => {
  setTheme("blind");
  setScheme("light");

  assert.equal(storage.get("allsessions_theme"), "blind");
  assert.equal(storage.get("allsessions_scheme"), "light");
  assert.equal(root.dataset.theme, "blind");
  assert.equal(root.dataset.scheme, "light");
  assert.deepEqual(getThemeState(), {
    theme: "blind",
    scheme: "light",
    resolvedScheme: "light",
  });

  assert.equal(toggleScheme().resolvedScheme, "dark");
  assert.equal(storage.get("allsessions_scheme"), "dark");
});

test("跟随系统时响应系统外观变化", () => {
  setScheme("system");
  mediaQuery.matches = false;
  systemListener({ matches: false });

  assert.equal(root.dataset.scheme, "light");
  assert.equal(getThemeState().scheme, "system");
});

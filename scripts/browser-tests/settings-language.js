// 在已打开 AllSessions 的隔离浏览器会话中通过 playwright-cli run-code 执行。
// eslint-disable-next-line no-unused-vars -- Playwright CLI 直接调用此函数。
async function verifySettingsLanguage(page) {
  await page.evaluate(() => {
    const locales = ["en-US"];
    Object.defineProperty(globalThis.navigator, "languages", {
      configurable: true,
      get: () => locales,
    });
    globalThis.window.testLocales = locales;
    globalThis.window.__TAURI__ = {
      core: {
        invoke: async (_command, { request }) => {
          if (request.url === "/api/settings" && request.method === "GET") {
            return { sources: { codex: ["/example/original"] } };
          }
          if (request.url === "/api/tray/language") {
            globalThis.window.testTrayLanguage = request.body.language;
            return {};
          }
          throw new Error("意外的测试请求 " + request.url);
        },
      },
    };
  });
  await page.locator("#settings-toggle").click();
  const preference = page.locator("#settings-language-select");
  await preference.selectOption("zh");
  await preference.selectOption("system");
  const diagnostics = page.locator("#settings-diagnostics-meta");
  if (!(await diagnostics.textContent()).includes("Last scan")) {
    throw new Error("设置未使用系统英文");
  }
  await page.locator('[data-settings-tab="sources"]').click();
  await page.locator('.settings-source-card[data-key="codex"]').click();
  const path = page.locator(".settings-source-dialog .settings-root-row input");
  await path.fill("/example/unsaved");
  await page.evaluate(() => {
    globalThis.window.testLocales[0] = "zh-Hant";
    globalThis.window.dispatchEvent(new Event("languagechange"));
  });
  await page.waitForFunction(() => globalThis.window.testTrayLanguage === "zh");
  if (!(await diagnostics.textContent()).includes("最后扫描")) {
    throw new Error("系统语言变化后诊断文案未刷新");
  }
  if (
    !(await path.evaluate(
      (input) => input === input.ownerDocument.activeElement
    ))
  ) {
    throw new Error("系统语言变化后编辑框失去焦点");
  }
  if (
    (await path.inputValue()) !== "/example/unsaved" ||
    (await preference.inputValue()) !== "system"
  ) {
    throw new Error("系统语言变化丢失了目录草稿或语言偏好");
  }
}

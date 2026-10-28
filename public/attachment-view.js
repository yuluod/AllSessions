import { t } from "./i18n.js";

// 前端缓存按会话+定位键保存已取回的图片，避免滚动或筛选时重复走 IPC。
const MAX_CACHE_ENTRIES = 48;
const MAX_CACHE_CHARS = 48 * 1024 * 1024;

const cache = new Map();
const observers = new Set();
let cachedChars = 0;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = stableValue(value[key]);
        return result;
      }, {});
  }
  return value;
}

export function attachmentCacheKey(sessionKey, attachment) {
  // locator 是来源私有的：JSONL 用行号/路径，ZCode 用 part_id，
  // Devin 用 position/node_id 与下标，必须完整参与缓存键。
  return `${sessionKey || ""}|${JSON.stringify(stableValue(attachment?.locator || {}))}`;
}

export function clearAttachmentCache() {
  cache.clear();
  cachedChars = 0;
}

export function resetAttachmentObservers() {
  observers.forEach((observer) => observer.disconnect());
  observers.clear();
}

function remember(key, result) {
  const dataUrl = result?.data_url;
  if (!dataUrl || dataUrl.length > MAX_CACHE_CHARS) return;
  const previous = cache.get(key);
  if (previous) cachedChars -= previous.length;
  cache.delete(key);
  cache.set(key, dataUrl);
  cachedChars += dataUrl.length;
  while (cache.size > MAX_CACHE_ENTRIES || cachedChars > MAX_CACHE_CHARS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cachedChars -= cache.get(oldest)?.length || 0;
    cache.delete(oldest);
  }
}

function openPreview(dataUrl) {
  let dialog = document.getElementById("image-preview-dialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "image-preview-dialog";
    dialog.className = "image-preview-dialog";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "image-preview-close";
    close.textContent = "×";
    close.addEventListener("click", () => dialog.close());
    const image = document.createElement("img");
    dialog.append(close, image);
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    document.body.append(dialog);
  }
  dialog.setAttribute("aria-label", t("imagePreview"));
  const close = dialog.querySelector(".image-preview-close");
  close.setAttribute("aria-label", t("closeImage"));
  const image = dialog.querySelector("img");
  image.alt = t("imageAttachment");
  image.src = dataUrl;
  if (!dialog.open) dialog.showModal();
}

function createAttachment(attachment, { sessionKey, loadAttachment }) {
  const card = document.createElement("figure");
  card.className = "message-attachment";

  const frame = document.createElement("button");
  frame.type = "button";
  frame.className = "message-attachment-frame";
  frame.setAttribute("aria-label", t("openImage"));

  const image = document.createElement("img");
  image.alt = t("imageAttachment");
  image.hidden = true;
  frame.append(image);

  const status = document.createElement("figcaption");
  status.className = "message-attachment-status";
  status.textContent = t("imageAttachment");

  card.append(frame, status);

  let started = false;
  let loaded = false;
  const show = (dataUrl) => {
    image.src = dataUrl;
    image.hidden = false;
    status.hidden = true;
    card.classList.add("loaded");
    loaded = true;
  };
  const start = async () => {
    if (started) return;
    started = true;
    const key = attachmentCacheKey(sessionKey, attachment);
    const cached = cache.get(key);
    if (cached) {
      show(cached);
      return;
    }
    status.textContent = t("imageLoading");
    card.classList.remove("failed");
    card.classList.add("loading");
    try {
      const result = await loadAttachment(sessionKey, attachment.locator);
      if (!result?.data_url) throw new Error(t("imageLoadFailed"));
      remember(key, result);
      show(result.data_url);
    } catch (error) {
      // 失败后允许用户点击重试；原文变化等情况需要先刷新会话。
      started = false;
      card.classList.add("failed");
      status.textContent = t("imageLoadFailed");
      status.title = error?.message || "";
    } finally {
      card.classList.remove("loading");
    }
  };

  frame.addEventListener("click", () => {
    if (loaded) openPreview(image.src);
    else start();
  });

  if (typeof IntersectionObserver === "function") {
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        observers.delete(observer);
        start();
      },
      { rootMargin: "300px" }
    );
    observer.observe(card);
    observers.add(observer);
  } else {
    start();
  }
  return card;
}

export function renderAttachments(container, attachments, options = {}) {
  const items = (attachments || []).filter(
    (attachment) => attachment?.kind === "image" && attachment.locator
  );
  if (!items.length || !options.loadAttachment) return;
  const list = document.createElement("div");
  list.className = "message-attachments";
  items.forEach((attachment) =>
    list.append(createAttachment(attachment, options))
  );
  container.append(list);
}

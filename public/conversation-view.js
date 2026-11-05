import { t } from "./i18n.js";
import {
  renderAttachments,
  resetAttachmentObservers,
} from "./attachment-view.js";
import { markdownToPlainText, renderMarkdown } from "./markdown.js";
import {
  compactText,
  formatListTimestamp,
  formatTimestamp,
} from "./session-format.js";
import { displayMessageText } from "./session-export.js";
import {
  filterConversationMessages,
  groupToolMessages,
} from "./conversation-filter.js";
import {
  highlightMatches,
  highlightRegexMatches,
  bindMatchNavigation,
} from "./search-view.js";

const ROLE_LABEL_KEYS = {
  user: "roleUser",
  assistant: "roleAssistant",
  tool: "roleTool",
  system: "roleSystem",
  developer: "roleDeveloper",
};

// 复制反馈：短暂替换为 SVG check/cross 并着色，超时还原文案；不用文本字符当图标。
function setCopyFeedback(button, outcome) {
  if (button._copyTimer) clearTimeout(button._copyTimer);
  const success = outcome === "success";
  button.dataset.state = outcome;
  button.replaceChildren(createCopyResultIcon(success));
  button.title = t(success ? "copied" : "copyFailed");
  button.setAttribute("aria-label", button.title);
  button._copyTimer = setTimeout(() => {
    delete button.dataset.state;
    button.title = t("copyMessage");
    button.removeAttribute("aria-label");
    button.textContent = t("copy");
  }, 1500);
}

function createCopyResultIcon(success) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("fill", "none");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute(
    "d",
    success ? "M5 12.5l4.5 4.5L19 7.5" : "M6 6l12 12M18 6L6 18"
  );
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2.4");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

function displayRoleLabel(role) {
  const normalized = String(role || "").toLowerCase();
  return t(ROLE_LABEL_KEYS[normalized] || "roleUnknown");
}

export function createConversationView({
  state,
  elements,
  isMessageRemoved,
  onRequestDelete,
  onRestoreMessage,
  onHighlightError,
  onLoadAttachment,
}) {
  let highlightController = null;
  function filtered(messages) {
    const decorated = messages.map((message) => ({
      ...message,
      _removed: isMessageRemoved?.(message) === true,
    }));
    return filterConversationMessages(decorated, {
      query: "",
      showTools: state.showTools,
      searchTargetOrdinal: state.currentDetail?.search_context
        ? state.currentDetail.search_target
        : null,
      showContext: state.showContext,
      showRemoved: state.showRemoved,
      roleFilter: state.roleFilter,
    });
  }

  function displayed(messages) {
    const groups = groupToolMessages(filtered(messages));
    return state.conversationDesc ? [...groups].reverse() : groups;
  }

  function setMessageCardCollapsed(card, toggleButton, collapsed) {
    card.classList.toggle("collapsed", collapsed);
    toggleButton.textContent = collapsed ? "▶" : "▼";
    toggleButton.setAttribute("aria-expanded", collapsed ? "false" : "true");
    const label = collapsed ? t("expandMessage") : t("collapseMessage");
    toggleButton.title = label;
    toggleButton.setAttribute("aria-label", label);
  }

  function scrollToMessage(index) {
    const anchor = document.querySelector(`#message-${index + 1}`);
    if (!anchor) return;
    // 工具结果在合并卡内以锚点形式存在：折叠落到所属卡片，滚动仍对准结果本身。
    const card = anchor.closest(".message-card") || anchor;
    const toggle = card.querySelector(".message-toggle");
    if (toggle) setMessageCardCollapsed(card, toggle, false);
    const scroller = elements.conversationList?.closest(".detail-shell");
    if (!scroller) {
      anchor.scrollIntoView({ block: "start", behavior: "auto" });
      return;
    }
    const margin = parseFloat(getComputedStyle(card).scrollMarginTop) || 0;
    const targetTop = () =>
      Math.max(
        0,
        anchor.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop -
          margin
      );
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    scroller.scrollTo({
      top: targetTop(),
      behavior: reduce ? "auto" : "smooth",
    });
    // 部分环境会静默丢弃或中途冻结平滑滚动，且冻结的动画会锁住后续滚动请求：
    // 350ms 后没对齐，就直接赋值 scrollTop 强制落到精确位置。
    setTimeout(() => {
      if (Math.abs(targetTop() - scroller.scrollTop) > 2) {
        scroller.scrollTop = targetTop();
      }
    }, 350);
  }

  function appendMessageNavItems(container, groups) {
    container.replaceChildren();
    if (!groups.length) {
      const empty = document.createElement("p");
      empty.className = "props-empty";
      empty.textContent = t("noMessageNav");
      container.append(empty);
      return;
    }

    groups.forEach(({ message }) => {
      const button = document.createElement("button");
      button.className = "message-nav-item";
      button.type = "button";
      button.addEventListener("click", () => {
        const menu = container.closest("details");
        if (menu) menu.open = false;
        scrollToMessage(message._origIdx);
      });

      const top = document.createElement("span");
      top.className = "message-nav-top";
      top.textContent = `#${message._origIdx + 1} · ${message.tool_kind || displayRoleLabel(message.role)}`;

      const text = document.createElement("span");
      text.className = "message-nav-text";
      text.textContent = compactText(
        markdownToPlainText(displayMessageText(message)),
        72
      );

      button.append(top, text);
      container.append(button);
    });
  }

  function renderMessageNavigation(messages) {
    // 两个形态共享同一份列表与位置高亮：宽屏浮动目录（收起为右缘进度轨），窄屏工具栏下拉。
    const visibleGroups = displayed(messages);
    if (elements.messageNavInlineList) {
      appendMessageNavItems(elements.messageNavInlineList, visibleGroups);
    }
    if (elements.messageOutlineList) {
      appendMessageNavItems(elements.messageOutlineList, visibleGroups);
    }
    renderMessageOutlineRail(visibleGroups);
    bindMessageNavSpy();
  }

  // 收起态的右缘进度轨：圆点过多时按桶聚合（轨道高度约可容纳 60 个圆点）。
  const OUTLINE_RAIL_MAX_DOTS = 60;
  let lastNavMessages = [];
  function renderMessageOutlineRail(visibleGroups) {
    lastNavMessages = visibleGroups;
    const rail = elements.messageOutline?.querySelector(
      ".message-outline-rail"
    );
    if (!rail) return;
    rail.replaceChildren();
    if (!visibleGroups.length) return;
    const step = Math.ceil(visibleGroups.length / OUTLINE_RAIL_MAX_DOTS);
    const buckets = Math.ceil(visibleGroups.length / step);
    for (let b = 0; b < buckets; b++) {
      const start = b * step;
      const first = visibleGroups[start].message;
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "message-outline-dot";
      // 初始按索引均分占位；卡片渲染完成后由 layoutMessageOutlineRail
      // 改为按真实内容位置分布（真正的滚动 minimap）。
      dot.style.top = buckets > 1 ? (b / (buckets - 1)) * 100 + "%" : "50%";
      dot.dataset.startIdx = first._origIdx;
      dot.dataset.tip =
        "#" +
        (first._origIdx + 1) +
        " · " +
        displayRoleLabel(first.role) +
        "：" +
        compactText(markdownToPlainText(displayMessageText(first)), 36);
      dot.setAttribute("aria-label", dot.dataset.tip);
      dot.addEventListener("click", () => scrollToMessage(first._origIdx));
      rail.append(dot);
    }
    rail.dataset.buckets = buckets;
    rail.dataset.step = step;
  }

  // 依据各桶首条消息在滚动范围内的真实位置摆放圆点；会话过短无法滚动时退回索引均分。
  function layoutMessageOutlineRail(visibleGroups) {
    const rail = elements.messageOutline?.querySelector(
      ".message-outline-rail"
    );
    if (!rail || !visibleGroups.length) return;
    const scroller = elements.conversationList?.closest(".detail-shell");
    if (!scroller) return;
    const dots = rail.querySelectorAll(".message-outline-dot");
    if (!dots.length) return;
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    if (maxScroll < 80) return;
    const shellRect = scroller.getBoundingClientRect();
    const scrollTop = scroller.scrollTop;
    dots.forEach((dot) => {
      const card = document.querySelector(
        `#message-${+dot.dataset.startIdx + 1}`
      );
      if (!card) return;
      const margin = parseFloat(getComputedStyle(card).scrollMarginTop) || 0;
      const rel =
        card.getBoundingClientRect().top - shellRect.top + scrollTop - margin;
      const pct = Math.min(100, Math.max(0, (rel / maxScroll) * 100));
      dot.style.top = pct.toFixed(2) + "%";
    });
    dots[dots.length - 1].style.top = "100%";
  }

  // 滚动位置 → 目录/下拉高亮。挂在滚动容器 .detail-shell 上，整个会话生命周期只绑一次。
  let messageNavSpyBound = false;
  let messageNavSpyUpdate = null;
  let outlineRailResizeTimer = null;
  function bindMessageNavSpy() {
    if (messageNavSpyBound || !elements.conversationList) return;
    const scroller = elements.conversationList.closest(".detail-shell");
    if (!scroller) return;
    messageNavSpyBound = true;
    // 窗口尺寸变化会改变滚动范围与消息位置，防抖后重排进度轨圆点。
    window.addEventListener("resize", () => {
      clearTimeout(outlineRailResizeTimer);
      outlineRailResizeTimer = setTimeout(() => {
        layoutMessageOutlineRail(lastNavMessages);
      }, 150);
    });
    let ticking = false;
    const update = () => {
      ticking = false;
      const cards =
        elements.conversationList.querySelectorAll(".message-card[id]");
      if (!cards.length) return;
      // 阈值与 .message-card 的 scroll-margin-top 对齐：点目录跳转后，目标条目即高亮。
      const edge = scroller.getBoundingClientRect().top + 216;
      let active = 0;
      cards.forEach((card, i) => {
        if (card.getBoundingClientRect().top <= edge) active = i;
      });
      syncMessageNavActive(active);
    };
    scroller.addEventListener("scroll", () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(update);
      }
    });
    messageNavSpyUpdate = update;
    update();
  }

  function syncMessageNavActive(active) {
    [elements.messageOutlineList, elements.messageNavInlineList].forEach(
      (list) => {
        if (!list) return;
        list
          .querySelectorAll(".message-nav-item")
          .forEach((el, i) => el.classList.toggle("active", i === active));
      }
    );
    // 进度轨圆点按桶聚合：高亮 active 所在的桶。
    const rail = elements.messageOutline?.querySelector(
      ".message-outline-rail"
    );
    if (rail && rail.dataset.buckets) {
      const step = +rail.dataset.step;
      const activeBucket = Math.floor(active / step);
      rail
        .querySelectorAll(".message-outline-dot")
        .forEach((dot, i) =>
          dot.classList.toggle("active", i === activeBucket)
        );
    }
  }

  // 工具结果并入调用卡：结果保留自己的锚点，搜索定位与附件加载仍按原消息索引工作。
  function appendToolResult(after, result, messageContents) {
    const block = document.createElement("div");
    block.className = "tool-result";
    block.id = `message-${result._origIdx + 1}`;
    block.classList.toggle("removed", result._removed === true);

    const head = document.createElement("div");
    head.className = "tool-result-head";
    const label = document.createElement("span");
    label.className = "tool-result-label";
    label.textContent = `#${result._origIdx + 1} · ${t("toolResult")}`;
    head.append(label);
    if (result.is_error === true) {
      const status = document.createElement("span");
      status.className = "tool-result-status";
      status.dataset.state = "error";
      status.textContent = t("toolResultError");
      head.append(status);
    }
    const time = document.createElement("time");
    time.className = "tool-result-time";
    time.textContent = formatListTimestamp(result.timestamp);
    time.title = formatTimestamp(result.timestamp);
    head.append(time);
    if (result._message_key && result._removed) {
      const restoreButton = document.createElement("button");
      restoreButton.type = "button";
      restoreButton.className = "message-restore-btn";
      restoreButton.textContent = t("restore");
      restoreButton.addEventListener("click", () => onRestoreMessage?.(result));
      head.append(restoreButton);
    }
    if (result._message_key) {
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "message-delete-btn";
      deleteButton.textContent = t("deleteMessage");
      deleteButton.addEventListener("click", () => onRequestDelete?.(result));
      head.append(deleteButton);
    }

    const content = document.createElement("div");
    content.className = "message-text markdown-body tool-result-text";
    content.id = `message-content-${result._origIdx + 1}`;
    renderMarkdown(content, displayMessageText(result));
    messageContents.push(content);
    if (!state.searchRegex) highlightMatches(content, state.detailQuery);

    block.append(head, content);
    if (result.attachments?.length) {
      const attachmentsHost = document.createElement("div");
      attachmentsHost.className = "message-attachments";
      renderAttachments(attachmentsHost, result.attachments, {
        sessionKey: state.currentDetail?.summary?._key,
        loadAttachment: onLoadAttachment,
      });
      block.append(attachmentsHost);
    }
    after.after(block);
    return content.id;
  }

  function renderConversation(messages) {
    highlightController?.abort();
    resetAttachmentObservers();
    highlightController = new AbortController();
    const { signal } = highlightController;
    elements.conversationList.replaceChildren();
    const visibleGroups = displayed(messages);
    renderMessageNavigation(messages);

    if (!visibleGroups.length) {
      bindMatchNavigation(elements.conversationList);
      const empty = document.createElement("p");
      empty.className = "hero-copy";
      // 会话本身有消息但被角色/显示选项过滤掉时，说明是筛选结果为空。
      empty.textContent =
        messages.length > 0 ? t("noMessagesForFilter") : t("noConversations");
      elements.conversationList.append(empty);
      return;
    }

    const batch = document.createDocumentFragment();
    const messageContents = [];
    visibleGroups.forEach(({ message, result }) => {
      const fragment =
        elements.conversationItemTemplate.content.cloneNode(true);
      const card = fragment.querySelector(".message-card");
      card.classList.toggle("removed", message._removed === true);
      card.id = `message-${message._origIdx + 1}`;
      card.dataset.role = message.role;
      const avatar = card.querySelector(".message-avatar");
      const conversational =
        message.role === "user" || message.role === "assistant";
      avatar.classList.toggle("hidden", !conversational);
      avatar.textContent = conversational
        ? message.role === "user"
          ? "U"
          : "A"
        : "";
      fragment.querySelector(".message-idx").textContent =
        `#${message._origIdx + 1}`;
      fragment.querySelector(".message-role").textContent = displayRoleLabel(
        message.role
      );
      const toolElement = fragment.querySelector(".message-tool");
      if (message.synthetic_context) {
        toolElement.textContent = t("systemContext");
        toolElement.classList.remove("hidden");
      } else if (message.tool_kind || message.tool_name) {
        toolElement.textContent = [message.tool_kind, message.tool_name]
          .filter(Boolean)
          .join(" · ");
        toolElement.classList.remove("hidden");
      }
      const messageTime = fragment.querySelector(".message-time");
      messageTime.textContent = formatListTimestamp(message.timestamp);
      messageTime.title = formatTimestamp(message.timestamp);
      const messageText = displayMessageText(message);
      const messageContent = fragment.querySelector(".message-text");
      messageContent.id = `message-content-${message._origIdx + 1}`;
      renderMarkdown(messageContent, messageText);
      const attachmentsHost = fragment.querySelector(".message-attachments");
      if (attachmentsHost) {
        renderAttachments(attachmentsHost, message.attachments, {
          sessionKey: state.currentDetail?.summary?._key,
          loadAttachment: onLoadAttachment,
        });
      }
      messageContents.push(messageContent);
      if (!state.searchRegex)
        highlightMatches(messageContent, state.detailQuery);

      const resultContentId = result
        ? appendToolResult(messageContent, result, messageContents)
        : "";
      const shouldCollapse =
        message.role === "tool" ||
        message.synthetic_context === true ||
        markdownToPlainText(messageText).length > 1800;

      const toggleButton = fragment.querySelector(".message-toggle");
      toggleButton.setAttribute(
        "aria-controls",
        [messageContent.id, resultContentId].filter(Boolean).join(" ")
      );
      setMessageCardCollapsed(card, toggleButton, shouldCollapse);
      toggleButton.addEventListener("click", () => {
        setMessageCardCollapsed(
          card,
          toggleButton,
          !card.classList.contains("collapsed")
        );
      });

      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "message-copy-btn";
      copyButton.title = t("copyMessage");
      copyButton.textContent = t("copy");
      const copyText = result
        ? `${messageText}\n\n${displayMessageText(result)}`
        : messageText;
      copyButton.addEventListener("click", () => {
        navigator.clipboard
          .writeText(copyText)
          .then(() => setCopyFeedback(copyButton, "success"))
          .catch(() => setCopyFeedback(copyButton, "failed"));
      });
      const header = fragment.querySelector(".message-card header");
      header.append(copyButton);
      if (message._message_key) {
        if (message._removed) {
          const restoreButton = document.createElement("button");
          restoreButton.type = "button";
          restoreButton.className = "message-restore-btn";
          restoreButton.textContent = t("restore");
          restoreButton.addEventListener("click", () =>
            onRestoreMessage?.(message)
          );
          header.append(restoreButton);
        }
        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "message-delete-btn";
        deleteButton.textContent = t("deleteMessage");
        deleteButton.addEventListener("click", () =>
          onRequestDelete?.(message)
        );
        header.append(deleteButton);
      }
      batch.append(fragment);
    });
    elements.conversationList.append(batch);
    bindMatchNavigation(elements.conversationList);
    if (state.searchRegex) {
      void highlightRegexMatches(messageContents, state.detailQuery, { signal })
        .then(() => {
          if (!signal.aborted) bindMatchNavigation(elements.conversationList);
        })
        .catch((error) => {
          if (error.name !== "AbortError") onHighlightError(error.message);
        });
    }
    // 卡片就位后：校准导航高亮，并把进度轨圆点对齐到真实内容位置。
    messageNavSpyUpdate?.();
    layoutMessageOutlineRail(visibleGroups);
  }

  return { renderConversation };
}

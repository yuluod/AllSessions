import { t } from "./i18n.js";
import { markdownToPlainText, renderMarkdown } from "./markdown.js";
import { compactText, formatTimestamp } from "./session-format.js";
import { displayMessageText } from "./session-export.js";
import { filterConversationMessages } from "./conversation-filter.js";

const ROLE_LABELS = {
  user: "user",
  assistant: "assistant",
  tool: "tool",
  system: "system",
  developer: "developer",
};

function displayRoleLabel(role) {
  const normalized = String(role || "").toLowerCase();
  if (ROLE_LABELS[normalized]) return ROLE_LABELS[normalized];
  if (!normalized) return "system";
  return "system";
}

export function createConversationView({
  state,
  elements,
  isMessageRemoved,
  onRequestDelete,
  onRestoreMessage,
}) {
  function filtered(messages) {
    const decorated = messages.map((message) => ({
      ...message,
      _removed: isMessageRemoved?.(message) === true,
    }));
    return filterConversationMessages(decorated, {
      query: state.detailQuery,
      showTools: state.showTools,
      showContext: state.showContext,
      showRemoved: state.showRemoved,
      roleFilter: state.roleFilter,
    });
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
    const target = document.querySelector(`#message-${index + 1}`);
    if (!target) return;
    const toggle = target.querySelector(".message-toggle");
    if (toggle) setMessageCardCollapsed(target, toggle, false);
    target.scrollIntoView({
      block: "nearest",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }

  function appendMessageNavItems(container, messages) {
    container.replaceChildren();
    if (!messages.length) {
      const empty = document.createElement("p");
      empty.className = "props-empty";
      empty.textContent = t("noMessageNav");
      container.append(empty);
      return;
    }

    messages.forEach((message) => {
      const button = document.createElement("button");
      button.className = "message-nav-item";
      button.type = "button";
      button.addEventListener("click", () => scrollToMessage(message._origIdx));

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

  function createMessageNavSection(messages) {
    const wrap = document.createElement("div");
    wrap.className = "props-section message-nav-section";
    const heading = document.createElement("h3");
    heading.textContent = t("messageNav");
    const list = document.createElement("div");
    list.className = "message-nav-list";
    appendMessageNavItems(list, filtered(messages));
    wrap.append(heading, list);
    return wrap;
  }

  function renderMessageNavigation(messages) {
    const visibleMessages = filtered(messages);
    if (elements.messageNavInlineList) {
      appendMessageNavItems(elements.messageNavInlineList, visibleMessages);
    }
    const propsNavList = elements.propsContent?.querySelector(
      ".message-nav-section .message-nav-list"
    );
    if (propsNavList) {
      appendMessageNavItems(propsNavList, visibleMessages);
    }
  }

  function renderConversation(messages) {
    elements.conversationList.replaceChildren();
    const visibleMessages = filtered(messages);
    renderMessageNavigation(messages);

    if (!visibleMessages.length) {
      const empty = document.createElement("p");
      empty.className = "hero-copy";
      empty.textContent = t("noConversations");
      elements.conversationList.append(empty);
      return;
    }

    visibleMessages.forEach((message) => {
      const fragment =
        elements.conversationItemTemplate.content.cloneNode(true);
      const card = fragment.querySelector(".message-card");
      card.classList.toggle("removed", message._removed === true);
      card.id = `message-${message._origIdx + 1}`;
      card.dataset.role = message.role;
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
      fragment.querySelector(".message-time").textContent = formatTimestamp(
        message.timestamp
      );
      const messageText = displayMessageText(message);
      const messageContent = fragment.querySelector(".message-text");
      messageContent.id = `message-content-${message._origIdx + 1}`;
      renderMarkdown(messageContent, messageText);

      const shouldCollapse =
        message.role === "tool" ||
        message.synthetic_context === true ||
        markdownToPlainText(messageText).length > 1800;

      const toggleButton = fragment.querySelector(".message-toggle");
      toggleButton.setAttribute("aria-controls", messageContent.id);
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
      copyButton.addEventListener("click", () => {
        navigator.clipboard
          .writeText(messageText)
          .then(() => {
            copyButton.textContent = "✓";
            setTimeout(() => {
              copyButton.textContent = t("copy");
            }, 1500);
          })
          .catch(() => {
            copyButton.textContent = t("copyFailed");
            setTimeout(() => {
              copyButton.textContent = t("copy");
            }, 1500);
          });
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
      elements.conversationList.append(fragment);
    });
  }

  return { createMessageNavSection, renderConversation };
}

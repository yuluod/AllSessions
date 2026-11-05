import { t } from "./i18n.js";
import { displayMessageText } from "./session-export.js";
import { filterToolOperations } from "./conversation-filter.js";

const OPERATION_LIMIT = 200;

export function createToolOperations({ container, onSelectMessage }) {
  let kind = "all";
  let query = "";
  let lastSessionKey;
  return {
    render(groups, { sessionKey, truncated = false } = {}) {
      if (!container) return;
      if (lastSessionKey !== sessionKey) {
        kind = "all";
        query = "";
        lastSessionKey = sessionKey;
      }
      const operations = filterToolOperations(groups);
      container.classList.toggle("hidden", !operations.length);
      container.replaceChildren();
      if (!operations.length) return;
      const summary = document.createElement("summary");
      summary.textContent = t("toolOperationsCount", { n: operations.length });
      const scope = document.createElement("p");
      scope.className = "tool-operations-scope";
      scope.textContent = t(
        truncated ? "toolOperationsPartial" : "toolOperationsScope"
      );
      const controls = document.createElement("div");
      controls.className = "tool-operations-controls";
      const filter = document.createElement("select");
      filter.setAttribute("aria-label", t("toolOperationsFilter"));
      for (const [value, label] of [
        ["all", "toolOperationsAll"],
        ["commands", "toolOperationsCommands"],
        ["errors", "toolOperationsErrors"],
      ]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = t(label);
        filter.append(option);
      }
      filter.value = kind;
      const search = document.createElement("input");
      search.type = "search";
      search.value = query;
      search.placeholder = t("toolOperationsSearch");
      search.setAttribute("aria-label", t("toolOperationsSearch"));
      controls.append(filter, search);
      const count = document.createElement("p");
      count.className = "tool-operations-scope";
      const list = document.createElement("ol");
      list.className = "tool-operations-list";
      const renderRows = () => {
        const visible = filterToolOperations(operations, { kind, query });
        list.replaceChildren();
        count.textContent = t("toolOperationsShown", {
          n: Math.min(visible.length, OPERATION_LIMIT),
          total: visible.length,
        });
        for (const { message, result } of visible.slice(0, OPERATION_LIMIT)) {
          const item = document.createElement("li");
          const failed = message.is_error === true || result?.is_error === true;
          const returned =
            Boolean(result) ||
            ["tool_result", "function_call_output"].includes(message.tool_kind);
          const status = failed
            ? "toolResultError"
            : returned
              ? "toolOperationReturned"
              : "toolOperationMissing";
          const button = document.createElement("button");
          button.type = "button";
          button.className = "ghost-button tool-operation-link";
          button.textContent = `#${message._origIdx + 1} · ${message.command_name || message.tool_name || t("roleTool")} · ${t(status)}`;
          button.dataset.state = failed ? "error" : "";
          button.addEventListener("click", () =>
            onSelectMessage(
              failed && result ? result._origIdx : message._origIdx
            )
          );
          const excerpt = document.createElement("p");
          excerpt.textContent = displayMessageText(
            failed && result ? result : message
          ).slice(0, 180);
          item.append(button, excerpt);
          list.append(item);
        }
      };
      filter.addEventListener("change", () => {
        kind = filter.value;
        renderRows();
      });
      search.addEventListener("input", () => {
        query = search.value;
        renderRows();
      });
      container.append(summary, scope, controls, count, list);
      renderRows();
    },
  };
}

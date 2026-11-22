// 交接预览 P1 控制器:选择模式、模态预览、复制闭环与草稿生命周期。
// 交互契约见 docs/cross-agent-context.zh-CN.md §4.1；文本结构见 §4.2。
import { t, getLang } from "../i18n.js";
import { formatTimestamp } from "../session-format.js";
import {
  HANDOFF_LIMITS,
  buildHandoffMarkdown,
  createHandoffDraft,
  handoffSelectable,
  orderedSelectionMessages,
  takeChars,
  validateSelections,
} from "../handoff.js";

export function createHandoffController({
  state,
  elements,
  sessionWorkspace,
  displaySourceLabel,
  announce,
  showError,
  getConversationView,
}) {
  let draft = null;
  let pendingConfirm = null;
  let lastDialogFocus = null;

  const messages = () => state.currentDetail?.conversation_messages || [];
  const summary = () => state.currentDetail?.summary;
  const conversationView = () => getConversationView?.();

  const isActive = () => draft !== null;
  const isSelected = (key) => draft?.selections.has(key) === true;

  function buildOutput() {
    const detail = state.currentDetail;
    const totalMessages = detail?.search_context
      ? null
      : (detail?.truncation?.messages?.total ??
        detail?.summary?.message_count ??
        null);
    return buildHandoffMarkdown({
      draft,
      messages: messages(),
      summary: summary(),
      workspace: sessionWorkspace(summary()),
      totalMessages,
      sourceLabel: displaySourceLabel(summary()),
      formatTimestamp,
    });
  }

  function visibleKeys() {
    return (
      conversationView()?.visibleMessageKeys?.() ??
      new Set(
        messages()
          .map((message) => message._message_key)
          .filter(Boolean)
      )
    );
  }

  // 打开预览与复制前都重新校验：刷新、软移除或筛选变化后的引用必须显式失效。
  function revalidateDraft() {
    if (!draft) return [];
    return validateSelections(draft, messages(), visibleKeys());
  }

  // 「未复制的选择或编辑」才需要确认；输出与最近复制版本一致视为干净。
  function isDirty() {
    if (!draft) return false;
    const hasContent =
      draft.selections.size > 0 ||
      draft.nextStep.trim() !== "" ||
      draft.notes.trim() !== "";
    if (!hasContent) return false;
    return buildOutput().text !== draft.lastCopiedText;
  }

  function syncEntryButton() {
    const btn = elements.handoffBtn;
    if (!btn) return;
    const detail = state.currentDetail;
    const blocked = !detail || detail.search_context === true;
    btn.disabled = blocked;
    btn.title = detail?.search_context
      ? t("handoffSearchContextDisabled")
      : t("handoffEntryTitle");
    if (draft) {
      btn.dataset.active = "true";
      btn.textContent = t("handoffReturn", { n: draft.selections.size });
    } else {
      delete btn.dataset.active;
      btn.textContent = t("handoffEntry");
    }
  }

  function toggle(message) {
    if (!draft || !handoffSelectable(message)) return;
    const key = message._message_key;
    if (draft.selections.has(key)) {
      draft.selections.delete(key);
    } else {
      if (draft.selections.size >= HANDOFF_LIMITS.maxExcerpts) {
        announce(t("handoffMaxExcerpts", { n: HANDOFF_LIMITS.maxExcerpts }));
        return;
      }
      const capped = takeChars(message.text, HANDOFF_LIMITS.maxExcerptChars);
      draft.selections.set(key, {
        text: capped.text,
        sourceTruncated: capped.truncated,
      });
    }
    syncEntryButton();
    conversationView()?.syncHandoffMarks?.();
  }

  function showWarning(lines) {
    const el = elements.handoffWarning;
    if (!el) return;
    el.textContent = lines.filter(Boolean).join("\n");
    el.classList.toggle("hidden", !el.textContent);
  }

  function renderExcerptList() {
    const host = elements.handoffExcerpts;
    if (!host || !draft) return;
    host.replaceChildren();
    const selected = orderedSelectionMessages(draft, messages());
    if (!selected.length) {
      const empty = document.createElement("p");
      empty.className = "handoff-empty";
      empty.textContent = t("handoffExcerptsEmpty");
      host.append(empty);
      return;
    }
    selected.forEach((message) => {
      const key = message._message_key;
      const item = document.createElement("div");
      item.className = "handoff-excerpt";
      item.dataset.messageKey = key;

      const head = document.createElement("div");
      head.className = "handoff-excerpt-head";
      const meta = document.createElement("span");
      meta.className = "handoff-excerpt-meta";
      meta.textContent = [
        message.role || "",
        formatTimestamp(message.timestamp),
      ]
        .filter(Boolean)
        .join(" · ");
      const jump = document.createElement("button");
      jump.type = "button";
      jump.className = "handoff-excerpt-jump";
      jump.textContent = t("handoffJump");
      jump.addEventListener("click", () => jumpToSource(key));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "handoff-excerpt-remove";
      remove.textContent = t("handoffRemove");
      remove.addEventListener("click", () => {
        draft?.selections.delete(key);
        renderExcerptList();
        rebuildOutput();
        syncEntryButton();
      });
      head.append(meta, jump, remove);

      const area = document.createElement("textarea");
      area.className = "handoff-excerpt-text";
      area.rows = 4;
      area.maxLength = HANDOFF_LIMITS.maxExcerptChars;
      area.value = draft.selections.get(key)?.text ?? "";
      area.setAttribute("aria-label", t("handoffExcerptLabel"));
      area.addEventListener("input", () => {
        const entry = draft?.selections.get(key);
        if (entry) entry.text = area.value;
        rebuildOutput();
      });

      const note = document.createElement("p");
      note.className = "handoff-excerpt-note";
      item.append(head, area, note);
      host.append(item);
    });
  }

  // 只更新元数据/警告/输出与各摘录的截断说明，不重建输入节点以免丢失焦点。
  function rebuildOutput() {
    if (!draft) return;
    const result = buildOutput();
    elements.handoffOutput.textContent = result.fixedOverBudget
      ? ""
      : result.text;
    elements.handoffMeta.textContent = t("handoffMeta", {
      source: displaySourceLabel(summary()) || "-",
      n: draft.selections.size,
      max: HANDOFF_LIMITS.maxExcerpts,
      kib: (result.bytes / 1024).toFixed(1),
      maxKib: Math.round(HANDOFF_LIMITS.maxTotalBytes / 1024),
    });
    const warnings = [];
    if (result.fixedOverBudget) {
      warnings.push(t("handoffFixedOverBudget"));
    } else if (result.omitted.length) {
      warnings.push(
        t("handoffOmittedItems", {
          list: result.omitted
            .map((item) => item.pos)
            .sort((a, b) => a - b)
            .join(getLang() === "zh" ? "、" : ", "),
        })
      );
    }
    showWarning(warnings);
    const copied = result.text !== "" && result.text === draft.lastCopiedText;
    elements.handoffCopiedState.textContent = copied ? t("handoffCopied") : "";
    elements.handoffCopyBtn.disabled =
      result.fixedOverBudget || result.text === "";
    elements.handoffExcerpts
      ?.querySelectorAll(".handoff-excerpt")
      .forEach((item) => {
        const key = item.dataset.messageKey;
        const sel = draft.selections.get(key);
        const notes = [];
        if (sel?.sourceTruncated) {
          notes.push(
            t("handoffSourceTruncated", { n: HANDOFF_LIMITS.maxExcerptChars })
          );
        }
        if (result.truncatedKeys.has(key)) {
          notes.push(t("handoffBudgetTruncated"));
        }
        const note = item.querySelector(".handoff-excerpt-note");
        if (note) note.textContent = notes.join(" ");
      });
  }

  function openPreview() {
    if (!draft || !elements.handoffDialog) return;
    const dropped = revalidateDraft();
    elements.handoffNextStep.value = draft.nextStep;
    elements.handoffNotes.value = draft.notes;
    renderExcerptList();
    rebuildOutput();
    if (dropped.length) {
      showWarning([t("handoffDropped", { n: dropped.length })]);
      announce(t("handoffDropped", { n: dropped.length }));
    }
    if (!elements.handoffDialog.open) {
      elements.handoffDialog.showModal();
      (lastDialogFocus || elements.handoffNextStep)?.focus();
    }
    syncEntryButton();
  }

  function startOrReturn() {
    const detail = state.currentDetail;
    if (!detail) return;
    if (!draft) {
      if (detail.search_context) {
        announce(t("handoffSearchContextDisabled"));
        return;
      }
      if (!messages().some(handoffSelectable)) {
        announce(t("handoffNoSelectable"));
        return;
      }
      draft = createHandoffDraft({
        sessionKey: detail.summary?._key,
        uiLang: getLang(),
      });
      announce(t("handoffStarted", { n: HANDOFF_LIMITS.maxExcerpts }));
      syncEntryButton();
      conversationView()?.renderConversation(messages());
      return;
    }
    openPreview();
  }

  // 「查看原文」暂存草稿回到详情；不是结束操作。
  function viewSource() {
    if (elements.handoffDialog?.contains(document.activeElement)) {
      lastDialogFocus = document.activeElement;
    }
    elements.handoffDialog?.close();
    syncEntryButton();
  }

  function endHandoff() {
    const hadDraft = draft !== null;
    draft = null;
    lastDialogFocus = null;
    if (elements.handoffDialog?.open) elements.handoffDialog.close();
    syncEntryButton();
    conversationView()?.renderConversation(messages());
    if (hadDraft) announce(t("handoffEnded"));
  }

  // 已有确认在询问时不覆盖：快速连按导航不能让前一个守卫悬挂。
  function confirmDiscard(onConfirm) {
    if (pendingConfirm) return false;
    pendingConfirm = onConfirm;
    if (!elements.handoffDiscardDialog?.open) {
      elements.handoffDiscardDialog?.showModal();
    }
    elements.handoffDiscardConfirm?.focus();
    return true;
  }

  // X / Escape / 结束交接 统一入口：草稿检查，脏则确认，净则直接结束。
  function requestEnd() {
    if (!isDirty()) {
      endHandoff();
      return;
    }
    confirmDiscard(endHandoff);
  }

  function jumpToSource(key) {
    if (!messages().some((entry) => entry._message_key === key)) {
      showError(t("handoffJumpMissing"));
      return;
    }
    if (!visibleKeys().has(key)) {
      showError(t("handoffJumpFiltered"));
      return;
    }
    viewSource();
    // 卡片锚点 id 用 _origIdx 编号；它只存在于过滤装饰副本上，
    // 原始消息没有该字段，定位交给对话视图按消息键完成。
    const origIdx = conversationView()?.scrollToMessageKey?.(key);
    if (!Number.isInteger(origIdx)) {
      showError(t("handoffJumpMissing"));
      return;
    }
    document
      .querySelector(`#message-${origIdx + 1}`)
      ?.closest(".message-card")
      ?.querySelector(".message-toggle")
      ?.focus({ preventScroll: true });
  }

  async function copyHandoff() {
    if (!draft) return;
    const dropped = revalidateDraft();
    if (dropped.length) {
      renderExcerptList();
      rebuildOutput();
      showWarning([t("handoffDropped", { n: dropped.length })]);
      announce(t("handoffDropped", { n: dropped.length }));
      return;
    }
    const result = buildOutput();
    if (result.fixedOverBudget || !result.text) {
      rebuildOutput();
      return;
    }
    try {
      await navigator.clipboard.writeText(result.text);
      draft.lastCopiedText = result.text;
      rebuildOutput();
      announce(t("handoffCopiedAnnounce", { n: result.included.length }));
    } catch (error) {
      // 剪贴板失败保留编辑内容并留在预览中，不标记已复制。
      showError(`${t("copyFailed")}: ${error.message || error}`);
    }
  }

  // 会话/搜索命中切换守卫：返回 Promise<boolean>，取消即保持现状。
  function confirmLeave({ key, hit = false }) {
    if (!draft) return Promise.resolve(true);
    const leaving = key !== draft.sessionKey || hit === true;
    if (!leaving) return Promise.resolve(true);
    if (!isDirty()) {
      endHandoff();
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const opened = confirmDiscard(() => {
        endHandoff();
        resolve(true);
      });
      if (!opened) {
        resolve(false);
        return;
      }
      pendingResolve = resolve;
    });
  }

  let pendingResolve = null;
  function settleDiscard(confirmed) {
    const confirm = pendingConfirm;
    const resolve = pendingResolve;
    pendingConfirm = null;
    pendingResolve = null;
    elements.handoffDiscardDialog?.close();
    if (confirmed) confirm?.();
    else resolve?.(false);
  }

  // 详情被替换或清空后的兜底绑定：绕开守卫的路径不能留下跨会话草稿。
  function onDetailChanged() {
    if (draft && draft.sessionKey !== state.selectedSessionKey) {
      const hadContent =
        draft.selections.size > 0 ||
        draft.nextStep.trim() !== "" ||
        draft.notes.trim() !== "";
      draft = null;
      if (elements.handoffDialog?.open) elements.handoffDialog.close();
      conversationView()?.renderConversation(messages());
      if (hadContent) announce(t("handoffSessionChanged"));
    }
    syncEntryButton();
  }

  function bind() {
    elements.handoffBtn?.addEventListener("click", startOrReturn);
    elements.handoffCopyBtn?.addEventListener(
      "click",
      () => void copyHandoff()
    );
    elements.handoffViewSourceBtn?.addEventListener("click", viewSource);
    elements.handoffEndBtn?.addEventListener("click", requestEnd);
    elements.handoffDialogClose?.addEventListener("click", requestEnd);
    elements.handoffDialog?.addEventListener("cancel", (event) => {
      // 原生 Esc 关闭会绕过草稿检查，必须先拦截再走统一结束入口。
      event.preventDefault();
      requestEnd();
    });
    elements.handoffNextStep?.addEventListener("input", (event) => {
      if (draft) draft.nextStep = event.target.value;
      rebuildOutput();
    });
    elements.handoffNotes?.addEventListener("input", (event) => {
      if (draft) draft.notes = event.target.value;
      rebuildOutput();
    });
    elements.handoffDiscardConfirm?.addEventListener("click", () =>
      settleDiscard(true)
    );
    elements.handoffDiscardCancel?.addEventListener("click", () =>
      settleDiscard(false)
    );
    elements.handoffDiscardClose?.addEventListener("click", () =>
      settleDiscard(false)
    );
    elements.handoffDiscardDialog?.addEventListener("cancel", () => {
      pendingConfirm = null;
      pendingResolve?.(false);
      pendingResolve = null;
    });
    syncEntryButton();
  }

  return {
    bind,
    isActive,
    isSelected,
    toggle,
    syncEntryButton,
    confirmLeave,
    jumpToSource,
    onDetailChanged,
    onLanguageChanged: () => {
      syncEntryButton();
      if (elements.handoffDialog?.open) {
        renderExcerptList();
        rebuildOutput();
      }
    },
    // 供 conversation-view 的开关回调使用。
    isSelectable: handoffSelectable,
    onToggle: toggle,
  };
}

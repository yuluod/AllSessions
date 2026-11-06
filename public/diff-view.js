// Edit/Write 工具调用的 diff 渲染：行级 LCS diff + 成对行内的词级高亮。
// 输入为后端归一化的 message.file_edit：{path, create, truncated, edits:[{old,new,truncated}]}。

const LCS_CELL_LIMIT = 1_000_000;

function splitLines(text) {
  const value = String(text ?? "");
  return value === "" ? [] : value.split("\n");
}

// 前后公共行先剥离，中间段行数乘积超限时不做 LCS，直接整段 del+add。
export function diffLines(oldText, newText) {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  let head = 0;
  while (
    head < oldLines.length &&
    head < newLines.length &&
    oldLines[head] === newLines[head]
  ) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] ===
      newLines[newLines.length - 1 - tail]
  ) {
    tail += 1;
  }
  const oldMid = oldLines.slice(head, oldLines.length - tail);
  const newMid = newLines.slice(head, newLines.length - tail);
  const rows = [
    ...oldLines.slice(0, head).map((text) => ({ type: "context", text })),
    ...(oldMid.length * newMid.length <= LCS_CELL_LIMIT
      ? lcsDiff(oldMid, newMid)
      : [
          ...oldMid.map((text) => ({ type: "del", text })),
          ...newMid.map((text) => ({ type: "add", text })),
        ]),
    ...oldLines.slice(oldLines.length - tail).map((text) => ({
      type: "context",
      text,
    })),
  ];
  return pairInline(rows);
}

function lcsDiff(oldLines, newLines) {
  const m = oldLines.length;
  const n = newLines.length;
  // dp[i][j] = oldLines[i:] 与 newLines[j:] 的 LCS 长度，自底向上填表。
  const dp = new Uint32Array((m + 1) * (n + 1));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * (n + 1) + j] =
        oldLines[i] === newLines[j]
          ? dp[(i + 1) * (n + 1) + j + 1] + 1
          : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + j + 1]);
    }
  }
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      rows.push({ type: "context", text: oldLines[i] });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * (n + 1) + j] >= dp[i * (n + 1) + j + 1]) {
      rows.push({ type: "del", text: oldLines[i] });
      i += 1;
    } else {
      rows.push({ type: "add", text: newLines[j] });
      j += 1;
    }
  }
  while (i < m) rows.push({ type: "del", text: oldLines[i++] });
  while (j < n) rows.push({ type: "add", text: newLines[j++] });
  return rows;
}

// 相邻 del 块 + add 块按序配对：逐对计算公共前后缀，中段标记为 changed。
function pairInline(rows) {
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].type !== "del") continue;
    let end = i;
    while (end + 1 < rows.length && rows[end + 1].type === "del") end += 1;
    let addEnd = end;
    while (addEnd + 1 < rows.length && rows[addEnd + 1].type === "add") {
      addEnd += 1;
    }
    const dels = rows.slice(i, end + 1);
    const adds = rows.slice(end + 1, addEnd + 1);
    for (let k = 0; k < Math.min(dels.length, adds.length); k += 1) {
      const [delSpans, addSpans] = inlineSpans(dels[k].text, adds[k].text);
      dels[k].spans = delSpans;
      adds[k].spans = addSpans;
    }
    i = addEnd;
  }
  return rows;
}

function inlineSpans(oldText, newText) {
  let head = 0;
  const limit = Math.min(oldText.length, newText.length);
  while (head < limit && oldText[head] === newText[head]) head += 1;
  let tail = 0;
  while (
    tail < limit - head &&
    oldText[oldText.length - 1 - tail] === newText[newText.length - 1 - tail]
  ) {
    tail += 1;
  }
  const spans = (text, midEnd) => {
    const parts = [];
    if (head) parts.push({ text: text.slice(0, head), changed: false });
    if (text.length - tail > head) {
      parts.push({ text: text.slice(head, midEnd), changed: true });
    }
    if (tail)
      parts.push({ text: text.slice(text.length - tail), changed: false });
    return parts;
  };
  return [
    spans(oldText, oldText.length - tail),
    spans(newText, newText.length - tail),
  ];
}

// 单个编辑段的增删行统计；整段都是 context 时说明 old == new。
export function editCounts(edit) {
  let added = 0;
  let removed = 0;
  for (const row of diffLines(edit.old, edit.new)) {
    if (row.type === "add") added += 1;
    else if (row.type === "del") removed += 1;
  }
  return { added, removed };
}

export function renderHunk(hunk) {
  const table = document.createElement("div");
  table.className = "diff-table";
  appendDiffRows(table, diffLines(hunk.old, hunk.new));
  return table;
}

function appendDiffRows(host, rows) {
  for (const row of rows) {
    const line = document.createElement("div");
    line.className = `diff-line diff-${row.type}`;
    const sign = document.createElement("span");
    sign.className = "diff-sign";
    sign.textContent =
      row.type === "add" ? "+" : row.type === "del" ? "−" : " ";
    const text = document.createElement("span");
    text.className = "diff-text";
    if (row.spans) {
      for (const span of row.spans) {
        const part = document.createElement("span");
        if (span.changed) part.className = "diff-changed";
        part.textContent = span.text;
        text.append(part);
      }
    } else {
      text.textContent = row.text;
    }
    line.append(sign, text);
    host.append(line);
  }
}

function fileEditCounts(fileEdit) {
  return (fileEdit.edits || []).reduce(
    (sum, edit) => {
      const { added, removed } = editCounts(edit);
      sum.added += added;
      sum.removed += removed;
      return sum;
    },
    { added: 0, removed: 0 }
  );
}

export function fileEditBadge(fileEdit) {
  const badge = document.createElement("span");
  badge.className = "diff-counts";
  const { added, removed } = fileEditCounts(fileEdit);
  if (added) {
    const add = document.createElement("span");
    add.className = "diff-count-add";
    add.textContent = `+${added}`;
    badge.append(add);
  }
  if (removed) {
    const del = document.createElement("span");
    del.className = "diff-count-del";
    del.textContent = `−${removed}`;
    badge.append(del);
  }
  return badge;
}

// 单条 Edit/Write 调用的 diff 块。返回 null 表示没有可渲染内容。
export function renderFileEdit(t, fileEdit) {
  if (!fileEdit?.edits?.length) return null;
  const block = document.createElement("div");
  block.className = "file-edit";
  const head = document.createElement("div");
  head.className = "file-edit-head";
  const path = document.createElement("span");
  path.className = "file-edit-path";
  path.textContent = fileEdit.path;
  path.title = fileEdit.path;
  head.append(path);
  if (fileEdit.create) {
    const create = document.createElement("span");
    create.className = "file-edit-create";
    create.textContent = t("fileEditCreate");
    head.append(create);
  }
  head.append(fileEditBadge(fileEdit));
  if (fileEdit.truncated) {
    const note = document.createElement("span");
    note.className = "file-edit-truncated";
    note.textContent = t("fileEditTruncated");
    head.append(note);
  }
  block.append(head);
  for (const edit of fileEdit.edits) {
    block.append(renderHunk(edit));
  }
  return block;
}

// 会话级聚合：按路径合并所有 file_edit，返回排序后的数组。
export function collectFileEdits(groups) {
  const files = new Map();
  for (const { message } of groups) {
    const edit = message.file_edit;
    if (!edit?.edits?.length) continue;
    if (!files.has(edit.path)) {
      files.set(edit.path, {
        path: edit.path,
        added: 0,
        removed: 0,
        edits: [],
      });
    }
    const file = files.get(edit.path);
    const { added, removed } = fileEditCounts(edit);
    file.added += added;
    file.removed += removed;
    for (const hunk of edit.edits) {
      file.edits.push({ index: message._origIdx, hunk });
    }
  }
  return [...files.values()].sort(
    (a, b) =>
      b.added + b.removed - (a.added + a.removed) ||
      a.path.localeCompare(b.path)
  );
}

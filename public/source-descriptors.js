// 来源类型、Agent 分组与展示信息的唯一前端定义；不参与原始数据解析。
export const SOURCE_DESCRIPTORS = [
  {
    key: "codex",
    agent: "codex",
    label: "Codex",
    railAgent: "codex",
    kinds: ["codex"],
    colorToken: "--src-codex",
  },
  {
    key: "codex_archived",
    agent: "codex",
    label: "Codex Archived",
    railAgent: "codex",
    kinds: ["codex_archived"],
    colorToken: "--src-codex",
  },
  {
    key: "claude",
    agent: "claude",
    label: "Claude Code",
    railAgent: "claude",
    kinds: ["claude", "claude_code"],
    colorToken: "--src-claude",
  },
  {
    key: "claude_cowork",
    agent: "claude",
    label: "Claude Cowork",
    railAgent: "claude_cowork",
    kinds: ["claude_cowork"],
    colorToken: "--src-claude",
  },
  {
    key: "gemini",
    agent: "gemini",
    label: "Gemini CLI",
    railAgent: "gemini",
    kinds: ["gemini"],
    colorToken: "--src-gemini",
  },
  {
    key: "grok",
    agent: "grok",
    label: "Grok Build",
    railAgent: "grok",
    kinds: ["grok"],
    colorToken: "--text-secondary",
  },
  {
    key: "pi",
    agent: "pi",
    label: "Pi",
    railAgent: "pi",
    kinds: ["pi"],
    colorToken: "--src-pi",
  },
  {
    key: "omp",
    agent: "omp",
    label: "Oh My Pi",
    railAgent: "omp",
    kinds: ["omp"],
    colorToken: "--src-omp",
  },
  {
    key: "kimi",
    agent: "kimi",
    label: "Kimi Code CLI",
    railAgent: "kimi",
    kinds: ["kimi"],
    colorToken: "--src-kimi",
  },
  {
    key: "opencode",
    agent: "opencode",
    label: "OpenCode",
    railAgent: "opencode",
    kinds: ["opencode"],
    colorToken: "--src-opencode",
  },
  {
    key: "kilo",
    agent: "kilo",
    label: "Kilo",
    railAgent: "kilo",
    kinds: ["kilo"],
    colorToken: "--src-opencode",
  },
  {
    key: "zcode",
    agent: "zcode",
    label: "ZCode",
    railAgent: "zcode",
    kinds: ["zcode"],
    colorToken: "--src-zcode",
  },
  {
    key: "cursor",
    agent: "cursor",
    label: "Cursor",
    railAgent: "cursor",
    kinds: ["cursor"],
    colorToken: "--muted",
  },
  {
    key: "devin",
    agent: "devin",
    label: "Devin",
    railAgent: "devin",
    kinds: ["devin"],
    colorToken: "--src-devin",
  },
  {
    key: "copilot",
    agent: "copilot",
    label: "GitHub Copilot",
    railAgent: "copilot",
    kinds: ["copilot"],
    colorToken: "--src-copilot",
  },
  {
    key: "hermes",
    agent: "hermes",
    label: "Hermes Agent",
    railAgent: "hermes",
    kinds: ["hermes"],
    colorToken: "--src-hermes",
  },
  {
    key: "vscode_copilot",
    agent: "copilot",
    label: "VS Code Copilot Chat",
    railAgent: "copilot",
    kinds: ["vscode_copilot"],
    colorToken: "--src-copilot",
  },
  {
    key: "deepseek",
    agent: "deepseek",
    label: "DeepSeek Harness",
    railAgent: "deepseek",
    kinds: ["deepseek"],
    colorToken: "--line-strong",
  },
  {
    key: "jetbrains_air",
    agent: "jetbrains_air",
    label: "JetBrains Air",
    railAgent: "jetbrains_air",
    kinds: ["jetbrains_air"],
    colorToken: "--text",
  },
  {
    key: "workbuddy",
    agent: "workbuddy",
    label: "WorkBuddy",
    railAgent: "workbuddy",
    kinds: ["workbuddy"],
    colorToken: "--src-workbuddy",
  },
];

export const SOURCE_RAIL_AGENTS = [
  ...new Set(SOURCE_DESCRIPTORS.map((source) => source.railAgent)),
].map((agent) => ({
  agent,
  kinds: SOURCE_DESCRIPTORS.filter(
    (source) => source.railAgent === agent
  ).flatMap((source) => source.kinds),
}));

export function agentPresentation(agent) {
  const source =
    SOURCE_DESCRIPTORS.find(
      (source) => source.key === agent || source.kinds.includes(agent)
    ) || SOURCE_DESCRIPTORS.find((source) => source.agent === agent);
  return {
    label: source?.label || agent,
    colorToken: source?.colorToken || "--line-strong",
  };
}

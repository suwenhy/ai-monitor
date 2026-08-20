const fs = require("node:fs/promises");
const path = require("node:path");

const PROVIDERS = ["codex", "claude"];
const PATH_KEYS = ["desktopPath", "cliPath", "dataHome"];

function emptySettings() {
  return {
    schemaVersion: 1,
    providers: {
      codex: { desktopPath: "", cliPath: "", dataHome: "" },
      claude: { desktopPath: "", cliPath: "", dataHome: "" },
    },
  };
}

function cleanPath(value) {
  const cleaned = typeof value === "string" ? value.trim() : "";
  if (cleaned.length >= 2 && cleaned.startsWith('"') && cleaned.endsWith('"')) {
    return cleaned.slice(1, -1).trim();
  }
  return cleaned;
}

function normalizeSettings(value) {
  const normalized = emptySettings();
  for (const provider of PROVIDERS) {
    for (const key of PATH_KEYS) {
      normalized.providers[provider][key] = cleanPath(value?.providers?.[provider]?.[key]);
    }
  }
  return normalized;
}

async function validateSettings(value, options = {}) {
  const stat = typeof options === "function" ? options : options.stat || fs.stat;
  const platform = typeof options === "function" ? process.platform : options.platform || process.platform;
  const settings = normalizeSettings(value);
  const errors = {};

  await Promise.all(PROVIDERS.flatMap((provider) => PATH_KEYS.map(async (key) => {
    const target = settings.providers[provider][key];
    if (!target) return;
    const field = `${provider}.${key}`;
    if (!path.isAbsolute(target)) {
      errors[field] = "请输入绝对路径";
      return;
    }
    try {
      const info = await stat(target);
      if (key === "dataHome" && !info.isDirectory()) errors[field] = "请选择数据目录";
      if (key !== "dataHome") {
        const macAppBundle = platform === "darwin"
          && key === "desktopPath"
          && info.isDirectory()
          && /\.app$/i.test(target);
        if (!info.isFile() && !macAppBundle) {
          errors[field] = platform === "darwin" && key === "desktopPath"
            ? "请选择可执行文件或 .app 应用"
            : "请选择可执行文件";
        }
      }
    } catch {
      errors[field] = "路径不存在或当前账户无权访问";
    }
  })));

  return { settings, errors, valid: Object.keys(errors).length === 0 };
}

module.exports = {
  PATH_KEYS,
  PROVIDERS,
  emptySettings,
  normalizeSettings,
  validateSettings,
};

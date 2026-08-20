const fs = require("node:fs/promises");
const path = require("node:path");

const WINDOWS_APPS_SEGMENT = `${path.sep}Microsoft${path.sep}WindowsApps${path.sep}`.toLowerCase();
const PACKAGE_APPS_SEGMENT = `${path.sep}Program Files${path.sep}WindowsApps${path.sep}`.toLowerCase();

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function isWindowsAppsPath(target) {
  const normalized = String(target || "").toLowerCase();
  return normalized.includes(WINDOWS_APPS_SEGMENT) || normalized.includes(PACKAGE_APPS_SEGMENT);
}

function isClaudeDesktopAlias(target) {
  if (!target || path.basename(target).toLowerCase() !== "claude.exe") return false;
  const normalized = target.toLowerCase();
  return normalized.includes(WINDOWS_APPS_SEGMENT)
    || normalized.includes(`${path.sep}anthropicclaude${path.sep}`)
    || /\\app-[^\\]+\\claude\.exe$/i.test(target)
    || /\\windowsapps\\claude_[^\\]+\\app\\claude\.exe$/i.test(target);
}

function isClaudeCliPath(target) {
  if (!target || isClaudeDesktopAlias(target)) return false;
  const basename = path.basename(target).toLowerCase();
  if (["claude.cmd", "claude.bat", "claude.ps1"].includes(basename)) return true;
  const normalized = target.toLowerCase();
  return basename === "claude.exe" && (
    normalized.includes(`${path.sep}.local${path.sep}bin${path.sep}`)
    || normalized.includes(`${path.sep}npm${path.sep}`)
    || normalized.includes(`${path.sep}claude-cli${path.sep}`)
    || normalized.includes(`${path.sep}claude-cli-nodejs${path.sep}`)
  );
}

function desktopCandidatesFromCli(provider, cliPath) {
  if (!cliPath) return [];
  const normalized = path.normalize(cliPath);

  if (provider === "codex") {
    const resources = path.dirname(normalized);
    if (path.basename(resources).toLowerCase() !== "resources") return [];
    const appRoot = path.dirname(resources);
    return [path.join(appRoot, "ChatGPT.exe"), path.join(appRoot, "Codex.exe")];
  }

  if (provider === "claude" && isClaudeDesktopAlias(normalized)) return [normalized];
  return [];
}

function packageExecutableCandidates(provider, packages = []) {
  const executableNames = provider === "codex" ? ["ChatGPT.exe", "Codex.exe"] : ["Claude.exe"];
  const packagePattern = provider === "codex" ? /(?:openai|codex|chatgpt)/i : /(?:anthropic|claude)/i;

  return packages.flatMap((item) => {
    const identity = `${item?.name || ""} ${item?.familyName || ""}`;
    if (!item?.installLocation || !packagePattern.test(identity)) return [];
    return executableNames.flatMap((name) => [
      path.join(item.installLocation, "app", name),
      path.join(item.installLocation, name),
    ]);
  });
}

function registeredExecutableCandidates(provider, registrations = []) {
  const executableNames = provider === "codex" ? ["ChatGPT.exe", "Codex.exe"] : ["Claude.exe"];
  const pattern = provider === "codex" ? /(?:openai|codex|chatgpt)/i : /(?:anthropic|claude)/i;
  const candidates = [];

  for (const item of registrations) {
    if (!pattern.test(String(item?.name || ""))) continue;
    const displayIcon = String(item?.displayIcon || "").trim();
    const iconMatch = displayIcon.match(/^"([^"]+\.exe)"(?:,\d+)?$/i)
      || displayIcon.match(/^(.+?\.exe)(?:,\d+)?$/i);
    if (iconMatch?.[1]) candidates.push(iconMatch[1]);
    if (item?.installLocation) {
      for (const executable of executableNames) candidates.push(path.join(item.installLocation, executable));
    }
  }
  return unique(candidates);
}

function processExecutableCandidates(provider, processes = []) {
  const pattern = provider === "codex" ? /^(?:chatgpt|codex)$/i : /^claude$/i;
  return unique(processes
    .filter((item) => {
      if (!pattern.test(String(item?.name || "")) || !item?.path) return false;
      if (provider === "claude" && isClaudeCliPath(item.path)) return false;
      if (provider === "codex" && /\\resources\\codex(?:\.exe)?$/i.test(item.path)) return false;
      return true;
    })
    .map((item) => item.path));
}

function startAppId(provider, startApps = []) {
  const pattern = provider === "codex" ? /(?:openai|codex|chatgpt)/i : /(?:anthropic|claude)/i;
  return startApps.find((item) => pattern.test(`${item?.name || ""} ${item?.appId || ""}`))?.appId || null;
}

function appIdFromExecutable(provider, target) {
  if (provider !== "claude" || !target) return null;
  const folder = path.normalize(target).match(/\\WindowsApps\\([^\\]+)\\/i)?.[1];
  const separator = folder?.lastIndexOf("__") ?? -1;
  if (!folder || separator < 1) return null;
  const packageIdentity = folder.slice(0, separator);
  const publisherId = folder.slice(separator + 2);
  const packageName = packageIdentity.match(/^(.+?)_\d/)?.[1];
  return packageName && publisherId ? `${packageName}_${publisherId}!Claude` : null;
}

async function versionedExecutableCandidates(roots, executableNames) {
  const candidates = [];
  for (const root of unique(roots)) {
    let entries = [];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const versionDirectories = entries
      .filter((entry) => entry.isDirectory() && /^app-/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    for (const directory of versionDirectories) {
      for (const executable of executableNames) {
        candidates.push(path.join(root, directory, executable));
      }
    }
  }
  return candidates;
}

function parsePowerShellJson(stdout) {
  const text = String(stdout || "").trim().replace(/^\uFEFF/, "");
  const empty = { packages: [], startApps: [], processes: [], registrations: [] };
  if (!text) return empty;
  try {
    const parsed = JSON.parse(text);
    const array = (value) => Array.isArray(value) ? value : value ? [value] : [];
    return {
      packages: array(parsed?.packages),
      startApps: array(parsed?.startApps),
      processes: array(parsed?.processes),
      registrations: array(parsed?.registrations),
    };
  } catch {
    return empty;
  }
}

module.exports = {
  appIdFromExecutable,
  desktopCandidatesFromCli,
  isClaudeCliPath,
  isClaudeDesktopAlias,
  isWindowsAppsPath,
  packageExecutableCandidates,
  parsePowerShellJson,
  processExecutableCandidates,
  registeredExecutableCandidates,
  startAppId,
  versionedExecutableCandidates,
};

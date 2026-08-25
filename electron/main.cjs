const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, shell, Tray } = require("electron");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const {
  appIdFromExecutable,
  desktopCandidatesFromCli,
  isClaudeCliPath,
  isClaudeDesktopAlias,
  packageExecutableCandidates,
  parsePowerShellJson,
  processExecutableCandidates,
  registeredExecutableCandidates,
  startAppId,
  versionedExecutableCandidates,
} = require("./windows-discovery.cjs");
const { emptySettings, normalizeSettings, validateSettings } = require("./settings.cjs");

const execFileAsync = promisify(execFile);
const REFRESH_INTERVAL_MS = 3_000;
const MAX_SESSION_FILES = 14;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const CODEX_APPROVAL_GRACE_MS = REFRESH_INTERVAL_MS * 2;
const CLAUDE_RECENT_ACTIVITY_MS = 15_000;
const CLAUDE_USAGE_STALE_MS = 30 * 60_000;
const WINDOWS_DISCOVERY_TTL_MS = 5 * 60_000;
const CLAUDE_USAGE_KEYS = {
  fh: "fiveHour",
  sd: "sevenDay",
  so: "sevenDayOpus",
  oa: "sevenDayOauthApps",
  cw: "sevenDayCowork",
  om: "sevenDayOmelette",
  op: "omelettePromotional",
  sn: "sevenDaySonnet",
  xu: "extraUsage",
};

let mainWindow = null;
let miniWindow = null;
let tray = null;
let refreshTimer = null;
let lastSnapshot = null;
let refreshPromise = null;
let appIsQuitting = false;
let windowsDiscoveryCache = null;
let windowsDiscoveryPromise = null;
let monitorSettings = null;

function exists(target) {
  return fs.access(target).then(() => true).catch(() => false);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function homePath(...parts) {
  return path.join(os.homedir(), ...parts);
}

function normalizeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isSessionId(value) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

async function launchCliSession(provider, session) {
  if (!provider.cliPath || !isSessionId(session.id)) {
    return { ok: false, error: "未检测到可恢复该会话的客户端" };
  }

  const resumeArgs = provider.id === "codex" ? ["resume", session.id] : ["--resume", session.id];
  const cwd = session.cwd && path.isAbsolute(session.cwd) ? session.cwd : os.homedir();

  try {
    if (process.platform === "darwin") {
      const command = `cd ${shellQuote(cwd)} && ${shellQuote(provider.cliPath)} ${resumeArgs.map(shellQuote).join(" ")}`;
      const appleScript = [
        'tell application "Terminal"',
        "activate",
        `do script ${JSON.stringify(command)}`,
        "end tell",
      ].join("\n");
      await execFileAsync("osascript", ["-e", appleScript], { timeout: 5_000 });
      return { ok: true, method: "cli" };
    }

    if (process.platform === "win32") {
      const command = `"${provider.cliPath}" ${resumeArgs.join(" ")}`;
      const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/k", command], {
        cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      child.unref();
      return { ok: true, method: "cli" };
    }

    const child = spawn("x-terminal-emulator", ["-e", provider.cliPath, ...resumeArgs], {
      cwd,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return { ok: true, method: "cli" };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

function settingsFilePath() {
  return path.join(app.getPath("userData"), "settings.json");
}

async function loadMonitorSettings() {
  if (monitorSettings) return monitorSettings;
  try {
    const value = JSON.parse(await fs.readFile(settingsFilePath(), "utf8"));
    monitorSettings = normalizeSettings(value);
  } catch {
    monitorSettings = emptySettings();
  }
  return monitorSettings;
}

async function saveMonitorSettings(value) {
  const validation = await validateSettings(value);
  if (!validation.valid) return { ok: false, errors: validation.errors };
  try {
    await fs.mkdir(app.getPath("userData"), { recursive: true });
    await fs.writeFile(settingsFilePath(), `${JSON.stringify(validation.settings, null, 2)}\n`, "utf8");
    monitorSettings = validation.settings;
    return { ok: true, settings: monitorSettings };
  } catch (error) {
    return { ok: false, error: normalizeError(error), errors: {} };
  }
}

async function applyPathOverride(configured, detected, label, errors) {
  if (!configured) return { path: detected, overridden: false };
  if (await exists(configured)) return { path: configured, overridden: true };
  errors.push(`${label} 的手动路径已失效，已回退自动检测`);
  return { path: detected, overridden: false };
}

async function activateDesktopApp(provider) {
  if (process.platform === "win32" && provider.desktopAppId) {
    try {
      await execFileAsync("explorer.exe", [`shell:AppsFolder\\${provider.desktopAppId}`], { timeout: 5_000 });
      return null;
    } catch {
      // Fall back to the registered protocol or executable path.
    }
  }

  if (process.platform === "win32" && provider.id === "claude") {
    try {
      await shell.openExternal("claude://");
      return null;
    } catch {
      // Fall back to the executable path for legacy Squirrel installations.
    }
  }

  if (!provider.desktopPath) return "未检测到桌面客户端";
  return shell.openPath(provider.desktopPath);
}

async function firstExisting(candidates) {
  for (const candidate of unique(candidates)) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function locateExecutables(command) {
  try {
    const locator = process.platform === "win32" ? "where.exe" : "which";
    const { stdout } = await execFileAsync(locator, [command], { timeout: 2_000 });
    const located = unique(stdout.split(/\r?\n/).map((item) => item.trim()));
    if (process.platform !== "win32") return located;
    const score = (target) => ({ ".cmd": 3, ".exe": 2, ".bat": 1 }[path.extname(target).toLowerCase()] || 0);
    return located.sort((left, right) => score(right) - score(left));
  } catch {
    // Fall back to well-known installation locations.
    return [];
  }
}

async function findExecutable(command, candidates, accept = () => true) {
  const located = await locateExecutables(command);
  return firstExisting([...located.filter(accept), ...candidates]);
}

async function readWindowsDiscoveryMetadata() {
  if (process.platform !== "win32") return { packages: [], startApps: [], processes: [], registrations: [] };
  if (windowsDiscoveryCache?.expiresAt > Date.now()) return windowsDiscoveryCache.value;
  if (windowsDiscoveryPromise) return windowsDiscoveryPromise;

  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$packages = @(Get-AppxPackage | Where-Object { ($_.Name + ' ' + $_.PackageFamilyName) -match 'OpenAI|Codex|ChatGPT|Anthropic|Claude' } | ForEach-Object { [PSCustomObject]@{ name = $_.Name; familyName = $_.PackageFamilyName; installLocation = $_.InstallLocation } })",
    "$startApps = @(Get-StartApps | Where-Object { ($_.Name + ' ' + $_.AppID) -match 'OpenAI|Codex|ChatGPT|Anthropic|Claude' } | ForEach-Object { [PSCustomObject]@{ name = $_.Name; appId = $_.AppID } })",
    "$processes = @(Get-Process | Where-Object { $_.ProcessName -match '^(ChatGPT|Codex|Claude)$' } | ForEach-Object { [PSCustomObject]@{ name = $_.ProcessName; path = $_.Path } })",
    "$uninstallPaths = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
    "$registrations = @(Get-ItemProperty -Path $uninstallPaths | Where-Object { $_.DisplayName -match 'OpenAI|Codex|ChatGPT|Anthropic|Claude' } | ForEach-Object { [PSCustomObject]@{ name = $_.DisplayName; installLocation = $_.InstallLocation; displayIcon = $_.DisplayIcon } })",
    "[PSCustomObject]@{ packages = $packages; startApps = $startApps; processes = $processes; registrations = $registrations } | ConvertTo-Json -Compress -Depth 4",
  ].join("; ");

  windowsDiscoveryPromise = execFileAsync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], { timeout: 8_000, windowsHide: true })
    .then(({ stdout }) => parsePowerShellJson(stdout))
    .catch(() => ({ packages: [], startApps: [], processes: [], registrations: [] }))
    .then((value) => {
      windowsDiscoveryCache = { value, expiresAt: Date.now() + WINDOWS_DISCOVERY_TTL_MS };
      windowsDiscoveryPromise = null;
      return value;
    });
  return windowsDiscoveryPromise;
}

function platformCandidates() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");

  if (process.platform === "darwin") {
    return {
      codexDesktop: ["/Applications/ChatGPT.app", "/Applications/Codex.app", homePath("Applications", "ChatGPT.app")],
      codexCli: ["/opt/homebrew/bin/codex", "/usr/local/bin/codex", homePath(".local", "bin", "codex")],
      claudeDesktop: ["/Applications/Claude.app", homePath("Applications", "Claude.app")],
      claudeCli: ["/opt/homebrew/bin/claude", "/usr/local/bin/claude", homePath(".local", "bin", "claude")],
      claudeDesktopData: [homePath("Library", "Application Support", "Claude")],
    };
  }

  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    return {
      codexDesktop: [
        path.join(localAppData, "Programs", "ChatGPT", "ChatGPT.exe"),
        path.join(localAppData, "Programs", "Codex", "Codex.exe"),
        path.join(localAppData, "Codex", "Codex.exe"),
        path.join(programFiles, "Codex", "Codex.exe"),
        path.join(programFiles, "ChatGPT", "ChatGPT.exe"),
        path.join(programFilesX86, "Codex", "Codex.exe"),
        path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "ChatGPT.lnk"),
      ],
      codexDesktopVersionRoots: [
        path.join(localAppData, "Codex"),
        path.join(localAppData, "Programs", "Codex"),
        path.join(localAppData, "Programs", "ChatGPT"),
      ],
      codexCli: [
        path.join(appData, "npm", "codex.cmd"),
        homePath(".local", "bin", "codex.exe"),
        path.join(localAppData, "Programs", "codex", "codex.exe"),
      ],
      claudeDesktop: [
        path.join(localAppData, "Programs", "Claude", "Claude.exe"),
        path.join(localAppData, "AnthropicClaude", "Claude.exe"),
        path.join(programFiles, "Claude", "Claude.exe"),
        path.join(programFilesX86, "Claude", "Claude.exe"),
      ],
      claudeDesktopVersionRoots: [
        path.join(localAppData, "AnthropicClaude"),
        path.join(localAppData, "Programs", "Claude"),
        path.join(localAppData, "Programs", "claude"),
      ],
      claudeCli: [path.join(appData, "npm", "claude.cmd"), homePath(".local", "bin", "claude.exe")],
      claudeDesktopData: [path.join(appData, "Claude"), path.join(localAppData, "Claude")],
    };
  }

  return {
    codexDesktop: [],
    codexCli: ["/usr/local/bin/codex", homePath(".local", "bin", "codex")],
    claudeDesktop: [],
    claudeCli: ["/usr/local/bin/claude", homePath(".local", "bin", "claude")],
    claudeDesktopData: [homePath(".config", "Claude"), homePath(".config", "claude")],
  };
}

async function resolveWindowsInstallations(provider, candidates) {
  const command = provider === "codex" ? "codex" : "claude";
  const [located, metadata, versioned] = await Promise.all([
    locateExecutables(command),
    readWindowsDiscoveryMetadata(),
    versionedExecutableCandidates(
      candidates[`${provider}DesktopVersionRoots`] || [],
      provider === "codex" ? ["ChatGPT.exe", "Codex.exe"] : ["Claude.exe"],
    ),
  ]);
  const cliCandidates = provider === "claude" ? located.filter(isClaudeCliPath) : located;
  const cliPath = await firstExisting([...cliCandidates, ...candidates[`${provider}Cli`]]);
  const inferredDesktop = unique([...located, cliPath].flatMap((item) => desktopCandidatesFromCli(provider, item)));
  const aliases = provider === "claude" ? located.filter(isClaudeDesktopAlias) : [];
  const packageCandidates = packageExecutableCandidates(provider, metadata.packages);
  const processCandidates = processExecutableCandidates(provider, metadata.processes);
  const registeredCandidates = registeredExecutableCandidates(provider, metadata.registrations);
  const registeredAppId = startAppId(provider, metadata.startApps);
  const desktopPath = await firstExisting([
    ...candidates[`${provider}Desktop`],
    ...versioned,
    ...inferredDesktop,
    ...processCandidates,
    ...registeredCandidates,
    ...packageCandidates,
    ...aliases,
  ]) || (registeredAppId ? packageCandidates[0] || null : null);
  const desktopAppId = registeredAppId || appIdFromExecutable(provider, desktopPath);

  return {
    cliPath,
    desktopPath,
    desktopAppId,
  };
}

async function resolveInstallations(provider, candidates) {
  if (process.platform === "win32") return resolveWindowsInstallations(provider, candidates);
  const [desktopPath, cliPath] = await Promise.all([
    firstExisting(candidates[`${provider}Desktop`]),
    findExecutable(provider, candidates[`${provider}Cli`]),
  ]);
  return { desktopPath, cliPath, desktopAppId: null };
}

async function listProcesses() {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("tasklist.exe", ["/FO", "CSV", "/NH"], { timeout: 3_000 });
      return stdout.split(/\r?\n/).filter(Boolean).map((line) => {
        const columns = line.match(/"([^"]*)"/g)?.map((value) => value.slice(1, -1)) || [];
        return { name: columns[0] || line, pid: Number(columns[1]) || null, command: columns[0] || line };
      });
    }

    const { stdout } = await execFileAsync("ps", ["-ax", "-o", "pid=,etime=,command="], { timeout: 3_000 });
    return stdout.split(/\r?\n/).filter(Boolean).map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
      return {
        pid: match ? Number(match[1]) : null,
        elapsed: match?.[2] || null,
        command: match?.[3] || line.trim(),
        name: path.basename((match?.[3] || line.trim()).split(/\s+/)[0]),
      };
    });
  } catch {
    return [];
  }
}

function matchingProcesses(processes, provider) {
  const patterns = provider === "codex"
    ? [
        /\/ChatGPT\.app\/Contents\/MacOS\/ChatGPT(?:\s|$)/i,
        /(?:^|[\\/\s])ChatGPT\.exe(?:\s|$)/i,
        /(?:^|\s)(?:[A-Za-z]:\\[^\s"]*\\|\/[^\s"]*\/)?codex(?:\.exe)?(?:\s|$)/i,
      ]
    : [
        /\/Claude\.app\/Contents\/MacOS\/Claude(?:\s|$)/i,
        /(?:^|[\\/\s])Claude\.exe(?:\s|$)/i,
        /(?:^|\s)(?:[A-Za-z]:\\[^\s"]*\\|\/[^\s"]*\/)?claude(?:\.exe)?(?:\s|$)/i,
      ];
  return processes
    .filter((item) => patterns.some((pattern) => pattern.test(item.command)))
    .map((item) => ({ ...item, command: item.command.slice(0, 240) }))
    .slice(0, 12);
}

function matchingClaudeCodeProcesses(processes) {
  return processes
    .filter((item) => {
      const command = String(item.command || "");
      if (process.platform === "win32" && /^claude\.exe$/i.test(command)) return false;
      if (command.startsWith("/Applications/Claude.app/")) return false;
      if (/^\/.*\/claude\.app\/Contents\/MacOS\/claude(?:\s|$)/.test(command)) return true;
      const executable = command.match(/^"([^"]+)"|^(\S+)/)?.slice(1).find(Boolean) || "";
      return /^claude(?:\.exe|\.cmd)?$/i.test(executable.split(/[\\/]/).at(-1));
    })
    .map((item) => ({ ...item, command: item.command.slice(0, 240) }))
    .slice(0, 12);
}

async function collectFiles(root, extension, limit = MAX_SESSION_FILES) {
  if (!(await exists(root))) return [];
  const results = [];
  const pending = [root];

  while (pending.length) {
    const current = pending.pop();
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith(extension)) {
        try {
          const stat = await fs.stat(fullPath);
          results.push({ path: fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
        } catch {
          // File may disappear during session rotation.
        }
      }
    }
  }

  return results.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

async function readJsonLines(fileInfo) {
  try {
    const handle = await fs.open(fileInfo.path, "r");
    try {
      if (fileInfo.size <= MAX_READ_BYTES) {
        const text = await handle.readFile({ encoding: "utf8" });
        return text.split(/\r?\n/).filter(Boolean).map(safeJson).filter(Boolean);
      }

      const headSize = Math.min(256 * 1024, fileInfo.size);
      const tailSize = MAX_READ_BYTES - headSize;
      const head = Buffer.alloc(headSize);
      const tail = Buffer.alloc(tailSize);
      await handle.read(head, 0, headSize, 0);
      await handle.read(tail, 0, tailSize, Math.max(0, fileInfo.size - tailSize));
      const combined = `${head.toString("utf8")}\n${tail.toString("utf8")}`;
      return combined.split(/\r?\n/).filter(Boolean).map(safeJson).filter(Boolean);
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readClaudeDesktopSessionIndex(dataRoots) {
  const dataRoot = await firstExisting(dataRoots);
  if (!dataRoot) return new Map();

  const files = await collectFiles(path.join(dataRoot, "claude-code-sessions"), ".json", 500);
  const index = new Map();
  await Promise.all(files.map(async (file) => {
    let record;
    try {
      record = safeJson(await fs.readFile(file.path, "utf8"));
    } catch {
      return;
    }

    const cliSessionId = record?.cliSessionId;
    const desktopSessionId = record?.sessionId;
    if (!isSessionId(cliSessionId) || typeof desktopSessionId !== "string") return;

    const current = index.get(cliSessionId) || {};
    if (desktopSessionId === `local_${cliSessionId}`) {
      current.importedSessionId ||= desktopSessionId;
    } else {
      current.nativeSessionId ||= desktopSessionId;
    }
    index.set(cliSessionId, current);
  }));
  return index;
}

function shorten(text, fallback = "未命名会话") {
  const cleaned = String(text || "")
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return fallback;
  return cleaned.length > 68 ? `${cleaned.slice(0, 68)}...` : cleaned;
}

function latestValue(items, selector) {
  let result = null;
  for (const item of items) {
    const value = selector(item);
    if (value !== undefined && value !== null) result = value;
  }
  return result;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => ["text", "input_text", "output_text"].includes(item?.type) && item.text)
    .map((item) => item.text)
    .join(" ");
}

function codexMessageText(line) {
  if (line.type === "event_msg"
    && ["user_message", "agent_message"].includes(line.payload?.type)) {
    return line.payload.message || "";
  }
  if (line.type === "response_item"
    && line.payload?.type === "message"
    && ["user", "assistant"].includes(line.payload.role)) {
    return contentText(line.payload.content);
  }
  return "";
}

function toolInputText(input) {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input ?? "");
  } catch {
    return String(input || "");
  }
}

function hasPendingCodexConfirmation(lines, turnContext) {
  const responseItems = lines.filter((line) => line.type === "response_item");
  const answeredCalls = new Set(responseItems
    .filter((line) => ["function_call_output", "custom_tool_call_output"].includes(line.payload?.type))
    .map((line) => line.payload?.call_id)
    .filter(Boolean));
  const approvalsAreAutomatic = turnContext?.approvals_reviewer === "auto_review"
    || turnContext?.approval_policy === "never";

  return responseItems.some((line) => {
    const payload = line.payload || {};
    if (!payload.call_id || answeredCalls.has(payload.call_id)) return false;
    if (payload.type === "function_call" && payload.name === "request_user_input") return true;
    if (payload.type !== "custom_tool_call" || payload.name !== "exec") return false;

    const input = toolInputText(payload.input);
    const requestsApproval = input.includes("require_escalated")
      && input.includes("sandbox_permissions");
    if (!requestsApproval || approvalsAreAutomatic) return false;

    const requestedAt = Date.parse(line.timestamp || "");
    return Number.isFinite(requestedAt)
      && Date.now() - requestedAt >= CODEX_APPROVAL_GRACE_MS;
  });
}

function parseCodexSession(fileInfo, lines, processRunning) {
  const metadata = lines.find((line) => line.type === "session_meta")?.payload || {};
  const contexts = lines.filter((line) => line.type === "turn_context");
  const latestContext = contexts.at(-1)?.payload || {};
  const events = lines.filter((line) => line.type === "event_msg");
  const userMessage = events.find((line) => line.payload?.type === "user_message")?.payload?.message;
  const latestContent = latestValue(lines, (line) => codexMessageText(line) || undefined);
  const lastTaskEvent = latestValue(events, (line) => {
    if (["task_started", "task_complete", "turn_aborted"].includes(line.payload?.type)) {
      return { type: line.payload.type, at: line.timestamp || line.payload.started_at || line.payload.completed_at };
    }
    return undefined;
  });
  const tokenEvent = latestValue(events, (line) => line.payload?.type === "token_count" ? line.payload : undefined);
  const usage = tokenEvent?.info?.total_token_usage || {};
  const contextUsage = tokenEvent?.info?.last_token_usage || {};
  const rateLimits = tokenEvent?.rate_limits || null;
  const sourceIsSubagent = metadata.thread_source === "subagent"
    || (metadata.source && typeof metadata.source === "object" && Boolean(metadata.source.subagent));
  const freshness = Date.now() - fileInfo.mtimeMs;
  const waitingForConfirmation = hasPendingCodexConfirmation(lines, latestContext);
  let status = "idle";
  if (lastTaskEvent?.type === "task_started" && processRunning) {
    status = waitingForConfirmation ? "waiting" : "running";
  }
  if (lastTaskEvent?.type === "turn_aborted") status = "failed";
  if (freshness < 15_000 && processRunning && lastTaskEvent?.type !== "task_complete") {
    status = waitingForConfirmation ? "waiting" : "running";
  }

  return {
    id: metadata.id || metadata.session_id || path.basename(fileInfo.path, ".jsonl"),
    title: shorten(userMessage, path.basename(metadata.cwd || fileInfo.path)),
    latestContent: shorten(latestContent, userMessage || path.basename(metadata.cwd || fileInfo.path)),
    cwd: metadata.cwd || latestContext.cwd || null,
    model: latestContext.model || metadata.model || null,
    effort: latestContext.effort || null,
    status,
    source: metadata.originator || metadata.source || "Codex",
    updatedAt: new Date(fileInfo.mtimeMs).toISOString(),
    transcriptPath: fileInfo.path,
    usage: {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cachedInputTokens: usage.cached_input_tokens || 0,
      totalTokens: usage.total_tokens || 0,
      contextTokens: contextUsage.input_tokens || usage.input_tokens || 0,
      contextWindow: tokenEvent?.info?.model_context_window || metadata.context_window || null,
    },
    rateLimits,
    internal: sourceIsSubagent
      || String(userMessage || "").startsWith("The following is the Codex agent history whose request action you are assessing."),
  };
}

function messageText(message) {
  return contentText(message?.content);
}

function hasPendingClaudeQuestion(lines) {
  const toolResults = new Set();
  for (const line of lines) {
    if (line.type !== "user" || !Array.isArray(line.message?.content)) continue;
    for (const item of line.message.content) {
      if (item?.type === "tool_result" && item.tool_use_id) toolResults.add(item.tool_use_id);
    }
  }

  return lines.some((line) => line.type === "assistant"
    && Array.isArray(line.message?.content)
    && line.message.content.some((item) => item?.type === "tool_use"
      && item.name === "AskUserQuestion"
      && item.id
      && !toolResults.has(item.id)));
}

function claudeTurnIsActive(lines) {
  let active = false;
  for (const line of lines) {
    if (line.type === "user") {
      active = true;
      continue;
    }

    if (line.type === "assistant") {
      const stopReason = line.message?.stop_reason;
      active = !["end_turn", "stop_sequence", "max_tokens", "refusal"].includes(stopReason);
      continue;
    }

    if (line.type === "system" && ["turn_duration", "stop_hook_summary"].includes(line.subtype)) active = false;
  }
  return active;
}

function agentIsWaiting(agent) {
  if (!agent) return false;
  const state = [agent.status, agent.state, agent.phase, agent.permissionStatus]
    .filter(Boolean)
    .join(" ");
  return /waiting|needs?.?input|approval|permission|blocked/i.test(state);
}

function parseClaudeSession(fileInfo, lines, activeAgents, claudeCodeRunning) {
  const meaningful = lines.filter((line) => !line.isSidechain);
  const firstUser = meaningful.find((line) => line.type === "user" && !line.sourceToolAssistantUUID);
  const title = latestValue(meaningful, (line) => line.type === "ai-title" ? line.aiTitle : undefined);
  const assistants = meaningful.filter((line) => line.type === "assistant");
  const latestAssistant = assistants.at(-1);
  const latestContent = latestValue(meaningful, (line) => {
    if (!["user", "assistant"].includes(line.type)) return undefined;
    return messageText(line.message) || undefined;
  });
  const transcriptId = path.basename(fileInfo.path, ".jsonl");
  const id = isSessionId(transcriptId)
    ? transcriptId
    : latestValue(meaningful, (line) => line.sessionId || line.session_id) || transcriptId;
  const cwd = latestValue(meaningful, (line) => line.cwd);
  const mode = latestValue(meaningful, (line) => line.type === "permission-mode" ? line.permissionMode : undefined);
  const totals = assistants.reduce((sum, line) => {
    const usage = line.message?.usage || {};
    sum.inputTokens += usage.input_tokens || 0;
    sum.outputTokens += usage.output_tokens || 0;
    sum.cachedInputTokens += usage.cache_read_input_tokens || 0;
    sum.cacheCreationTokens += usage.cache_creation_input_tokens || 0;
    return sum;
  }, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0 });
  const latestUsage = latestAssistant?.message?.usage || {};
  const agent = activeAgents.get(id);
  const latestActivityAt = latestValue(meaningful, (line) => {
    if (!["user", "assistant", "queue-operation"].includes(line.type) || !line.timestamp) return undefined;
    const timestamp = Date.parse(line.timestamp);
    return Number.isFinite(timestamp) ? timestamp : undefined;
  });
  const activityAge = latestActivityAt === null ? Infinity : Math.max(0, Date.now() - latestActivityAt);
  const pendingQuestion = hasPendingClaudeQuestion(meaningful);
  const transcriptTurnActive = claudeTurnIsActive(meaningful);
  const recentlyActive = activityAge < CLAUDE_RECENT_ACTIVITY_MS;
  const active = transcriptTurnActive && (Boolean(agent) || claudeCodeRunning || recentlyActive);
  const waitingForConfirmation = active && (agentIsWaiting(agent) || pendingQuestion);

  return {
    id,
    title: shorten(title || messageText(firstUser?.message), path.basename(cwd || fileInfo.path)),
    latestContent: shorten(latestContent, title || messageText(firstUser?.message) || path.basename(cwd || fileInfo.path)),
    cwd: cwd || null,
    model: latestAssistant?.message?.model || null,
    effort: latestAssistant?.effort || null,
    status: waitingForConfirmation ? "waiting" : active ? "running" : "idle",
    source: firstUser?.entrypoint || "Claude Code",
    permissionMode: mode || null,
    updatedAt: new Date(fileInfo.mtimeMs).toISOString(),
    transcriptPath: fileInfo.path,
    usage: {
      ...totals,
      totalTokens: totals.inputTokens + totals.outputTokens + totals.cachedInputTokens + totals.cacheCreationTokens,
      contextTokens: (latestUsage.input_tokens || 0)
        + (latestUsage.output_tokens || 0)
        + (latestUsage.cache_read_input_tokens || 0)
        + (latestUsage.cache_creation_input_tokens || 0),
      contextWindow: null,
    },
  };
}

async function readClaudeAgents(claudeCli) {
  if (!claudeCli) return [];
  try {
    const command = process.platform === "win32" && /\.(cmd|bat)$/i.test(claudeCli)
      ? {
          file: process.env.ComSpec || "cmd.exe",
          args: ["/d", "/s", "/c", `"${claudeCli}" agents --json`],
        }
      : { file: claudeCli, args: ["agents", "--json"] };
    const { stdout } = await execFileAsync(command.file, command.args, { timeout: 4_000, maxBuffer: 2 * 1024 * 1024 });
    const parsed = JSON.parse(stdout || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function readClaudeStats(claudeHome) {
  const statsPath = path.join(claudeHome, "stats-cache.json");
  try {
    const data = JSON.parse(await fs.readFile(statsPath, "utf8"));
    const modelUsage = Object.entries(data.modelUsage || {}).map(([model, usage]) => ({ model, ...usage }));
    return {
      totalSessions: data.totalSessions || 0,
      totalMessages: data.totalMessages || 0,
      firstSessionDate: data.firstSessionDate || null,
      lastComputedDate: data.lastComputedDate || null,
      modelUsage,
      path: statsPath,
    };
  } catch {
    return null;
  }
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, number));
}

function normalizeUsageResetAt(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric)
    ? (numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric)
    : Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

async function readClaudePlanUsage(dataDirectories = []) {
  const usagePath = await firstExisting(dataDirectories.map((directory) => path.join(directory, "plan-usage-history.json")));
  if (!usagePath) return null;

  try {
    const data = JSON.parse(await fs.readFile(usagePath, "utf8"));
    const sample = Array.isArray(data.samples)
      ? data.samples
        .filter((item) => Number.isFinite(Number(item?.t)) && item?.u && typeof item.u === "object")
        .sort((left, right) => Number(left.t) - Number(right.t))
        .at(-1)
      : null;
    if (!sample) return null;

    const windows = {};
    for (const [shortName, longName] of Object.entries(CLAUDE_USAGE_KEYS)) {
      const rawUsage = sample.u[shortName];
      const usedPercent = clampPercent(typeof rawUsage === "object"
        ? rawUsage?.usedPercent ?? rawUsage?.used_percent ?? rawUsage?.value
        : rawUsage);
      if (usedPercent === null) continue;
      const resetsAt = normalizeUsageResetAt(
        rawUsage?.resetsAt
          ?? rawUsage?.resets_at
          ?? rawUsage?.resetAt
          ?? rawUsage?.reset_at
          ?? sample.r?.[shortName]
          ?? sample.resets?.[shortName],
      );
      windows[longName] = {
        usedPercent,
        remainingPercent: Math.max(0, 100 - usedPercent),
        ...(resetsAt ? { resetsAt } : {}),
      };
    }

    const sampledAt = Number(sample.t);
    return {
      windows,
      sampledAt: new Date(sampledAt).toISOString(),
      stale: Date.now() - sampledAt > CLAUDE_USAGE_STALE_MS,
      path: usagePath,
    };
  } catch {
    return null;
  }
}

async function collectCodex(processes, candidates, configured = {}) {
  const detectedHome = process.env.CODEX_HOME || homePath(".codex");
  const installation = await resolveInstallations("codex", candidates);
  const errors = [];
  const [desktop, cli, data] = await Promise.all([
    applyPathOverride(configured.desktopPath, installation.desktopPath, "Codex Desktop", errors),
    applyPathOverride(configured.cliPath, installation.cliPath, "Codex CLI", errors),
    applyPathOverride(configured.dataHome, detectedHome, "Codex 数据目录", errors),
  ]);
  const desktopPath = desktop.path;
  const cliPath = cli.path;
  const codexHome = data.path;
  const desktopAppId = desktop.overridden
    ? appIdFromExecutable("codex", desktopPath)
    : installation.desktopAppId;
  const files = await collectFiles(path.join(codexHome, "sessions"), ".jsonl");
  const runningProcesses = matchingProcesses(processes, "codex");
  const parsedSessions = await Promise.all(files.map(async (file) => parseCodexSession(file, await readJsonLines(file), runningProcesses.length > 0)));
  const sessions = parsedSessions.filter((session) => !session.internal).map(({ internal: _internal, ...session }) => session);
  const totals = sessions.reduce((sum, session) => {
    sum.inputTokens += session.usage.inputTokens;
    sum.outputTokens += session.usage.outputTokens;
    sum.cachedInputTokens += session.usage.cachedInputTokens;
    sum.totalTokens += session.usage.totalTokens;
    return sum;
  }, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 });

  return {
    id: "codex",
    label: "Codex Desktop",
    installed: Boolean(desktopPath || desktopAppId || cliPath),
    running: runningProcesses.length > 0,
    desktopPath,
    desktopAppId,
    cliPath,
    dataHome: (await exists(codexHome)) ? codexHome : null,
    pathOverrides: { desktop: desktop.overridden, cli: cli.overridden, data: data.overridden },
    detectedPaths: {
      desktopPath: installation.desktopPath,
      cliPath: installation.cliPath,
      dataHome: (await exists(detectedHome)) ? detectedHome : null,
    },
    processes: runningProcesses,
    sessions,
    totals,
    stats: null,
    errors,
  };
}

async function collectClaude(processes, candidates, configured = {}) {
  const detectedHome = process.env.CLAUDE_CONFIG_DIR || homePath(".claude");
  const installation = await resolveInstallations("claude", candidates);
  const errors = [];
  const [desktop, cli, data] = await Promise.all([
    applyPathOverride(configured.desktopPath, installation.desktopPath, "Claude Desktop", errors),
    applyPathOverride(configured.cliPath, installation.cliPath, "Claude CLI", errors),
    applyPathOverride(configured.dataHome, detectedHome, "Claude 数据目录", errors),
  ]);
  const desktopPath = desktop.path;
  const cliPath = cli.path;
  const claudeHome = data.path;
  const desktopAppId = desktop.overridden
    ? appIdFromExecutable("claude", desktopPath)
    : installation.desktopAppId;
  const [files, stats, planUsage, desktopSessionIndex] = await Promise.all([
    collectFiles(path.join(claudeHome, "projects"), ".jsonl"),
    readClaudeStats(claudeHome),
    readClaudePlanUsage(candidates.claudeDesktopData),
    readClaudeDesktopSessionIndex(candidates.claudeDesktopData),
  ]);
  const agents = await readClaudeAgents(cliPath);
  const activeAgents = new Map(agents
    .map((agent) => [agent.sessionId || agent.session_id || agent.id, agent])
    .filter(([id]) => Boolean(id)));
  const runningProcesses = matchingProcesses(processes, "claude");
  const codeProcesses = matchingClaudeCodeProcesses(processes);
  const mainSessionFiles = files.filter((file) => !file.path.includes(`${path.sep}subagents${path.sep}`));
  const sessions = await Promise.all(mainSessionFiles.map(async (file) => {
    const session = parseClaudeSession(file, await readJsonLines(file), activeAgents, codeProcesses.length > 0);
    const desktopSession = desktopSessionIndex.get(session.id);
    return {
      ...session,
      desktopSessionId: desktopSession?.nativeSessionId || null,
      desktopImported: Boolean(desktopSession?.importedSessionId),
    };
  }));
  const sessionTotals = sessions.reduce((sum, session) => {
    sum.inputTokens += session.usage.inputTokens;
    sum.outputTokens += session.usage.outputTokens;
    sum.cachedInputTokens += session.usage.cachedInputTokens;
    sum.totalTokens += session.usage.totalTokens;
    return sum;
  }, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 });
  const totalCostUsd = stats?.modelUsage?.reduce((sum, item) => sum + (Number(item.costUSD) || 0), 0) || 0;

  return {
    id: "claude",
    label: "Claude Desktop",
    installed: Boolean(desktopPath || desktopAppId || cliPath),
    running: runningProcesses.length > 0,
    desktopPath,
    desktopAppId,
    cliPath,
    dataHome: (await exists(claudeHome)) ? claudeHome : null,
    pathOverrides: { desktop: desktop.overridden, cli: cli.overridden, data: data.overridden },
    detectedPaths: {
      desktopPath: installation.desktopPath,
      cliPath: installation.cliPath,
      dataHome: (await exists(detectedHome)) ? detectedHome : null,
    },
    processes: runningProcesses,
    codeProcesses,
    sessions,
    agents,
    totals: { ...sessionTotals, totalCostUsd },
    stats,
    planUsage,
    errors,
  };
}

async function buildSnapshot() {
  const candidates = platformCandidates();
  const [processes, settings] = await Promise.all([listProcesses(), loadMonitorSettings()]);
  const [codex, claude] = await Promise.all([
    collectCodex(processes, candidates, settings.providers.codex),
    collectClaude(processes, candidates, settings.providers.claude),
  ]);
  return {
    schemaVersion: 1,
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    refreshedAt: new Date().toISOString(),
    codex,
    claude,
  };
}

function snapshotSessions(snapshot) {
  const sessions = new Map();
  for (const provider of [snapshot?.codex, snapshot?.claude]) {
    if (!provider) continue;
    for (const session of provider.sessions || []) {
      sessions.set(`${provider.id}:${session.id}`, { provider, session });
    }
  }
  return sessions;
}

function snapshotAlerts(previousSnapshot, nextSnapshot) {
  if (!previousSnapshot) return [];
  const previous = snapshotSessions(previousSnapshot);
  const next = snapshotSessions(nextSnapshot);
  const activeStatuses = new Set(["running", "waiting"]);
  const alerts = [];

  for (const [key, current] of next) {
    const before = previous.get(key);
    if (current.session.status !== "waiting" || before?.session.status === "waiting") continue;
    alerts.push({
      type: "waiting",
      providerId: current.provider.id,
      providerLabel: current.provider.label,
      sessionId: current.session.id,
      title: current.session.title,
      message: "任务需要你的确认",
    });
  }

  for (const [key, before] of previous) {
    if (!activeStatuses.has(before.session.status)) continue;
    const current = next.get(key);
    if (current?.session.status === "waiting") continue;
    if (current?.session.status === "failed") {
      alerts.push({
        type: "failed",
        providerId: before.provider.id,
        providerLabel: before.provider.label,
        sessionId: before.session.id,
        title: before.session.title,
        message: "任务运行异常",
        session: current.session,
      });
      continue;
    }
    if (!current || !activeStatuses.has(current.session.status)) {
      alerts.push({
        type: "complete",
        providerId: before.provider.id,
        providerLabel: before.provider.label,
        sessionId: before.session.id,
        title: before.session.title,
        message: "任务已完成",
        session: current?.session || before.session,
      });
    }
  }

  return alerts;
}

function sendSnapshot(window, snapshot) {
  if (window && !window.isDestroyed()) window.webContents.send("monitor:snapshot", snapshot);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function toggleMiniWindow() {
  if (!miniWindow || miniWindow.isDestroyed()) {
    createMiniWindow();
    notifyMiniVisibility();
    return { visible: true };
  }
  if (miniWindow.isVisible()) miniWindow.hide();
  else miniWindow.showInactive();
  notifyMiniVisibility();
  return { visible: miniWindow.isVisible() };
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const miniVisible = Boolean(miniWindow && !miniWindow.isDestroyed() && miniWindow.isVisible());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示主界面", click: showMainWindow },
    { label: miniVisible ? "隐藏悬浮窗" : "显示悬浮窗", click: toggleMiniWindow },
    { type: "separator" },
    {
      label: "退出 AI Monitor",
      click: () => {
        appIsQuitting = true;
        app.quit();
      },
    },
  ]));
}

function createTray() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "app-icon.png")
    : path.join(__dirname, "..", "build", "app-icon.png");
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) icon = nativeImage.createFromPath(process.execPath);
  if (icon.isEmpty()) return;
  if (process.platform === "darwin") icon.setTemplateImage(true);
  else icon = icon.resize({ width: 16, height: 16 });

  tray = new Tray(icon);
  tray.setToolTip("AI Monitor");
  updateTrayMenu();
  if (process.platform !== "darwin") tray.on("click", showMainWindow);
}

function notifyMiniVisibility() {
  const visible = Boolean(miniWindow && !miniWindow.isDestroyed() && miniWindow.isVisible());
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("monitor:mini-visibility", visible);
  }
  updateTrayMenu();
}

async function refreshSnapshot() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = buildSnapshot()
    .then((snapshot) => {
      const alerts = snapshotAlerts(lastSnapshot, snapshot);
      lastSnapshot = snapshot;
      sendSnapshot(mainWindow, snapshot);
      sendSnapshot(miniWindow, snapshot);
      if (miniWindow && !miniWindow.isDestroyed() && miniWindow.isVisible()) {
        for (const alert of alerts) miniWindow.webContents.send("monitor:mini-alert", alert);
      }
      return snapshot;
    })
    .catch((error) => ({
      ...(lastSnapshot || {}),
      refreshedAt: new Date().toISOString(),
      fatalError: normalizeError(error),
    }))
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

function glassWindowOptions(fallbackColor, { frameless = false } = {}) {
  if (process.platform === "darwin") {
    return {
      backgroundColor: "#00000000",
      vibrancy: "under-window",
      visualEffectState: "active",
      ...(frameless ? { transparent: true } : { titleBarStyle: "hiddenInset" }),
    };
  }

  if (process.platform === "win32") {
    return {
      backgroundColor: "#00FFFFFF",
      backgroundMaterial: "acrylic",
      ...(frameless ? { transparent: true } : {}),
    };
  }

  return { backgroundColor: fallbackColor };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    ...glassWindowOptions("#e9edf4"),
    title: "AI Monitor",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (app.isPackaged) mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  else mainWindow.loadURL("http://127.0.0.1:5173");

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.on("close", () => {
    if (process.platform === "darwin" || appIsQuitting) return;
    appIsQuitting = true;
    if (miniWindow && !miniWindow.isDestroyed()) miniWindow.destroy();
  });
}

function createMiniWindow() {
  const workArea = screen.getPrimaryDisplay().workArea;
  miniWindow = new BrowserWindow({
    width: 390,
    height: 280,
    minWidth: 340,
    minHeight: 200,
    x: Math.max(workArea.x, workArea.x + workArea.width - 414),
    y: workArea.y + 24,
    frame: false,
    alwaysOnTop: true,
    // On macOS the Dock icon is app-wide. Marking this helper window as
    // skipTaskbar can hide the whole app from the Dock.
    skipTaskbar: process.platform !== "darwin",
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    ...glassWindowOptions("#f8faf7", { frameless: true }),
    title: "AI Monitor Active Tasks",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  miniWindow.setAlwaysOnTop(true, "floating");
  if (process.platform === "darwin") {
    miniWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  if (app.isPackaged) {
    miniWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"), { query: { view: "mini" } });
  } else {
    miniWindow.loadURL("http://127.0.0.1:5173/?view=mini");
  }

  miniWindow.on("show", () => {
    ensureMacDockVisible();
    notifyMiniVisibility();
  });
  miniWindow.on("hide", notifyMiniVisibility);
  miniWindow.on("close", (event) => {
    if (appIsQuitting) return;
    event.preventDefault();
    miniWindow.hide();
  });
  miniWindow.on("closed", () => {
    miniWindow = null;
    notifyMiniVisibility();
  });
  miniWindow.webContents.on("did-finish-load", () => {
    if (lastSnapshot) sendSnapshot(miniWindow, lastSnapshot);
  });

  return miniWindow;
}

async function ensureMacDockVisible() {
  if (process.platform !== "darwin" || !app.dock || app.dock.isVisible()) return;
  try {
    await app.dock.show();
  } catch (error) {
    console.warn(`Unable to show Dock icon: ${normalizeError(error)}`);
  }
}

async function setMacDockIcon() {
  if (process.platform !== "darwin" || !app.dock) return;
  await ensureMacDockVisible();
  if (app.isPackaged) return;
  const iconPath = path.join(__dirname, "..", "build", "app-icon.png");
  if (!(await exists(iconPath))) return;
  try {
    app.dock.setIcon(iconPath);
  } catch (error) {
    console.warn(`Unable to set development Dock icon: ${normalizeError(error)}`);
  }
}

ipcMain.handle("monitor:get-snapshot", () => refreshSnapshot());
ipcMain.handle("monitor:get-runtime", () => ({
  platform: process.platform,
  packaged: app.isPackaged,
  version: app.getVersion(),
}));
ipcMain.handle("monitor:get-settings", () => loadMonitorSettings());
ipcMain.handle("monitor:save-settings", async (_event, value) => {
  const result = await saveMonitorSettings(value);
  if (result.ok) {
    if (refreshPromise) await refreshPromise;
    await refreshSnapshot();
  }
  return result;
});
ipcMain.handle("monitor:reset-settings", async () => {
  const result = await saveMonitorSettings(emptySettings());
  if (result.ok) {
    if (refreshPromise) await refreshPromise;
    await refreshSnapshot();
  }
  return result;
});
ipcMain.handle("monitor:pick-settings-path", async (_event, provider, key) => {
  if (!["codex", "claude"].includes(provider) || !["desktopPath", "cliPath", "dataHome"].includes(key)) {
    return { ok: false, error: "无效的设置项" };
  }
  const settings = await loadMonitorSettings();
  const configured = settings.providers[provider][key];
  const selectingMacApp = process.platform === "darwin" && key === "desktopPath";
  const result = await dialog.showOpenDialog(mainWindow, {
    title: key === "dataHome"
      ? "选择本地数据目录"
      : selectingMacApp ? "选择 .app 应用或可执行文件" : "选择可执行文件",
    defaultPath: configured || undefined,
    properties: key === "dataHome" ? ["openDirectory"] : ["openFile"],
    message: selectingMacApp ? "请选择 Codex、ChatGPT 或 Claude 的 .app 应用" : undefined,
    filters: key === "dataHome" || process.platform !== "win32"
      ? undefined
      : [{ name: "可执行文件", extensions: ["exe", "cmd", "bat"] }, { name: "所有文件", extensions: ["*"] }],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  return { ok: true, path: result.filePaths[0] };
});
ipcMain.handle("monitor:get-mini-state", () => ({
  visible: Boolean(miniWindow && !miniWindow.isDestroyed() && miniWindow.isVisible()),
}));
ipcMain.handle("monitor:toggle-mini", toggleMiniWindow);
ipcMain.handle("monitor:close-mini", () => {
  if (miniWindow && !miniWindow.isDestroyed()) miniWindow.hide();
  notifyMiniVisibility();
  return { visible: false };
});
ipcMain.handle("monitor:open-path", async (_event, targetPath) => {
  if (typeof targetPath !== "string" || !path.isAbsolute(targetPath)) return { ok: false, error: "Invalid path" };
  const error = await shell.openPath(targetPath);
  return error ? { ok: false, error } : { ok: true };
});
ipcMain.handle("monitor:open-session", async (_event, providerId, sessionId) => {
  if (!['codex', 'claude'].includes(providerId) || !isSessionId(sessionId)) {
    return { ok: false, error: "无效的会话标识" };
  }

  const snapshot = lastSnapshot || await refreshSnapshot();
  const provider = snapshot?.[providerId];
  const session = provider?.sessions?.find((item) => item.id === sessionId);
  if (!provider || !session) return { ok: false, error: "本地会话已不存在" };

  if (providerId === "codex" && (provider.desktopPath || provider.desktopAppId)) {
    const deepLink = `codex://threads/${encodeURIComponent(session.id)}`;
    try {
      await shell.openExternal(deepLink);
      return { ok: true, method: "desktop" };
    } catch {
      // Fall through to the documented CLI resume command.
    }
  }

  if (providerId === "claude" && (provider.desktopPath || provider.desktopAppId)) {
    // Claude Desktop cannot externally focus a native local Code session. Its
    // resume URL imports the CLI transcript as a second "General coding
    // session", so only activate the app when the native mapping is present.
    const originatedInDesktop = session.desktopSessionId
      || String(session.source || "").startsWith("claude-desktop");
    if (originatedInDesktop) {
      const error = await activateDesktopApp(provider);
      return error
        ? { ok: false, error }
        : { ok: true, method: "desktop-activate", exact: false };
    }

    try {
      await shell.openExternal(`claude://resume?session=${encodeURIComponent(session.id)}`);
      return { ok: true, method: "desktop", exact: true };
    } catch {
      const error = await activateDesktopApp(provider);
      if (!error) return { ok: true, method: "desktop-activate", exact: false };
    }
  }

  return launchCliSession(provider, session);
});

app.whenReady().then(async () => {
  await setMacDockIcon();
  if (process.argv.includes("--snapshot-json")) {
    const snapshot = await buildSnapshot();
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    app.quit();
    return;
  }

  createWindow();
  createTray();
  await refreshSnapshot();
  refreshTimer = setInterval(refreshSnapshot, REFRESH_INTERVAL_MS);
  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    else mainWindow.show();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  appIsQuitting = true;
  if (refreshTimer) clearInterval(refreshTimer);
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
});

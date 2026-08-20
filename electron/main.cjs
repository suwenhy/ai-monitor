const { app, BrowserWindow, ipcMain, screen, shell } = require("electron");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const REFRESH_INTERVAL_MS = 3_000;
const MAX_SESSION_FILES = 14;
const MAX_READ_BYTES = 4 * 1024 * 1024;

let mainWindow = null;
let miniWindow = null;
let refreshTimer = null;
let lastSnapshot = null;
let refreshPromise = null;
let appIsQuitting = false;

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

async function firstExisting(candidates) {
  for (const candidate of unique(candidates)) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function findExecutable(command, candidates) {
  try {
    const locator = process.platform === "win32" ? "where.exe" : "which";
    const { stdout } = await execFileAsync(locator, [command], { timeout: 2_000 });
    const located = stdout.split(/\r?\n/).map((item) => item.trim()).find(Boolean);
    if (located) return located;
  } catch {
    // Fall back to well-known installation locations.
  }
  return firstExisting(candidates);
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
    };
  }

  if (process.platform === "win32") {
    return {
      codexDesktop: [
        path.join(localAppData, "Programs", "ChatGPT", "ChatGPT.exe"),
        path.join(localAppData, "Programs", "Codex", "Codex.exe"),
        path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "ChatGPT.lnk"),
      ],
      codexCli: [
        path.join(appData, "npm", "codex.cmd"),
        path.join(localAppData, "Programs", "codex", "codex.exe"),
      ],
      claudeDesktop: [
        path.join(localAppData, "Programs", "Claude", "Claude.exe"),
        path.join(localAppData, "AnthropicClaude", "Claude.exe"),
      ],
      claudeCli: [path.join(appData, "npm", "claude.cmd"), homePath(".local", "bin", "claude.exe")],
    };
  }

  return {
    codexDesktop: [],
    codexCli: ["/usr/local/bin/codex", homePath(".local", "bin", "codex")],
    claudeDesktop: [],
    claudeCli: ["/usr/local/bin/claude", homePath(".local", "bin", "claude")],
  };
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
        /\\ChatGPT\.exe(?:\s|$)/i,
        /(?:^|\s)(?:[A-Za-z]:\\[^\s"]*\\|\/[^\s"]*\/)?codex(?:\.exe)?(?:\s|$)/i,
      ]
    : [
        /\/Claude\.app\/Contents\/MacOS\/Claude(?:\s|$)/i,
        /\\Claude\.exe(?:\s|$)/i,
        /(?:^|\s)(?:[A-Za-z]:\\[^\s"]*\\|\/[^\s"]*\/)?claude(?:\.exe)?(?:\s|$)/i,
      ];
  return processes
    .filter((item) => patterns.some((pattern) => pattern.test(item.command)))
    .map((item) => ({ ...item, command: item.command.slice(0, 240) }))
    .slice(0, 12);
}

async function collectFiles(root, extension) {
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

  return results.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_SESSION_FILES);
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

function hasPendingCodexConfirmation(lines) {
  const responseItems = lines.filter((line) => line.type === "response_item");
  const answeredCalls = new Set(responseItems
    .filter((line) => ["function_call_output", "custom_tool_call_output"].includes(line.payload?.type))
    .map((line) => line.payload?.call_id)
    .filter(Boolean));

  return responseItems.some((line) => {
    const payload = line.payload || {};
    if (!payload.call_id || answeredCalls.has(payload.call_id)) return false;
    if (payload.type === "function_call" && payload.name === "request_user_input") return true;
    if (payload.type !== "custom_tool_call") return false;
    return payload.name === "exec"
      && String(payload.input || "").includes("require_escalated")
      && String(payload.input || "").includes("sandbox_permissions");
  });
}

function parseCodexSession(fileInfo, lines, processRunning) {
  const metadata = lines.find((line) => line.type === "session_meta")?.payload || {};
  const contexts = lines.filter((line) => line.type === "turn_context");
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
  const freshness = Date.now() - fileInfo.mtimeMs;
  const waitingForConfirmation = hasPendingCodexConfirmation(lines);
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
    cwd: metadata.cwd || contexts.at(-1)?.payload?.cwd || null,
    model: contexts.at(-1)?.payload?.model || metadata.model || null,
    effort: contexts.at(-1)?.payload?.effort || null,
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
    internal: typeof metadata.thread_source === "object"
      && String(userMessage || "").startsWith("The following is the Codex agent history whose request action you are assessing."),
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
    if (line.type === "queue-operation") {
      if (["enqueue", "dequeue"].includes(line.operation)) active = true;
      continue;
    }

    if (line.type === "user") {
      active = true;
      continue;
    }

    if (line.type === "assistant") {
      const stopReason = line.message?.stop_reason;
      active = !["end_turn", "stop_sequence", "max_tokens", "refusal"].includes(stopReason);
      continue;
    }

    if (line.type === "system" && line.subtype === "turn_duration") active = false;
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

function parseClaudeSession(fileInfo, lines, activeAgents) {
  const meaningful = lines.filter((line) => !line.isSidechain);
  const firstUser = meaningful.find((line) => line.type === "user" && !line.sourceToolAssistantUUID);
  const title = latestValue(meaningful, (line) => line.type === "ai-title" ? line.aiTitle : undefined);
  const assistants = meaningful.filter((line) => line.type === "assistant");
  const latestAssistant = assistants.at(-1);
  const latestContent = latestValue(meaningful, (line) => {
    if (!["user", "assistant"].includes(line.type)) return undefined;
    return messageText(line.message) || undefined;
  });
  const id = latestValue(meaningful, (line) => line.sessionId || line.session_id) || path.basename(fileInfo.path, ".jsonl");
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
  const active = Boolean(agent);
  const waitingForConfirmation = active && (agentIsWaiting(agent) || hasPendingClaudeQuestion(meaningful));
  const turnIsActive = active && claudeTurnIsActive(meaningful);

  return {
    id,
    title: shorten(title || messageText(firstUser?.message), path.basename(cwd || fileInfo.path)),
    latestContent: shorten(latestContent, title || messageText(firstUser?.message) || path.basename(cwd || fileInfo.path)),
    cwd: cwd || null,
    model: latestAssistant?.message?.model || null,
    effort: latestAssistant?.effort || null,
    status: waitingForConfirmation ? "waiting" : turnIsActive ? "running" : "idle",
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

async function collectCodex(processes, candidates) {
  const codexHome = process.env.CODEX_HOME || homePath(".codex");
  const [desktopPath, cliPath, files] = await Promise.all([
    firstExisting(candidates.codexDesktop),
    findExecutable("codex", candidates.codexCli),
    collectFiles(path.join(codexHome, "sessions"), ".jsonl"),
  ]);
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
    installed: Boolean(desktopPath || cliPath),
    running: runningProcesses.length > 0,
    desktopPath,
    cliPath,
    dataHome: (await exists(codexHome)) ? codexHome : null,
    processes: runningProcesses,
    sessions,
    totals,
    stats: null,
    errors: [],
  };
}

async function collectClaude(processes, candidates) {
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || homePath(".claude");
  const [desktopPath, cliPath, files, stats] = await Promise.all([
    firstExisting(candidates.claudeDesktop),
    findExecutable("claude", candidates.claudeCli),
    collectFiles(path.join(claudeHome, "projects"), ".jsonl"),
    readClaudeStats(claudeHome),
  ]);
  const agents = await readClaudeAgents(cliPath);
  const activeAgents = new Map(agents
    .map((agent) => [agent.sessionId || agent.session_id || agent.id, agent])
    .filter(([id]) => Boolean(id)));
  const runningProcesses = matchingProcesses(processes, "claude");
  const mainSessionFiles = files.filter((file) => !file.path.includes(`${path.sep}subagents${path.sep}`));
  const sessions = await Promise.all(mainSessionFiles.map(async (file) => parseClaudeSession(file, await readJsonLines(file), activeAgents)));
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
    installed: Boolean(desktopPath || cliPath),
    running: runningProcesses.length > 0,
    desktopPath,
    cliPath,
    dataHome: (await exists(claudeHome)) ? claudeHome : null,
    processes: runningProcesses,
    sessions,
    agents,
    totals: { ...sessionTotals, totalCostUsd },
    stats,
    errors: [],
  };
}

async function buildSnapshot() {
  const candidates = platformCandidates();
  const processes = await listProcesses();
  const [codex, claude] = await Promise.all([
    collectCodex(processes, candidates),
    collectClaude(processes, candidates),
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

function notifyMiniVisibility() {
  const visible = Boolean(miniWindow && !miniWindow.isDestroyed() && miniWindow.isVisible());
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("monitor:mini-visibility", visible);
  }
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#f4f6f8",
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
}

function createMiniWindow() {
  const workArea = screen.getPrimaryDisplay().workArea;
  miniWindow = new BrowserWindow({
    width: 390,
    height: 320,
    minWidth: 340,
    minHeight: 220,
    x: Math.max(workArea.x, workArea.x + workArea.width - 414),
    y: workArea.y + 24,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: "#f8faf7",
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

  miniWindow.on("show", notifyMiniVisibility);
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

ipcMain.handle("monitor:get-snapshot", () => refreshSnapshot());
ipcMain.handle("monitor:get-runtime", () => ({ platform: process.platform, packaged: app.isPackaged }));
ipcMain.handle("monitor:get-mini-state", () => ({
  visible: Boolean(miniWindow && !miniWindow.isDestroyed() && miniWindow.isVisible()),
}));
ipcMain.handle("monitor:toggle-mini", () => {
  if (!miniWindow || miniWindow.isDestroyed()) {
    createMiniWindow().showInactive();
    notifyMiniVisibility();
    return { visible: true };
  }
  if (miniWindow.isVisible()) miniWindow.hide();
  else miniWindow.showInactive();
  notifyMiniVisibility();
  return { visible: miniWindow.isVisible() };
});
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

  if (provider.desktopPath) {
    const deepLink = providerId === "codex"
      ? `codex://threads/${encodeURIComponent(session.id)}`
      : `claude://resume?session=${encodeURIComponent(session.id)}`;
    try {
      await shell.openExternal(deepLink);
      return { ok: true, method: "desktop" };
    } catch {
      // Fall through to the documented CLI resume command.
    }
  }

  return launchCliSession(provider, session);
});

app.whenReady().then(async () => {
  if (process.argv.includes("--snapshot-json")) {
    const snapshot = await buildSnapshot();
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    app.quit();
    return;
  }

  createWindow();
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
});

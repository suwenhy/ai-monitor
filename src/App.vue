<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  Activity,
  AppWindow,
  BadgeDollarSign,
  Braces,
  CircleOff,
  CirclePause,
  Database,
  Eye,
  EyeOff,
  FileJson2,
  FlaskConical,
  FolderOpen,
  Gauge,
  HardDrive,
  Inbox,
  MessageSquareText,
  Monitor,
  Moon,
  PictureInPicture2,
  Radio,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Sun,
  TerminalSquare,
  TriangleAlert,
} from "@lucide/vue";
import { mockSnapshot } from "./mock";
import claudePixel from "./assets/claude-prompt-pixel.svg";
import codexPixel from "./assets/codex-console-pixel.svg";
import stylesHref from "./styles.css?url";

if (!document.querySelector('link[data-ai-monitor-style="main"]')) {
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = stylesHref;
  stylesheet.dataset.aiMonitorStyle = "main";
  document.head.append(stylesheet);
}

const snapshot = ref(null);
const loading = ref(true);
const now = ref(Date.now());
const filter = ref("all");
const refreshRotation = ref(0);
const isPreview = !window.aiMonitor;
const overviewVisible = ref(localStorage.getItem("ai-monitor-overview") !== "hidden");
const miniVisible = ref(false);
const openingSessionId = ref(null);
const sessionNotice = ref(null);
const theme = ref(
  localStorage.getItem("ai-monitor-theme")
    || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
);
let unsubscribe = null;
let unsubscribeMiniVisibility = null;
let noticeTimer = null;
let clockTimer = null;

watch(theme, (value) => {
  document.documentElement.dataset.theme = value;
  localStorage.setItem("ai-monitor-theme", value);
}, { immediate: true });

watch(overviewVisible, (value) => {
  localStorage.setItem("ai-monitor-overview", value ? "visible" : "hidden");
});

const statusLabels = {
  running: "进行中",
  waiting: "等待授权",
  idle: "空闲",
  completed: "已完成",
  failed: "异常",
  unknown: "未知",
};

const providers = computed(() => snapshot.value ? [snapshot.value.codex, snapshot.value.claude] : []);
const onlineCount = computed(() => providers.value.filter((provider) => provider.running).length);
const installedCount = computed(() => providers.value.filter((provider) => provider.installed).length);
const activeCount = computed(() => providers.value
  .flatMap((provider) => provider.sessions)
  .filter((session) => ["running", "waiting"].includes(session.status)).length);
const totalTokens = computed(() => providers.value.reduce((sum, provider) => sum + provider.totals.totalTokens, 0));

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(value || 0);
}

function formatTokens(value) {
  if (!value) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return String(value);
}

function formatMoney(value) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value || 0);
}

function relativeTime(iso) {
  const seconds = Math.max(0, Math.floor((now.value - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function platformName(platform) {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  return platform;
}

function shortPath(value) {
  if (!value) return "未检测到";
  const parts = value.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 4) return value;
  return `${value.startsWith("/") ? "/" : ""}${parts[0]}/.../${parts.slice(-2).join("/")}`;
}

function visibleSessions(provider) {
  if (filter.value === "all") return provider.sessions;
  return provider.sessions.filter((session) => ["running", "waiting"].includes(session.status));
}

function providerMeta(provider) {
  return provider.id === "claude"
    ? { icon: claudePixel, subtitle: "Desktop · Code · Background agents" }
    : { icon: codexPixel, subtitle: "Desktop · CLI · App Server" };
}

function toggleTheme() {
  theme.value = theme.value === "dark" ? "light" : "dark";
}

function toggleOverview() {
  overviewVisible.value = !overviewVisible.value;
}

async function toggleMiniWindow() {
  if (!window.aiMonitor) {
    window.open(`${window.location.origin}${window.location.pathname}?view=mini`, "ai-monitor-mini", "popup,width=390,height=320");
    return;
  }
  const result = await window.aiMonitor.toggleMiniWindow();
  miniVisible.value = Boolean(result?.visible);
}

function showNotice(text, type = "info") {
  if (noticeTimer) clearTimeout(noticeTimer);
  sessionNotice.value = { text, type };
  noticeTimer = setTimeout(() => {
    sessionNotice.value = null;
  }, 3200);
}

function installationItems(provider) {
  return [
    { label: "Desktop", path: provider.desktopPath, icon: AppWindow },
    { label: "CLI", path: provider.cliPath, icon: TerminalSquare },
    { label: "数据目录", path: provider.dataHome, icon: Database },
  ];
}

function providerMetrics(provider) {
  const isClaude = provider.id === "claude";
  const currentActive = provider.sessions.filter((session) => ["running", "waiting"].includes(session.status)).length;
  const sessionStat = isClaude && provider.stats
    ? `${formatNumber(provider.stats.totalSessions)} 历史会话`
    : `${provider.sessions.length} 个最近会话`;
  return [
    { label: "活动会话", value: String(currentActive), helper: sessionStat, icon: Activity },
    { label: "本地 Token", value: formatTokens(provider.totals.totalTokens), helper: `缓存 ${formatTokens(provider.totals.cachedInputTokens)}`, icon: Braces },
    {
      label: isClaude ? "历史成本" : "输出 Token",
      value: isClaude ? formatMoney(provider.totals.totalCostUsd) : formatTokens(provider.totals.outputTokens),
      helper: isClaude ? "Claude 本地估算" : "最近会话累计",
      icon: isClaude ? BadgeDollarSign : MessageSquareText,
    },
    {
      label: "运行状态",
      value: provider.running ? "在线" : "离线",
      helper: provider.processes.length ? `${provider.processes.length} 个核心进程` : "未发现相关进程",
      icon: provider.running ? Radio : CircleOff,
    },
    providerAllowance(provider),
  ];
}

function numberFrom(value, ...keys) {
  for (const key of keys) {
    const raw = value?.[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const number = Number(raw);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function providerAllowance(provider) {
  if (provider.id === "claude" && provider.planUsage) {
    const fiveHourRemaining = numberFrom(provider.planUsage.windows?.fiveHour, "remainingPercent");
    const sevenDayRemaining = numberFrom(provider.planUsage.windows?.sevenDay, "remainingPercent");
    const primaryRemaining = sevenDayRemaining ?? fiveHourRemaining;
    const sampledAt = provider.planUsage.sampledAt
      ? relativeTime(provider.planUsage.sampledAt)
      : null;
    return {
      label: "套餐剩余",
      value: primaryRemaining === null ? "--" : `${Math.round(primaryRemaining)}%`,
      helper: sevenDayRemaining === null ? "7 天用量未提供" : "7 天全部模型",
      account: fiveHourRemaining === null
        ? (sampledAt ? `${sampledAt}采样` : "5 小时用量未提供")
        : `5 小时剩余 ${Math.round(fiveHourRemaining)}%${provider.planUsage.stale ? " · 历史样本" : ""}`,
      icon: Gauge,
      progress: primaryRemaining,
    };
  }

  const current = provider.sessions.find((session) => ["running", "waiting"].includes(session.status))
    || provider.sessions[0];
  const contextWindow = Number(current?.usage?.contextWindow) || 0;
  const contextUsed = Number(current?.usage?.contextTokens ?? current?.usage?.inputTokens) || 0;
  const remainingTokens = contextWindow ? Math.max(0, contextWindow - contextUsed) : null;
  const contextRemainingPercent = remainingTokens === null
    ? null
    : Math.round((remainingTokens / contextWindow) * 100);

  let accountRemainingPercent = null;
  for (const session of provider.sessions) {
    const limits = session.rateLimits;
    const window = limits?.primary || limits?.secondary;
    const usedPercent = numberFrom(window, "usedPercent", "used_percent");
    if (usedPercent !== null) {
      accountRemainingPercent = Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
      break;
    }
  }

  return {
    label: "剩余 Token",
    value: remainingTokens === null ? "--" : formatTokens(remainingTokens),
    helper: contextRemainingPercent === null ? "上下文未提供" : `上下文剩余 ${contextRemainingPercent}%`,
    account: accountRemainingPercent === null ? "账号未提供" : `账号剩余 ${accountRemainingPercent}%`,
    icon: Gauge,
    progress: accountRemainingPercent ?? contextRemainingPercent,
  };
}

function contextPercent(session) {
  if (!session.usage.contextWindow) return null;
  const usedTokens = session.usage.contextTokens ?? session.usage.inputTokens;
  return Math.min(100, Math.round((usedTokens / session.usage.contextWindow) * 100));
}

function overviewTitle() {
  if (onlineCount.value === 2) return "两个桌面代理均在线";
  if (onlineCount.value === 1) return "一个桌面代理在线";
  return "桌面代理当前离线";
}

async function openPath(targetPath) {
  if (targetPath && window.aiMonitor) await window.aiMonitor.openPath(targetPath);
}

async function openSession(provider, session) {
  if (openingSessionId.value) return;
  if (!window.aiMonitor) {
    showNotice("界面预览未连接桌面客户端");
    return;
  }

  openingSessionId.value = session.id;
  try {
    const result = await window.aiMonitor.openSession(provider.id, session.id);
    if (result?.ok) {
      if (result.method === "desktop-activate" && result.exact === false) {
        showNotice("已打开 Claude Desktop；当前版本暂不支持从外部定位原生 Code 会话");
      } else {
        const destination = result.method === "cli"
          ? `${provider.id === "claude" ? "Claude" : "Codex"} CLI`
          : provider.label;
        showNotice(`已在 ${destination} 打开会话`, "success");
      }
    } else {
      showNotice(result?.error || "无法打开该会话", "error");
    }
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "无法打开该会话", "error");
  } finally {
    openingSessionId.value = null;
  }
}

async function refresh(manual = false) {
  if (manual) refreshRotation.value += 360;
  try {
    snapshot.value = window.aiMonitor
      ? await window.aiMonitor.getSnapshot()
      : { ...mockSnapshot, refreshedAt: new Date().toISOString() };
  } catch (error) {
    if (snapshot.value) {
      snapshot.value = {
        ...snapshot.value,
        fatalError: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  clockTimer = setInterval(() => {
    now.value = Date.now();
  }, 1_000);
  unsubscribe = window.aiMonitor?.subscribe((nextSnapshot) => {
    snapshot.value = nextSnapshot;
    loading.value = false;
  });
  unsubscribeMiniVisibility = window.aiMonitor?.subscribeMiniVisibility((visible) => {
    miniVisible.value = Boolean(visible);
  });
  refresh();
  if (window.aiMonitor) {
    try {
      const miniState = await window.aiMonitor.getMiniWindowState();
      miniVisible.value = Boolean(miniState?.visible);
    } catch {
      miniVisible.value = false;
    }
  }
});

onUnmounted(() => {
  unsubscribe?.();
  unsubscribeMiniVisibility?.();
  if (noticeTimer) clearTimeout(noticeTimer);
  if (clockTimer) clearInterval(clockTimer);
});
</script>

<template>
  <div v-if="loading || !snapshot" class="loading-screen">
    <span class="loading-mark"><ScanLine /></span>
    <strong>正在读取本机 AI 状态</strong>
    <span>扫描安装位置、进程与最近会话</span>
  </div>

  <div v-else class="app-shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"><span class="brand-screen"></span></span>
        <div>
          <h1>AI Monitor</h1>
          <p>LOCAL AGENT CONSOLE</p>
        </div>
      </div>
      <div class="top-actions">
        <span v-if="isPreview" class="preview-label"><FlaskConical />界面预览</span>
        <span class="machine-label"><Monitor />{{ platformName(snapshot.platform) }} · {{ snapshot.arch }}</span>
        <span class="auto-refresh"><span class="pulse-dot"></span>每 3 秒刷新</span>
        <button
          class="icon-button mini-window-button"
          :class="{ active: miniVisible }"
          :aria-label="miniVisible ? '隐藏活动任务浮窗' : '显示活动任务浮窗'"
          :title="miniVisible ? '隐藏活动任务浮窗' : '显示活动任务浮窗'"
          @click="toggleMiniWindow"
        >
          <PictureInPicture2 />
        </button>
        <button
          class="icon-button overview-button"
          :aria-label="overviewVisible ? '隐藏状态概览' : '显示状态概览'"
          :title="overviewVisible ? '隐藏状态概览' : '显示状态概览'"
          @click="toggleOverview"
        >
          <EyeOff v-if="overviewVisible" />
          <Eye v-else />
        </button>
        <button
          class="icon-button theme-button"
          :aria-label="theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'"
          :title="theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'"
          @click="toggleTheme"
        >
          <Sun v-if="theme === 'dark'" />
          <Moon v-else />
        </button>
        <button
          class="icon-button refresh-button"
          :style="{ '--rotation': `${refreshRotation}deg` }"
          aria-label="立即刷新"
          title="立即刷新"
          @click="refresh(true)"
        >
          <RefreshCw />
        </button>
      </div>
    </header>

    <main>
      <Transition name="overview-fold">
        <section v-if="overviewVisible" class="overview" aria-label="全局概览">
          <div class="overview-copy">
            <span class="eyebrow">{{ snapshot.hostname }}</span>
            <h2>{{ overviewTitle() }}</h2>
            <p>安装目录、进程和本地会话均由当前设备直接读取。</p>
          </div>
          <div class="overview-stats">
            <div><strong>{{ onlineCount }}/{{ installedCount || 2 }}</strong><span>在线 / 已安装</span></div>
            <div><strong>{{ activeCount }}</strong><span>活动会话</span></div>
            <div><strong>{{ formatTokens(totalTokens) }}</strong><span>本地累计 Token</span></div>
            <div>
              <strong>{{ new Date(snapshot.refreshedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) }}</strong>
              <span>最后刷新</span>
            </div>
          </div>
        </section>
      </Transition>

      <div v-if="snapshot.fatalError" class="error-banner">
        <TriangleAlert />
        <span>{{ snapshot.fatalError }}</span>
      </div>

      <div class="workspace-toolbar">
        <div class="segmented" aria-label="会话筛选">
          <button :class="{ selected: filter === 'all' }" @click="filter = 'all'">全部会话</button>
          <button :class="{ selected: filter === 'active' }" @click="filter = 'active'">仅活动</button>
        </div>
        <span class="privacy-note"><ShieldCheck />只读本地数据，不上传会话内容</span>
      </div>

      <div class="provider-grid">
        <section
          v-for="provider in providers"
          :key="provider.id"
          class="provider"
          :class="`provider-${provider.id}`"
          :aria-labelledby="`${provider.id}-title`"
        >
          <div class="provider-heading">
            <span class="provider-mark" aria-hidden="true">
              <img :src="providerMeta(provider).icon" alt="" />
            </span>
            <div class="provider-head-body">
              <div class="provider-title-row">
                <div>
                  <h2 :id="`${provider.id}-title`">{{ provider.label }}</h2>
                  <p>{{ providerMeta(provider).subtitle }}</p>
                </div>
                <div class="provider-badges">
                  <span class="badge" :class="provider.installed ? 'badge-ok' : 'badge-off'">
                    <HardDrive />{{ provider.installed ? "已安装" : "未安装" }}
                  </span>
                  <span class="badge" :class="provider.running ? 'badge-live' : 'badge-off'">
                    <span class="pulse-dot"></span>{{ provider.running ? "运行中" : "未运行" }}
                  </span>
                </div>
              </div>

              <div class="provider-metrics">
                <div v-for="metric in providerMetrics(provider)" :key="metric.label" class="provider-metric">
                  <div class="metric-label"><component :is="metric.icon" />{{ metric.label }}</div>
                  <strong>{{ metric.value }}</strong>
                  <span>{{ metric.helper }}</span>
                  <span v-if="metric.account" class="metric-account">{{ metric.account }}</span>
                  <span v-if="metric.progress !== undefined && metric.progress !== null" class="metric-progress" aria-hidden="true">
                    <i :style="{ width: `${metric.progress}%` }"></i>
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div class="install-block" aria-label="安装位置">
            <div v-for="item in installationItems(provider)" :key="item.label" class="install-row">
              <span class="install-icon"><component :is="item.icon" /></span>
              <span class="install-name">{{ item.label }}</span>
              <span class="install-path" :class="{ muted: !item.path }" :title="item.path || ''">{{ shortPath(item.path) }}</span>
              <button
                v-if="item.path"
                class="icon-button path-button"
                :aria-label="`打开 ${item.label}`"
                title="打开位置"
                @click="openPath(item.path)"
              >
                <FolderOpen />
              </button>
              <span v-else class="missing-mark">--</span>
            </div>
          </div>

          <div class="sessions-heading">
            <div>
              <h3>最近会话</h3>
              <span>{{ filter === "active" ? "仅显示活动状态" : "按本地更新时间排序" }}</span>
            </div>
            <span class="session-count">{{ visibleSessions(provider).length }}</span>
          </div>

          <div class="session-columns" aria-hidden="true">
            <span>状态</span><span>会话 / 工作目录</span><span>模型</span><span>用量</span><span>更新时间</span><span></span>
          </div>

          <div class="session-list">
            <div
              v-for="session in visibleSessions(provider)"
              :key="session.id"
              class="session-row"
              :class="{ 'is-opening': openingSessionId === session.id }"
            >
              <button
                class="session-open-button"
                :aria-busy="openingSessionId === session.id"
                :aria-label="`在 ${provider.label} 打开会话：${session.title}`"
                :title="`在 ${provider.label} 打开会话`"
                @click="openSession(provider, session)"
              ></button>
              <div class="session-state">
                <span class="session-status" :class="`status-${session.status}`">
                  <span class="status-dot"></span>{{ statusLabels[session.status] || statusLabels.unknown }}
                </span>
              </div>
              <div class="session-main">
                <div class="session-title" :title="session.title">{{ session.title }}</div>
                <div class="session-path" :title="session.cwd || ''">{{ shortPath(session.cwd) }}</div>
              </div>
              <div class="session-model">
                <span>{{ session.model || "未知模型" }}</span>
                <small v-if="session.effort">{{ session.effort }}</small>
              </div>
              <div class="session-usage">
                <span>{{ formatTokens(session.usage.totalTokens) }}</span>
                <small v-if="contextPercent(session) === null">累计 Token</small>
                <small v-else>上下文 {{ contextPercent(session) }}%</small>
              </div>
              <time class="session-time" :datetime="session.updatedAt">{{ relativeTime(session.updatedAt) }}</time>
              <button class="icon-button transcript-button" aria-label="打开会话记录" title="打开会话记录" @click.stop="openPath(session.transcriptPath)">
                <FileJson2 />
              </button>
            </div>

            <div v-if="!visibleSessions(provider).length" class="empty-state">
              <CirclePause v-if="filter === 'active' && provider.sessions.length" />
              <Inbox v-else />
              <strong>{{ filter === "active" && provider.sessions.length ? "当前没有活动会话" : "还没有发现本地会话" }}</strong>
              <span>
                {{ filter === "active" && provider.sessions.length
                  ? "切换到全部会话查看最近记录"
                  : `确认 ${provider.id === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"} 指向正确的数据目录` }}
              </span>
            </div>
          </div>
        </section>
      </div>
    </main>

    <footer>
      <span><HardDrive />数据保留在本机</span>
      <span>AI Monitor 0.1.0</span>
    </footer>

    <Transition name="notice-pop">
      <div v-if="sessionNotice" class="session-notice" :class="`notice-${sessionNotice.type}`" role="status">
        {{ sessionNotice.text }}
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { AlertTriangle, Check, ExternalLink, LoaderCircle, X } from "@lucide/vue";
import { mockSnapshot } from "./mock";
import claudePixel from "./assets/claude-prompt-pixel.svg";
import codexPixel from "./assets/codex-console-pixel.svg";
import miniStylesHref from "./mini-styles.css?url";

if (!document.querySelector('link[data-ai-monitor-style="mini"]')) {
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = miniStylesHref;
  stylesheet.dataset.aiMonitorStyle = "mini";
  document.head.append(stylesheet);
}

const snapshot = ref(null);
const loading = ref(true);
const now = ref(Date.now());
const openingSessionId = ref(null);
const activeAlert = ref(null);
const recentSessions = ref([]);
const alertQueue = [];
const recentSessionTimers = new Map();
const RECENT_SESSION_DURATION_MS = 60_000;
const ALLOWANCE_VISIBILITY_KEY = "ai-monitor-mini-allowances";
const allowanceToggles = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude" },
];
const theme = ref(
  localStorage.getItem("ai-monitor-theme")
    || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
);
const allowanceVisibility = ref(readAllowanceVisibility());
let unsubscribe = null;
let unsubscribeAlerts = null;
let alertTimer = null;
let clockTimer = null;

watch(theme, (value) => {
  document.documentElement.dataset.theme = value;
}, { immediate: true });

watch(allowanceVisibility, (value) => {
  localStorage.setItem(ALLOWANCE_VISIBILITY_KEY, JSON.stringify(value));
}, { deep: true });

const activeSessions = computed(() => {
  if (!snapshot.value) return [];
  return [snapshot.value.codex, snapshot.value.claude]
    .flatMap((provider) => provider.sessions
      .filter((session) => ["running", "waiting"].includes(session.status))
      .map((session) => ({ provider, session })))
    .sort((a, b) => {
      if (a.session.status !== b.session.status) return a.session.status === "waiting" ? -1 : 1;
      return new Date(b.session.updatedAt) - new Date(a.session.updatedAt);
    });
});

const displayedSessions = computed(() => {
  const activeKeys = new Set(activeSessions.value
    .map(({ provider, session }) => `${provider.id}:${session.id}`));
  const recent = recentSessions.value
    .filter(({ provider, session }) => !activeKeys.has(`${provider.id}:${session.id}`));
  return [...recent, ...activeSessions.value];
});

const accountAllowances = computed(() => {
  if (!snapshot.value) return [];
  return [snapshot.value.codex, snapshot.value.claude]
    .filter(Boolean)
    .map((provider) => providerAllowance(provider));
});

const visibleAllowances = computed(() => accountAllowances.value
  .filter((allowance) => allowanceVisibility.value[allowance.id]));

const alertIcon = computed(() => {
  if (activeAlert.value?.type === "complete") return Check;
  if (activeAlert.value?.type === "waiting" || activeAlert.value?.type === "failed") return AlertTriangle;
  return LoaderCircle;
});

function providerIcon(providerId) {
  return providerId === "claude" ? claudePixel : codexPixel;
}

function readAllowanceVisibility() {
  try {
    const stored = JSON.parse(localStorage.getItem(ALLOWANCE_VISIBILITY_KEY));
    return {
      codex: stored?.codex !== false,
      claude: stored?.claude !== false,
    };
  } catch {
    return { codex: true, claude: true };
  }
}

function toggleAllowance(providerId) {
  allowanceVisibility.value[providerId] = !allowanceVisibility.value[providerId];
}

function formatTokens(value) {
  if (!value) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return String(value);
}

function finiteNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function usedPercent(limit) {
  const used = finiteNumber(limit?.usedPercent ?? limit?.used_percent);
  if (used !== null) return Math.max(0, Math.min(100, used));
  const remaining = finiteNumber(limit?.remainingPercent ?? limit?.remaining_percent);
  return remaining === null ? null : Math.max(0, Math.min(100, 100 - remaining));
}

function limitResetAt(limit) {
  const raw = limit?.resetsAt ?? limit?.resets_at ?? limit?.resetAt ?? limit?.reset_at;
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "number" || /^\d+(\.\d+)?$/.test(String(raw))) {
    const timestamp = Number(raw);
    const date = new Date(timestamp < 1_000_000_000_000 ? timestamp * 1_000 : timestamp);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function providerAllowance(provider) {
  if (provider.id === "claude") {
    const sevenDay = provider.planUsage?.windows?.sevenDay;
    const fiveHour = provider.planUsage?.windows?.fiveHour;
    const window = fiveHour || sevenDay;
    const used = usedPercent(window);
    return {
      id: provider.id,
      label: "CLAUDE",
      used,
      detail: fiveHour ? "5 小时已用" : sevenDay ? "7 天已用" : "账号用量未提供",
      resetAt: limitResetAt(window),
      stale: Boolean(provider.planUsage?.stale),
    };
  }

  const limits = (provider.sessions || []).flatMap((session) => [
    session.rateLimits?.primary,
    session.rateLimits?.secondary,
  ]).filter(Boolean);
  const fiveHour = limits.find((limit) => (
    finiteNumber(limit?.windowMinutes ?? limit?.window_minutes) === 5 * 60
  ));
  const sevenDay = limits.find((limit) => (
    finiteNumber(limit?.windowMinutes ?? limit?.window_minutes) === 7 * 24 * 60
  ));
  const limit = fiveHour || sevenDay || limits[0];
  const used = usedPercent(limit);
  const windowMinutes = finiteNumber(limit?.windowMinutes ?? limit?.window_minutes);
  const detail = fiveHour
    ? "5 小时已用"
    : sevenDay
      ? "7 天已用"
      : windowMinutes
        ? `${Math.round(windowMinutes / 60)} 小时已用`
        : "账号用量未提供";
  return {
    id: provider.id,
    label: "CODEX",
    used,
    detail,
    resetAt: limitResetAt(limit),
    stale: false,
  };
}

function formatResetTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function relativeTime(iso) {
  const seconds = Math.max(0, Math.floor((now.value - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`;
}

function showNextAlert() {
  if (activeAlert.value || !alertQueue.length) return;
  activeAlert.value = alertQueue.shift();
  const duration = activeAlert.value.type === "complete" ? 4200 : 6000;
  alertTimer = setTimeout(() => {
    activeAlert.value = null;
    alertTimer = null;
    showNextAlert();
  }, duration);
}

function queueAlert(alert) {
  if (!alert?.type) return;
  if (["complete", "failed"].includes(alert.type) && alert.session) {
    retainResolvedSession(alert);
  }
  alertQueue.push(alert);
  showNextAlert();
}

function retainResolvedSession(alert) {
  const provider = [snapshot.value?.codex, snapshot.value?.claude]
    .find((item) => item?.id === alert.providerId)
    || { id: alert.providerId, label: alert.providerLabel };
  const key = `${provider.id}:${alert.session.id}`;
  const status = alert.type === "failed" ? "failed" : "complete";
  const retained = {
    provider,
    session: {
      ...alert.session,
      status,
      updatedAt: new Date().toISOString(),
    },
  };

  recentSessions.value = [
    retained,
    ...recentSessions.value.filter(({ provider: itemProvider, session }) => (
      `${itemProvider.id}:${session.id}` !== key
    )),
  ];

  if (recentSessionTimers.has(key)) clearTimeout(recentSessionTimers.get(key));
  recentSessionTimers.set(key, setTimeout(() => {
    recentSessions.value = recentSessions.value
      .filter(({ provider: itemProvider, session }) => `${itemProvider.id}:${session.id}` !== key);
    recentSessionTimers.delete(key);
  }, RECENT_SESSION_DURATION_MS));
}

function statusLabel(status) {
  if (status === "waiting") return "等待确认";
  if (status === "complete") return "已完成";
  if (status === "failed") return "运行异常";
  return "运行中";
}

async function openSession(provider, session) {
  if (openingSessionId.value) return;
  if (!window.aiMonitor) {
    queueAlert({ type: "waiting", message: "请在桌面应用中打开会话", title: session.title });
    return;
  }

  openingSessionId.value = session.id;
  try {
    const result = await window.aiMonitor.openSession(provider.id, session.id);
    if (!result?.ok) queueAlert({ type: "failed", message: result?.error || "无法打开会话", title: session.title });
  } catch (error) {
    queueAlert({ type: "failed", message: error instanceof Error ? error.message : "无法打开会话", title: session.title });
  } finally {
    openingSessionId.value = null;
  }
}

function closeMiniWindow() {
  if (window.aiMonitor) window.aiMonitor.closeMiniWindow();
  else window.close();
}

function syncTheme(event) {
  if (event.key === "ai-monitor-theme" && ["light", "dark"].includes(event.newValue)) {
    theme.value = event.newValue;
  }
}

async function refresh() {
  try {
    snapshot.value = window.aiMonitor
      ? await window.aiMonitor.getSnapshot()
      : { ...mockSnapshot, refreshedAt: new Date().toISOString() };
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  clockTimer = setInterval(() => {
    now.value = Date.now();
  }, 1_000);
  window.addEventListener("storage", syncTheme);
  unsubscribe = window.aiMonitor?.subscribe((nextSnapshot) => {
    snapshot.value = nextSnapshot;
    loading.value = false;
  });
  unsubscribeAlerts = window.aiMonitor?.subscribeMiniAlerts(queueAlert);
  refresh();
});

onUnmounted(() => {
  window.removeEventListener("storage", syncTheme);
  unsubscribe?.();
  unsubscribeAlerts?.();
  if (alertTimer) clearTimeout(alertTimer);
  if (clockTimer) clearInterval(clockTimer);
  for (const timer of recentSessionTimers.values()) clearTimeout(timer);
  recentSessionTimers.clear();
});
</script>

<template>
  <div class="mini-page">
    <section class="mini-shell" :class="activeAlert ? `mini-alerting-${activeAlert.type}` : ''">
      <header class="mini-header">
        <div class="mini-heading">
          <strong>ACTIVE TASKS</strong>
          <span><i class="mini-live-dot"></i>{{ activeSessions.length }} 个进行中</span>
        </div>
        <div class="mini-header-actions">
          <button
            v-for="provider in allowanceToggles"
            :key="provider.id"
            class="mini-allowance-toggle"
            :class="[`mini-provider-${provider.id}`, { 'is-visible': allowanceVisibility[provider.id] }]"
            :aria-label="`${allowanceVisibility[provider.id] ? '隐藏' : '显示'} ${provider.label} 用量`"
            :title="`${allowanceVisibility[provider.id] ? '隐藏' : '显示'} ${provider.label} 用量`"
            :aria-pressed="allowanceVisibility[provider.id]"
            @click="toggleAllowance(provider.id)"
          >
            <img :src="providerIcon(provider.id)" alt="" />
          </button>
          <button class="mini-icon-button" aria-label="隐藏浮窗" title="隐藏浮窗" @click="closeMiniWindow">
            <X />
          </button>
        </div>
      </header>

      <Transition name="mini-alert">
        <div v-if="activeAlert" class="mini-alert-strip" :class="`mini-alert-${activeAlert.type}`" role="status">
          <span class="mini-alert-icon"><component :is="alertIcon" /></span>
          <div>
            <strong>{{ activeAlert.message }}</strong>
            <span>{{ activeAlert.title }}</span>
          </div>
        </div>
      </Transition>

      <section
        v-if="visibleAllowances.length"
        class="mini-allowances"
        :class="{ 'mini-allowances-single': visibleAllowances.length === 1 }"
        aria-label="账号用量"
      >
        <article
          v-for="allowance in visibleAllowances"
          :key="allowance.id"
          class="mini-allowance"
          :class="`mini-provider-${allowance.id}`"
        >
          <div class="mini-allowance-heading">
            <span>{{ allowance.label }}</span>
            <strong>{{ allowance.used === null ? "--" : `${Math.round(allowance.used)}%` }}</strong>
          </div>
          <div class="mini-allowance-track" aria-hidden="true">
            <i :style="{ width: `${allowance.used ?? 0}%` }"></i>
          </div>
          <div class="mini-allowance-meta">
            <span>{{ allowance.detail }}{{ allowance.stale ? " · 历史" : "" }}</span>
            <time v-if="allowance.resetAt" :datetime="allowance.resetAt">
              刷新 {{ formatResetTime(allowance.resetAt) }}
            </time>
          </div>
        </article>
      </section>

      <main class="mini-content">
        <div v-if="loading" class="mini-empty mini-loading">
          <LoaderCircle />
          <strong>正在同步任务</strong>
        </div>

        <TransitionGroup v-else-if="displayedSessions.length" name="mini-list" tag="div" class="mini-session-list">
          <button
            v-for="{ provider, session } in displayedSessions"
            :key="`${provider.id}-${session.id}`"
            class="mini-session"
            :class="[
              `mini-provider-${provider.id}`,
              `mini-session-${session.status}`,
              { 'mini-opening': openingSessionId === session.id },
            ]"
            :aria-label="`在 ${provider.label} 打开会话：${session.title}`"
            @click="openSession(provider, session)"
          >
            <span class="mini-provider-icon"><img :src="providerIcon(provider.id)" alt="" /></span>
            <span class="mini-session-body">
              <span class="mini-session-preview">{{ session.latestContent || session.title }}</span>
              <span class="mini-session-meta">
                <span class="mini-session-status" :class="`mini-status-${session.status}`">
                  <i></i>{{ statusLabel(session.status) }}
                </span>
                <span>{{ session.model || "未知模型" }}</span>
                <span>{{ formatTokens(session.usage.totalTokens) }} Token</span>
              </span>
            </span>
            <span class="mini-session-side">
              <ExternalLink />
              <time :datetime="session.updatedAt">{{ relativeTime(session.updatedAt) }}</time>
            </span>
          </button>
        </TransitionGroup>

        <div v-else class="mini-empty">
          <span class="mini-empty-pixel"><i></i></span>
          <strong>暂无活动任务</strong>
          <span>新任务开始后会显示在这里</span>
        </div>
      </main>

    </section>
  </div>
</template>

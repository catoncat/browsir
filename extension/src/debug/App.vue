<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";

interface SessionIndexEntry {
  id: string;
  updatedAt: string;
}

interface RuntimeResponse<T = any> {
  ok?: boolean;
  data?: T;
  error?: string;
}

async function sendMessage<T = any>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  const out = (await chrome.runtime.sendMessage({ type, ...payload })) as RuntimeResponse<T>;
  if (!out?.ok) throw new Error(out?.error || `${type} failed`);
  return out.data as T;
}

const loading = ref(false);
const error = ref("");
const sessions = ref<SessionIndexEntry[]>([]);
const activeSessionId = ref("");
const stepStream = ref<Array<Record<string, unknown>>>([]);
const debugDump = ref<Record<string, unknown> | null>(null);
const liveEvents = ref<Array<Record<string, unknown>>>([]);
const debugConfig = ref<Record<string, unknown> | null>(null);

function pushLiveEvent(event: Record<string, unknown>) {
  liveEvents.value.unshift(event);
  if (liveEvents.value.length > 120) liveEvents.value.splice(120);
}

const onRuntimeMessage = (message: any) => {
  if (message?.type !== "brain.event" || !message?.event) return;
  pushLiveEvent(message.event);
};

async function refreshSessions() {
  const out = await sendMessage<{ sessions: SessionIndexEntry[] }>("brain.session.list");
  sessions.value = Array.isArray(out.sessions) ? out.sessions : [];
  if (!activeSessionId.value && sessions.value.length > 0) {
    activeSessionId.value = sessions.value[0].id;
  }
}

async function loadSelectedSession() {
  if (!activeSessionId.value) return;
  const [stream, dump] = await Promise.all([
    sendMessage<{ stream: Array<Record<string, unknown>> }>("brain.step.stream", { sessionId: activeSessionId.value }),
    sendMessage<Record<string, unknown>>("brain.debug.dump", { sessionId: activeSessionId.value })
  ]);
  stepStream.value = stream.stream ?? [];
  debugDump.value = dump;
}

async function refreshAll() {
  loading.value = true;
  error.value = "";
  try {
    await refreshSessions();
    debugConfig.value = await sendMessage<Record<string, unknown>>("brain.debug.config");
    await loadSelectedSession();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

function clearEvents() {
  liveEvents.value = [];
}

onMounted(() => {
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  void refreshAll();
});

onUnmounted(() => {
  chrome.runtime.onMessage.removeListener(onRuntimeMessage);
});
</script>

<template>
  <main class="debug-shell">
    <header class="debug-header">
      <h1 class="debug-title">Browser Brain Debug Workspace</h1>
      <div class="actions">
        <button class="btn" :disabled="loading" @click="refreshAll">刷新</button>
        <button class="btn" :disabled="loading || !activeSessionId" @click="loadSelectedSession">拉取当前会话</button>
        <button class="btn ghost" :disabled="loading" @click="clearEvents">清空事件</button>
      </div>
    </header>

    <section class="controls">
      <label>
        <span>会话</span>
        <select v-model="activeSessionId" @change="loadSelectedSession">
          <option value="">请选择会话</option>
          <option v-for="session in sessions" :key="session.id" :value="session.id">
            {{ session.id }} · {{ session.updatedAt }}
          </option>
        </select>
      </label>
    </section>

    <section class="grid">
      <article class="card">
        <h2>Live Events</h2>
        <pre>{{ JSON.stringify(liveEvents, null, 2) }}</pre>
      </article>
      <article class="card">
        <h2>Step Stream</h2>
        <pre>{{ JSON.stringify(stepStream, null, 2) }}</pre>
      </article>
      <article class="card">
        <h2>Debug Config</h2>
        <pre>{{ JSON.stringify(debugConfig, null, 2) }}</pre>
      </article>
      <article class="card">
        <h2>Debug Dump</h2>
        <pre>{{ JSON.stringify(debugDump, null, 2) }}</pre>
      </article>
    </section>

    <p v-if="error" class="error">{{ error }}</p>
  </main>
</template>

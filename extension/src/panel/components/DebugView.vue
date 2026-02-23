<script setup lang="ts">
import { storeToRefs } from "pinia";
import { useRuntimeStore } from "../stores/runtime";
import { X, Server, Radio, Database, Activity, RefreshCw, ArrowLeft } from "lucide-vue-next";

const emit = defineEmits(["close"]);
const store = useRuntimeStore();
const { health, loading } = storeToRefs(store);

async function refresh() {
  await store.refreshHealth();
}
</script>

<template>
  <div class="fixed inset-0 z-[60] bg-ui-bg flex flex-col animate-in fade-in duration-200">
    <!-- Standard Header (Unified) -->
    <header class="h-12 flex items-center px-2 border-b border-ui-border bg-ui-bg shrink-0">
      <button @click="$emit('close')" class="p-2 hover:bg-ui-surface rounded-sm transition-colors text-ui-text-muted">
        <ArrowLeft :size="18" />
      </button>
      <h2 class="ml-2 font-bold text-[14px] text-ui-text tracking-tight">运行调试</h2>
    </header>

    <div class="flex-1 overflow-y-auto p-4 space-y-6">
      <div class="grid grid-cols-1 gap-3">
        <!-- Status Card -->
        <div class="p-3 bg-ui-surface border border-ui-border rounded-sm space-y-2">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2 text-[10px] font-bold text-ui-text-muted uppercase tracking-widest">
              <Server :size="14" />
              Bridge
            </div>
            <span 
              class="w-2 h-2 rounded-full"
              :class="health.bridgeUrl ? 'bg-green-500' : 'bg-red-500'"
            ></span>
          </div>
          <p class="text-[11px] font-mono text-ui-text-muted truncate opacity-70">{{ health.bridgeUrl }}</p>
        </div>

        <div class="p-3 bg-ui-surface border border-ui-border rounded-sm space-y-2">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2 text-[10px] font-bold text-ui-text-muted uppercase tracking-widest">
              <Radio :size="14" />
              Engine
            </div>
            <span 
              class="w-2 h-2 rounded-full"
              :class="health.hasLlmApiKey ? 'bg-green-500' : 'bg-red-500'"
            ></span>
          </div>
          <p class="text-[11px] font-mono text-ui-text-muted truncate opacity-70 uppercase">{{ health.llmModel }}</p>
        </div>
      </div>

      <!-- Protocols -->
      <section class="space-y-3">
        <h3 class="text-[10px] font-bold text-ui-text-muted/50 uppercase tracking-[0.2em] px-1">Active Protocols</h3>
        <div class="space-y-2">
          <div class="flex items-center justify-between p-3 border border-ui-border rounded-sm hover:bg-ui-surface transition-colors">
             <div class="flex items-center gap-3">
               <Database :size="16" class="text-ui-text-muted opacity-40" />
               <span class="text-[13px] font-medium text-ui-text">CDP Runtime</span>
             </div>
             <span class="text-[9px] font-bold text-green-600 bg-green-500/10 px-1.5 py-0.5 rounded-sm uppercase">Ready</span>
          </div>
          <div class="flex items-center justify-between p-3 border border-ui-border rounded-sm hover:bg-ui-surface transition-colors">
             <div class="flex items-center gap-3">
               <Activity :size="16" class="text-ui-text-muted opacity-40" />
               <span class="text-[13px] font-medium text-ui-text">Message Bus</span>
             </div>
             <span class="text-[9px] font-bold text-green-600 bg-green-500/10 px-1.5 py-0.5 rounded-sm uppercase">Active</span>
          </div>
        </div>
      </section>
    </div>

    <footer class="p-4 border-t border-ui-border bg-ui-surface/20">
      <button 
        @click="refresh"
        class="w-full bg-ui-bg border border-ui-border py-2.5 rounded-sm text-[12px] font-bold flex items-center justify-center gap-2 hover:bg-ui-surface transition-all"
        :disabled="loading"
      >
        <RefreshCw class="text-ui-text-muted" :size="16" :class="loading ? 'animate-spin' : ''" />
        RE-SCAN ENVIRONMENT
      </button>
    </footer>
  </div>
</template>

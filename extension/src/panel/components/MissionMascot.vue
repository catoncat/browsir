<script setup lang="ts">
import { computed } from "vue";

type MascotPhase = "thinking" | "tool" | "verify" | "done" | "error";

const props = defineProps<{
  visible: boolean;
  phase: MascotPhase;
  message: string;
}>();

const phaseLabel = computed(() => {
  if (props.phase === "thinking") return "思考中";
  if (props.phase === "tool") return "执行工具";
  if (props.phase === "verify") return "结果校验";
  if (props.phase === "done") return "已完成";
  return "遇到问题";
});
</script>

<template>
  <transition name="mascot-pop">
    <div
      v-if="visible"
      class="mission-mascot pointer-events-none"
      role="status"
      aria-live="polite"
      :aria-label="`任务助手：${message}`"
    >
      <div class="mascot-roamer" :class="`phase-${phase}`">
        <div class="mascot-bubble" :class="`phase-${phase}`">
          <p class="bubble-text">{{ message }}</p>
          <p class="bubble-phase">{{ phaseLabel }}</p>
        </div>

        <div class="mascot-dog" :class="`phase-${phase}`" aria-hidden="true">
          <svg viewBox="0 0 140 140" class="dog-svg">
            <g class="dog-core">
              <path class="dog-ear ear-left" d="M32 72 C26 60, 24 44, 36 34 C48 24, 62 30, 66 44 Z" fill="#b77243" />
              <path class="dog-ear ear-right" d="M108 72 C114 60, 116 44, 104 34 C92 24, 78 30, 74 44 Z" fill="#b77243" />
              <circle cx="70" cy="62" r="30" fill="#f6bd79" />
              <ellipse cx="70" cy="88" rx="32" ry="24" fill="#ebb172" />
              <ellipse cx="70" cy="74" rx="16" ry="12" fill="#fbe1bd" />
              <circle cx="58" cy="60" r="3.4" fill="#212121" />
              <circle cx="82" cy="60" r="3.4" fill="#212121" />
              <circle cx="70" cy="67" r="4.4" fill="#3a2a20" />
              <path d="M60 75 Q70 84 80 75" fill="none" stroke="#5a3d2a" stroke-width="2.3" stroke-linecap="round" />
              <path class="dog-tail" d="M102 92 Q124 82 116 66" fill="none" stroke="#c9854f" stroke-width="6" stroke-linecap="round" />
              <path class="dog-paw paw-left" d="M50 104 q-8 3 -8 11" fill="none" stroke="#c9854f" stroke-width="5" stroke-linecap="round" />
              <path class="dog-paw paw-right" d="M88 104 q10 2 10 10" fill="none" stroke="#c9854f" stroke-width="5" stroke-linecap="round" />
            </g>

            <g class="thought-dots">
              <circle class="thought-dot dot-1" cx="103" cy="26" r="3" />
              <circle class="thought-dot dot-2" cx="113" cy="20" r="2.6" />
              <circle class="thought-dot dot-3" cx="121" cy="14" r="2.2" />
            </g>

            <g class="verify-lens">
              <circle cx="106" cy="30" r="8.5" fill="none" stroke="#3f7ae0" stroke-width="2.4" />
              <path d="M112 36 L118 42" stroke="#3f7ae0" stroke-width="2.4" stroke-linecap="round" />
            </g>

            <g class="done-spark">
              <path d="M106 16 L108 21 L113 23 L108 25 L106 30 L104 25 L99 23 L104 21 Z" fill="#f4c542" />
            </g>

            <g class="error-mark">
              <path d="M106 12 L112 21 L100 21 Z" fill="#ef4444" />
              <circle cx="106" cy="24.5" r="1.7" fill="#ef4444" />
            </g>
          </svg>
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.mission-mascot {
  position: absolute;
  top: 56px;
  right: 8px;
  bottom: 88px;
  left: 8px;
  z-index: 32;
  overflow: hidden;
}

.mascot-roamer {
  position: absolute;
  left: 10%;
  top: 8%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  animation: roam-path 17s linear infinite;
}

.mascot-roamer.phase-tool {
  animation-duration: 11s;
}

.mascot-roamer.phase-verify {
  animation-duration: 14s;
}

.mascot-roamer.phase-done {
  animation-duration: 9s;
}

.mascot-roamer.phase-error {
  animation-duration: 16s;
  animation-direction: alternate;
}

.mascot-bubble {
  max-width: min(220px, calc(100vw - 56px));
  border: 1px solid rgba(15, 23, 42, 0.12);
  background: #fffdf7;
  border-radius: 14px;
  padding: 10px 12px;
  box-shadow: 0 8px 22px rgba(15, 23, 42, 0.14);
  transform-origin: center bottom;
}

.mascot-bubble.phase-thinking {
  background: #fffef5;
}

.mascot-bubble.phase-tool {
  background: #f5fbff;
}

.mascot-bubble.phase-verify {
  background: #f0f9ff;
}

.bubble-text {
  margin: 0;
  color: #25304a;
  font-size: 12px;
  line-height: 1.35;
  font-weight: 700;
}

.bubble-phase {
  margin: 4px 0 0;
  font-size: 10px;
  letter-spacing: 0.02em;
  color: #53607a;
  font-weight: 700;
}

.mascot-bubble.phase-error {
  background: #fff3f2;
  border-color: rgba(220, 38, 38, 0.2);
}

.mascot-bubble.phase-done {
  background: #f4fff5;
  border-color: rgba(34, 197, 94, 0.2);
}

.mascot-dog {
  width: 82px;
  height: 82px;
  border-radius: 999px;
  background: radial-gradient(circle at 50% 40%, #fff9ee 0%, #fff3dd 66%, #ffe8bf 100%);
  border: 1px solid rgba(15, 23, 42, 0.08);
  box-shadow: 0 10px 22px rgba(15, 23, 42, 0.16);
  animation: dog-float 2.4s ease-in-out infinite;
}

.dog-svg {
  width: 100%;
  height: 100%;
}

.dog-tail {
  transform-origin: 102px 92px;
  animation: tail-wag 0.36s ease-in-out infinite alternate;
}

.dog-paw {
  transform-origin: 70px 104px;
}

.paw-left {
  transform-origin: 50px 104px;
}

.paw-right {
  transform-origin: 88px 104px;
}

.dog-ear {
  transform-origin: 70px 60px;
}

.phase-tool .dog-paw {
  animation: paw-wave 0.7s ease-in-out infinite;
}

.phase-tool .paw-left {
  animation-delay: -0.35s;
}

.thought-dots,
.verify-lens,
.done-spark,
.error-mark {
  opacity: 0;
}

.phase-thinking .thought-dots {
  opacity: 1;
}

.phase-thinking .thought-dot {
  fill: #6b7280;
}

.phase-thinking .dot-1 {
  animation: thought-pop 1s ease-in-out infinite;
}

.phase-thinking .dot-2 {
  animation: thought-pop 1s ease-in-out infinite 0.2s;
}

.phase-thinking .dot-3 {
  animation: thought-pop 1s ease-in-out infinite 0.4s;
}

.phase-verify .verify-lens {
  opacity: 1;
  animation: lens-spin 1.2s linear infinite;
  transform-origin: 106px 30px;
}

.phase-done .done-spark {
  opacity: 1;
  animation: spark-bounce 0.9s ease-in-out infinite;
}

.phase-thinking .dog-core {
  animation: thinking-head 1.5s ease-in-out infinite;
}

.phase-tool .dog-core {
  animation: sprint-body 0.44s ease-in-out infinite;
}

.phase-verify .dog-core {
  animation: sniff-head 1.05s ease-in-out infinite;
}

.phase-done .dog-core {
  animation: happy-hop 0.78s ease-in-out infinite;
}

.phase-error .dog-core {
  animation: dog-shake 0.38s linear infinite;
  transform-origin: 70px 78px;
}

.phase-error .dog-ear.ear-left {
  transform: rotate(18deg) translate(1px, 2px);
}

.phase-error .dog-ear.ear-right {
  transform: rotate(-18deg) translate(-1px, 2px);
}

.phase-error .error-mark {
  opacity: 1;
  animation: thought-pop 0.9s ease-in-out infinite;
}

.mascot-pop-enter-active,
.mascot-pop-leave-active {
  transition: opacity 180ms ease, transform 180ms ease;
}

.mascot-pop-enter-from,
.mascot-pop-leave-to {
  opacity: 0;
  transform: translateY(10px) scale(0.95);
}

@keyframes roam-path {
  0% {
    left: 10%;
    top: 8%;
  }

  16% {
    left: 54%;
    top: 10%;
  }

  32% {
    left: 38%;
    top: 34%;
  }

  48% {
    left: 14%;
    top: 52%;
  }

  64% {
    left: 50%;
    top: 66%;
  }

  82% {
    left: 24%;
    top: 76%;
  }

  100% {
    left: 10%;
    top: 8%;
  }
}

@keyframes dog-float {
  0%,
  100% {
    transform: translateY(0);
  }

  50% {
    transform: translateY(-3px);
  }
}

@keyframes tail-wag {
  from {
    transform: rotate(-16deg);
  }

  to {
    transform: rotate(10deg);
  }
}

@keyframes paw-wave {
  0%,
  100% {
    transform: rotate(0deg);
  }

  50% {
    transform: rotate(-16deg);
  }
}

@keyframes thought-pop {
  0%,
  100% {
    transform: translateY(0);
    opacity: 0.25;
  }

  45% {
    transform: translateY(-2px);
    opacity: 0.95;
  }
}

@keyframes lens-spin {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
}

@keyframes spark-bounce {
  0%,
  100% {
    transform: scale(0.9);
    opacity: 0.6;
  }

  50% {
    transform: scale(1.2);
    opacity: 1;
  }
}

@keyframes dog-shake {
  0%,
  100% {
    transform: translateX(0);
  }

  25% {
    transform: translateX(-2px);
  }

  75% {
    transform: translateX(2px);
  }
}

@keyframes thinking-head {
  0%,
  100% {
    transform: rotate(0deg) translateY(0);
  }

  35% {
    transform: rotate(-5deg) translateY(-1px);
  }

  70% {
    transform: rotate(5deg) translateY(-2px);
  }
}

@keyframes sprint-body {
  0%,
  100% {
    transform: translateY(0);
  }

  50% {
    transform: translateY(-3px);
  }
}

@keyframes sniff-head {
  0%,
  100% {
    transform: translateX(0) rotate(0deg);
  }

  25% {
    transform: translateX(2px) rotate(3deg);
  }

  75% {
    transform: translateX(-2px) rotate(-3deg);
  }
}

@keyframes happy-hop {
  0%,
  100% {
    transform: translateY(0) scale(1);
  }

  45% {
    transform: translateY(-6px) scale(1.02);
  }

  70% {
    transform: translateY(-2px) scale(0.98);
  }
}

@media (prefers-reduced-motion: reduce) {
  .mascot-roamer,
  .mascot-dog,
  .dog-tail,
  .dog-paw,
  .phase-thinking .thought-dot,
  .phase-verify .verify-lens,
  .phase-done .done-spark,
  .phase-error .dog-core,
  .phase-thinking .dog-core,
  .phase-tool .dog-core,
  .phase-verify .dog-core,
  .phase-done .dog-core,
  .phase-error .error-mark {
    animation: none !important;
  }
}
</style>

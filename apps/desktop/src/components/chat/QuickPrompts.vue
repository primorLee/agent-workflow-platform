<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ChatMessage } from '@/api/types'

const { t } = useI18n()

defineProps<{
  messages: ChatMessage[]
}>()

const emit = defineEmits<{
  (e: 'send-prompt', prompt: string): void
}>()

const quickPrompts = computed(() => [
  { icon: 'PL', title: t('chat.qpPlanWorkflow'), desc: t('chat.qpPlanWorkflowDesc'), prompt: t('chat.qpPlanWorkflowPrompt') },
  { icon: 'DB', title: t('chat.qpDebugFailure'), desc: t('chat.qpDebugFailureDesc'), prompt: t('chat.qpDebugFailurePrompt') },
  { icon: 'RV', title: t('chat.qpReviewChanges'), desc: t('chat.qpReviewChangesDesc'), prompt: t('chat.qpReviewChangesPrompt') },
  { icon: 'RS', title: t('chat.qpResumeRun'), desc: t('chat.qpResumeRunDesc'), prompt: t('chat.qpResumeRunPrompt') },
  { icon: 'OP', title: t('chat.qpHardenDeployment'), desc: t('chat.qpHardenDeploymentDesc'), prompt: t('chat.qpHardenDeploymentPrompt') },
  { icon: 'RP', title: t('chat.qpReproduceIssue'), desc: t('chat.qpReproduceIssueDesc'), prompt: t('chat.qpReproduceIssuePrompt') },
])
</script>

<template>
  <div class="empty-chat">
    <div class="welcome-header">
      <h3>Agent Workflow Platform</h3>
      <p>{{ t('chat.describeNeeds') }}</p>
    </div>
    <div class="quick-prompts">
      <button
        v-for="qp in quickPrompts"
        :key="qp.title"
        class="quick-prompt-card"
        @click="emit('send-prompt', qp.prompt)"
      >
        <span class="qp-icon">{{ qp.icon }}</span>
        <div class="qp-text">
          <span class="qp-title">{{ qp.title }}</span>
          <span class="qp-desc">{{ qp.desc }}</span>
        </div>
      </button>
    </div>
  </div>
</template>

<style scoped>
.empty-chat {
  max-width: 760px;
  margin: 0 auto;
  width: 100%;
  padding: 48px 0 24px;
  display: flex;
  flex-direction: column;
  gap: 28px;
}

.welcome-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  color: var(--text-muted);
}
.welcome-logo {
  width: 56px;
  height: 56px;
  opacity: 0.9;
}
.welcome-header h3 {
  font-size: 22px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}
.welcome-header p {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

.quick-prompts {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}

.quick-prompt-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 16px;
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  text-align: left;
  cursor: pointer;
  transition: background 120ms, border-color 120ms, transform 120ms;
}
.quick-prompt-card:hover {
  background: var(--panel-soft);
  border-color: var(--primary);
  transform: translateY(-1px);
}
.quick-prompt-card:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}

.qp-icon {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: var(--primary-soft);
  color: var(--primary);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.5px;
}

.qp-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.qp-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
.qp-desc {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}
</style>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { QuestionRequest } from '../api/client'

const props = defineProps<{
  request: QuestionRequest
}>()

const emit = defineEmits<{
  (e: 'answered', requestId: string, answers: string[][]): void
  (e: 'rejected', requestId: string): void
}>()

const isSubmitting = ref(false)
const isAnswered = ref(false)
const selectedAnswers = ref<string[][]>([])
const customInputs = ref<string[]>([])

// Initialize arrays based on number of questions
const initializeAnswers = () => {
  selectedAnswers.value = props.request.questions.map(() => [])
  customInputs.value = props.request.questions.map(() => '')
  isAnswered.value = false
}
initializeAnswers()

// Re-initialize if request changes (e.g., component reuse)
watch(() => props.request.id, () => {
  initializeAnswers()
})

const canSubmit = computed(() => {
  return props.request.questions.every((_q, i) => {
    const hasSelection = selectedAnswers.value[i]?.length > 0
    const hasCustom = customInputs.value[i]?.trim().length > 0
    return hasSelection || hasCustom
  })
})

const toggleOption = (questionIndex: number, label: string, multiple: boolean) => {
  if (!selectedAnswers.value[questionIndex]) {
    selectedAnswers.value[questionIndex] = []
  }

  const answers = selectedAnswers.value[questionIndex]
  const index = answers.indexOf(label)

  if (index >= 0) {
    answers.splice(index, 1)
  } else {
    if (multiple) {
      answers.push(label)
    } else {
      selectedAnswers.value[questionIndex] = [label]
    }
  }
}

const isSelected = (questionIndex: number, label: string) => {
  return selectedAnswers.value[questionIndex]?.includes(label) ?? false
}

const submitAnswer = () => {
  if (!canSubmit.value || isSubmitting.value) return

  // Build answers: for each question, combine selected options and custom input
  const answers = props.request.questions.map((_, i) => {
    const selected = selectedAnswers.value[i] || []
    const custom = customInputs.value[i]?.trim()
    if (custom) {
      return [...selected, custom]
    }
    return selected
  })

  isAnswered.value = true
  emit('answered', props.request.id, answers)
}

const rejectQuestion = () => {
  if (isSubmitting.value) return

  isAnswered.value = true
  emit('rejected', props.request.id)
}
</script>

<template>
  <div class="agent-question" :class="{ answered: isAnswered }">
    <div class="question-header">
      <div class="question-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
          <line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
      </div>
      <span class="question-label">AI needs your input</span>
    </div>

    <div v-for="(question, qIndex) in request.questions" :key="qIndex" class="question-item">
      <div class="question-text">{{ question.question }}</div>

      <div class="options-list">
        <button
          v-for="option in question.options"
          :key="option.label"
          class="option-btn"
          :class="{ selected: isSelected(qIndex, option.label) }"
          :disabled="isAnswered || isSubmitting"
          @click="toggleOption(qIndex, option.label, question.multiple ?? false)"
        >
          <span class="option-label">{{ option.label }}</span>
          <span v-if="option.description" class="option-desc">{{ option.description }}</span>
        </button>
      </div>

      <div v-if="question.custom !== false" class="custom-input-wrapper">
        <input
          v-model="customInputs[qIndex]"
          type="text"
          class="custom-input"
          placeholder="Or type your own answer..."
          :disabled="isAnswered || isSubmitting"
          @keyup.enter="submitAnswer"
        />
      </div>
    </div>

    <div v-if="!isAnswered" class="question-actions">
      <button class="btn btn-ghost" :disabled="isSubmitting" @click="rejectQuestion">
        Skip
      </button>
      <button
        class="btn btn-primary"
        :disabled="!canSubmit || isSubmitting"
        @click="submitAnswer"
      >
        <span v-if="isSubmitting" class="loading-spinner small"></span>
        <span v-else>Submit</span>
      </button>
    </div>

    <div v-else class="question-answered">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M20 6L9 17l-5-5"/>
      </svg>
      <span>Answered</span>
    </div>
  </div>
</template>

<style scoped>
.agent-question {
  background: var(--glass-bg);
  border: 0.5px solid var(--glass-border);
  border-radius: var(--radius-md);
  padding: var(--space-md);
  margin: var(--space-sm) 0;
}

.agent-question.answered {
  opacity: 0.7;
}

.question-header {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-bottom: var(--space-md);
}

.question-icon {
  color: var(--accent);
  display: flex;
  align-items: center;
}

.question-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.question-item {
  margin-bottom: var(--space-md);
}

.question-item:last-of-type {
  margin-bottom: var(--space-md);
}

.question-text {
  font-size: 0.9375rem;
  color: var(--text-primary);
  margin-bottom: var(--space-sm);
  line-height: 1.5;
}

.options-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}

.option-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: var(--space-sm) var(--space-md);
  background: var(--surface-2);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--transition-fast);
  text-align: left;
}

.option-btn:hover:not(:disabled) {
  background: var(--surface-3);
  border-color: var(--accent);
}

.option-btn.selected {
  background: var(--accent-subtle);
  border-color: var(--accent);
}

.option-btn:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.option-label {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-primary);
}

.option-desc {
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-top: 2px;
}

.custom-input-wrapper {
  margin-top: var(--space-sm);
}

.custom-input {
  width: 100%;
  padding: var(--space-sm) var(--space-md);
  background: var(--surface-1);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 0.875rem;
}

.custom-input:focus {
  outline: none;
  border-color: var(--accent);
}

.custom-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.question-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm);
  padding-top: var(--space-sm);
  border-top: 0.5px solid var(--border-default);
}

.question-answered {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  color: var(--success);
  font-size: 0.75rem;
  font-weight: 500;
  padding-top: var(--space-sm);
  border-top: 0.5px solid var(--border-default);
}

.loading-spinner.small {
  width: 14px;
  height: 14px;
}
</style>

<script setup lang="ts">
import { ref } from 'vue'
import { Pencil, BookOpen, Code2, Home, Sparkles, X } from 'lucide-vue-next'

const emit = defineEmits<{
  select: [prompt: string]
}>()

const categories = [
  {
    id: 'write',
    label: 'Write',
    icon: Pencil,
    suggestions: [
      'Write something in the voice of my favorite historical figure',
      'Develop content briefs',
      'Develop content templates',
      'Write event descriptions',
    ]
  },
  {
    id: 'learn',
    label: 'Learn',
    icon: BookOpen,
    suggestions: [
      'Explain a complex topic in simple terms',
      'Create a study plan for a new subject',
      'Break down a research paper',
      'Teach me about a historical event',
    ]
  },
  {
    id: 'code',
    label: 'Code',
    icon: Code2,
    suggestions: [
      'Help me debug this code',
      'Write a function that...',
      'Explain this code snippet',
      'Review my code for improvements',
    ]
  },
  {
    id: 'life',
    label: 'Life stuff',
    icon: Home,
    suggestions: [
      'Help me plan a trip',
      'Create a weekly meal plan',
      'Organize my schedule',
      'Help me draft an email',
    ]
  },
  {
    id: 'choice',
    label: "Recommended",
    icon: Sparkles,
    suggestions: [
      'Surprise me with something interesting',
      'Tell me a fun fact I probably don\'t know',
      'Give me a creative writing prompt',
      'Suggest a thought experiment',
    ]
  }
]

const activeCategory = ref<string | null>(null)

function toggleCategory(id: string) {
  activeCategory.value = activeCategory.value === id ? null : id
}

function selectSuggestion(prompt: string) {
  emit('select', prompt)
  activeCategory.value = null
}

function getActiveSuggestions() {
  return categories.find(c => c.id === activeCategory.value)?.suggestions || []
}
</script>

<template>
  <div class="prompt-categories-wrapper">
    <!-- Category Tags -->
    <div class="prompt-categories" role="tablist" aria-label="Prompt categories">
      <button
        v-for="cat in categories"
        :key="cat.id"
        class="category-tag"
        :class="{ active: activeCategory === cat.id }"
        role="tab"
        :aria-selected="activeCategory === cat.id"
        @click="toggleCategory(cat.id)"
      >
        <component :is="cat.icon" :size="14" />
        <span>{{ cat.label }}</span>
      </button>
    </div>

    <!-- Suggestion Panel -->
    <div v-if="activeCategory" class="suggestions-panel">
      <div class="suggestions-header">
        <span class="suggestions-title">{{ categories.find(c => c.id === activeCategory)?.label }}</span>
        <button class="suggestions-close" @click="activeCategory = null">
          <X :size="14" />
        </button>
      </div>
      <div class="suggestions-list">
        <button
          v-for="(suggestion, i) in getActiveSuggestions()"
          :key="i"
          class="suggestion-item"
          @click="selectSuggestion(suggestion)"
        >
          {{ suggestion }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.prompt-categories-wrapper {
  width: 100%;
  max-width: var(--input-max-width);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  margin: 0 auto;
  padding: 0 var(--space-md);
}

.prompt-categories {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}

.category-tag {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: 14px;
  font-weight: 400;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}

.category-tag:hover {
  border-color: var(--border-hover);
  color: var(--text-primary);
  background: var(--bg-elevated);
}

.category-tag:active {
  transform: scale(0.98);
}

.category-tag.active {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-subtle);
}

.category-tag svg {
  opacity: 0.6;
}

.category-tag:hover svg,
.category-tag.active svg {
  opacity: 1;
}

/* Suggestions Panel */
.suggestions-panel {
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-md);
  overflow: hidden;
  animation: suggestionsIn 0.2s ease-out;
}

@keyframes suggestionsIn {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.suggestions-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px var(--space-md);
  border-bottom: 1px solid var(--border-subtle);
}

.suggestions-title {
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.suggestions-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all 0.15s ease;
}

.suggestions-close:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.suggestions-list {
  display: flex;
  flex-direction: column;
}

.suggestion-item {
  padding: 10px var(--space-md);
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-serif);
  font-size: 14px;
  font-weight: 400;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s ease;
}

.suggestion-item:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}
</style>

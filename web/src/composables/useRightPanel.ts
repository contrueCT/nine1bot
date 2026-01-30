import { ref, computed, watch } from 'vue'
import { useAgentTerminal } from './useAgentTerminal'
import { useFilePreview } from './useFilePreview'

export type RightPanelTab = 'terminal' | 'preview'

// Shared state
const activeTab = ref<RightPanelTab>('terminal')
const panelWidth = ref(450)

export function useRightPanel() {
  const { terminals, isPanelOpen: isTerminalPanelOpen, hasTerminals } = useAgentTerminal()
  const { previews, isPanelOpen: isPreviewPanelOpen, hasPreviews } = useFilePreview()

  // Panel is open if either terminal or preview wants to be open
  const isPanelOpen = computed(() => isTerminalPanelOpen.value || isPreviewPanelOpen.value)

  // Auto-switch to terminal when new terminal is created
  watch(
    () => terminals.value.length,
    (newLen, oldLen) => {
      if (newLen > oldLen) {
        activeTab.value = 'terminal'
      }
    },
  )

  // Auto-switch to preview when new preview is opened
  watch(
    () => previews.value.length,
    (newLen, oldLen) => {
      if (newLen > oldLen) {
        activeTab.value = 'preview'
      }
    },
  )

  // If active tab becomes empty, switch to the other tab
  watch(
    [hasTerminals, hasPreviews],
    ([hasTerms, hasPrevs]) => {
      if (activeTab.value === 'terminal' && !hasTerms && hasPrevs) {
        activeTab.value = 'preview'
      } else if (activeTab.value === 'preview' && !hasPrevs && hasTerms) {
        activeTab.value = 'terminal'
      }
    },
  )

  function setActiveTab(tab: RightPanelTab) {
    activeTab.value = tab
  }

  function closePanel() {
    // Close both panels
    const { closePanel: closeTerminalPanel } = useAgentTerminal()
    const { closePanel: closePreviewPanel } = useFilePreview()
    closeTerminalPanel()
    closePreviewPanel()
  }

  function openPanel() {
    // Open based on what's available
    if (hasTerminals.value) {
      const { openPanel } = useAgentTerminal()
      openPanel()
      activeTab.value = 'terminal'
    } else if (hasPreviews.value) {
      const { openPanel } = useFilePreview()
      openPanel()
      activeTab.value = 'preview'
    }
  }

  return {
    // State
    activeTab,
    panelWidth,
    isPanelOpen,
    hasTerminals,
    hasPreviews,

    // Actions
    setActiveTab,
    closePanel,
    openPanel,
  }
}

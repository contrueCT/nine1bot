interface AgentVisualState {
  state: 'active' | 'idle' | 'stopping'
  heartbeatAt: number
  activeInThisTab: boolean
  sameGroupActive: boolean
  taskLabel?: string
}

const HEARTBEAT_TIMEOUT_MS = 8000
const ROOT_ID = 'nine1bot-agent-indicator-root'

let root: HTMLDivElement | null = null
let shadowRoot: ShadowRoot | null = null
let heartbeatWatchTimer: ReturnType<typeof setInterval> | null = null
let latestState: AgentVisualState = {
  state: 'idle',
  heartbeatAt: 0,
  activeInThisTab: false,
  sameGroupActive: false,
}

function ensureUi(): void {
  if (root && shadowRoot) return

  root = document.createElement('div')
  root.id = ROOT_ID
  root.style.all = 'initial'
  root.style.position = 'fixed'
  root.style.inset = '0'
  root.style.pointerEvents = 'none'
  root.style.zIndex = '2147483647'
  root.style.display = 'none'
  document.documentElement.appendChild(root)

  shadowRoot = root.attachShadow({ mode: 'open' })
  shadowRoot.innerHTML = `
    <style>
      .border {
        position: fixed;
        inset: 0;
        border: 4px solid rgba(255, 140, 0, 0.9);
        box-sizing: border-box;
        pointer-events: none;
        animation: pulse 1.5s infinite;
      }
      .hint {
        position: fixed;
        bottom: 16px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(24, 24, 24, 0.92);
        color: #fff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 13px;
        border-radius: 10px;
        padding: 10px 14px;
        max-width: min(720px, calc(100vw - 32px));
        line-height: 1.4;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
      }
      .stop {
        pointer-events: auto;
        position: fixed;
        right: 16px;
        bottom: 16px;
        border: 0;
        border-radius: 999px;
        background: linear-gradient(180deg, #ff8a00, #ff6a00);
        color: #fff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 13px;
        font-weight: 600;
        padding: 10px 14px;
        cursor: pointer;
        box-shadow: 0 8px 24px rgba(255, 106, 0, 0.4);
      }
      .stop:hover {
        filter: brightness(1.04);
      }
      @keyframes pulse {
        0%, 100% { box-shadow: inset 0 0 0 0 rgba(255, 138, 0, 0.35); }
        50% { box-shadow: inset 0 0 0 6px rgba(255, 138, 0, 0.08); }
      }
    </style>
    <div id="border" class="border" hidden></div>
    <div id="hint" class="hint" hidden></div>
    <button id="stop" class="stop" hidden>Stop Nine1Bot</button>
  `

  const stopButton = shadowRoot.getElementById('stop') as HTMLButtonElement | null
  if (stopButton) {
    stopButton.addEventListener('click', async () => {
      try {
        await chrome.runtime.sendMessage({
          type: 'nine1bot-agent-stop-request',
          url: window.location.href,
        })
      } catch (error) {
        console.warn('[Nine1Bot Indicator] Failed to send stop request:', error)
      }
    })
  }
}

function hideUi(): void {
  if (!root || !shadowRoot) return
  root.style.display = 'none'
  const border = shadowRoot.getElementById('border')
  const hint = shadowRoot.getElementById('hint')
  const stop = shadowRoot.getElementById('stop')
  if (border) border.setAttribute('hidden', 'true')
  if (hint) hint.setAttribute('hidden', 'true')
  if (stop) stop.setAttribute('hidden', 'true')
}

function render(state: AgentVisualState): void {
  ensureUi()
  if (!root || !shadowRoot) return

  const border = shadowRoot.getElementById('border') as HTMLDivElement | null
  const hint = shadowRoot.getElementById('hint') as HTMLDivElement | null
  const stop = shadowRoot.getElementById('stop') as HTMLButtonElement | null
  if (!border || !hint || !stop) return

  if (state.activeInThisTab) {
    root.style.display = 'block'
    border.removeAttribute('hidden')
    stop.removeAttribute('hidden')
    hint.textContent = state.taskLabel ? `Nine1Bot is running: ${state.taskLabel}` : 'Nine1Bot is active on this tab'
    hint.removeAttribute('hidden')
    return
  }

  if (state.sameGroupActive) {
    root.style.display = 'block'
    border.setAttribute('hidden', 'true')
    stop.setAttribute('hidden', 'true')
    hint.textContent = 'Nine1Bot is active in this tab group'
    hint.removeAttribute('hidden')
    return
  }

  hideUi()
}

function startHeartbeatWatch(): void {
  if (heartbeatWatchTimer) return
  heartbeatWatchTimer = setInterval(() => {
    if (!latestState.activeInThisTab && !latestState.sameGroupActive) return
    const stale = Date.now() - latestState.heartbeatAt > HEARTBEAT_TIMEOUT_MS
    if (stale) {
      latestState = {
        state: 'idle',
        heartbeatAt: 0,
        activeInThisTab: false,
        sameGroupActive: false,
      }
      hideUi()
    }
  }, 1000)
}

export function initAgentVisualIndicator(): void {
  ensureUi()
  startHeartbeatWatch()
}

export function updateAgentVisualIndicator(state: AgentVisualState): void {
  latestState = state
  render(state)
}

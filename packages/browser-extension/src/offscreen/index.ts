interface RecordingFrame {
  dataUrl: string
  timestamp: number
  label?: string
}

interface RecordingSession {
  id: string
  startedAt: number
  stoppedAt?: number
  frames: RecordingFrame[]
}

const sessions = new Map<string, RecordingSession>()
let audioContext: AudioContext | null = null

function getOrCreateSession(id: string): RecordingSession {
  let session = sessions.get(id)
  if (!session) {
    session = {
      id,
      startedAt: Date.now(),
      frames: [],
    }
    sessions.set(id, session)
  }
  return session
}

async function playTone(type: 'success' | 'error' | 'confirm'): Promise<void> {
  if (!audioContext) {
    audioContext = new AudioContext()
  }
  if (audioContext.state === 'suspended') {
    await audioContext.resume()
  }

  const baseFrequency = type === 'error' ? 280 : type === 'confirm' ? 660 : 520
  const oscillator = audioContext.createOscillator()
  const gainNode = audioContext.createGain()
  oscillator.type = type === 'error' ? 'sawtooth' : 'sine'
  oscillator.frequency.value = baseFrequency
  gainNode.gain.value = 0.001
  oscillator.connect(gainNode)
  gainNode.connect(audioContext.destination)
  oscillator.start()

  const now = audioContext.currentTime
  gainNode.gain.exponentialRampToValueAtTime(0.1, now + 0.02)
  gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.3)

  await new Promise((resolve) => setTimeout(resolve, 320))
  oscillator.stop()
  oscillator.disconnect()
  gainNode.disconnect()
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'nine1bot-offscreen-command') return false

  const command = message.command as string
  const payload = message.payload ?? {}

  if (command === 'record-start') {
    const id = String(payload.id || `recording_${Date.now()}`)
    const session = getOrCreateSession(id)
    session.startedAt = Date.now()
    session.stoppedAt = undefined
    session.frames = []
    sendResponse({ ok: true, id })
    return true
  }

  if (command === 'record-frame') {
    const id = String(payload.id || '')
    const dataUrl = String(payload.dataUrl || '')
    if (!id || !dataUrl) {
      sendResponse({ ok: false, error: 'id and dataUrl are required' })
      return true
    }
    const session = getOrCreateSession(id)
    session.frames.push({
      dataUrl,
      timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : Date.now(),
      label: typeof payload.label === 'string' ? payload.label : undefined,
    })
    sendResponse({ ok: true, frameCount: session.frames.length })
    return true
  }

  if (command === 'record-stop') {
    const id = String(payload.id || '')
    const session = sessions.get(id)
    if (!session) {
      sendResponse({ ok: false, error: `Recording not found: ${id}` })
      return true
    }
    session.stoppedAt = Date.now()
    sendResponse({
      ok: true,
      id,
      frameCount: session.frames.length,
      durationMs: session.stoppedAt - session.startedAt,
    })
    return true
  }

  if (command === 'record-export-gif') {
    const id = String(payload.id || '')
    const session = sessions.get(id)
    if (!session) {
      sendResponse({ ok: false, error: `Recording not found: ${id}` })
      return true
    }

    // Minimal implementation: return first frame preview + metadata.
    const firstFrame = session.frames[0]?.dataUrl
    sendResponse({
      ok: true,
      id,
      frameCount: session.frames.length,
      durationMs: (session.stoppedAt ?? Date.now()) - session.startedAt,
      previewDataUrl: firstFrame ?? null,
      note: 'Minimal export currently returns previewDataUrl + metadata. Replace with full GIF encoder in next iteration.',
    })
    return true
  }

  if (command === 'record-clear') {
    const id = String(payload.id || '')
    sessions.delete(id)
    sendResponse({ ok: true })
    return true
  }

  if (command === 'play-sound') {
    const sound = (payload.sound as 'success' | 'error' | 'confirm') ?? 'success'
    playTone(sound)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    return true
  }

  sendResponse({ ok: false, error: `Unknown offscreen command: ${command}` })
  return true
})

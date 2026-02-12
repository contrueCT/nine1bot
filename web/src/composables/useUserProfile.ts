import { ref, watch } from 'vue'

const PROFILE_KEY = 'nine1bot-user-profile'
const LOGO_KEY = 'nine1bot-brand-logo'
const BOT_AVATAR_KEY = 'nine1bot-bot-avatar'

interface UserProfile {
  name: string
  avatarUrl: string // base64 data URL or empty string
}

interface BrandLogo {
  logoUrl: string // base64 data URL or empty string
}

interface BotAvatar {
  botAvatarUrl: string // base64 data URL or empty string
}

function loadProfile(): UserProfile {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}')
  } catch {
    return { name: '', avatarUrl: '' }
  }
}

function loadLogo(): BrandLogo {
  try {
    return JSON.parse(localStorage.getItem(LOGO_KEY) || '{}')
  } catch {
    return { logoUrl: '' }
  }
}

function loadBotAvatar(): BotAvatar {
  try {
    return JSON.parse(localStorage.getItem(BOT_AVATAR_KEY) || '{}')
  } catch {
    return { botAvatarUrl: '' }
  }
}

// Singleton state
const profile = ref<UserProfile>(loadProfile())
const brandLogo = ref<BrandLogo>(loadLogo())
const botAvatar = ref<BotAvatar>(loadBotAvatar())

// Persist on change
watch(profile, (val) => {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(val))
}, { deep: true })

watch(brandLogo, (val) => {
  localStorage.setItem(LOGO_KEY, JSON.stringify(val))
}, { deep: true })

watch(botAvatar, (val) => {
  localStorage.setItem(BOT_AVATAR_KEY, JSON.stringify(val))
}, { deep: true })

export function useUserProfile() {
  function setName(name: string) {
    profile.value = { ...profile.value, name }
  }

  function setAvatar(dataUrl: string) {
    profile.value = { ...profile.value, avatarUrl: dataUrl }
  }

  function setLogo(dataUrl: string) {
    brandLogo.value = { logoUrl: dataUrl }
  }

  function setBotAvatar(dataUrl: string) {
    botAvatar.value = { botAvatarUrl: dataUrl }
  }

  function clearAvatar() {
    profile.value = { ...profile.value, avatarUrl: '' }
  }

  function clearLogo() {
    brandLogo.value = { logoUrl: '' }
  }

  function clearBotAvatar() {
    botAvatar.value = { botAvatarUrl: '' }
  }

  return {
    profile,
    brandLogo,
    botAvatar,
    setName,
    setAvatar,
    setLogo,
    setBotAvatar,
    clearAvatar,
    clearLogo,
    clearBotAvatar
  }
}

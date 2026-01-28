/**
 * Nine1Bot CLI UI 工具
 */

// ANSI 颜色代码
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',

  // 前景色
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',

  // 亮色
  brightBlack: '\x1b[90m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',
}

/**
 * Nine1Bot Logo (简化版)
 */
export function logo(): string {
  return `${colors.brightCyan}${colors.bold}
  _   _ _            _ ____        _
 | \\ | (_)_ __   ___/ | __ )  ___ | |_
 |  \\| | | '_ \\ / _ \\ |  _ \\ / _ \\| __|
 | |\\  | | | | |  __/ | |_) | (_) | |_
 |_| \\_|_|_| |_|\\___|_|____/ \\___/ \\__|
${colors.reset}`
}

/**
 * 打印 Logo
 */
export function printLogo(): void {
  console.log(logo())
}

/**
 * 打印空行
 */
export function empty(): void {
  console.log()
}

/**
 * 打印普通消息
 */
export function println(...messages: string[]): void {
  console.log(...messages)
}

/**
 * 打印成功消息
 */
export function success(message: string): void {
  console.log(`${colors.green}✓${colors.reset} ${message}`)
}

/**
 * 打印错误消息
 */
export function error(message: string): void {
  console.log(`${colors.red}✗${colors.reset} ${message}`)
}

/**
 * 打印警告消息
 */
export function warn(message: string): void {
  console.log(`${colors.yellow}⚠${colors.reset} ${message}`)
}

/**
 * 打印信息消息
 */
export function info(message: string): void {
  console.log(`${colors.blue}ℹ${colors.reset} ${message}`)
}

/**
 * 打印标题
 */
export function title(text: string): void {
  console.log(`${colors.bold}${colors.brightWhite}${text}${colors.reset}`)
}

/**
 * 打印带颜色的 URL
 */
export function url(label: string, urlStr: string): void {
  console.log(`  ${colors.dim}${label}:${colors.reset} ${colors.cyan}${urlStr}${colors.reset}`)
}

/**
 * 打印分隔线
 */
export function divider(): void {
  console.log(`${colors.dim}${'─'.repeat(50)}${colors.reset}`)
}

/**
 * 格式化配置值显示
 */
export function formatConfigValue(value: any): string {
  if (value === undefined || value === null) {
    return `${colors.dim}(not set)${colors.reset}`
  }
  if (typeof value === 'boolean') {
    return value ? `${colors.green}true${colors.reset}` : `${colors.red}false${colors.reset}`
  }
  if (typeof value === 'string' && value.includes('***')) {
    return `${colors.yellow}${value}${colors.reset}`
  }
  return `${colors.cyan}${JSON.stringify(value)}${colors.reset}`
}

/**
 * 取消错误
 */
export class CancelledError extends Error {
  constructor() {
    super('Operation cancelled')
    this.name = 'CancelledError'
  }
}

export const UI = {
  logo,
  printLogo,
  empty,
  println,
  success,
  error,
  warn,
  info,
  title,
  url,
  divider,
  formatConfigValue,
  CancelledError,
  colors,
}

export default UI

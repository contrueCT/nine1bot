// File URLs describe the server filesystem, which may differ from the browser's
// OS. Decode once before placing the path in an HTTP query parameter.
function basename(value: string) {
  return value.split(/[\\/]/).at(-1) || ''
}

function rawFileUrlPath(value: string): string {
  const path = value.slice('file://'.length)
  if (/^\/?[a-z]:[\\/]/i.test(path)) return path.replace(/^\//, '').replace(/\//g, '\\')
  if (path.startsWith('/') || path.startsWith('\\\\')) return path
  return `\\\\${path.replace(/\//g, '\\')}`
}

export function fileUrlPath(value: string, filename?: string): string | null {
  if (!/^file:\/\//i.test(value)) return null
  let decoded: string | null = null
  try {
    const url = new URL(value)
    const pathname = decodeURIComponent(url.pathname)
    if (url.hostname && url.hostname !== 'localhost') {
      decoded = `\\\\${url.hostname}${pathname.replace(/\//g, '\\')}`
    } else if (/^\/[a-z]:\//i.test(pathname)) {
      decoded = pathname.slice(1).replace(/\//g, '\\')
    } else {
      decoded = pathname
    }
  } catch {}
  // Older send_file parts stored raw paths after "file://". Their filename
  // metadata disambiguates literal %, # and ? from URL encoding/fragment syntax.
  if (filename) {
    const raw = rawFileUrlPath(value)
    const name = basename(filename)
    const rawWindowsShare = value.slice('file://'.length).startsWith('\\\\')
    if (basename(raw) === name && (rawWindowsShare || decoded === null || basename(decoded) !== name)) return raw
  }
  return decoded
}

export function resolveFileUrl(value: string, endpoint: 'upload' | 'download' = 'upload', filename?: string): string {
  const path = fileUrlPath(value, filename)
  return path === null ? value : `/file/${endpoint}?path=${encodeURIComponent(path)}`
}

import { expect, test } from 'bun:test'
import { pathToFileURL } from 'node:url'
import { fileUrlPath, resolveFileUrl } from '../src/utils/file-url'

test('attachment URLs round-trip Unicode, spaces, percent, hash and question marks exactly once', () => {
  for (const name of ['报告 1.png', 'file%20literal.txt', 'report#1?.pdf', 'emoji-🧪.png']) {
    const path = `/tmp/.nine1bot/uploads/session/${name}`
    const url = pathToFileURL(path).href
    expect(fileUrlPath(url)).toBe(path)
    for (const endpoint of ['upload', 'download'] as const) {
      const resolved = new URL(resolveFileUrl(url, endpoint), 'http://localhost')
      expect(resolved.pathname).toBe(`/file/${endpoint}`)
      expect(resolved.searchParams.get('path')).toBe(path)
    }
  }
})

test('Windows drive and UNC file URLs decode for the server independently of browser OS', () => {
  expect(fileUrlPath('file:///C:/Users/test/.nine1bot/uploads/%E6%8A%A5%E5%91%8A%201.png')).toBe('C:\\Users\\test\\.nine1bot\\uploads\\报告 1.png')
  expect(fileUrlPath('file://fileserver/share/.nine1bot/uploads/a%20b.txt')).toBe('\\\\fileserver\\share\\.nine1bot\\uploads\\a b.txt')
  expect(fileUrlPath('file://localhost/tmp/a%20b.txt')).toBe('/tmp/a b.txt')
})

test('legacy raw send_file URLs use filename metadata without corrupting literal percent, hash or question marks', () => {
  for (const filename of ['file%20literal.txt', 'report#1?.pdf', '100%ready.txt', '报告 1.png']) {
    for (const path of [`/tmp/.nine1bot/uploads/${filename}`, `C:\\work\\.nine1bot\\uploads\\${filename}`, `\\\\server\\share\\${filename}`]) {
      const url = `file://${path}` // Historical send_file and prompt attachment format.
      expect(fileUrlPath(url, filename)).toBe(path)
      expect(new URL(resolveFileUrl(url, 'download', filename), 'http://localhost').searchParams.get('path')).toBe(path)
    }
    const path = `/tmp/.nine1bot/uploads/${filename}`
    expect(fileUrlPath(pathToFileURL(path).href, filename)).toBe(path)
  }
})

test('filename metadata may contain a relative path and does not guess ambiguous directory encodings', () => {
  expect(fileUrlPath('file:///tmp/report#1.txt', 'docs/report#1.txt')).toBe('/tmp/report#1.txt')
  expect(fileUrlPath('file:///tmp/a%20b/report.txt', 'report.txt')).toBe('/tmp/a b/report.txt')
})

test('HTTP/data URLs remain unchanged and malformed file URLs never break message rendering', () => {
  for (const value of ['https://example.com/a%20b.png', 'data:image/png;base64,YQ==', '/file/upload?path=example', 'file:///%ZZ']) {
    expect(resolveFileUrl(value)).toBe(value)
  }
})

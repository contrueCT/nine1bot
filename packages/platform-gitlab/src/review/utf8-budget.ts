export function truncateUtf8(value: string, maxBytes: number) {
  if (maxBytes <= 0) return ''
  let bytes = 0
  let end = 0
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index)!
    const codeUnits = codePoint > 0xFFFF ? 2 : 1
    const codePointBytes = codePoint <= 0x7F
      ? 1
      : codePoint <= 0x7FF
        ? 2
        : codePoint <= 0xFFFF
          ? 3
          : 4
    if (bytes + codePointBytes > maxBytes) break
    bytes += codePointBytes
    index += codeUnits
    end = index
  }
  return end === value.length ? value : value.slice(0, end)
}

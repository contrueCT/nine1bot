/** Decode a base64 string that contains UTF-8 encoded text */
export function decodeBase64Utf8(base64: string): string {
  const binaryStr = atob(base64)
  const bytes = Uint8Array.from(binaryStr, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

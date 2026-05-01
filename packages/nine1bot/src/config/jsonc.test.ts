import { describe, expect, it } from 'bun:test'
import { stripJsonComments, upsertTopLevelJsoncProperty } from './jsonc'

describe('jsonc utilities', () => {
  it('strips comments without touching comment-like string content', () => {
    const stripped = stripJsonComments(`{
  // remove this comment
  "url": "https://example.com/a//b",
  "text": "quote: \\" // not comment"
}`)

    expect(JSON.parse(stripped)).toEqual({
      url: 'https://example.com/a//b',
      text: 'quote: " // not comment',
    })
  })

  it('upserts a top-level property while preserving surrounding comments', () => {
    const updated = upsertTopLevelJsoncProperty({
      jsonc: `{
  // keep model
  "model": "openai/gpt-5"
}
`,
      key: 'platforms',
      value: {
        gitlab: {
          enabled: true,
        },
      },
    })

    expect(updated).toContain('// keep model')
    expect(updated).toContain('"model": "openai/gpt-5"')
    expect(stripJsonComments(updated)).toContain('"platforms"')
    expect(JSON.parse(stripJsonComments(updated)).platforms.gitlab.enabled).toBe(true)
  })
})

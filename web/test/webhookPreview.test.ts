import { describe, expect, test } from "bun:test"
import {
  WEBHOOK_PRESETS,
  previewWebhookConfig,
  webhookPresetById,
} from "../src/utils/webhooks"

describe("webhook presets", () => {
  test("ships the expected built-in presets", () => {
    expect(WEBHOOK_PRESETS.map((preset) => preset.id)).toEqual([
      "generic",
      "uptime-kuma",
      "gitlab-webhook",
    ])
  })

  test("renders Uptime Kuma sample fields, prompt, and dedupe key", () => {
    const preset = webhookPresetById("uptime-kuma")
    const preview = previewWebhookConfig({
      sourceName: preset.sourceName,
      projectName: "nine1bot",
      requestMappingText: JSON.stringify(preset.requestMapping),
      promptTemplate: preset.promptTemplate,
      samplePayloadText: JSON.stringify(preset.samplePayload),
      dedupeKeyTemplate: preset.guards.dedupe.keyTemplate,
    })

    expect(preview.ok).toBe(true)
    expect(preview.fields.service).toBe("API")
    expect(preview.fields.status).toBe(0)
    expect(preview.dedupeKey).toBe("12:0")
    expect(preview.renderedPrompt).toContain("Uptime Kuma reported")
  })

  test("reports invalid sample payload JSON", () => {
    const preset = webhookPresetById("generic")
    const preview = previewWebhookConfig({
      sourceName: preset.sourceName,
      projectName: "nine1bot",
      requestMappingText: JSON.stringify(preset.requestMapping),
      promptTemplate: preset.promptTemplate,
      samplePayloadText: "{",
      dedupeKeyTemplate: preset.guards.dedupe.keyTemplate,
    })

    expect(preview.ok).toBe(false)
    expect(preview.error).toBeTruthy()
  })
})

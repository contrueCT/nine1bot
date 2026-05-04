import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFeishuPageContextPayload } from '@nine1bot/platform-feishu'
import type { FeishuCliRunner } from '@nine1bot/platform-feishu/node'
import type { RuntimeControllerProtocol } from '../../../../opencode/packages/opencode/src/runtime/controller/protocol'
import {
  getBuiltinPlatformManager,
  resetBuiltinPlatformManagerForTesting,
} from './builtin'
import {
  clearFeishuControllerMessageContextCacheForTesting,
  prepareFeishuControllerMessageContext,
} from './feishu-context'

beforeEach(() => {
  resetBuiltinPlatformManagerForTesting()
  clearFeishuControllerMessageContextCacheForTesting()
})

afterEach(() => {
  resetBuiltinPlatformManagerForTesting()
  clearFeishuControllerMessageContextCacheForTesting()
})

describe('Feishu controller page context enrichment', () => {
  test('appends Feishu metadata block before prompt compilation', async () => {
    getBuiltinPlatformManager({
      config: {
        feishu: {
          enabled: true,
          settings: {
            cliPath: 'lark-cli',
          },
        },
      },
    })
    const runner: FeishuCliRunner = async (_command, args, options) => {
      if (args.join(' ') === 'auth status') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ identity: 'user:ou_123', tokenStatus: 'valid' }),
          stderr: '',
        }
      }
      const fileArg = args.find((arg) => arg.startsWith('@'))
      const payload = fileArg && options.cwd
        ? await Bun.file(join(options.cwd, fileArg.slice(1))).json()
        : undefined
      expect(payload).toEqual({
        token: 'GKw9w6TOliwkBXkqO8UcphiDnUg',
      })
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          code: 0,
          data: {
            node: {
              title: 'Wiki Doc',
              obj_type: 'docx',
              obj_token: 'docx_token',
              space_id: 'spc_123',
            },
          },
        }),
        stderr: '',
      }
    }

    const body = messageBody()
    const result = await withFakeCliEnv((env) => prepareFeishuControllerMessageContext(body, { runner, env }))

    expect(result.contextEnrichment).toMatchObject({
      platform: 'feishu',
      status: 'loaded',
    })
    expect(result.body.context?.page?.raw?.feishu).toMatchObject({
      enrichment: {
        status: 'loaded',
        resolvedObjType: 'docx',
      },
    })
    expect(result.body.context?.blocks).toContainEqual(expect.objectContaining({
      id: 'page:feishu-metadata',
      source: 'page-context.feishu.metadata.wiki.spaces.get_node',
    }))
  })

  test('reuses Feishu metadata for repeated sends in the same session page scope', async () => {
    getBuiltinPlatformManager({
      config: {
        feishu: {
          enabled: true,
          settings: {
            cliPath: 'lark-cli',
          },
        },
      },
    })
    let calls = 0
    const runner: FeishuCliRunner = async (_command, args, options) => {
      calls++
      if (args.join(' ') === 'auth status') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ identity: 'user:ou_123', tokenStatus: 'valid' }),
          stderr: '',
        }
      }
      const fileArg = args.find((arg) => arg.startsWith('@'))
      const payload = fileArg && options.cwd
        ? await Bun.file(join(options.cwd, fileArg.slice(1))).json()
        : undefined
      expect(payload).toEqual({
        token: 'GKw9w6TOliwkBXkqO8UcphiDnUg',
      })
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          code: 0,
          data: {
            node: {
              title: 'Wiki Doc',
              obj_type: 'docx',
              obj_token: 'docx_token',
              space_id: 'spc_123',
            },
          },
        }),
        stderr: '',
      }
    }

    const { first, second } = await withFakeCliEnv(async (env) => {
      const first = await prepareFeishuControllerMessageContext(messageBody(), {
        runner,
        env,
        cacheScope: 'ses_1',
      })
      const base = messageBody()
      const second = await prepareFeishuControllerMessageContext({
        ...base,
        context: {
          ...base.context,
          blocks: [{ id: 'existing' }],
        },
      }, {
        runner,
        env,
        cacheScope: 'ses_1',
      })
      return { first, second }
    })

    expect(calls).toBe(2)
    expect(first.contextEnrichment?.status).toBe('loaded')
    expect(second.contextEnrichment?.status).toBe('loaded')
    expect(second.body.context?.blocks).toContainEqual({ id: 'existing' })
    expect(second.body.context?.blocks).toContainEqual(expect.objectContaining({
      id: 'page:feishu-metadata',
    }))
  })

  test('skips Feishu metadata when the platform is disabled', async () => {
    getBuiltinPlatformManager({
      config: {
        feishu: {
          enabled: false,
        },
      },
    })
    const runner: FeishuCliRunner = async () => {
      throw new Error('CLI should not run for a disabled platform')
    }
    const body = messageBody()
    const result = await prepareFeishuControllerMessageContext(body, { runner })

    expect(result.body).toBe(body)
    expect(result.contextEnrichment).toBeUndefined()
  })

  test('keeps unknown Feishu routes visible-only without CLI metadata noise', async () => {
    getBuiltinPlatformManager({
      config: {
        feishu: {
          enabled: true,
          settings: {
            cliPath: 'lark-cli',
          },
        },
      },
    })
    const runner: FeishuCliRunner = async () => {
      throw new Error('CLI should not run for unknown Feishu routes')
    }
    const body = messageBody('https://gdut-topview.feishu.cn/space/home')
    const result = await prepareFeishuControllerMessageContext(body, { runner })

    expect(result.body).toBe(body)
    expect(result.contextEnrichment).toBeUndefined()
  })
})

function messageBody(url = 'https://gdut-topview.feishu.cn/wiki/GKw9w6TOliwkBXkqO8UcphiDnUg'): RuntimeControllerProtocol.MessageSendRequest {
  return {
    parts: [{ type: 'text', text: 'hello' }],
    entry: {
      source: 'browser-extension',
      platform: 'feishu',
      mode: 'browser-sidepanel',
    },
    context: {
      page: buildFeishuPageContextPayload({
        url,
        title: 'Wiki Doc',
      }),
    },
  }
}

async function withFakeCliEnv<T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'nine1bot-feishu-cli-'))
  try {
    await writeFile(join(directory, 'lark-cli.cmd'), '@echo off\r\n', 'utf8')
    return await fn({ OS: 'Windows_NT', PATH: directory })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

import { describe, expect, test } from 'bun:test'
import {
  createGitLabProjectProfile,
  parseGitLabProjectProfiles,
  serializeGitLabProjectProfiles,
  validateGitLabProjectBindings,
} from '../src/lib/gitlab-project-profiles'
import {
  gitLabProjectProfileDiagnosticKey,
  gitLabProjectProfileDiagnosticLabel,
  parseGitLabProjectProfileDocument,
  renderGitLabProjectProfileDocument,
  serializeGitLabProjectProfileDocument,
  updateGitLabProjectProfileDocument,
  validateGitLabProjectProfileDocument,
} from '../src/lib/gitlab-project-profile-document'

describe('GitLab project profiles', () => {
  test('renders distinct field-aware diagnostics for colliding CI aliases', () => {
    const document = parseGitLabProjectProfileDocument([{
      id: 'ci-alias-diagnostics',
      host: 'gitlab.example.com',
      projectId: 3,
      nine1botProjectID: 'project-uf',
      ci: {
        maxJobLogs: 4,
        max_job_logs: 0,
        maxFailedJobs: 'four',
        max_failed_jobs: null,
        maxJobLogBytes: 8_000,
      },
    }])
    const diagnostics = validateGitLabProjectProfileDocument(document)
      .filter((diagnostic) => diagnostic.code === 'profile_ci_max_job_logs_invalid')

    expect(diagnostics.map((diagnostic) => diagnostic.field)).toEqual([
      'max_job_logs',
      'maxFailedJobs',
      'max_failed_jobs',
    ])
    const keys = diagnostics.map(gitLabProjectProfileDiagnosticKey)
    expect(new Set(keys).size).toBe(keys.length)
    for (const diagnostic of diagnostics) {
      expect(gitLabProjectProfileDiagnosticLabel(diagnostic)).toContain(`字段：${diagnostic.field}`)
    }
  })

  test('round-trips every canonical review overlay and CI limit', () => {
    const original = createGitLabProjectProfile({
      id: 3,
      pathWithNamespace: 'root/uftest',
      webUrl: 'https://gitlab.example.com/root/uftest',
    }, 'https://gitlab.example.com')
    const configured = {
      ...original,
      nine1botProjectID: 'project-uf',
      reviewContextMarkdown: 'UF review overlay',
      reviewFocus: ['auth'],
      includePathPrefixes: ['src/'],
      excludePathPatterns: ['**/*.generated.ts'],
      maxContextBytes: 120_000,
      maxFiles: 40,
      ci: { maxJobLogs: 4, maxJobLogBytes: 12_000 },
    }

    expect(parseGitLabProjectProfiles(serializeGitLabProjectProfiles([configured])))
      .toEqual([configured])
  })

  test('migrates legacy context and failed-job fields to canonical output', () => {
    const profiles = parseGitLabProjectProfiles(JSON.stringify([{
      id: 'legacy',
      host: 'https://GITLAB.example.com',
      projectId: 3,
      nine1botProjectID: 'project-uf',
      contextMarkdown: 'Legacy overlay',
      reviewFocus: [' auth ', 'security'],
      ci: {
        enabled: false,
        includeFailedJobLogs: false,
        maxFailedJobs: 5,
        maxJobLogBytes: 9_000,
      },
    }]))

    expect(profiles).toEqual([expect.objectContaining({
      id: 'legacy',
      host: 'gitlab.example.com',
      reviewContextMarkdown: 'Legacy overlay',
      reviewFocus: ['auth', 'security'],
      ci: { maxJobLogs: 5, maxJobLogBytes: 9_000 },
    })])
    const canonical = serializeGitLabProjectProfiles(profiles)
    expect(canonical).not.toContain('contextMarkdown')
    expect(canonical).not.toContain('maxFailedJobs')
    expect(canonical).not.toContain('includeFailedJobLogs')
    expect(canonical).not.toContain('"enabled": false')
  })

  test('deduplicates normalized host and project identities while preserving custom ports', () => {
    const profiles = parseGitLabProjectProfiles(JSON.stringify([
      {
        id: 'first',
        host: 'gitlab.example.com:8443',
        projectId: 3,
        nine1botProjectID: 'project-uf',
      },
      {
        id: 'duplicate',
        host: 'https://GITLAB.EXAMPLE.COM:8443/root',
        projectId: '3',
        nine1botProjectID: 'project-other',
      },
    ]))

    expect(profiles).toHaveLength(1)
    expect(profiles[0]).toMatchObject({
      id: 'first',
      host: 'gitlab.example.com:8443',
      projectId: 3,
    })

    expect(createGitLabProjectProfile({
      id: 8,
      pathWithNamespace: 'root/custom',
    }, 'http://gitlab.example.com:9443/gitlab')).toMatchObject({
      id: 'project-gitlab.example.com-9443-8',
      host: 'gitlab.example.com:9443',
      projectId: 8,
      ci: { maxJobLogs: 3, maxJobLogBytes: 8_000 },
    })
  })

  test('uses the selected project URL before the configured base URL', () => {
    const profile = createGitLabProjectProfile({
      id: 9,
      pathWithNamespace: 'team/repo',
      webUrl: 'https://project-host.example.com:7443/team/repo',
    }, 'https://configured-host.example.com')

    expect(profile.host).toBe('project-host.example.com:7443')
    expect(parseGitLabProjectProfiles('not-json')).toEqual([])
  })

  test('rejects stale project bindings even when the project list is empty', () => {
    const profileWithBinding = {
      ...createGitLabProjectProfile({ id: 3, pathWithNamespace: 'root/uftest' }, 'https://gitlab.example.com'),
      nine1botProjectID: 'project-uf',
    }
    const matchingProject = { id: 'project-uf' }

    expect(validateGitLabProjectBindings([profileWithBinding], [])).toContain('不存在')
    expect(validateGitLabProjectBindings([profileWithBinding], [matchingProject])).toBeUndefined()
  })

  test('preserves malformed and duplicate entries while editing a valid profile document entry', () => {
    const document = parseGitLabProjectProfileDocument(JSON.stringify([
      { id: 'first', host: 'gitlab.example.com', projectId: 1, nine1botProjectID: 'project-one' },
      { id: 'first', host: 'other.example.com', projectId: 2, nine1botProjectID: 'project-two' },
      { id: 'same-identity', host: 'https://GITLAB.example.com', projectId: '1', nine1botProjectID: 'project-three' },
      { malformed: true },
      {
        id: 'editable',
        host: 'gitlab.example.com',
        projectId: 5,
        nine1botProjectID: 'project-five',
        extensionField: { preserve: true },
        ci: { maxFailedJobs: 4, maxJobLogBytes: 9_000 },
      },
    ]))

    expect(document.entries).toHaveLength(5)
    expect(document.editable).toHaveLength(4)
    const editable = document.editable.find((entry) => entry.index === 4)
    expect(editable).toBeDefined()
    const updated = updateGitLabProjectProfileDocument(document, 4, {
      ...editable!.profile,
      displayName: 'Edited profile',
    })

    expect(updated.entries).toHaveLength(5)
    expect(updated.entries[3]).toEqual({ malformed: true })
    expect(updated.entries[4]).toMatchObject({
      displayName: 'Edited profile',
      extensionField: { preserve: true },
      ci: { maxFailedJobs: 4, maxJobLogBytes: 9_000 },
    })
    expect(JSON.stringify(updated.entries[4])).not.toContain('maxJobLogs')
    expect(validateGitLabProjectProfileDocument(updated).map((item) => item.code)).toEqual(expect.arrayContaining([
      'profile_id_duplicate',
      'profile_identity_duplicate',
      'profile_id_missing',
    ]))
    expect(serializeGitLabProjectProfileDocument(updated)).toMatchObject({
      ok: false,
      diagnostics: expect.any(Array),
    })
  })

  test('round-trips a valid profile document and migrates legacy fields only after validation', () => {
    const document = parseGitLabProjectProfileDocument(JSON.stringify([{
      id: 'legacy',
      host: 'https://GITLAB.example.com',
      projectId: 3,
      nine1botProjectID: 'project-uf',
      contextMarkdown: 'Legacy overlay',
      extensionField: 'preserved',
      ci: {
        maxFailedJobs: 5,
        maxJobLogBytes: 9_000,
        extensionLimit: 12,
      },
    }]))
    const result = serializeGitLabProjectProfileDocument(document)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected valid profile document')
    const reloaded = JSON.parse(result.value)
    expect(reloaded).toEqual([expect.objectContaining({
      id: 'legacy',
      host: 'gitlab.example.com',
      projectId: 3,
      nine1botProjectID: 'project-uf',
      reviewContextMarkdown: 'Legacy overlay',
      extensionField: 'preserved',
      ci: {
        maxJobLogs: 5,
        maxJobLogBytes: 9_000,
        extensionLimit: 12,
      },
    })])
    expect(result.value).not.toContain('contextMarkdown')
    expect(result.value).not.toContain('maxFailedJobs')
    expect(parseGitLabProjectProfileDocument(result.value).entries).toEqual(reloaded)
  })

  test('preserves colliding and null raw representations through unrelated edits until explicit repair', () => {
    const exactContext = 'x'.repeat(64_000)
    const scenarios = [
      {
        name: 'valid canonical with invalid alias',
        fields: { maxContextBytes: 500, max_context_bytes: 'invalid-alias' },
        diagnostic: { code: 'profile_max_context_bytes_invalid', field: 'max_context_bytes' },
        representations: ['maxContextBytes', 'max_context_bytes'],
        canonical: 'maxContextBytes',
        repairedValue: 600,
        repair: (profile: ReturnType<typeof parseGitLabProjectProfiles>[number]) => ({
          ...profile,
          maxContextBytes: 600,
        }),
      },
      {
        name: 'invalid canonical with valid alias',
        fields: { maxContextBytes: 'invalid-canonical', max_context_bytes: 500 },
        diagnostic: { code: 'profile_max_context_bytes_invalid', field: 'maxContextBytes' },
        representations: ['maxContextBytes', 'max_context_bytes'],
        canonical: 'maxContextBytes',
        repairedValue: 600,
        repair: (profile: ReturnType<typeof parseGitLabProjectProfiles>[number]) => ({
          ...profile,
          maxContextBytes: 600,
        }),
      },
      {
        name: 'explicit null with valid alias',
        fields: { reviewFocus: null, review_focus: ['legacy'] },
        diagnostic: { code: 'profile_review_focus_invalid', field: 'reviewFocus' },
        representations: ['reviewFocus', 'review_focus'],
        canonical: 'reviewFocus',
        repairedValue: ['security'],
        repair: (profile: ReturnType<typeof parseGitLabProjectProfiles>[number]) => ({
          ...profile,
          reviewFocus: ['security'],
        }),
      },
      {
        name: 'exact canonical context with oversized alias',
        fields: { reviewContextMarkdown: exactContext, context_markdown: `${exactContext}x` },
        diagnostic: { code: 'profile_review_context_too_large', field: 'context_markdown' },
        representations: [
          'reviewContextMarkdown',
          'review_context_markdown',
          'contextMarkdown',
          'context_markdown',
        ],
        canonical: 'reviewContextMarkdown',
        repairedValue: 'Repaired context',
        repair: (profile: ReturnType<typeof parseGitLabProjectProfiles>[number]) => ({
          ...profile,
          reviewContextMarkdown: 'Repaired context',
        }),
      },
    ] as const

    for (const scenario of scenarios) {
      const document = parseGitLabProjectProfileDocument([{
        id: `profile-${scenario.name}`,
        host: 'gitlab.example.com',
        projectId: 3,
        nine1botProjectID: 'project-uf',
        displayName: 'Before edit',
        extensionField: { preserve: scenario.name },
        ...scenario.fields,
      }])
      expect(document.editable, scenario.name).toHaveLength(1)
      const updated = updateGitLabProjectProfileDocument(document, 0, {
        ...document.editable[0]!.profile,
        displayName: 'After edit',
      })

      expect(updated.entries[0], scenario.name).toMatchObject({
        ...scenario.fields,
        displayName: 'After edit',
        extensionField: { preserve: scenario.name },
      })
      expect(JSON.parse(renderGitLabProjectProfileDocument(updated))[0], scenario.name)
        .toEqual(updated.entries[0])
      expect(validateGitLabProjectProfileDocument(updated), scenario.name).toEqual([
        expect.objectContaining(scenario.diagnostic),
      ])
      expect(serializeGitLabProjectProfileDocument(updated), scenario.name).toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining(scenario.diagnostic)],
      })

      const repaired = updateGitLabProjectProfileDocument(updated, 0, scenario.repair(updated.editable[0]!.profile))
      const repairedEntry = repaired.entries[0] as Record<string, unknown>
      expect(repairedEntry[scenario.canonical], scenario.name).toEqual(scenario.repairedValue)
      for (const key of scenario.representations) {
        if (key !== scenario.canonical) expect(repairedEntry, scenario.name).not.toHaveProperty(key)
      }
      expect(repairedEntry.extensionField, scenario.name).toEqual({ preserve: scenario.name })
      const serialized = serializeGitLabProjectProfileDocument(repaired)
      expect(serialized.ok, scenario.name).toBe(true)
    }
  })

  test('keeps an invalid identity canonical editable through its valid alias and repairs both keys', () => {
    const document = parseGitLabProjectProfileDocument([{
      id: 'identity-collision',
      host: 'gitlab.example.com',
      projectId: { malformed: true },
      project_id: 3,
      nine1botProjectID: 'project-uf',
      displayName: 'Before edit',
      extensionField: 'preserved',
    }])

    expect(document.editable).toHaveLength(1)
    const updated = updateGitLabProjectProfileDocument(document, 0, {
      ...document.editable[0]!.profile,
      displayName: 'After edit',
    })
    expect(updated.entries[0]).toMatchObject({
      projectId: { malformed: true },
      project_id: 3,
      displayName: 'After edit',
      extensionField: 'preserved',
    })
    expect(validateGitLabProjectProfileDocument(updated)).toEqual([
      expect.objectContaining({ code: 'profile_project_id_missing', field: 'projectId' }),
    ])
    expect(serializeGitLabProjectProfileDocument(updated)).toMatchObject({ ok: false })

    const repaired = updateGitLabProjectProfileDocument(updated, 0, {
      ...updated.editable[0]!.profile,
      projectId: 4,
    })
    expect(repaired.entries[0]).toMatchObject({ projectId: 4, extensionField: 'preserved' })
    expect(repaired.entries[0]).not.toHaveProperty('project_id')
    expect(serializeGitLabProjectProfileDocument(repaired)).toMatchObject({ ok: true })
  })

  test('validates CI aliases independently and only canonicalizes explicitly changed CI fields', () => {
    const document = parseGitLabProjectProfileDocument([{
      id: 'ci-collision',
      host: 'gitlab.example.com',
      projectId: 3,
      nine1botProjectID: 'project-uf',
      displayName: 'Before edit',
      ci: {
        maxJobLogs: 4,
        max_job_logs: 0,
        maxFailedJobs: 'four',
        max_failed_jobs: null,
        maxJobLogBytes: 8_000,
        max_job_log_bytes: null,
        extensionLimit: 12,
      },
    }])
    const updated = updateGitLabProjectProfileDocument(document, 0, {
      ...document.editable[0]!.profile,
      displayName: 'After edit',
    })

    expect(updated.entries[0]).toEqual(expect.objectContaining({
      displayName: 'After edit',
      ci: {
        maxJobLogs: 4,
        max_job_logs: 0,
        maxFailedJobs: 'four',
        max_failed_jobs: null,
        maxJobLogBytes: 8_000,
        max_job_log_bytes: null,
        extensionLimit: 12,
      },
    }))
    expect(validateGitLabProjectProfileDocument(updated).map(({ code, field }) => ({ code, field }))).toEqual([
      { code: 'profile_ci_max_job_logs_invalid', field: 'max_job_logs' },
      { code: 'profile_ci_max_job_logs_invalid', field: 'maxFailedJobs' },
      { code: 'profile_ci_max_job_logs_invalid', field: 'max_failed_jobs' },
      { code: 'profile_ci_max_job_log_bytes_invalid', field: 'max_job_log_bytes' },
    ])

    const logsRepaired = updateGitLabProjectProfileDocument(updated, 0, {
      ...updated.editable[0]!.profile,
      ci: { ...updated.editable[0]!.profile.ci, maxJobLogs: 5 },
    })
    expect(logsRepaired.entries[0]).toEqual(expect.objectContaining({
      ci: {
        maxJobLogs: 5,
        maxJobLogBytes: 8_000,
        max_job_log_bytes: null,
        extensionLimit: 12,
      },
    }))
    expect(validateGitLabProjectProfileDocument(logsRepaired)).toEqual([
      expect.objectContaining({
        code: 'profile_ci_max_job_log_bytes_invalid',
        field: 'max_job_log_bytes',
      }),
    ])
    expect(serializeGitLabProjectProfileDocument(logsRepaired)).toMatchObject({ ok: false })

    const repaired = updateGitLabProjectProfileDocument(logsRepaired, 0, {
      ...logsRepaired.editable[0]!.profile,
      ci: { ...logsRepaired.editable[0]!.profile.ci, maxJobLogBytes: 9_000 },
    })
    expect(repaired.entries[0]).toEqual(expect.objectContaining({
      ci: { maxJobLogs: 5, maxJobLogBytes: 9_000, extensionLimit: 12 },
    }))
    expect(serializeGitLabProjectProfileDocument(repaired)).toMatchObject({ ok: true })
  })

  test('preserves an explicit null CI object until a nested CI field is changed', () => {
    const document = parseGitLabProjectProfileDocument([{
      id: 'null-ci',
      host: 'gitlab.example.com',
      projectId: 3,
      nine1botProjectID: 'project-uf',
      displayName: 'Before edit',
      ci: null,
      extensionField: true,
    }])
    const updated = updateGitLabProjectProfileDocument(document, 0, {
      ...document.editable[0]!.profile,
      displayName: 'After edit',
    })

    expect(updated.entries[0]).toMatchObject({ ci: null, displayName: 'After edit', extensionField: true })
    expect(validateGitLabProjectProfileDocument(updated)).toEqual([
      expect.objectContaining({ code: 'profile_ci_invalid', field: 'ci' }),
    ])
    expect(serializeGitLabProjectProfileDocument(updated)).toMatchObject({ ok: false })

    const repaired = updateGitLabProjectProfileDocument(updated, 0, {
      ...updated.editable[0]!.profile,
      ci: { ...updated.editable[0]!.profile.ci, maxJobLogs: 5 },
    })
    expect(repaired.entries[0]).toMatchObject({ ci: { maxJobLogs: 5 }, extensionField: true })
    expect(serializeGitLabProjectProfileDocument(repaired)).toMatchObject({ ok: true })
  })

  test('blocks invalid canonical limits and preserves them through unrelated edits until repair', () => {
    const document = parseGitLabProjectProfileDocument([{
      id: 'invalid-canonical',
      host: 'gitlab.example.com',
      projectId: 3,
      nine1botProjectID: 'project-uf',
      displayName: 'Before edit',
      maxContextBytes: '500',
      maxFiles: -2,
    }])

    expect(validateGitLabProjectProfileDocument(document).map(({ code }) => code)).toEqual([
      'profile_max_context_bytes_invalid',
      'profile_max_files_invalid',
    ])
    const updated = updateGitLabProjectProfileDocument(document, 0, {
      ...document.editable[0]!.profile,
      displayName: 'After edit',
    })
    expect(updated.entries[0]).toMatchObject({
      displayName: 'After edit',
      maxContextBytes: '500',
      maxFiles: -2,
    })
    expect(serializeGitLabProjectProfileDocument(updated)).toMatchObject({
      ok: false,
      diagnostics: [
        { code: 'profile_max_context_bytes_invalid' },
        { code: 'profile_max_files_invalid' },
      ],
    })

    const repaired = updateGitLabProjectProfileDocument(updated, 0, {
      ...updated.editable[0]!.profile,
      maxContextBytes: 500,
      maxFiles: 2,
    })
    const serialized = serializeGitLabProjectProfileDocument(repaired)
    expect(serialized.ok).toBe(true)
    if (!serialized.ok) throw new Error('expected repaired limits to serialize')
    expect(JSON.parse(serialized.value)[0]).toMatchObject({ maxContextBytes: 500, maxFiles: 2 })
  })

  test('blocks invalid limit aliases and preserves the original aliases on unrelated edits', () => {
    const document = parseGitLabProjectProfileDocument([{
      id: 'invalid-aliases',
      host: 'gitlab.example.com',
      project_id: 3,
      nine1bot_project_id: 'project-uf',
      display_name: 'Before edit',
      max_context_bytes: Number.POSITIVE_INFINITY,
      max_files: '20',
    }])
    const updated = updateGitLabProjectProfileDocument(document, 0, {
      ...document.editable[0]!.profile,
      displayName: 'After edit',
    })

    expect(validateGitLabProjectProfileDocument(updated).map(({ code }) => code)).toEqual([
      'profile_max_context_bytes_invalid',
      'profile_max_files_invalid',
    ])
    expect(updated.entries[0]).toMatchObject({
      displayName: 'After edit',
      max_context_bytes: Number.POSITIVE_INFINITY,
      max_files: '20',
    })
    expect(updated.entries[0]).not.toHaveProperty('maxContextBytes')
    expect(updated.entries[0]).not.toHaveProperty('maxFiles')
  })

  test('matches the backend stored-context boundary and preserves oversized alias input', () => {
    const exactContext = 'x'.repeat(64_000)
    for (const sourceKey of [
      'reviewContextMarkdown',
      'review_context_markdown',
      'contextMarkdown',
      'context_markdown',
    ]) {
      const exactDocument = parseGitLabProjectProfileDocument([{
        id: `exact-${sourceKey}`,
        host: 'gitlab.example.com',
        projectId: 3,
        nine1botProjectID: 'project-uf',
        [sourceKey]: exactContext,
      }])
      expect(validateGitLabProjectProfileDocument(exactDocument), sourceKey).toEqual([])

      const oversizedDocument = parseGitLabProjectProfileDocument([{
        id: `oversized-${sourceKey}`,
        host: 'gitlab.example.com',
        projectId: 3,
        nine1botProjectID: 'project-uf',
        [sourceKey]: `${exactContext}x`,
      }])
      expect(validateGitLabProjectProfileDocument(oversizedDocument), sourceKey).toEqual([
        expect.objectContaining({ code: 'profile_review_context_too_large', field: sourceKey }),
      ])
    }

    const exact = parseGitLabProjectProfileDocument([{
      id: 'exact-context',
      host: 'gitlab.example.com',
      projectId: 3,
      nine1botProjectID: 'project-uf',
      reviewContextMarkdown: exactContext,
    }])
    expect(validateGitLabProjectProfileDocument(exact)).toEqual([])

    const oversized = parseGitLabProjectProfileDocument([{
      id: 'oversized-context',
      host: 'gitlab.example.com',
      project_id: 4,
      nine1bot_project_id: 'project-other',
      context_markdown: `${exactContext}x`,
      display_name: 'Before edit',
    }])
    const updated = updateGitLabProjectProfileDocument(oversized, 0, {
      ...oversized.editable[0]!.profile,
      displayName: 'After edit',
    })

    expect(validateGitLabProjectProfileDocument(updated)).toEqual([
      expect.objectContaining({ code: 'profile_review_context_too_large' }),
    ])
    expect(updated.entries[0]).toMatchObject({
      context_markdown: `${exactContext}x`,
      displayName: 'After edit',
    })
    expect(updated.entries[0]).not.toHaveProperty('reviewContextMarkdown')
    expect(serializeGitLabProjectProfileDocument(updated)).toMatchObject({ ok: false })
  })
})

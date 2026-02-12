/**
 * Page scripts for browser automation
 *
 * These are pure browser-side scripts that can be injected via:
 * - CDP mode: Runtime.evaluate(expression)
 * - Extension mode: the Extension already has equivalent tools (read_page, find, computer, form_input)
 *
 * Each module exports a build*Expression() function that returns a self-executing
 * JS expression string. The expression takes serialized arguments and returns
 * a JSON string result.
 */

export { buildSnapshotExpression, type SnapshotOptions } from './snapshot'
export { buildFindExpression, type FindMatch } from './find'
export { buildResolveRefExpression, buildScrollIntoViewExpression, type ResolvedElement } from './resolve-ref'
export { buildFormFillExpression, type FormFillResult } from './form-fill'

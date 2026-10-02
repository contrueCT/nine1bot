/** Session diffs are published only after their snapshot has been persisted. */
export function isCurrentSessionDiff(
  event: { type?: string; properties?: { sessionID?: string } } | undefined,
  sessionId: string | undefined,
): boolean {
  return Boolean(sessionId && event?.type === 'session.diff' && event.properties?.sessionID === sessionId)
}

/**
 * Start every enabled page load without letting a slow site queue the others.
 * Each source owns its own WebContents/session, so these navigations are
 * independent. A failure is surfaced by that source's normal status probe.
 */
export async function loadSourcesInParallel<T extends { enabled: boolean }>(
  sources: readonly T[],
  load: (source: T) => Promise<unknown>
): Promise<void> {
  await Promise.all(sources.filter(source => source.enabled).map(async source => {
    try {
      await load(source);
    } catch {
      // The channel status is the user-facing error path; one failed page must
      // not keep another source from starting or reject the startup batch.
    }
  }));
}

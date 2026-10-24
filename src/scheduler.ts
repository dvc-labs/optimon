// Schedule the next report only after the previous one settles: never overlap.
// The first report happens after one full interval, not alongside the startup embed.
export function scheduleReports(
  task: () => Promise<void>,
  intervalMs: number,
  onError: (error: unknown) => void,
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout;
  function schedule(): void {
    timer = setTimeout(() => {
      run().catch(onError);
    }, intervalMs);
  }
  async function run(): Promise<void> {
    try {
      await task();
    } catch (error) {
      onError(error);
    } finally {
      if (!stopped) schedule();
    }
  }
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

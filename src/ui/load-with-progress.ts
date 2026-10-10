import { BorderedLoader, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type Result<T> = { kind: "ok"; value: T } | { kind: "error"; error: unknown } | { kind: "cancel" };

/** Cancellation stops discovery/waiting, never the user's active agent task. */
export async function loadWithProgress<T>(ctx: ExtensionCommandContext, work: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  const result = await ctx.ui.custom<Result<T>>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, "pi-go：等待当前任务结束并加载项目 / 会话…");
    const abort = new AbortController();
    let closed = false;
    const finish = (value: Result<T>) => {
      if (closed) return;
      closed = true;
      done(value);
    };
    loader.onAbort = () => { abort.abort(); finish({ kind: "cancel" }); };
    // Attach the component before work can complete, so custom UI always disposes the spinner.
    const scheduled = setImmediate(() => {
      if (abort.signal.aborted) return;
      void work(abort.signal).then(
        value => finish({ kind: "ok", value }),
        error => { if (!abort.signal.aborted) finish({ kind: "error", error }); },
      );
    });
    return {
      render: (width: number) => loader.render(width),
      invalidate: () => loader.invalidate(),
      handleInput: (data: string) => loader.handleInput(data),
      dispose: () => { closed = true; clearImmediate(scheduled); abort.abort(); loader.dispose(); },
    };
  });
  if (result.kind === "error") throw result.error;
  return result.kind === "ok" ? result.value : undefined;
}

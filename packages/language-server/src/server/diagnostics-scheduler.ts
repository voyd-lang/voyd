export type DiagnosticsRun = {
  isCurrent: () => boolean;
};

export class DiagnosticsScheduler {
  #runId = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;

  schedule({
    delayMs,
    publish,
  }: {
    delayMs: number;
    publish: (run: DiagnosticsRun) => Promise<void> | void;
  }): void {
    this.#runId += 1;
    const runId = this.#runId;

    if (this.#timer) {
      clearTimeout(this.#timer);
    }

    this.#timer = setTimeout(() => {
      void Promise.resolve(
        publish({
          isCurrent: () => runId === this.#runId,
        }),
      );
    }, delayMs);
  }

  dispose(): void {
    if (!this.#timer) {
      return;
    }
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

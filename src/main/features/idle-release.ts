/** One cancellable deadline per detached surface. Repeated layout passes don't postpone it. */
export class IdleRelease {
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly release: () => void, private readonly delayMs = 60_000) {}
  arm(): void {
    this.timer ??= setTimeout(() => { this.timer = null; this.release(); }, this.delayMs);
    this.timer.unref();
  }
  cancel(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }
}

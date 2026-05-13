export type ReporterState = "ok" | "delay" | "fail" | "offline";

export type ReporterListener = (state: ReporterState, message: string) => void;

/**
 * Reporter tracks the connection status and notifies subscribers.
 * Framework-agnostic: no Svelte imports. The Svelte UI subscribes via `subscribe()`.
 *
 * State precedence (highest wins):
 *   offline > fail > delay > ok
 *
 * ``offline`` is set by the connection layer when the browser fires
 * the ``offline`` window event; cleared via ``success()`` on
 * ``online`` *after* the SSE stream reopens. While offline, transient
 * ``delay`` / ``fail`` from the inevitable POST/SSE failures don't
 * flap the banner — the user already knows.
 */
export class Reporter {
  state: ReporterState = "ok";
  message: string = "";
  private setAt: number = 0;
  private listeners: ReporterListener[] = [];

  subscribe(listener: ReporterListener): () => void {
    this.listeners.push(listener);
    // Return unsubscribe function
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private notify() {
    for (const listener of this.listeners) {
      listener(this.state, this.message);
    }
  }

  success() {
    if (
      this.state === "fail" &&
      this.setAt > Date.now() - 1000 * 10
    ) {
      setTimeout(() => this.success(), 5000);
    } else {
      this.state = "ok";
      this.message = "";
      this.setAt = 0;
      this.notify();
    }
  }

  failure(err: Error | string) {
    // Don't overwrite "offline" with a downstream fetch failure that's
    // a consequence of being offline — the offline banner is more
    // actionable than e.g. "Send failed: 0".
    if (this.state === "offline") return;
    this.show("fail", err instanceof Error ? err.message : String(err));
  }

  delay(err: Error | string) {
    if (this.state === "fail" || this.state === "offline") return;
    this.show("delay", err instanceof Error ? err.message : String(err));
  }

  offline() {
    this.show(
      "offline",
      "You're offline. Your changes will sync when you reconnect.",
    );
  }

  private show(type: "fail" | "delay" | "offline", message: string) {
    this.state = type;
    this.message = message;
    this.setAt = Date.now();
    this.notify();
  }
}

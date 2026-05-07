export type ReporterState = "ok" | "delay" | "fail";

export type ReporterListener = (state: ReporterState, message: string) => void;

/**
 * Reporter tracks the connection status and notifies subscribers.
 * Framework-agnostic: no Svelte imports. The Svelte UI subscribes via `subscribe()`.
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
    this.show("fail", err instanceof Error ? err.message : String(err));
  }

  delay(err: Error | string) {
    if (this.state === "fail") return;
    this.show("delay", err instanceof Error ? err.message : String(err));
  }

  private show(type: "fail" | "delay", message: string) {
    this.state = type;
    this.message = message;
    this.setAt = Date.now();
    this.notify();
  }
}

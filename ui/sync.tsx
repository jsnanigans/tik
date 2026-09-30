import React, { useEffect } from "react";
import { Text, useApp } from "ink";
import { C, progressBar, formatElapsed } from "../lib";
import { renderInteractive } from "./render";

type CompletedPhase = { label: string; count: number };

type SyncState = {
  mode: string;
  phases: CompletedPhase[];
  active: { label: string; fetched: number; total: number } | null;
  startedAt: number;
  error?: string;
  done?: string;
};

function SyncView({ state }: { state: SyncState }): JSX.Element {
  const { exit } = useApp();

  useEffect(() => {
    if (state.done || state.error) exit();
  }, [state.done, state.error, exit]);

  if (state.error) {
    return <Text>{state.error}</Text>;
  }

  if (state.done) {
    return <Text>{state.done}</Text>;
  }

  const elapsed = formatElapsed(Date.now() - state.startedAt);
  const parts: string[] = [state.mode];

  for (const p of state.phases) {
    parts.push(`${C.green}✓${C.reset} ${p.count} ${p.label}`);
  }

  if (state.active) {
    const { label, fetched, total } = state.active;
    if (total > 0) {
      const pct = Math.round((fetched / total) * 100);
      parts.push(`${progressBar(pct, 20)} ${fetched}/${total} ${label}`);
    } else {
      parts.push(`${C.dim}${label}...${C.reset}`);
    }
  }

  parts.push(`${C.dim}${elapsed}${C.reset}`);
  return <Text>{parts.join("  ")}</Text>;
}

export class SyncProgress {
  private state: SyncState;
  private ui: ReturnType<typeof renderInteractive>;
  private timer: ReturnType<typeof setInterval>;

  constructor(mode: string) {
    this.state = {
      mode,
      phases: [],
      active: null,
      startedAt: Date.now(),
    };
    this.ui = renderInteractive(React.createElement(SyncView, { state: this.state }));
    this.timer = setInterval(() => this.render(), 1000);
  }

  startPhase(label: string): void {
    if (this.state.active) {
      this.state.phases.push({
        label: this.state.active.label,
        count: this.state.active.fetched,
      });
    }
    this.state.active = { label, fetched: 0, total: 0 };
    this.render();
  }

  update(fetched: number, total: number): void {
    if (this.state.active) {
      this.state.active = { ...this.state.active, fetched, total };
      this.render();
    }
  }

  async done(message: string): Promise<void> {
    clearInterval(this.timer);
    const elapsed = formatElapsed(Date.now() - this.state.startedAt);
    this.state.done = `${message}  ${C.dim}${elapsed}${C.reset}`;
    this.state.active = null;
    this.render();
    await this.ui.waitUntilExit();
  }

  async error(message: string): Promise<void> {
    clearInterval(this.timer);
    this.state.error = message;
    this.state.active = null;
    this.render();
    await this.ui.waitUntilExit();
  }

  private render(): void {
    this.ui.rerender(React.createElement(SyncView, { state: { ...this.state } }));
  }
}

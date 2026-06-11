import * as process from "node:process";

export interface LogEvent {
  tool: string;
  args: unknown;
  ok: boolean;
  durMs: number;
  error?: string;
}

export type Logger = (event: LogEvent) => void;

export function makeLogger(serverName: string, quiet: boolean): Logger {
  if (quiet) return () => {};
  return (event) => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      server: serverName,
      ...event,
    });
    process.stderr.write(line + "\n");
  };
}

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as process from "node:process";
import type { Writable } from "node:stream";

// Keeps Windows awake (system + display) only while the counted work below is active.
// Uses SetThreadExecutionState via a long-lived PowerShell helper so sleep resumes as soon
// as the model is done responding. SetThreadExecutionState alone does NOT stop a screensaver
// or inactivity-policy workstation lock, since those are driven by the OS's last-input-time
// tracker rather than the display/system idle timers. A .NET Timer (independent of the
// blocking stdin read below) also taps an unmapped virtual key (VK_F15) periodically while
// holding, which resets the input idle timer without producing any visible keystroke.
const HOLD_SCRIPT = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace LmStudioTools {
  public static class Power {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    const uint Continuous = 0x80000000;
    const uint SystemRequired = 0x00000001;
    const uint DisplayRequired = 0x00000002;
    const byte VkF15 = 0x7E;
    const uint KeyUp = 0x0002;

    static volatile bool holding;
    static Timer jiggleTimer;

    public static void Start() {
      jiggleTimer = new Timer(Jiggle, null, 30000, 30000);
    }

    static void Jiggle(object state) {
      if (!holding) return;
      keybd_event(VkF15, 0, 0, UIntPtr.Zero);
      keybd_event(VkF15, 0, KeyUp, UIntPtr.Zero);
    }

    public static void Hold() {
      holding = true;
      SetThreadExecutionState(Continuous | SystemRequired | DisplayRequired);
    }

    public static void Release() {
      holding = false;
      SetThreadExecutionState(Continuous);
    }
  }
}
'@
[LmStudioTools.Power]::Start()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq "hold") {
    [LmStudioTools.Power]::Hold()
  } elseif ($line -eq "release") {
    [LmStudioTools.Power]::Release()
  }
}
[LmStudioTools.Power]::Release()
`;

const disabled = process.platform !== "win32" || process.env.VITEST === "true";

type WakeLockProcess = ChildProcessByStdio<Writable, null, null>;

let child: WakeLockProcess | null = null;
let starting: Promise<WakeLockProcess | null> | null = null;
let refCount = 0;

async function ensureChild(): Promise<WakeLockProcess | null> {
  if (disabled) return null;
  if (child) return child;
  if (!starting) {
    starting = (async () => {
      const scriptPath = path.join(os.tmpdir(), `lmstudio-tools-wake-lock-${process.pid}.ps1`);
      await fs.writeFile(scriptPath, HOLD_SCRIPT, "utf8");
      const powershellPath = path.join(
        process.env.SystemRoot ?? String.raw`C:\Windows`,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      );
      const proc = spawn(
        powershellPath,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        { stdio: ["pipe", "ignore", "ignore"] }
      );
      proc.unref();
      proc.on("exit", () => { if (child === proc) child = null; });
      proc.on("error", () => { if (child === proc) child = null; });
      child = proc;
      return proc;
    })();
  }
  try {
    return await starting;
  } catch {
    return null;
  } finally {
    starting = null;
  }
}

/** Prevents system/display sleep until every matching release() call has happened. */
export async function acquireWakeLock(): Promise<void> {
  refCount += 1;
  if (refCount !== 1) return;
  try {
    const proc = await ensureChild();
    proc?.stdin.write("hold\n");
  } catch {
    // Best-effort only: narration proceeds even if the OS refuses to stay awake.
  }
}

export function releaseWakeLock(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount !== 0) return;
  try {
    child?.stdin.write("release\n");
  } catch {
    // Helper process may already be gone; nothing left to release.
  }
}

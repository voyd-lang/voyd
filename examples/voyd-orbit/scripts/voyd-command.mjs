import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function voydCommand(rootDir, args) {
  const sourceCli = resolve(rootDir, "../../scripts/voyd");
  if (existsSync(sourceCli)) {
    return {
      command: process.execPath,
      args: [sourceCli, ...args],
      env: { ...process.env, VOYD_USE_SRC: "1" },
    };
  }

  return {
    command: process.platform === "win32" ? "voyd.cmd" : "voyd",
    args,
    env: process.env,
  };
}

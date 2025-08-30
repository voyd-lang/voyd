// Minimal debug logging for inference hot paths.
// Enable with VOYD_DEBUG_INFER=1

const DEBUG = !!process.env.VOYD_DEBUG_INFER && process.env.VOYD_DEBUG_INFER !== "0";

let depth = 0;

export const pushInfer = (label?: string) => {
  if (DEBUG) {
    // eslint-disable-next-line no-console
    if (label) console.log(`${" ".repeat(depth * 2)}[infer] ${label}`);
  }
  depth += 1;
};

export const popInfer = () => {
  depth = Math.max(0, depth - 1);
};

export const logInfer = (msg: string) => {
  if (!DEBUG) return;
  // eslint-disable-next-line no-console
  console.log(`${" ".repeat(depth * 2)}[infer] ${msg}`);
};


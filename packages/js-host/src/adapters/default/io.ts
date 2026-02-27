import type { NodeWritableWithWrite } from "./types.js";

export const writeToNodeStream = async ({
  stream,
  value,
}: {
  stream: NodeWritableWithWrite;
  value: string | Uint8Array;
}): Promise<void> =>
  new Promise((resolve, reject) => {
    try {
      stream.write(value, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });

export const flushNodeStream = async (
  stream: NodeWritableWithWrite
): Promise<void> => {
  if (!stream.writableNeedDrain) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: unknown): void => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const cleanup = (): void => {
      stream.removeListener("drain", onDrain);
      stream.removeListener("error", onError);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
};

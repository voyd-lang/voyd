type BufferLike = {
  from(data: Uint8Array): { toString(encoding: "base64"): string };
};

const getBuffer = (): BufferLike | undefined => {
  const buffer = (globalThis as { Buffer?: BufferLike }).Buffer;
  return buffer && typeof buffer.from === "function" ? buffer : undefined;
};

const getBtoa = (): ((data: string) => string) | undefined =>
  (globalThis as { btoa?: (data: string) => string }).btoa;

const toBinaryString = (data: Uint8Array): string => {
  let result = "";
  for (let index = 0; index < data.length; index += 1) {
    result += String.fromCharCode(data[index]!);
  }
  return result;
};

export const toBase64 = (data: Uint8Array): string => {
  const buffer = getBuffer();
  if (buffer) {
    return buffer.from(data).toString("base64");
  }

  const btoa = getBtoa();
  if (btoa) {
    return btoa(toBinaryString(data));
  }

  throw new Error("Base64 encoding is unavailable in this environment");
};

import {
  fsSuccessPayload,
  globalRecord,
  hostError,
  isRecord,
  joinListDirChildPath,
  normalizeByte,
  readField,
  toNumberOrUndefined,
  toPath,
  toStringOrUndefined,
} from "../helpers.js";
import { maybeNodeFs } from "../runtime-imports.js";
import {
  opEntries,
  registerMissingOpHandlers,
  registerOpHandler,
  registerUnsupportedHandlers,
} from "../registration.js";
import { FS_EFFECT_ID, type CapabilityDefinition } from "../types.js";

export const fsCapabilityDefinition: CapabilityDefinition = {
  capability: "fs",
  effectId: FS_EFFECT_ID,
  register: async ({ host, runtime, diagnostics, effectBufferSize }) => {
    const entries = opEntries({ host, effectId: FS_EFFECT_ID });
    if (entries.length === 0) {
      return 0;
    }

    const nodeFs = runtime === "node" ? await maybeNodeFs() : undefined;
    const deno =
      runtime === "deno" ? (globalRecord.Deno as Record<string, unknown>) : undefined;
    const denoReadFile = deno?.readFile as
      | ((path: string) => Promise<Uint8Array>)
      | undefined;
    const denoReadTextFile = deno?.readTextFile as
      | ((path: string) => Promise<string>)
      | undefined;
    const denoWriteFile = deno?.writeFile as
      | ((path: string, data: Uint8Array) => Promise<void>)
      | undefined;
    const denoWriteTextFile = deno?.writeTextFile as
      | ((path: string, data: string) => Promise<void>)
      | undefined;
    const denoStat = deno?.stat as ((path: string) => Promise<unknown>) | undefined;
    const denoReadDir = deno?.readDir as
      | ((path: string) => AsyncIterable<{ name: string }>)
      | undefined;

    const hasNodeFs = !!nodeFs;
    const hasDenoFs =
      !!denoReadFile &&
      !!denoReadTextFile &&
      !!denoWriteFile &&
      !!denoWriteTextFile &&
      !!denoStat &&
      !!denoReadDir;

    if (!hasNodeFs && !hasDenoFs) {
      return registerUnsupportedHandlers({
        host,
        effectId: FS_EFFECT_ID,
        capability: "fs",
        runtime,
        reason: "filesystem APIs are not available",
        diagnostics,
      });
    }

    const implementedOps = new Set<string>();
    let registered = 0;
    const ioErrorCode = (error: unknown): number => {
      const errno = isRecord(error) ? readField(error, "errno") : undefined;
      const parsed = toNumberOrUndefined(errno);
      return parsed === undefined ? 1 : parsed;
    };
    const ioErrorMessage = (error: unknown): string =>
      error instanceof Error ? error.message : String(error);

    registered += registerOpHandler({
      host,
      effectId: FS_EFFECT_ID,
      opName: "read_bytes",
      handler: async ({ tail }, path) => {
        try {
          const resolvedPath = toPath(path);
          const bytes = hasNodeFs
            ? await nodeFs!.readFile(resolvedPath)
            : await denoReadFile!(resolvedPath);
          if (bytes.byteLength > effectBufferSize) {
            return tail(
              hostError(
                `Default fs adapter read_bytes response exceeds effect transport buffer (${effectBufferSize} bytes). Increase createVoydHost({ bufferSize }) or read a smaller payload.`
              )
            );
          }
          return tail(
            fsSuccessPayload({
              opName: "read_bytes",
              value: Array.from(bytes.values()),
              effectBufferSize,
            })
          );
        } catch (error) {
          return tail(hostError(ioErrorMessage(error), ioErrorCode(error)));
        }
      },
    });
    implementedOps.add("read_bytes");

    registered += registerOpHandler({
      host,
      effectId: FS_EFFECT_ID,
      opName: "read_string",
      handler: async ({ tail }, path) => {
        try {
          const resolvedPath = toPath(path);
          const value = hasNodeFs
            ? new TextDecoder().decode(await nodeFs!.readFile(resolvedPath))
            : await denoReadTextFile!(resolvedPath);
          return tail(
            fsSuccessPayload({
              opName: "read_string",
              value,
              effectBufferSize,
            })
          );
        } catch (error) {
          return tail(hostError(ioErrorMessage(error), ioErrorCode(error)));
        }
      },
    });
    implementedOps.add("read_string");

    registered += registerOpHandler({
      host,
      effectId: FS_EFFECT_ID,
      opName: "write_bytes",
      handler: async ({ tail }, payload) => {
        try {
          const pathValue = toPath(readField(payload, "path"));
          const bytesValue = readField(payload, "bytes");
          const rawBytes = Array.isArray(bytesValue) ? bytesValue : [];
          const bytes = Uint8Array.from(rawBytes.map(normalizeByte));
          if (hasNodeFs) {
            await nodeFs!.writeFile(pathValue, bytes);
          } else {
            await denoWriteFile!(pathValue, bytes);
          }
          return tail({ ok: true });
        } catch (error) {
          return tail(hostError(ioErrorMessage(error), ioErrorCode(error)));
        }
      },
    });
    implementedOps.add("write_bytes");

    registered += registerOpHandler({
      host,
      effectId: FS_EFFECT_ID,
      opName: "write_string",
      handler: async ({ tail }, payload) => {
        try {
          const pathValue = toPath(readField(payload, "path"));
          const value = toStringOrUndefined(readField(payload, "value")) ?? "";
          if (hasNodeFs) {
            await nodeFs!.writeFile(pathValue, value);
          } else {
            await denoWriteTextFile!(pathValue, value);
          }
          return tail({ ok: true });
        } catch (error) {
          return tail(hostError(ioErrorMessage(error), ioErrorCode(error)));
        }
      },
    });
    implementedOps.add("write_string");

    registered += registerOpHandler({
      host,
      effectId: FS_EFFECT_ID,
      opName: "exists",
      handler: async ({ tail }, path) => {
        try {
          const resolvedPath = toPath(path);
          if (hasNodeFs) {
            await nodeFs!.access(resolvedPath);
          } else {
            await denoStat!(resolvedPath);
          }
          return tail(true);
        } catch {
          return tail(false);
        }
      },
    });
    implementedOps.add("exists");

    registered += registerOpHandler({
      host,
      effectId: FS_EFFECT_ID,
      opName: "list_dir",
      handler: async ({ tail }, path) => {
        try {
          const resolvedPath = toPath(path);
          let names: string[];
          if (hasNodeFs) {
            names = await nodeFs!.readdir(resolvedPath);
          } else {
            names = [];
            for await (const entry of denoReadDir!(resolvedPath)) {
              names.push(entry.name);
            }
          }
          return tail(
            fsSuccessPayload({
              opName: "list_dir",
              value: names.map((name) =>
                joinListDirChildPath({
                  directoryPath: resolvedPath,
                  childName: name,
                })
              ),
              effectBufferSize,
            })
          );
        } catch (error) {
          return tail(hostError(ioErrorMessage(error), ioErrorCode(error)));
        }
      },
    });
    implementedOps.add("list_dir");

    return (
      registered +
      registerMissingOpHandlers({
        host,
        effectId: FS_EFFECT_ID,
        implementedOps,
        diagnostics,
      })
    );
  },
};

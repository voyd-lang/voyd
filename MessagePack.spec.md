# MessagePack Tasks

This document tracks tasks for adding MessagePack serialization between the JS host and Wasm runtime.

## Tasks

- [x] Implement a minimal MessagePack encoder/decoder for JSON-like values (null, booleans, numbers, strings, arrays, objects).
- [x] Support writing encoded data directly into linear memory and decoding from it to enable efficient chunked I/O.
- [x] Add unit tests verifying round-trip serialization between the JS host and a simulated Wasm memory.
- [ ] Extend the codec with additional MessagePack types (binary blobs, 64-bit integers, etc.).
- [ ] Hook the codec into the runtime's streaming interfaces for large payloads.


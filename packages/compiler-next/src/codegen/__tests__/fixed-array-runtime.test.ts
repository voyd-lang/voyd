import { describe, expect, it } from "vitest";
import { getWasmInstance } from "@voyd/lib/wasm.js";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";

const source = `
obj Some<T> { value: T }
obj None {}
pub type Optional<T> = Some<T> | None

trait Iterator<T>
  fn next(self) -> Optional<T>

fn normalize_index(index: i32, length: i32) -> i32
  if index < 0 then: length + index else: index

pub fn new_fixed_array<T>(size: i32) -> FixedArray<T>
  __array_new<T>(size)

pub fn get<T>(arr: FixedArray<T>, index: i32) -> Optional<T>
  let len = __array_len(arr)
  let idx = normalize_index(index, len)

  if idx < 0 then:
    None {}
  else:
    if idx >= len then:
      None {}
    else:
      Some<T> { value: __array_get(arr, idx) }

pub fn set<T>(arr: FixedArray<T>, index: i32, value: T) -> FixedArray<T>
  let len = __array_len(arr)
  let idx = normalize_index(index, len)

  if idx < 0 then:
    arr
  else:
    if idx >= len then:
      arr
    else:
      __array_set(arr, idx, value)
      arr

pub fn copy<T>(dest_array: FixedArray<T>, opts: {
  from: FixedArray<T>,
  to_index: i32,
  from_index: i32,
  count: i32
}) -> FixedArray<T>
  let dest_length = __array_len(dest_array)
  let from_length = __array_len(opts.from)
  let to_index = normalize_index(opts.to_index, dest_length)
  let from_index = normalize_index(opts.from_index, from_length)

  if to_index < 0 then:
    dest_array
  else:
    if from_index < 0 then:
      dest_array
    else:
      if to_index >= dest_length then:
        dest_array
      else:
        if from_index >= from_length then:
          dest_array
        else:
          if opts.count <= 0 then:
            dest_array
          else:
            let remaining_dest = dest_length - to_index
            let remaining_from = from_length - from_index
            let max_copy = if remaining_dest < remaining_from then: remaining_dest else: remaining_from
            let count = if opts.count < max_copy then: opts.count else: max_copy

            if count <= 0 then:
              dest_array
            else:
              __array_copy(dest_array, {
                from: opts.from,
                to_index: to_index,
                from_index: from_index,
                count: count
              })
              dest_array

pub fn length<T>(arr: FixedArray<T>) -> i32
  __array_len(arr)

obj FixedArrayIterator<T> {
  index: i32,
  array: FixedArray<T>
}

impl<T> Iterator<T> for FixedArrayIterator<T>
  fn next(self) -> Optional<T>
    if self.index >= self.array.length<T>() then:
      None {}
    else:
      let value = __array_get(self.array, self.index)
      self.index = self.index + 1
      Some<T> { value: value }

pub fn empty_negative_get() -> i32
  let arr = new_fixed_array<i32>(0)
  let value = arr.get<i32>(-1)
  match(value)
    Some<i32>:
      1
    None:
      0

pub fn tail_negative_get() -> i32
  var arr = new_fixed_array<i32>(2)
  arr = arr.set<i32>(0, 1)
  arr = arr.set<i32>(1, 2)
  let value = arr.get<i32>(-1)
  match(value)
    Some<i32>:
      value.value
    None:
      -1

pub fn set_out_of_bounds_noop() -> i32
  let arr = new_fixed_array<i32>(0)
  arr.set<i32>(-1, 7)
  arr.length<i32>()

pub fn copy_clamps() -> i32
  var dest = new_fixed_array<i32>(2)
  var src = new_fixed_array<i32>(2)
  dest = dest.set<i32>(0, 1)
  dest = dest.set<i32>(1, 2)
  src = src.set<i32>(0, 5)
  src = src.set<i32>(1, 6)
  dest = dest.copy<i32>({
    from: src,
    to_index: 0,
    from_index: 0,
    count: 5
  })
  let first = dest.get<i32>(0)
  let second = dest.get<i32>(1)
  let sum = match(first)
    Some<i32>:
      first.value
    None:
      -100
  match(second)
    Some<i32>:
      sum + second.value
    None:
      sum - 200

pub fn copy_oob_noop() -> i32
  var dest = new_fixed_array<i32>(2)
  dest = dest.set<i32>(0, 1)
  dest = dest.set<i32>(1, 9)
  dest = dest.copy<i32>({
    from: dest,
    to_index: 5,
    from_index: 0,
    count: 1
  })
  let first = dest.get<i32>(0)
  let second = dest.get<i32>(1)
  match(first)
    Some<i32>:
      match(second)
        Some<i32>:
          first.value + second.value
        None:
          -200
    None:
      -1

pub fn iterate_sum() -> i32
  var arr = new_fixed_array<i32>(3)
  arr = arr.set<i32>(0, 3)
  arr = arr.set<i32>(1, 4)
  arr = arr.set<i32>(2, 5)
  var iterator = FixedArrayIterator<i32> { index: 0, array: arr }
  var acc = 0
  var done = false
  while done == false do:
    let step = iterator.next<i32>()
    done = match(step)
      Some<i32>:
        acc = acc + step.value
        false
      None:
        true
  acc
`;

const loadExports = (): Record<string, CallableFunction> => {
  const ast = parse(source, "packages/std_next/fixed_array.voyd");
  const semantics = semanticsPipeline(ast);
  const { module } = codegen(semantics);
  const instance = getWasmInstance(module);
  return instance.exports as Record<string, CallableFunction>;
};

// TODO: Re-enable once compiler-next fixed-array intrinsics fully supported.
describe.skip("std_next FixedArray runtime behavior", () => {
  it("supports negative indexing and out-of-bounds guards", () => {
    const exports = loadExports();
    expect(exports.empty_negative_get()).toBe(0);
    expect(exports.tail_negative_get()).toBe(2);
    expect(exports.set_out_of_bounds_noop()).toBe(0);
  });

  it("clamps copies and iterates all elements", () => {
    const exports = loadExports();
    expect(exports.copy_clamps()).toBe(11);
    expect(exports.copy_oob_noop()).toBe(10);
    expect(exports.iterate_sum()).toBe(12);
  });
});

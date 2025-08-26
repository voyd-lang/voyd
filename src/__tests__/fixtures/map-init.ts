export const mapInitVoyd = `
use std::all

pub fn map_from_pairs() -> i32
  let bucket = new_array<{ key: String, value: i32 }>({ with_size: 1 })
  bucket.push({ key: "a", value: 1 })
  let buckets = new_array<Array<{ key: String, value: i32 }>>({ with_size: 1 })
  buckets.push(bucket)
  let m = Map<i32>(buckets)
  m.get("a").match(v)
    Some<i32>:
      v.value
    None:
      -1
`;

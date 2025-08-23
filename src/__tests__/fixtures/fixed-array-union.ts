export const fixedArrayUnionVoyd = `
use std::all

obj BoxedInt { value: i32 }
obj BoxedStr { value: string }

type StrOrInt = BoxedStr | BoxedInt

pub fn main() -> i32
  let arr: FixedArray<StrOrInt> = FixedArray<StrOrInt>(
    BoxedStr { value: "a" },
    BoxedInt { value: 1 }
  )
  arr.length<StrOrInt>()
`;

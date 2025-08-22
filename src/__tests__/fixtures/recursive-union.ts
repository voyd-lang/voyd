export const recursiveUnionVoyd = `
obj Box<T> { val: T }

type Recursive = Box<Recursive> | Box<i32>

fn find_int(r: Recursive) -> i32
  match(r)
    Box<Recursive>: find_int(r.val)
    Box<i32>: r.val

pub fn main() -> i32
  let r: Recursive = Box<Recursive> { val: Box { val: 5 } }
  find_int(r)
`;

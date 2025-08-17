export const genericTraitVoyd = `
use std::all

trait Trait<T>
  fn id(self) -> T

obj Wrapper<T> {
  value: T
}

impl<T> Trait<T> for Wrapper<T>
  fn id(self) -> T
    self.value

pub fn run() -> i32
  let w = Wrapper<i32> { value: 1 }
  let t: Trait<i32> = w
  t.id()
`;

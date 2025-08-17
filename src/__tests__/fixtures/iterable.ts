export const iterableVoyd = `
use std::all

trait BoxLike<T>
  fn get(self) -> T

obj ValueBox<T> {
  value: T
}

impl<T> BoxLike<T> for ValueBox<T>
  fn get(self) -> T
    self.value

fn take_and_double(b: BoxLike<i32>) -> i32
  b.get() * 2

pub fn run() -> i32
  let b = ValueBox<i32> { value: 4 }
  take_and_double(b)
`;

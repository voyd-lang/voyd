export const nestedGenericTraitParamVoyd = `
use std::all

trait MyIterator<T>
  fn next(self) -> Optional<T>

trait MyIterable<T>
  fn iterate(self) -> MyIterator<T>

obj Box<T> {
  value: T
}

impl<T> MyIterator<T> for Box<T>
  fn next(self) -> Optional<T>
    Some { value: self.value }

impl<T> MyIterable<T> for Box<T>
  fn iterate(self) -> MyIterator<T>
    self

pub fn run() -> i32
  let b = Box<i32> { value: 4 }
  call_iterator(b)

fn call_iterator(it: MyIterable<i32>) -> i32
  let iterator = it.iterate()
  iterator.next().match(o)
    Some<i32>:
      o.value
    None:
      -1
`;

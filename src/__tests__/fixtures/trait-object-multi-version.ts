export const traitObjectMultiVersionVoyd = `
use std::all

trait Iterator<T>
  fn next(self) -> Optional<T>

trait Iterable<T>
  fn iterate(self) -> Iterator<T>

obj Box<T> {
  value: T
}

impl<T> Iterator<T> for Box<T>
  fn next(self) -> Optional<T>
    Some { value: self.value }

impl<T> Iterable<T> for Box<T>
  fn iterate(self) -> Iterator<T>
    self

pub fn run() -> i32
  let bi = Box<i32> { value: 4 }
  let bf = Box<f64> { value: 2.0 }
  let a = bi.sum_iterable()
  let b = bf.sum_iterable()
  if b > 1.5 then:
    a + 1
  else:
    a

fn sum_iterable(it: Iterable<i32>) -> i32
  let iterator = it.iterate()
  iterator.next().match(o)
    Some<i32>:
      o.value
    None:
      -1

fn sum_iterable(it: Iterable<f64>) -> f64
  let iterator = it.iterate()
  iterator.next().match(o)
    Some<f64>:
      o.value
    None:
      -1.0
`;


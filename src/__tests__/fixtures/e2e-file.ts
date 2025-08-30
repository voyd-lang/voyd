export const e2eVoydText = `
use std::all

fn fib(n: i32) -> i32
  if n < 2 then:
    n
  else:
    fib(n - 1) + fib(n - 2)

pub fn main()
  fib(10)

`;

export const kitchenSink = `
use std::all
pub use std::string::all

obj Vec {
  x: i32,
  y: i32
}

obj Point: Vec {
  x: i32,
  y: i32,
  z: i32
}

obj Pointy: Vec {
  x: i32,
  y: i32,
  z: i32
}

obj Bitly: Vec {
  x: i32,
  y: i32,
  z: i32
}

fn get_x(vec: Vec)
  vec.x

fn get_member(vec: Point)
  vec.z

fn get_member(vec: Pointy)
  vec.x

fn get_num_from_vec_sub_obj(vec: Vec)
  match(vec)
    Pointy: get_member(vec)
    Point: get_member(vec)
    else: -1

// Should return 13
pub fn test1()
  let vec = Point { x: 1, y: 2, z: 13 }
  vec.get_member()

// Should return 1
pub fn test2()
  let vec = Pointy { x: 1, y: 2, z: 13 }
  vec.get_member()

// Should return 2
pub fn test3()
  2

// Should return 52
pub fn test4()
  let vec = Point { x: 52, y: 2, z: 21 }
  vec.get_x()

// Test match type guard (Pointy case), should return 52
pub fn test5()
  let vec = Pointy { x: 52, y: 2, z: 21 }
  get_num_from_vec_sub_obj(vec)

// Test match type guard (Point case), should return 21
pub fn test6()
  let vec = Point { x: 52, y: 2, z: 21 }
  get_num_from_vec_sub_obj(vec)

// Test match type guard (else case), should return -1
pub fn test7()
  let vec = Bitly { x: 52, y: 2, z: 21 }
  get_num_from_vec_sub_obj(vec)

type FixedArrayI32 = FixedArray<i32>

// Test generic functions, should return 143
pub fn test8()
  let arr2 = new_fixed_array<f64>(10)
  arr2.set<f64>(0, 1.5)
  arr2.get<f64>(0)

  let arr: FixedArrayI32 = new_fixed_array<i32>(10)
  arr.set<i32>(9, 143)
  arr.get<i32>(9)

obj VecGeneric<T> {
  x: T,
  y: T,
  z: T
}

// Test generic object initialization, should return 7.5
pub fn test9()
  let vec = VecGeneric<i32> { x: 7, y: 2, z: 3 }
  vec.x

  let vec2 = VecGeneric<f64> { x: 7.5, y: 2.5, z: 3.5 }
  vec2.x

// Test generics with sibling object types
fn generic_get_member<T>(vec: T)
  vec.get_member()

// Ensure generic functions with sibling types are called correctly
pub fn test10()
  let point = Point { x: 12, y: 17, z: 4 }
  generic_get_member<Point>(point)

  let pointy = Pointy { x: 12, y: 17, z: 4 }
  generic_get_member<Pointy>(pointy)

// Test generic object inheritance strictness
obj VecBox<T> {
  box: T
}

obj PointF: Vec {
  x: i32,
  y: i32,
  f: i32
}

pub fn test11()
  let pf = PointF { x: 12, y: 17, f: 4 }
  let pf_box = VecBox<PointF> { box: pf }
  pf_box.box.f

pub mod m1
  pub mod m2
    pub fn test()
      597

use m1::m2::{ test as hi }

pub fn test12()
  hi()

impl<T> VecGeneric<T>
  fn add(self, v: VecGeneric<T>) -> VecGeneric<T>
    VecGeneric<T> { x: self.x + v.x, y: self.y + v.y, z: self.z + v.z }

  pub fn do_work(self, v: VecGeneric<T>) -> VecGeneric<T>
    let b = self.add(v)
    b

// Test generic impls, should return 9
pub fn test13()
  let a = VecGeneric<i32> { x: 1, y: 2, z: 3 }
  let b = VecGeneric<i32> { x: 4, y: 5, z: 6 }
  let c = a.do_work(b)
  c.z // 9

// Test structural object field access
fn get_y_field(obj: { y: i32 }) -> i32
  obj.y

pub fn test14()
  let obj = { y: 17, z: 689 }
  get_y_field(obj)

// Test that structural parameters can accept matching nominal types
pub fn test15() -> i32
  let point = Point { x: 1, y: 82, z: 3 }
  get_y_field(point)

type GenericStructuralTypeAlias<T> = { x: T, y: T, z: T }

fn get_z_for_gen_str_ta(v: GenericStructuralTypeAlias<i32>) -> i32
  v.z

pub fn test16() -> i32
  get_z_for_gen_str_ta({ x: 1, y: 2, z: 3 })

obj None {}
obj Some<T> { value: T }

type Optional<T> = Some<T> | None

fn optional_match_chain()
  let some: Optional<i32> = Some<i32> { value: 39 }

  some
    .match(x)
      Some<i32>: Some<i32> { value: x.value + 1 }
      None: None {}
    .match(val)
      Some<i32>: Some<i32> { value: val.value + 2 }
      None: None {}

pub fn test17()
  let x = optional_match_chain()

  match(x)
    Some<i32>: x.value
    None: -1

obj Animal { age: i32 }
obj Insect: Animal { age: i32, legs: i32 }
obj Mammal: Animal { age: i32, legs: i32 }

fn get_legs(a: Animal + { legs: i32 }) -> i32
  a.legs

// Test intersection types
pub fn test18() -> i32
  let human = Mammal { age: 10, legs: 2 }
  get_legs(human)

// Test while loops and breaking, should return 20
pub fn test19() -> i32
  var x = 0
  var i = 0
  while i < 10 do:
    x = x + i * 2
    i = i + 1
    if i == 5 then: break
  x

pub fn test20() -> String
  "Hello, world!" + " " + "This is a test."

pub fn test21()
  let arr = new_array<Optional<i32>>({ with_size: 4 })
  arr.push(Some<i32> { value: 12 })
  arr.pop()
    .match(val)
      Some<Optional<i32>>:
        val.value
      None:
        None {}
    .match(v)
      Some<i32>:
        v.value
      None:
        -1

pub fn test22()
  let arr = [1, 2, 3, 4]
  arr.push(5)
  arr.push(3)
  arr.push(173)
  arr.pop()
    .match(v)
      Some<i32>:
        v.value
      None:
        -1

// Test structural object re-assignment
pub fn test23()
  let val = { x: 1, y: 2, z: 3 }
  val.x = 4
  val.x

// Test the Map type
pub fn test24()
  let map = new_map<String>()
  map.set("hello", "world")
  map.set("goodbye", "night")
  map.get("hello").match(v)
    Some<String>:
      v.value
    None:
      "not found"

trait Math
  fn add(self, b: i32) -> self
  fn sub(self, b: i32) -> self
  fn mul(self, b: i32) -> self

obj MathBox<T> {
  value: T
}

impl<T> Math for MathBox<T>
  fn add(self, b: i32) -> self
    MathBox<T> { value: self.value + b }

  fn sub(self, b: i32) -> self
    MathBox<T> { value: self.value - b }

  fn mul(self, b: i32) -> self
    MathBox<T> { value: self.value * b }

// Test trait impls, should return 8
pub fn test25()
  let a = MathBox<i32> { value: 4 }
  let b = a.add(4)
  b.value

obj Node<T> {
  val: T,
  left: Optional<Node<T>>,
  right: Optional<Node<T>>
}

pub fn test26() -> i32
  let none: Optional<Node<i32>> = None {}
  let leaf = Node<i32> { val: 7, left: none, right: none }
  let leftOpt: Optional<Node<i32>> = Some<Node<i32>> { value: leaf }
  let root = Node<i32> { val: 5, left: leftOpt, right: none }
  root.left.match(n)
    Some<Node<i32>>: n.value.val
    None: -1

pub fn test27() -> i32
  let none: Optional<Node<i32>> = None {}
  let root = Node<i32> { val: 5, left: none, right: none }
  root.right.match(n)
    Some<Node<i32>>: n.value.val
    None: -1

// Simple generic object to test type inference
obj NodeSimple<T> {
  val: T
}

pub fn test28() -> i32
  let node = NodeSimple { val: 5 }
  node.val

trait DoWork
  fn work(self) -> i32

obj Worker {}

impl DoWork for Worker
  fn work(self) -> i32
    1

fn takes_worker(w: DoWork) -> i32
  w.work()

pub fn test29() -> i32
  let w = Worker {}
  takes_worker(w)

// Tuple literal and numeric member access
pub fn test30() -> i32
  let tup = (1, 2, 3)
  tup.1

trait BoxLike<T>
  fn get(self) -> T

obj ValueBox<T> {
  value: T
}

impl<T> BoxLike<T> for ValueBox<T>
  fn get(self) -> T
    self.value

fn takes_box(b: BoxLike<i32>) -> i32
  1

pub fn test31() -> i32
  let b = ValueBox<i32> { value: 7 }
  takes_box(b)
`;

export const tcoText = `
use std::all

// Tail call fib
pub fn fib(n: i32, a: i32, b: i32) -> i32
  if n == 0 then:
    a
  else:
    fib(n - 1, b, a + b)
`;

export const controlFlowText = `
use std::all

// If-match without binder: returns 4
pub fn test1() -> i32
  let opt: Optional<i32> = Some<i32> { value: 4 }
  if opt.match(Some<i32>) then:
    opt.value
  else:
    -1

// If-match with binder: returns 7
pub fn test2() -> i32
  let opt: Optional<i32> = Some<i32> { value: 7 }
  if opt.match(x, Some<i32>) then:
    x.value
  else:
    -1

// While-match with binder: sum 1+2+3 = 6
pub fn test3() -> i32
  let a = [1, 2, 3]
  let iterator = a.iterate()
  var sum = 0
  while iterator.next().match(x, Some<i32>) do:
    sum = sum + x.value
  sum

// If optional unwrap (?=): returns 5
pub fn test4() -> i32
  let opt: Optional<i32> = Some<i32> { value: 5 }
  if x ?= opt then:
    x
  else:
    -1

// While optional unwrap (?=): sum 1+2+3 = 6
pub fn test5() -> i32
  let a = [1, 2, 3]
  let iterator = a.iterate()
  var sum = 0
  while n ?= iterator.next() do:
    sum = sum + n
  sum

// while-in sugar over array values: sum 1+2+3 = 6
pub fn test6() -> i32
  var sum = 0
  while n in [1, 2, 3] do:
    sum = sum + n
  sum

`;

export const goodTypeInferenceText = `
use std::all

// Should infer return type from fib_alias
fn fib(n: i32, a: i64, b: i64)
  if n == 0 then:
    a
  else:
    fib_alias(n - 1, b, a + b)

fn fib_alias(n: i32, a: i64, b: i64) -> i64
  fib(n - 1, b, a + b)

pub fn main() -> i64
  fib(10, 0i64, 1i64)
`;

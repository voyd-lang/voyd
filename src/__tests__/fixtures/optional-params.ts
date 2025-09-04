export const optionalParamsVoyd = `
use std::all

fn greet(name: String, middle?: String) -> i32
  match(middle)
    Some<String>:
      2
    None:
      1

pub fn greet_with_middle() -> i32
  greet("John", "Quincy")

pub fn greet_without_middle() -> i32
  greet("John")

fn banner({ title: String, subtitle?: String }) -> i32
  match(subtitle)
    Some<String>:
      2
    None:
      1

pub fn banner_with_subtitle() -> i32
  banner(title: "Hi", subtitle: "There")

pub fn banner_without_subtitle() -> i32
  banner(title: "Hi")

pub fn banner_obj_without_subtitle() -> i32
  banner({ title: "Hi" })

fn sum(a: i32, b?: i32, {c: i32}) -> i32
  a + c

pub fn skip_optional_labeled() -> i32
  sum(1, c: 2)

pub fn closure_with_arg() -> i32
  let f = (name: String, middle?: String) => greet(name, middle)
  f("John", "Quincy")

pub fn closure_without_arg() -> i32
  let f = (name: String, middle?: String) => greet(name, middle)
  f("John")
`;

export const leftoverArgVoyd = `
use std::all

fn sum(a: i32, b?: i32, {c: i32}) -> i32
  a + c

pub fn leftover_arg() -> i32
  sum(1, c: 2, 3)
`;

export const requiredOptionalVoyd = `
use std::all

fn expects(opt: Optional<String>) -> i32
  match(opt)
    Some<String>:
      1
    None:
      0

pub fn call_missing_opt() -> i32
  expects()
`;

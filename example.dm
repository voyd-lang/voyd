use std/struct ***

type Pos = {
	x:i32
	y:i32
	z:i32
}

fn multiply(a:i32 by:b:i32) -> i32
	a * b

fn main() -> i32
	let pos:Pos = Pos x: 23 y: 42 z: 5
	pos.x

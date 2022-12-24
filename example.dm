use std/struct ***

type Pos = {
	x:i32
	y:i32
	z:i32
}

fn make-pos() -> Pos
	let my:Pos = Pos x: 5 y: 4 z: 3
	let my2:Pos = Pos x: 11 y: 24 z: 33
	let my3:Pos = Pos x: 11 y: 24 z: 33
	my

fn main() -> i32
	let pos:Pos = make-pos()
	let pos2:Pos = Pos x: 98 y: 43 z: 32
	pos.x

type Pos = {
	x:i32,
	y:i32,
	z:i32
}

fn make-pos()
	let my = Pos { x: 5, y: 4, z: 3 }
	let my2 = Pos { x: 11, y: 24, z: 33 }
	let my3 = Pos { x: 11, y: 24, z: 33 }
	my

fn main()
	let pos = make-pos()
	let pos2 = Pos { x: 98, y: 43, z: 32 }
	pos.x

type Pos = {
	x:i32,
	y:i32,
	z:i32
}

fn make-pos()
	let my = Pos { x: 5, y: 4, z: 3 }
	let my2 = Pos { x: 11, y: 20, z: 33 }
	let my3 = Pos { x: 11, y: 24, z: 33 }
	my

fn main()
	let pos = Pos { x: 98, y: 43, z: 32 }
	let pos2 = Pos { x: 72, y: 39, z: 86 }
	let pos3 = Pos { x: 123, y: 654, z: 1 }
	let pos4 = make-pos()
	pos4.y = 10
	pos4.y

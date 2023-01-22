type B = {
	abba:f32,
	b:i32
}

type A = {
	a:i32,
	b:B
}


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
	let b = B { abba: 5.8, b: 3 }
	let a = A { a: 1, b: b }
	a.b.abba = 145.2
	a.b.abba

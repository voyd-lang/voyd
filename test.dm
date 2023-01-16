use std/memory ***

fn pos(x:i32 y:i32 z:i32) -> i32
	let address:i32 = alloc(12)
	set-x address x
	set-y address y
	set-z address z
	address

fn set-x(address:i32 value:i32) -> void
	store-i32 address 0 value

fn set-y(address:i32 value:i32) -> void
	store-i32 address 4 value

fn set-z(address:i32 value:i32) -> void
	store-i32 address 8 value

fn get-x(address:i32) -> i32
	read-i32 address 0

fn get-y(address:i32) -> i32
	read-i32 address 4

fn get-z(address:i32) -> i32
	read-i32 address 8

fn make-pos() -> i32
	let return-address:i32 = alloc(12)
	let pos-a:i32 = pos(1 2 3)
	let pos-b:i32 = pos(5 4 0)
	pos-a.set-x(pos-b.get-x)
	copy pos-a return-address
	set-return return-address

fn main() -> i32
	let return-address2 = alloc(12)
	let return-address = alloc(12)
	// let my-pos:i32 = make-pos()
	// my-pos.get-x
	return-address

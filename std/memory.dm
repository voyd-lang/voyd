use dir/macros ***
use dir/operators ***
use dir/utils ***

global let header-size = 8
global let size-index = 0
global let type-index = 4
global var stack-pointer = 0

// Returns a pointer with the location of the allocation
pub fn alloc(size:i32) -> i32
	ensure-space(size)
	let address = stack-pointer
	stack-pointer = stack-pointer + size + header-size
	bnr (i32 store void) (`(0) `(2) address size + header-size)
	address

// Returns dest pointer
pub fn copy(src:i32 dest:i32) -> i32
	bnr (memory copy void) (dest src src.size)
	dest

pub fn size(address:i32) -> i32
	bnr (i32 load i32) (`(0) `(2) size-index + address)

// Sets the stack pointer to the end of a function return space, returns the return address
pub fn set-return(return-address:i32) -> i32
	stack-pointer = return-address + return-address.size
	return-address

// For external load and store use. Add header size automatically to offset
pub fn read-i32(address:i32 offset:i32) -> i32
	bnr (i32 load i32) (`(0) `(2) (address + offset + header-size))

// For external load and store use. Add header size automatically to offset
pub fn store-i32(address:i32 offset:i32 value:i32) -> void
	bnr (i32 store i32) (`(0) `(2) (address + offset + header-size) value)

// For external load and store use. Add header size automatically to offset
pub fn read-f32(address:f32 offset:f32) -> f32
	bnr (f32 load f32) (`(0) `(2) (address + offset + header-size))

// For external load and store use. Add header size automatically to offset
pub fn store-f32(address:f32 offset:f32 value:f32) -> void
	bnr (f32 store f32) (`(0) `(2) (address + offset + header-size) value)

// For external load and store use. Add header size automatically to offset
pub fn read-i64(address:i64 offset:i64) -> i64
	bnr (i64 load i64) (`(0) `(2) (address + offset + header-size))

// For external load and store use. Add header size automatically to offset
pub fn store-i64(address:i64 offset:i64 value:i64) -> void
	bnr (i64 store i64) (`(0) `(2) (address + offset + header-size) value)

// For external load and store use. Add header size automatically to offset
pub fn read-f64(address:f64 offset:f64) -> f64
	bnr (f64 load f64) (`(0) `(2) (address + offset + header-size))

// For external load and store use. Add header size automatically to offset
pub fn store-f64(address:f64 offset:f64 value:f64) -> void
	bnr (f64 store f64) (`(0) `(2) (address + offset + header-size) value)

fn ensure-space(size:i32) -> i32
	let mem-size:i32 = bnr (memory size i32)
	if (stack-pointer + size + header-size) >= (mem-size * 65536)
		bnr (memory grow i32) (1)
		0

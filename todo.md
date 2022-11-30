- Consider redefining block http://www.lispworks.com/documentation/lw51/CLHS/Body/s_block.htm
- figure out why I can't inline sub expressions into arrays like this:
  ```
  	#[
  		"define-function"
  		identifier
  		params
  		variables
  		return-type
  		#["block"].concat(expressions)
  	]
  ```
  I think its the dot

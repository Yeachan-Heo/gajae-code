### Fixed

- The calc tool's exponentiation now accepts a unary sign on the exponent, so expressions like `2 ** -3` evaluate to 0.125 instead of failing with "Unexpected token in expression". Exponentiation stays right-associative, and unary-minus precedence on the left (`-2 ** 2` = -4) is unchanged.

# Math

Inline math like $a^2 + b^2 = c^2$ sits inside a sentence.

Inline math with subscripts $x_1 + x_2 = x_{total}$ and Greek letters $\alpha \beta$.

A block equation:

$$
E = mc^2
$$

A block equation on a single line:

$$\int_0^1 x^2 \, dx = \frac{1}{3}$$

A multi-line block with alignment:

$$
\begin{aligned}
f(x) &= (x+1)^2 \\
     &= x^2 + 2x + 1
\end{aligned}
$$

Dollar signs that are not math: a price of $5 and another price of $12
in the same sentence should not form an inline span in Obsidian-style
parsing, while $5 + 7$ with tight delimiters does.

An escaped dollar \$100 stays literal.

Math containing a pipe $|x|$ near a table-free paragraph.

Inline math inside emphasis: *the identity $e^{i\pi} + 1 = 0$ amazes*.

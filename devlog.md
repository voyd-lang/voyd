# 5 Dec 2022

**Changes:**

- Greedy operators (`;`, `=`, `=>`, etc) are much smarter now.

When next expression directly follows a greedy op, child expressions of the line are treated as
arguments of that expression. When the next expression is a child expression of the line, they become
part of a block

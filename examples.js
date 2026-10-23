window.DSAVIZ_EXAMPLES = [
  {
    name: "Linked list: zipper two lists",
    code: `class Node:
  def __init__(self, val):
    self.val = val
    self.next = None

def zipper_lists(head_1, head_2):
  tail = head_1
  current_1 = head_1.next
  current_2 = head_2
  count = 0
  while current_1 is not None and current_2 is not None:
    if count % 2 == 0:
      tail.next = current_2
      current_2 = current_2.next
    else:
      tail.next = current_1
      current_1 = current_1.next
    tail = tail.next
    count += 1
  if current_1 is not None:
    tail.next = current_1
  if current_2 is not None:
    tail.next = current_2
  return head_1

a = Node("a"); b = Node("b"); c = Node("c")
a.next = b; b.next = c
x = Node("x"); y = Node("y"); z = Node("z")
x.next = y; y.next = z

head = zipper_lists(a, x)
# a -> x -> b -> y -> c -> z
`,
  },
  {
    name: "Linked list: reverse",
    code: `class Node:
  def __init__(self, val):
    self.val = val
    self.next = None

def reverse_list(head):
  prev = None
  current = head
  while current is not None:
    next_node = current.next
    current.next = prev
    prev = current
    current = next_node
  return prev

a = Node("a"); b = Node("b"); c = Node("c")
a.next = b; b.next = c

new_head = reverse_list(a)
# c -> b -> a
`,
  },
  {
    name: "Recursion: factorial",
    code: `def factorial(n):
  if n == 0:
    return 1
  return n * factorial(n - 1)

print(factorial(4))
`,
  },
  {
    name: "Binary tree: sum of values",
    code: `class Node:
  def __init__(self, val):
    self.val = val
    self.left = None
    self.right = None

def tree_sum(root):
  if root is None:
    return 0
  return root.val + tree_sum(root.left) + tree_sum(root.right)

a = Node(3); b = Node(11); c = Node(4)
d = Node(4); e = Node(2)
a.left = b; a.right = c
b.left = d; b.right = e

print(tree_sum(a))
`,
  },
  {
    name: "Binary tree: depth-first traversal (stack)",
    code: `class Node:
  def __init__(self, val):
    self.val = val
    self.left = None
    self.right = None

def depth_first_values(root):
  current = root
  ret = []
  stack = []
  stack.append(root)

  while len(stack) != 0:
    current = stack.pop()
    if current is not None:
      if current.right is not None:
        stack.append(current.right)
      if current.left is not None:
        stack.append(current.left)
      ret.append(current.val)
  return ret

a = Node("a"); b = Node("b"); c = Node("c")
d = Node("d"); e = Node("e"); f = Node("f")
a.left = b; a.right = c
b.left = d; b.right = e
c.right = f

print(depth_first_values(a))
`,
  },
  {
    name: "Lists: aliasing vs copying",
    code: `nums = [1, 2, 3]
alias = nums
copy = list(nums)

alias.append(4)
copy.append(99)

grid = [[0, 0], [0, 0]]
grid[0][1] = 5
counts = {"a": 1, "b": 2}
counts["c"] = nums
print(nums, copy)
`,
  },
];

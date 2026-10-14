# Wishlist

Ideas for making dsaviz easier for students to follow. Roughly in priority order.

## Done

- [x] **Highlight what changed in each step.** The pointer that just moved is drawn thick and coral, with a dashed grey line showing where it pointed before. Values that changed get a tinted background.
- [x] **Plain-English caption for each step.** For example: "Ran line 16: `tail.next = current_1` · `Node 'x'.next` now points to `Node 'b'` (was Node 'y')". Also covers function calls and returns, new variables, aliasing ("the same list, not a copy"), lost nodes and printed output.
- [x] **Pointer labels instead of long arrows.** Variables appear as name tags on the box they point to; only links between objects (`.next`, `.left`, list items) are drawn as arrows. A Labels / Arrows switch keeps the Python Tutor style available.

- [x] **Clearer arrows.** Arrows to a node further left enter its right side, or arc over the row when it's on the same row, instead of looping underneath. Optional, on by default.

## Next

- [ ] **Smooth movement between steps.** When you press Next, a changed arrow slides from its old target to its new one (about 300 ms), and moved labels glide to their new box.
- [ ] **Focus on the current function.** While inside a function, dim or collapse the Global frame, whose pointers don't change there.
- [ ] **Show lost nodes before they disappear.** When nothing points to a node any more, keep it on screen for one step in grey with a "lost" label instead of removing it straight away.
- [ ] **Play button with speed control,** so a run can be watched like an animation and paused.
- [ ] **Change markers on the slider.** Ticks at steps where a link changes, plus a "next change ›" button that skips bookkeeping steps such as `count += 1`.
- [ ] **Show `None` explicitly,** for example a small ⏚ symbol at the end of a `next` that leads nowhere.

## Later

- [ ] **JavaScript support** (the reason the repo is called dsaviz, not pyviz).

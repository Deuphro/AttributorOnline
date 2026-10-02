# Where the attribution work stands

Written at a session boundary, so the state survives outside the conversation.
Everything here is either on disk or measured; nothing is a plan.

## Verified state

- All 12 JS suites green (`node scripts/<name>.test.mjs`), 419 tests; Rust 77/77.
- The node's top-`j` selection works and is proved to change the output:
  ratio 1, ppm 10 — j=1 → 95 formulas, j=3 → 240, j=5 → 316, 95/95 peaks,
  max |ppm| 9.93.
- One name for the option everywhere (`bestMatches`); a cross-file contract
  test fails if the node and the engine ever disagree again.
- The collection reader adopts a prebuilt collection instead of rebuilding it:
  285 ms → 18 ms at 17 689 formulas. Same keys, notations, errors, targets.

## Closed: isotopologue combinations no longer degenerate

**The identity in the previous version of this file was FALSE.** It read

    13CH2  ==  12CH2 + 13C        (the same formula)

`13CH2` carries ONE carbon; `12CH2 + 13C` carries TWO. They are not the same
formula. Anyone who "fixed" the duplication on that identity would have fixed
nothing. The relation that actually exists is

    13CH2 + 12C  ==  13C + 12CH2

which `findDependence` in `attribution.js` now *finds* rather than assumes: two
pairs of charge-free bricks with the same difference vector. It appears whenever
the combining list holds a group and one of its sub-groups — C in CH2, O in CO,
N in CN — which is what the fixture's `CH2, NH, O, C` is.

Three things changed, and they were coupled as suspected:

1. **The space shrank, not just the output.** `AttributionPlan` keeps one
   representative per composition — the canonical form. Measured on the fixture
   at ratio 0.01: 2 248 847 states visited → **725 429**, and 1 098 942 rendered
   → **350 816**, which is exactly the number of distinct compositions. **Zero
   compositions lost** (checked by brute force on a small plan and by set
   comparison on the fixture).
2. **`bestMatches` now means distinct readings.** The selection skips a
   candidate whose composition is already in that peak's bucket, keeping the
   sort order, so the champion is still the champion.
3. **The fixture test now checks it.** See "the missing test" below.

### The 26 s wall, and what the time actually was

Minimum of 7 runs, `ratio=0.01`, `j=3`, the 95-peak fixture:

| | before | after |
|---|---|---|
| `attributeSpectrum` | 19 574 ms | **261 ms** |
| states visited | 2 248 847 | 725 429 |

Three separate causes, not one:

- **`accept` does not shrink the walk.** Refusing duplicates at RENDER time still
  walked all 2 248 847 states: 20 141 ms. The prune has to happen at PUSH time.
  This is safe in the heap and *not* in the mixed-radix counter — where a
  non-canonical prefix can have canonical completions — so each sieve prunes at a
  different point, and the mixed-radix prunes only once all four relation
  indices are decided. Pruning it too early loses 168 420 compositions.
- **The `seen` signature was a string.** `Array.from(counts).join(",")` per
  state. It is now a mixed-radix integer, with a `Uint8Array` bitmap when the
  addressable space fits in 64 MiB and a `Set` otherwise.
- **The selection materialised 350 816 states to keep 285.** The sieve now takes
  an `emit` sink, so the selected path never builds the array (and the
  mixed-radix skips its final sort). 445 ms → 143 ms on the sieve alone.

### The default strategy changed, and that is a real change

`attributeSpectrum`'s default is now `mixedRadix`, not `heap`. The two return
identical sets — verified at ratios 0.01/0.02/0.05/0.1 — so this is the same
computation by another path, not a different answer. Measured, minimum of 7:

| ratio | heap | mixedRadix |
|---|---|---|
| 0.01 | 1 453 ms | 466 ms |
| 0.02 | 53 ms | 25 ms |
| 0.1 | 52 ms | 24 ms |

`cribleHeap` is **kept**: it is the one whose memory is the frontier's rather
than the space's, and it is the right choice if the space ever outgrows RAM.

### The missing test

`attribution.test.mjs` now has *"deux lectures d'un même pic sont deux FORMULES
différentes"*. It is deliberately built on the **ratio 0.01** plan, and it
asserts that plan is the dependent one — at ratio 0.1 the test would pass even
on the buggy code, which is exactly the kind of test that proves nothing.

**It was proved to fail on the buggy code.** With all three mechanisms disabled
(plan prune, sieve prune, selection dedup) it fails:

    peak 7 holds 3 readings but only 1 distinct formulas;
    12C7 13C6 1H5 16O2[+] appears 3×

Then it was restored, and the suite went back to green.

### The success criterion, met

`ratio=0.01`, `j=3`: **95 peaks covered, 3 readings per peak, all distinct,
261 ms** (minimum of 7). Both halves, not one.

### What is NOT fixed

- **`ratio:0` still crashes.** The bitmap has its own limit and the fallback is a
  `Set`, and at ratio 0 the plan has 16 bricks whose space exceeds both. The
  `RangeError: Set maximum size exceeded` listed below is therefore **still
  open**, and the mixed-radix at ratio 0 exhausts memory instead. This is a real
  gap, not a rounding error: it needs a plan-side answer (fewer bricks, or a
  mass-ordered streaming sieve that never holds the space).
- The attribution node still blocks the UI for the length of one spectrum; the
  worker/WASM path exists (Rust `crible_heap`, 77 tests) and is not wired here.
- The list virtualization fix is structurally tested only; no DOM in Node.
- `[CH3OH+H]` is still refused by the ionising-list parser.

## Measurements, and their limits

End to end, 10 000 fully-covered peaks at j=3 (17 689 formulas):

| | before | after adoption |
|---|---|---|
| engine | 359 ms | 359 ms |
| publish (AttributionNode) | 245 ms | 245 ms |
| rebuild (FormulaCollectionNode) | 291 ms | ~18 ms |
| **total** | **896 ms** | **~630 ms** |

Read this with care:

- It models two FUNCTIONS, not the nodes. It omits one O(N) pass in each (the
  logProbability/recipe loop, the note loop) and all the per-node rendering. So
  the real number is higher.
- Timings are the MINIMUM of 7 runs. This machine swings 2× run to run; an
  earlier breakdown I produced was subtraction of noisy numbers and I reported
  it as if it were solid. Do not trust a single median here.
- "896 ms" was called "end to end". It is not. It is the engine plus two
  collection passes.

## Open items, none urgent, all real

- `[CH3OH+H]` is REFUSED by the ionising-list parser with "carries no charge",
  though the formula does carry +1. The parser only looks for a sign at the END;
  the main `parse` path reads the same string correctly. Methylated solvent
  adducts are the form people actually type.
- The attribution node still blocks the UI for the length of one spectrum.
  Yielding happens BETWEEN spectra, not inside one. The worker/WASM path exists
  (Rust `crible_heap`, 77 tests) and is not wired here.
- `cribleHeap` can throw `RangeError: Set maximum size exceeded` when `ratio` is
  low over a wide mass window — STILL OPEN, see "What is NOT fixed" above. It was
  re-measured during this work, not assumed.
- The collection reader has a `ppmWindow` (default 5) with no UI field. It no
  longer overwrites the producer's window — that silent 10→5 was removed — but
  the hidden setting remains.
- The list virtualization fix (scroll position read from the wrong element) is
  **structurally** tested only. There is no DOM in Node, so nobody has watched
  that list scroll yet.
- The two chemistry tests I did NOT delete, having repaired them instead: the
  `[H+1]` case and the `[-H2O]` vs `[-(H2O)]` case. Both now assert the current
  grammar. Say so if you want them gone.

## Where things are

- `scripts/attribution.js` — the sieve, the selection, `attributeSpectrum`
- `scripts/chemistry.js` — grammar, `Formula`, `FormulaCollection` (`adoptAll`)
- `scripts/interface.js` — both nodes, the virtualized list, the comparators
- `scripts/attribution.test.mjs` — engine tests, crop fixture, name contract
- `scripts/collectionReader.test.mjs` — reader tests, extracts and EVALUATES the
  real code from `interface.js`, so the tests are not copies

The extraction trick in `collectionReader.test.mjs` is the pattern to reuse for
anything in the DOM-bound half of `interface.js`: slice between two anchors,
check both anchors matched, `new Function` the slice.

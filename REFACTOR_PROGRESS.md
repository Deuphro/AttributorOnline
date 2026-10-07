# Refactor Progress: `interface.js` to Modules

## Integrated

- Core graph classes and flows live under `scripts/core/` and `scripts/flow/`.
- Node classes live under `scripts/nodes/`, including `AttributionNode`, its
  `AttributionForestMethods`, `FormulaCollectionNode`, and its pure display/sort
  helpers.
- UI classes live under `scripts/ui/`; accordion helpers are exported by
  `Accordion.js`.
- `App`, session restoration, spinners, and node-type registration live under
  `scripts/app/`.
- `scripts/main.js` starts through `scripts/app/index.js`. The app no longer
  imports `interface.js`; `util.js` no longer imports it for side effects.
- `NODE_CONSTRUCTORS` and `SELF_SHAPED_NODES` are populated by
  `registerNodeTypes()` before the app restores or creates nodes.

## Verified

- All 18 JavaScript test suites pass.
- Browser smoke test: all nine menu node types instantiate; a new session
  disposes the old app and leaves exactly one new app.
- Browser round-trip: nine node types survive skeleton save and reload as
  specialized nodes.
- Thermo RAW bytes round-trip through skeleton JSON as byte arrays and are
  restored as `Uint8Array`; old skeletons with numeric object keys are accepted.
- A restored empty Thermo RAW node no longer fails when its derived `spectra`
  field is absent from the skeleton.
- The extracted Thermo RAW node imports `workerPool.js` from the scripts root;
  `Plot2D` imports the runtime `XYTrace` class; forest mixin statics and
  instance-only drawing state are retained by `AttributionNode`.
- Browser smoke test: dynamic worker import, XY trace rendering, and forest
  curve drawing all run without console errors.
- `forestNode.test.mjs` guards the three extracted-module contracts above.
- The browser reports no module-load or node-creation errors in these checks.

## Remaining

- Several tests still extract implementations from `interface.js`, so it must
  remain until those tests are moved to the modules or replaced with module-level
  tests.
- After the tests stop depending on it, remove `interface.js` and run the full
  suite and browser smoke test once more.
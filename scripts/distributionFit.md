# Distribution fits

`fitDistribution(x, y, options)` accepts `Float64Array` values and returns a
promise with named parameters, predictions, SSE, RMSE, reduced chi-square, R²,
AIC/AICc/BIC, convergence state, and the number of filtered observations.
`compareModels(x, y, models, options)` fits every requested model and sorts by
AICc (lowest first).

The public default treats `x` as the measured mass. For a discrete repeat index
`k`, pass `xIsIndex: true` and a repeat mass `massUnit`; continuous models then
evaluate at `m = M0 + k * massUnit`. Weßlau's `M0` must be known or supplied; if
omitted it is initialized below the smallest positive mass. Its `alpha` and
`mu` are free. `poisson_limit` defaults to true; set it false and `N` to use the
finite-binomial variance. Flory-Schulz uses `a` and supports `distribution:
"number"` or `distribution: "mass"`. Schulz-Zimm fits shape `z` and number
average mass `Mn`, with dispersity `Đ = 1 + 1/z`. `p0`, per-parameter `bounds`,
`normalizeY`, and `maxIterations` are optional. `chi2Red` uses unit observation
variance because the current fit is unweighted; it is not a statistical
goodness-of-fit measure unless unit variance is appropriate for the data.

```js
import {fitDistribution,compareModels} from "./distributionFit.js"

const x=Float64Array.from([1,2,3,4,5,6])
const y=Float64Array.from([90,62,43,30,21,15])
const fit=await fitDistribution(x,y,{model:"flory_schulz"})
console.log(fit.parameters,fit.rmse,fit.r2,fit.yPred)

const comparison=await compareModels(x,y,["flory_schulz","schulz_zimm"],{
    xIsIndex:true,m0:100,massUnit:14
})
console.log(comparison.best.model,comparison.best.aicc)
```

The Rust/WASM entry point is `distribution_fit`. The worker passes `Float64Array`
inputs directly to it; the same kernel is mirrored in `distributionFitKernel.js`
for browsers where WASM or workers are unavailable.
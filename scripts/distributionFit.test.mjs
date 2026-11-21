import assert from "node:assert/strict"
import {fitDistribution,compareModels} from "./distributionFit.js"
import {evaluateDistribution} from "./distributionFitKernel.js"

const x=Float64Array.from({length:14},(_,index)=>index+1)
const y=Float64Array.from(x,value=>7*(1-0.73)*0.73**(value-1))
const fit=await fitDistribution(x,y,{model:"flory_schulz"})
assert.ok(Math.abs(fit.parameters.a-0.73)<1e-6,`unexpected Flory parameter ${fit.parameters.a}`)
assert.ok(fit.rmse<1e-10,`unexpected RMSE ${fit.rmse}`)
assert.ok(fit.r2>0.999999)
assert.ok(fit.chi2Red<1e-18)
assert.equal(fit.x.length,x.length)

const compared=await compareModels(x,y,["schulz_zimm","flory_schulz"])
assert.equal(compared.best.model,"flory_schulz")
assert.equal(compared.fits.length,2)

const invalidFiltered=await fitDistribution(
    Float64Array.from([0,1,2,3,4,5]),
    Float64Array.from([10,8,5,3,2,1]),
    {model:"flory_schulz"}
)
assert.equal(invalidFiltered.dropped,1)
assert.equal(invalidFiltered.x[0],1)

const szX=Float64Array.from({length:25},(_,index)=>index+1)
const schulzY=Float64Array.from(szX,index=>evaluateDistribution("schulz_zimm",index,[4,3,300],{m0:75,massUnit:14,xIsIndex:true}))
const schulzFit=await fitDistribution(szX,schulzY,{
    model:"schulz_zimm",m0:75,massUnit:14,xIsIndex:true
})
assert.ok(Math.abs(schulzFit.parameters.z-3)<0.02,`unexpected Schulz-Zimm z=${schulzFit.parameters.z}`)
assert.ok(Math.abs(schulzFit.parameters.Mn-300)<0.2,`unexpected Schulz-Zimm Mn=${schulzFit.parameters.Mn}`)
assert.ok(schulzFit.yPred.every(Number.isFinite))

const wesslauY=Float64Array.from(x,index=>evaluateDistribution("wesslau",index,[5,1.08,6],{
    m0:80,massUnit:14,xIsIndex:true,poissonLimit:true,trials:1e9
}))
const wesslauFit=await fitDistribution(x,wesslauY,{model:"wesslau",m0:80,massUnit:14,xIsIndex:true})
assert.ok(Math.abs(wesslauFit.parameters.alpha-1.08)<1e-5)
assert.ok(Math.abs(wesslauFit.parameters.mu-6)<1e-4)
await assert.rejects(
    fitDistribution(x,wesslauY,{
        model:"wesslau",m0:80,xIsIndex:true,poisson_limit:false,N:5,
        bounds:{mu:[0.01,6]}
    }),
    /mu < N/
)
await assert.rejects(
    fitDistribution(x,y,{model:"flory_schulz",bounds:{a:[0,1]}}),
    /0 < a < 1/
)

const measuredMass=Float64Array.from({length:20},(_,index)=>80+(index+1)*14)
const measuredWesslauY=Float64Array.from(measuredMass,mass=>evaluateDistribution("wesslau",mass,[5,1.08,6],{m0:80}))
const measuredWesslau=await fitDistribution(measuredMass,measuredWesslauY,{model:"wesslau",m0:80})
assert.ok(Math.abs(measuredWesslau.parameters.alpha-1.08)<1e-5)
assert.ok(Math.abs(measuredWesslau.parameters.mu-6)<1e-4)

console.log("distribution fitting recovers all models and compares them with AICc")
//Compares the two JS fallbacks against the REAL wasm, to prove they agree.
import {readFileSync,writeFileSync} from "node:fs"
const wasm=await import("./pkg/attribrustor.js")
await wasm.default(new Uint8Array(readFileSync("./pkg/attribrustor_bg.wasm")))
const kw=readFileSync("../../scripts/kernelWorker.js","utf8")
//the density constants live at module scope, so take everything above the
//message listener and strip the ESM/export syntax
const src=kw.slice(0,kw.indexOf("self.addEventListener")).replace(/^import .*$/gm,"").replace(/^export /gm,"")
const fns=new Function(src+";return {trimGuessJS,trimApplyJS,trimHistogramJS}")
const J=fns()
const n=2000
const y=new Float64Array(n)
for(let i=0;i<n;i++) y[i]=100+8*Math.sin(i*0.7)+(i%11)*0.3
y[300]=1200;y[900]=5000;y[1500]=9000
let bad=0
//Number.isFinite on the EXPECTATION, not a bare tolerance: -Infinity minus
//-Infinity is NaN, so Math.abs reports a false failure on a correct answer
const cmp=(l,a,b,tol=1e-6)=>{const ok=Number.isFinite(b)?Math.abs(a-b)<=tol*Math.max(1,Math.abs(b)):Object.is(a,b);if(ok)return;bad++;console.log(`FAIL ${l}: rust=${a} js=${b}`)}
for(const [m,k,w,th] of [["madResidual",5,9,0.1],["madResidual",1,3,0.1],["madResidual",20,25,0.1],["intensityThreshold",5,9,250],["passthrough",5,9,0.1],["nope",5,9,0.1]]){
    cmp(`guess ${m} k=${k} w=${w}`, wasm.trim_guess(y,1,m,k,w,th), J.trimGuessJS(y,1,m,k,w,th))
}
for(const [lo,hi] of [[2000,6000],[-Infinity,Infinity],[0,Infinity],[0,6000],[NaN,NaN]]){
    const a=wasm.trim_apply(y,1,lo,hi), b=J.trimApplyJS(y,1,lo,hi)
    cmp(`apply ${lo}..${hi} kept`, a.kept_count, b.keptCount)
    for(let i=0;i<b.pointsX.length;i++) cmp(`apply ${lo}..${hi} x[${i}]`, a.points_x[i], b.pointsX[i])
}
for(const sc of ["log","linear"]){
    const a=wasm.trim_histogram(y,1,60,sc), b=J.trimHistogramJS(y,1,60,sc)
    cmp(`hist ${sc} n`, a.centres.length, b.centres.length)
    for(let i=0;i<b.centres.length;i++) cmp(`hist ${sc} c[${i}]`, a.centres[i], b.centres[i])
}
console.log(bad===0?"\nWASM == JS":"\n"+bad+" DIVERGENCE(S)")

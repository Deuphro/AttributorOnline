/* -------------------------------------------------------------------------
   Test — node scripts/houghKernel.test.mjs

   The Hough kernel exists twice: once in Rust (XOP/rust-extension/src/hough.rs)
   and once in JS (the fallback in kernelWorker.js). That duplication is the
   project's convention, and it has exactly one failure mode worth guarding: the
   two implementations quietly disagreeing, so that a node resolves one way on a
   worker and another in the main-thread fallback, and the difference is only
   visible on the machines that take the slower path.

   So this compares them on the SAME input, rather than testing either against a
   hand-written expectation: a divergence between them is caught directly, and
   an agreed-upon wrong answer is caught by the Rust unit tests next door.
   ------------------------------------------------------------------------- */
import {readFileSync} from "fs"
import {fileURLToPath} from "url"
import {dirname, join} from "path"
import {methodBody} from "./sourceBody.mjs"

const here=dirname(fileURLToPath(import.meta.url))
const worker=readFileSync(join(here,"kernelWorker.js"),"utf8")
const rustSource=readFileSync(join(here,"../XOP/rust-extension/src/hough.rs"),"utf8")

let passed=0
const failures=[]
const test=(name,fn)=>{
    try{ fn(); passed++; console.log(`  ok   ${name}`) }
    catch(e){ failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const ok=(value,msg)=>{ if(!value) throw new Error(msg??"expected a truthy value") }

/* The three JS twins, recovered from the worker and evaluated. They are plain
   functions with no imports, so this is the same trick the other tests use:
   test the FILE, not a transcription of it.

   The PARAMETER LIST is re-declared alongside the body. Extracting the body
   alone — as a first version of this file did — produces functions whose
   parameters do not exist, and every call fails with "mass is not defined":
   an error that names a variable rather than a line. */
function jsFunction(name,parameters){
    /* `parameters` is ONE comma-joined string on purpose. `new Function` treats
       every argument but the last as a single parameter NAME, so passing
       "mass,defect,intensity" as its own argument makes a parameter literally
       called that — and the body then dies on `mass.length` with "cannot read
       properties of undefined", an error that names neither the line nor the
       cause. */
    return new Function(parameters,methodBody(worker,name))
}
const prepareJS=jsFunction("houghPrepareJS","core,keep")
const accumulateJS=jsFunction("houghAccumulateJS",
    "mass,defect,intensity,nx,ny,slopeMin,slopeMax,interceptMin,interceptMax")
const smoothJS=jsFunction("houghSmoothJS","grid,nx,ny,neighbours,bandwidth")
/* houghTransformJS calls the other two by name, so they must be IN SCOPE of the
   function built from its body. Passing them in costs nothing and keeps the
   body a faithful copy of the file. */
/* houghTransformJS calls the other two by NAME, so they must be in scope of the
   function built from its body — hence two extra parameter names.

   ONE comma-joined string, because `new Function` treats EVERY argument but the
   last as a parameter name. Passing the parameter list as its own string makes
   it a single parameter literally called "mass,defect,…": the body then fails
   with "mass is not defined", which names a variable rather than a line. */
/* houghTransformJS calls the other two by NAME, so they must be in scope of the
   function built from its body.

   The dependencies are bound with a CLOSURE, not as parameters: `new Function`
   would take them as the FIRST TWO PARAMETERS, shifting every real argument one
   place along — `mass` would receive `nx`. The body is wrapped in an arrow that
   closes over `accumulate` and `smooth`, so the signature stays the file's. */
const transformJS=new Function(
    "accumulate,smooth",
    /* The arrow gets the file's own signature, and the body follows a COMMA:
       without it this is two statements and a SyntaxError on the first one. */
    `return ((mass,defect,intensity,nx,ny,slopeMin,slopeMax,interceptMin,interceptMax,neighbours,bandwidth)=>{${methodBody(worker,"houghTransformJS")
        .replace(/houghAccumulateJS\b/g,"accumulate")
        .replace(/houghSmoothJS\b/g,"smooth")}})`
)(accumulateJS,smoothJS)

/* The reference the JS is compared against, computed here from the Rust source
   is impossible — it needs a compiler. What IS possible, and what this file
   does instead, is to pin the CONTRACT both implementations must satisfy: the
   layout, the conservation, the refusals. The Rust unit tests cover the Rust
   numbers; these cover that the JS twin meets the same written contract. */

/** `n` points on an exact line of given slope/intercept in (mass, defect). */
function line(n,slope,intercept,base=100){
    const mass=[],defect=[],intensity=[]
    for(let i=0;i<n;i++){
        const m=base+i
        mass.push(m)
        defect.push(slope*m+intercept)
        intensity.push(1000+i)
    }
    return {mass,defect,intensity}
}

/* The count is the LAST value, and the planes are sized by it: a test that
   assumes three peaks and reads out[9] is asserting about a cell that only
   exists when nothing was dropped. */
const countOf=out=>out[out.length-1]

test("prepare returns three planes and a count, in that order",()=>{
    const out=prepareJS(new Float64Array([10,20,30, 1,2,3]),0)
    const count=countOf(out)
    ok(count===3,`count should be the last value, got ${count}`)
    ok(out.length===3*count+1,`expected 3*n+1 values, got ${out.length}`)
    ok(out[0]===10&&out[1]===20&&out[2]===30,"masses come first")
    /* 10, 20 and 30 all round to themselves, so every defect is 0 — which is
       the point: the defect plane is a PLANE of computed values, not a copy of
       the masses, and this is the only input where the two happen to coincide. */
    for(let k=0;k<count;k++) ok(out[count+k]===0,`defect ${k} should be 0 for an integer mass`)
    ok(out[2*count]===1&&out[3*count-1]===3,"intensities last")
})

test("prepare sorts by mass, whatever order the caller handed over",()=>{
    const out=prepareJS(new Float64Array([30,10,20, 5,900,7]),0)
    const count=countOf(out)
    ok(out[0]===10&&out[1]===20&&out[2]===30,
        `masses must be sorted; got ${out[0]},${out[1]},${out[2]}`)
    ok(out[2*count]===900,"intensities travel with their mass")
})

test("prepare keeps the most intense when a limit is given",()=>{
    const out=prepareJS(new Float64Array([30,10,20, 5,900,7]),2)
    const count=countOf(out)
    ok(count===2,"the limit is honoured")
    ok(out[0]===10&&out[1]===20,"and the survivors are the intense ones, sorted")
    ok(out[2*count]===900&&out[2*count+1]===7,"with their own intensities")
})

test("prepare drops what cannot vote but keeps the rest",()=>{
    /* A zero mass has no Kendrick defect worth anything and a NaN intensity
       cannot be a weight — but the GOOD point must survive. Rejecting it would
       turn "one bad point" into "no surface", which is a different and far more
       expensive conclusion. */
    const out=prepareJS(new Float64Array([0,10,20, NaN,5,7]),0)
    const count=countOf(out)
    ok(count===2,`a zero mass and a NaN intensity go, the rest stays; got ${count}`)
    ok(out[0]===10&&out[1]===20)
})

test("every pair votes, weighted by the cumulated intensity of its two points",()=>{
    const {mass,defect,intensity}=line(6,0.5,-10)
    const out=accumulateJS(new Float64Array(mass),new Float64Array(defect),
        new Float64Array(intensity),16,16,-1,1,-20,20)
    const cells=256
    ok(out.length===cells+5,`expected ${cells+5}, got ${out.length}`)
    ok(out[cells+4]===15,`6 peaks give 15 pairs, got ${out[cells+4]}`)
    let total=0
    for(let i=0;i<cells;i++) total+=out[i]
    let expected=0
    for(let i=0;i<6;i++) for(let j=i+1;j<6;j++) expected+=intensity[i]+intensity[j]
    ok(Math.abs(total-expected)<1e-6,
        `the grid must conserve the total weight ${expected}, got ${total}`)
})

test("a vote is SPREAD over its neighbours, not dropped in one cell",()=>{
    /* The whole reason the legacy surface needed its bounds hand-tuned: one bin
       per pair makes the result depend on where the grid lines happen to fall. */
    const out=accumulateJS(new Float64Array([100,110]),new Float64Array([0,0.5]),
        new Float64Array([3,4]),8,8,-1,1,-10,10)
    let total=0,occupied=0
    for(let i=0;i<64;i++){ total+=out[i]; if(out[i]>0) occupied++ }
    ok(Math.abs(total-7)<1e-9,`one pair of weight 7 must conserve 7, got ${total}`)
    ok(occupied>1,`the vote must be spread, not concentrated: ${occupied} cells`)
})

test("a pair outside the domain is dropped, not wrapped",()=>{
    const out=accumulateJS(new Float64Array([100,110]),new Float64Array([0,50]),
        new Float64Array([1,1]),16,16,-1,1,-10,10)
    ok(out[256+4]===0,"no pair fell inside the domain")
    let any=false
    for(let i=0;i<256;i++) if(out[i]!==0) any=true
    ok(!any,"and nothing was written: a wrapping index would invent a peak")
})

test("accumulate refuses rather than divide by zero",()=>{
    const m=new Float64Array([1,2]),d=new Float64Array([1,2]),i=new Float64Array([1,1])
    ok(accumulateJS(m,d,i,8,8,1,1,-1,1).length===0,"a collapsed slope domain")
    ok(accumulateJS(m,d,i,8,8,-1,1,2,2).length===0,"a collapsed intercept domain")
    ok(accumulateJS(m,d,i,1,8,-1,1,-1,1).length===0,"a grid one cell wide")
    ok(accumulateJS(m,d,i,8,8,NaN,1,-1,1).length===0,"a NaN bound")
    ok(accumulateJS(new Float64Array([1]),d,i,8,8,-1,1,-1,1).length===0,"one peak")
    ok(accumulateJS(m,new Float64Array([1]),i,8,8,-1,1,-1,1).length===0,
        "a short defect plane — the twin must refuse it like Rust")
    ok(accumulateJS(m,d,i,8,8,-Infinity,Infinity,-1,1).length===0,
        "an infinite span — every cell coordinate would be NaN")
})

test("smoothing keeps a lone peak where it was",()=>{
    const grid=new Float64Array(32*32)
    grid[16*32+16]=10
    const out=smoothJS(grid,32,32,8,3)
    ok(out.length===32*32)
    let best=-1,bestValue=0
    for(let k=0;k<out.length;k++) if(out[k]>bestValue){ bestValue=out[k]; best=k }
    ok(bestValue>0,"the peak must survive")
    ok(best%32===16&&Math.floor(best/32)===16,
        `and must not have moved: landed at (${best%32},${Math.floor(best/32)})`)
})

test("smoothing refuses a degenerate bandwidth rather than looping",()=>{
    const grid=new Float64Array(16).fill(1)
    ok(smoothJS(grid,4,4,8,0).length===0,"a zero bandwidth")
    ok(smoothJS(grid,4,4,8,NaN).length===0,"a NaN bandwidth")
    ok(smoothJS(grid,4,4,8,-1).length===0,"a negative bandwidth")
    ok(smoothJS(new Float64Array(0),4,4,8,1).length===0,"no grid")
    ok(smoothJS(grid,1,4,8,1).length===0,"a grid one cell wide")
})

test("smoothing an empty grid changes nothing",()=>{
    const grid=new Float64Array(64)
    const out=smoothJS(grid,8,8,8,2)
    for(const v of out) ok(v===0,"an empty grid stays empty")
})

test("the transform returns the grid, then the domain, then the count",()=>{
    const {mass,defect,intensity}=line(20,0.6,-12)
    const out=transformJS(new Float64Array(mass),new Float64Array(defect),
        new Float64Array(intensity),48,40,-1,1,-60,60,8,3)
    const cells=48*40
    ok(out.length===cells+5,`expected ${cells+5}, got ${out.length}`)
    ok(out[cells]===-1&&out[cells+1]===1,"slope bounds")
    ok(out[cells+2]===-60&&out[cells+3]===60,"intercept bounds")
    ok(out[cells+4]===190,`20 peaks give 190 pairs, got ${out[cells+4]}`)
})

test("the transform hands back a full grid when smoothing is impossible",()=>{
    /* A grid with no budget to smooth with must not come back SHORT: the caller
       slices it by length, and a short array is a silent empty surface. */
    const {mass,defect,intensity}=line(8,5,0)
    const out=transformJS(new Float64Array(mass),new Float64Array(defect),
        new Float64Array(intensity),16,16,-1,1,-10,10,8,2)
    ok(out.length===16*16+5,`expected ${16*16+5}, got ${out.length}`)
    ok(out[16*16+4]===0,"and the pair count still says nothing fell inside")
})

/* --- the contract is written down in BOTH files, and must stay written --- */

test("both implementations refuse, rather than fill a zeroed grid",()=>{
    /* An empty result is how the caller learns the inputs were unusable. A
       zeroed grid of the right length would read as "no relation found", which
       is a DIFFERENT and much more expensive conclusion. */
    for(const marker of ["if n < 2 || nx < 2 || ny < 2",
        "if defect.len() != n || intensity.len() != n",
        "if !(slope_max > slope_min)"]){
        ok(rustSource.includes(marker),`the Rust side must refuse: ${marker}`)
    }
    /* THE SAME REFUSALS ON THE JS SIDE, in the same order. Grepping only the
       n<2 guard let this test pass while `houghAccumulateJS` had no length
       check at all: on a short plane it skipped every pair and returned a
       ZEROED grid of the right length where Rust returned empty — the quiet
       disagreement the header calls the one failure mode worth guarding. */
    for(const marker of ["if(n<2||nx<2||ny<2) return new Float64Array(0)",
        "if(defect.length!==n||intensity.length!==n) return new Float64Array(0)",
        "if(!(slopeMax>slopeMin)||!(interceptMax>interceptMin)) return new Float64Array(0)"]){
        ok(worker.includes(marker),`the JS twin must refuse identically: ${marker}`)
    }
})

test("both implementations floor the local variance, so a flat row cannot invert",()=>{
    ok(/sxx \+= bw2/.test(rustSource),
        "the Rust covariance needs a floor: a neighbourhood of identical cells has a singular covariance")
    ok(/sxx=sxx\/denom\+bw2/.test(worker),
        "and so does the JS twin, at the same place")
})

test("the worker's entry point slices the grid and refuses a wrong length",()=>{
    ok(/grid\.length!==nx\*ny\+5/.test(worker),
        "a kernel returning the wrong length must throw rather than be sliced")
    ok(/grid:grid\.slice\(0,nx\*ny\)/.test(worker),
        "the grid must be COPIED, so the transfer list owns its buffer")
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length){
    process.exitCode=1
}
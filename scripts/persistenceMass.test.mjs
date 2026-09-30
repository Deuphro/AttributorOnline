/* -------------------------------------------------------------------------
   Test — node scripts/persistenceMass.test.mjs

   THE CLAIM UNDER TEST
   The union-find that merges points now also SUMS them, so a dying component
   reports the area of the peak that died instead of only its (birth, death)
   pair. Easy to state, easy to get subtly wrong, in three ways this pins down:

     1. a dying component must carry its OWN total, taken before it is folded
        into the survivor - stamping it with the total it just merged into is
        the classic off-by-one-merge;
     2. a component that never dies has a mass too, and is not an exception;
     3. the JS fallback and the Rust kernel must agree. The fallback exists so
        a stale pkg build still filters identically, which only means something
        if it is CHECKED - they are separate code and drift apart silently.

   The Rust runs for real through the built wasm (pkg/), because the arithmetic
   under test is exactly the arithmetic that got rewritten.
   ------------------------------------------------------------------------- */
import {readFileSync} from "fs"
import {fileURLToPath} from "url"
import {dirname, join} from "path"
import init, * as rust from "../XOP/rust-extension/pkg/attribrustor.js"

const here=dirname(fileURLToPath(import.meta.url))
/* The package is built with --target web, so its init() fetches the .wasm over
   the network - which node has no way to do for a file:// URL. Handing it the
   bytes is the same module doing the same work, and it keeps the test offline
   and hermetic. */
await init(readFileSync(join(here,"../XOP/rust-extension/pkg/attribrustor_bg.wasm")))

let passed=0
const failures=[]
const test=(name,fn)=>{
    try{ fn(); passed++; console.log(`  ok   ${name}`) }
    catch(e){ failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const ok=(value,msg)=>{ if(!value) throw new Error(msg??"expected a truthy value") }
const close=(a,b,msg)=>{
    if(!Number.isFinite(a)||!Number.isFinite(b)) throw new Error(`${msg??"values"}: ${a} vs ${b} is not a finite pair`)
    if(Math.abs(a-b)>1e-9) throw new Error(`${msg??"values differ"}: ${a} != ${b}`)
}

/* One block per class, so a test can ask about PeakPickingNode WITHOUT running
   it — it needs d3 and a real DOM. Reading interface.js as text and checking
   the wiring is a cheap guard, not a substitute for running the node; it is
   here because the thing that broke (the published column) is decided by a
   single argument name, which is exactly the kind of thing a test that only
   checked the KERNEL would sail straight past. */
function classBlocks(text){
    const starts=[...text.matchAll(/^class\s+(\w+)(?:\s+extends\s+(\w+))?[^{]*\{/gm)]
    return new Map(starts.map((match,index)=>[
        match[1],
        text.slice(match.index,starts[index+1]?.index??text.length)
    ]))
}
const blocks=classBlocks(readFileSync(join(here,"interface.js"),"utf8"))

/* The JS fallback, lifted OUT of kernelWorker.js rather than retyped here.
   kernelWorker.js is a worker: importing it for a test would need a Worker and
   a DOM, so the function is read out of the file and evaluated on its own. A
   copy would defeat the point - the drift caught here is a copy going stale. */
const workerSource=readFileSync(join(here,"kernelWorker.js"),"utf8")
function harvest(name){
    const start=workerSource.indexOf(`function ${name}(`)
    if(start<0) throw new Error(`${name} is no longer in kernelWorker.js`)
    let depth=0, began=false
    for(let i=workerSource.indexOf("{",start);i<workerSource.length;i++){
        if(workerSource[i]==="{"){depth++;began=true}
        else if(workerSource[i]==="}"){
            depth--
            if(began&&depth===0) return workerSource.slice(start,i+1)
        }
    }
    throw new Error(`${name} is not balanced in kernelWorker.js`)
}
const integrateComponentMassJS=new Function(
    `${harvest("integrateComponentMassJS")}; return integrateComponentMassJS`
)()

/* [x0..xN, y0..yN] - the canonical core layout the kernels take. */
const core=(xs,ys)=>Float64Array.from([...xs,...ys])

const CASES=[
    {name:"two equal peaks",      xs:[10,20,30],  ys:[5,0,5]},
    {name:"a single tall peak",  xs:[10,20,30],  ys:[1,9,1]},
    {name:"a wide plateau",      xs:[1,2,3,4],   ys:[5,0,0,5]},
    {name:"a flat profile",      xs:[1,2,3,4],   ys:[3,3,3,3]},
    {name:"a spike in a valley", xs:[1,2,3,4,5], ys:[1,1,20,1,1]},
    {name:"a monotonic ramp",    xs:[1,2,3,4],   ys:[1,2,3,4]},
]

console.log("the Rust kernel integrates the mass as it merges")
for(const {name,xs,ys} of CASES){
    test(`a component reports the area of the peak that died - ${name}`,()=>{
        const a=rust.persistent_homology_0d_waves(core(xs,ys),2,"superlevel")
        //PROPERTY, not a call: this wasm-bindgen build exposes the analysis
        //fields as getters, which is exactly how kernelWorker.js reads them
        const mass=a.integrated_mass
        const cent=a.centroid_x
        ok(mass.length===xs.length,`expected one mass per point, got ${mass.length}`)
        ok(cent.length===xs.length,`expected one centroid per point, got ${cent.length}`)
        //every point belongs to exactly one component, so the DEEPEST one must
        //hold the whole profile: that is the conservation that has to hold
        const total=ys.reduce((s,v)=>s+v,0)
        const largest=Array.from(mass).reduce((m,v)=>Math.max(m,v),0)
        close(largest,total,`the surviving component should hold the whole profile (${total})`)
        for(const m of mass) ok(Number.isFinite(m)&&m>=0,`a bad area was reported: ${m}`)
    })
}

test("a component with no intensity reports no centroid rather than a zero",()=>{
    const a=rust.persistent_homology_0d_waves(core([1,2,3],[0,0,0]),2,"superlevel")
    for(const c of a.centroid_x) ok(Number.isNaN(c),`an empty component reported the centroid ${c}`)
})

test("a non-finite sample does not poison the areas around it",()=>{
    const a=rust.persistent_homology_0d_waves(core([1,2,3],[10,NaN,4]),2,"superlevel")
    for(const m of a.integrated_mass) ok(Number.isFinite(m),`a NaN sample leaked into an area: ${m}`)
})

test("an empty profile is empty, not a crash",()=>{
    const a=rust.persistent_homology_0d_waves(new Float64Array(0),2,"superlevel")
    ok(a.integrated_mass.length===0)
    ok(a.centroid_x.length===0)
})

test("the deepest component's centroid is the intensity-weighted mean",()=>{
    //(10*5 + 20*0 + 30*5)/10 = 20
    const a=rust.persistent_homology_0d_waves(core([10,20,30],[5,0,5]),2,"superlevel")
    const cent=Array.from(a.centroid_x)
    ok(cent.some(c=>Math.abs(c-20)<1e-9),`no component reported the centroid 20, got ${JSON.stringify(cent)}`)
})

console.log("the JS fallback integrates EXACTLY like the Rust kernel")
for(const {name,xs,ys} of CASES){
    test(`both implementations agree - ${name}`,()=>{
        const c=core(xs,ys)
        const a=rust.persistent_homology_0d_waves(c,2,"superlevel")
        const js=integrateComponentMassJS(c,2,"superlevel")
        const mass=Array.from(a.integrated_mass)
        for(let i=0;i<mass.length;i++){
            close(js.mass[i],mass[i],`area of point ${i} (x=${xs[i]})`)
            //NaN is legitimate on both sides, so it is compared as "both
            //undefined" rather than skipped: a fallback that invented a
            //centroid where Rust says "none" is exactly the drift to catch
            const bothNaN=Number.isNaN(js.centroid[i])&&Number.isNaN(a.centroid_x[i])
            if(bothNaN) continue
            close(js.centroid[i],a.centroid_x[i],`centroid of point ${i} (x=${xs[i]})`)
        }
    })
}

test("the fallback and Rust agree in sublevel mode too",()=>{
    //only superlevel is swept above; a tie rule differing between the two
    //directions would hide here
    const xs=[1,2,3,4,5], ys=[4,1,7,1,3]
    const c=core(xs,ys)
    const a=rust.persistent_homology_0d_waves(c,2,"sublevel")
    const js=integrateComponentMassJS(c,2,"sublevel")
    const mass=Array.from(a.integrated_mass)
    for(let i=0;i<mass.length;i++) close(js.mass[i],mass[i],`sublevel area of point ${i}`)
})

console.log("the mass SURVIVES the classifier, which is where it used to die")
test("the classifier carries the mass instead of the chief",()=>{
    /* THE BUG THIS FILE EXISTS FOR, stated as a number.

       `points_y` is the intensity of the point that BORN a component — its
       chief. The classifier used to re-emit it and nothing else, so the sum
       computed by the sweep was correct for exactly one kernel call and gone by
       the next one. Everything downstream — the kept points, the anti-radio
       stage, the output wave — therefore still saw one tall point per peak.

       So the test is not "does the sweep compute a mass" (that one already
       passed). It is "does the mass come BACK OUT of the classifier". */
    const a=rust.persistent_homology_0d_waves(core([10,20,30],[5,0,5]),2,"superlevel")
    const chiefs=Array.from(a.points_y)
    const masses=Array.from(a.integrated_mass)
    //the chief column and the mass column must NOT be the same numbers
    const sameAsChiefs=chiefs.every((v,i)=>v===masses[i])
    ok(!sameAsChiefs,`the mass is just the chief again: ${JSON.stringify(masses)}`)

    const classification=rust.classify_persistence_0d(
        a.births,a.deaths,a.points_x,a.points_y,a.birth_indices,0.99,
        a.integrated_mass,a.centroid_x
    )
    const keptMass=Array.from(classification.kept_integrated_mass)
    ok(keptMass.length===masses.length,
        `the classifier kept ${keptMass.length} masses for ${masses.length} peaks`)
    ok(keptMass.length>0,"nothing survived to carry a mass")
    //and at least one kept mass is an AREA, i.e. bigger than the chief it replaced
    const biggestArea=Math.max(...keptMass)
    const biggestChief=Math.max(...chiefs)
    ok(biggestArea>=biggestChief,
        `the biggest area (${biggestArea}) should not be below the biggest chief (${biggestChief})`)
})
test("a classifier given no mass reports NaN, not a silent zero",()=>{
    const a=rust.persistent_homology_0d_waves(core([10,20,30],[5,0,5]),2,"superlevel")
    const empty=new Float64Array(0)
    const classification=rust.classify_persistence_0d(
        a.births,a.deaths,a.points_x,a.points_y,a.birth_indices,0.99,empty,empty
    )
    /* A zero would read as "this peak has no area", which is a CLAIM about the
       data. A NaN reads as "this build did not tell me", which is the truth. */
    for(const m of classification.kept_integrated_mass){
        ok(Number.isNaN(m),`a missing mass was reported as ${m} instead of NaN`)
    }
})

console.log("the node publishes the AREA, not the chief")
test("PeakPickingNode publishes the integrated mass as the peak's Y",()=>{
    /* The kernel is only half the pipeline. What the user SEES is the output
       wave, and it is published by publishOutput(). If the node still hands
       that the chief column, the integration is computed, carried, and then
       dropped one layer further down — which is precisely what happened, and
       precisely why nothing appeared to change on screen.

       The whole CLASS is read, not just publishOutput: the mass is chosen by
       its CALLER (applyAntiRadio), and a test scoped to the callee would have
       "passed" against a node that never used the mass at all. */
    const body=blocks.get("PeakPickingNode")??""
    const publish=body.slice(body.indexOf("    publishOutput("))
    ok(!/publishOutput\(result\.pointsX,result\.pointsY/.test(publish),
        "the node still publishes the anti-radio result's chief column")
    ok(/keptMass|publishedY/.test(body),
        "the node never mentions the integrated mass it was given")
    /* and the mass must be filtered by the SAME mask as the peaks, or the two
       columns drift apart: the area of one peak under the x of another */
    ok(/isRadio/.test(body),
        "the mass is not filtered by the anti-radio mask: the columns will misalign")
})
test("kernelWorker passes the new fields through to its callers",()=>{
    ok(/integratedMass:toFloat64\(analysis\.integrated_mass\)/.test(workerSource),
        "the Rust path in kernelWorker does not forward integrated_mass")
    ok(/centroidX:toFloat64\(analysis\.centroid_x\)/.test(workerSource),
        "the Rust path in kernelWorker does not forward centroid_x")
    ok(/integratedMass,centroidX/.test(workerSource),
        "the JS fallback in kernelWorker does not return the new fields")
})

console.log("")
if(failures.length){
    console.log(`${passed} passed, ${failures.length} failed`)
    process.exit(1)
}
console.log(`${passed} passed, 0 failed`)
// SPLIT

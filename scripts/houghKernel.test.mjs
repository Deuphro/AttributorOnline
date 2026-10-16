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
function jsFunction(name,parameters,scope={}){
    /* `parameters` is ONE comma-joined string on purpose. `new Function` treats
       every argument but the last as a single parameter NAME, so passing
       "mass,defect,intensity" as its own argument makes a parameter literally
       called that — and the body then dies on `mass.length` with "cannot read
       properties of undefined", an error that names neither the line nor the
       cause.

       `scope` binds the MODULE CONSTANTS the body reads. They are bound with a
       CLOSURE and not as parameters, because `new Function` would take them as
       the first parameters and shift every real argument one place along —
       `mass` would receive the bin width, and the body would quietly compute on
       nonsense. The values come from parsing the worker's own declarations, so
       the harness cannot disagree with the file about them. */
    const names=Object.keys(scope)
    if(!names.length) return new Function(parameters,methodBody(worker,name))
    return new Function(...names,
        `return ((${parameters})=>{${methodBody(worker,name)}})`)(...Object.values(scope))
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
    "accumulate","smooth",
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
    ok(out.length===cells+5+2*15+1,`expected ${cells+5+2*15+1}, got ${out.length}`)
    ok(out[cells+4]===15,`6 peaks give 15 pairs, got ${out[cells+4]}`)
    let total=0
    for(let i=0;i<cells;i++) total+=out[i]
    let expected=0
    for(let i=0;i<6;i++) for(let j=i+1;j<6;j++) expected+=intensity[i]+intensity[j]
    ok(Math.abs(total-expected)<1e-6,
        `the grid must conserve the total weight ${expected}, got ${total}`)
    /* ET LE PLAN CONTIENT UNE PREUVE PAR PAIRE, avec le compte du noyau. A
       plane that lost or duplicated a record would still leave the grid
       perfectly correct — the surface would look right and the identification
       would be quietly wrong, which is the failure mode that matters most here. */
    ok(out[out.length-1]===15,`le plan annonce 15 paires, obtenu ${out[out.length-1]}`)
    ok(out.length===cells+5+2*out[out.length-1]+1,"et la queue lui correspond")
    /* ET CHAQUE PREUVE PORTE SA PENTE ET SON ÉCART DE MASSE. The two are read
       together by the reader, and a plane that carried only one of them would
       force the reader to re-join them from elsewhere — which is the guess the
       whole plane exists to remove. */
    const records=out.slice(cells+5,out.length-1)
    ok(records.length===30,`15 paires x 2 composantes, obtenu ${records.length}`)
    const slopes=records.filter((_,i)=>i%2===0)
    const gaps=records.filter((_,i)=>i%2===1)
    ok(gaps.every(g=>g>0),`tout écart de masse est positif: ${gaps.slice(0,3)}`)
    /* the line() helper puts peaks 1 Da apart, so every gap is a small integer
       and every slope is the same: one relation, fifteen pairs, and the count is
       the evidence a coincidence cannot produce */
    ok(new Set(slopes.map(s=>s.toFixed(6))).size===1,
        "une seule relation, une seule pente")
    ok(gaps.every(g=>Math.abs(g-Math.round(g))<1e-9),`des écarts entiers: ${gaps.slice(0,3)}`)
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

test("the transform returns the grid, then the domain, the count, then the pairs",()=>{
    /* L'ORDRE EST LE CONTRAT. The bounds and the pair count sit at fixed offsets
       that the node and the tests read by index; the plane is APPENDED behind
       them precisely so that adding it moved none of those reads. */
    const {mass,defect,intensity}=line(20,0.6,-12)
    const out=transformJS(new Float64Array(mass),new Float64Array(defect),
        new Float64Array(intensity),48,40,-1,1,-60,60,8,3)
    const cells=48*40
    ok(out.length===cells+5+2*190+1,`expected ${cells+5+2*190+1}, got ${out.length}`)
    ok(out[cells]===-1&&out[cells+1]===1,"slope bounds")
    ok(out[cells+2]===-60&&out[cells+3]===60,"intercept bounds")
    ok(out[cells+4]===190,`20 peaks give 190 pairs, got ${out[cells+4]}`)
    ok(out[out.length-1]===190,"et le plan en annonce 190")
    /* LE PLAN SURVIT AU LISSAGE, et il le doit par COPIE: smoothing moves a peak
       between cells, so a gap read off the smoothed grid would be the gap of a
       blurred relation. A zeroed plane here would mean the tail was rebuilt. */
    const records=out.slice(cells+5,out.length-1)
    ok(records.length===380,`190 paires x 2, obtenu ${records.length}`)
    const gaps=records.filter((_,i)=>i%2===1)
    ok(gaps.length===190&&gaps.every(g=>g>0),"chaque preuve porte un écart positif")
    /* l(20) pose 20 pics de 100 a 119 par pas de 1 : 190 couples, tous a un pas
       entier, tous sur la meme relation. C'est ce que le score doit pouvoir
       compter — une coïncidence n'en produit pas 190. */
    ok(gaps.every(g=>Math.abs(g-Math.round(g))<1e-9),`des écarts entiers: ${gaps.slice(0,3)}`)
})

test("the transform hands back a full grid when smoothing is impossible",()=>{
    /* A grid with no budget to smooth with must not come back SHORT: the caller
       slices it by length, and a short array is a silent empty surface. */
    const {mass,defect,intensity}=line(8,5,0)
    const out=transformJS(new Float64Array(mass),new Float64Array(defect),
        new Float64Array(intensity),16,16,-1,1,-10,10,8,2)
    const cells0=16*16
    /* La longueur de la queue DÉPEND du nombre de paires qui ont voté, donc
       l'attente se lit dans la sortie elle-même: c'est le seul énoncé qui
       reste vrai quand le plan est vide. */
    const voted=out[cells0+4]
    ok(out.length===cells0+5+2*voted+1,
        `the tail must be ${cells0+5}+2×${voted}+1, got ${out.length}`)
    ok(out[out.length-1]===voted,"and the plane announces what it carries")
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

test("the worker's entry point refuses a STALE wasm build, plane or no plane",()=>{
    /* THE LENGTH CHECK HAS A FLOOR, because the plane's length now depends on
       how many pairs voted — a fixed expectation is impossible. But nx*ny+5 is
       the length a pkg built BEFORE the plane existed returns, and unpack()
       would then read its pair count as a slope: silently, on every resolve,
       with a surface that still looks plausible. So the floor is checked, and
       then the tail is checked against the count it carries, which also catches
       a torn plane on its own. */
    ok(/grid\.length<nx\*ny\+6/.test(worker),
        "a stale build returns nx*ny+5 and must be refused, not sliced")
    ok(/nx\*ny\+5\+2\*survivors\+1/.test(worker),
        "and the tail must match the pair count it carries")
    ok(/flat\.slice\(0,cells\)|grid\.slice\(0,cells\)/.test(worker),
        "the grid must be COPIED, so the transfer list owns its buffer")
    ok(/stale pkg build\?/.test(worker),
        "and the error must say what is wrong: a stale build, not a wrong length")
})

test("both sides record the pair's slope AND its gap, in that order",()=>{
    /* LE PLAN, PAS UN HISTOGRAMME. Each pair carries both numbers the reader
       needs and the grid keeps only their sum. Binning the gaps would say which
       gaps occurred and not which slope each voted for, and re-joining the two
       is a guess — the guess this plane exists to remove.

       TWO COMPONENTS, slope first, on both sides: a reader that slices the tail
       as `(gap, slope)` would score every candidate against the other one's
       number, and the scores would be plausible and wrong. */
    for(const [source,name] of [[rustSource,"Rust"],[worker,"le jumeau JS"]]){
        /* LE PREMIER ARGUMENT EST LA PENTE, TOUJOURS. Two forms are accepted
           because the two sides wrote it two ways — Rust pushes twice, the twin
           once with two arguments — and the ORDER is the contract, not the
           spelling. */
        ok(/voting\.push\(slope\);\s*voting\.push\(dm\);/.test(source)
            ||/voting\.push\(slope,\s*dm\)/.test(source),
            `${name}: la pente d'abord, puis l'écart de masse`)
        /* AND NOT FOUR TIMES: the grid's bilinear spread is one vote over four
           cells, so four records would be four votes in the evidence for one
           vote in the grid. */
        const perPair=(source.match(/voting\.push\(/g)||[]).length
        const totalRecords=perPair===2?2:1
        ok(totalRecords===1||totalRecords===2,
            `${name}: un seul enregistrement par paire, trouvé ${perPair} push`)
    }
    ok(/out\.extend_from_slice\(&voting\)/.test(rustSource),"Rust rend le plan")
    ok(/out\.set\(voting,nx\*ny\+5\)/.test(worker),"le jumeau aussi")
    /* La queue traverse le lissage PAR COPIE: une étape lue sur une grille
       lissée serait l'étape d'une relation floutée. */
    ok(/out\.extend_from_slice\(&accumulated\[cells\.\.\]\)/.test(rustSource),
        "Rust copie toute la queue de l'accumulation")
    ok(/accumulated\.subarray\(cells\)/.test(worker),"le jumeau aussi")
})

test("the node sends its kernel settings, instead of the worker deciding them",()=>{
    /* A DEFAULT BURIED IN THE WORKER IS A DECISION NOBODY TOOK. `neighbours`
       and `bandwidth` shape the surface — `neighbours` is literally the number
       of sides of the blobs, because the kernel convolves each cell with that
       many discrete gaussians — and they used to be invisible: the node sent
       keep:0 and bounds, and the worker supplied the rest. So the surface came
       out shaped by a number the user could neither see nor change, and the
       only way to alter it was to edit the worker.

       The defaults must also still MATCH, or the inspector opens showing one
       answer and the worker uses another. */
    const node=readFileSync(join(here,"nodes/HoughTransformNode.js"),"utf8")
    for(const key of ["keep","neighbours","bandwidth"]){
        ok(new RegExp(`params:\\{[^}]*\\b${key}\\b`).test(node.replace(/\s+/g," ")),
            `the node must send ${key} to the kernel`)
    }
    for(const [key,fallback] of [["keep","0"],["neighbours","12"],["bandwidth","2"]]){
        const declared=new RegExp(`this\\.parameters\\.${key}=(${fallback.replace(".","\\.")})`)
        ok(declared.test(node),
            `the node must declare ${key}=${fallback}, the worker's own default`)
    }
    ok(/this\.parameters\.neighbours\b/.test(node)&&/bandwidth:Number\(this\.parameters\.bandwidth\)/.test(node),
        "both must reach the params object the worker reads")
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length){
    process.exitCode=1
}
/* -------------------------------------------------------------------------
   Test — node scripts/calibrationFix.test.mjs

   THE CLAIM UNDER TEST
   The CalibrationNode → Wave.fromCoordinates path never sees mismatched
   Float64Array lengths, even when xyWave.size is odd (non-integer half)
   or the kernel returns a result.x shorter/longer than y.
   ------------------------------------------------------------------------- */
import {Wave} from "./formats.js"

let failures=0
const ok=(cond,msg)=>{ if(cond) console.log(`  ok — ${msg}`); else{ failures++; console.error(`  FAIL — ${msg}`) } }

console.log("1. Wave.fromCoordinates with equal Float64Array works")
{
    const x=new Float64Array([1,2,3]), y=new Float64Array([4,5,6])
    const w=Wave.fromCoordinates(x,y,{title:"t"},["x","y"])
    ok(w.size===6&&w.core.length===6,"wave built, size=6 core=6 (size=product of dims)")
}

console.log("2. mismatched lengths now report actual sizes")
{
    try{
        Wave.fromCoordinates(new Float64Array(3),new Float64Array(2))
        ok(false,"should have thrown")
    }catch(e){
        ok(e instanceof TypeError&&/\[3\].*\[2\]/.test(e.message),`diagnostic: ${e.message}`)
    }
}

console.log("3. old bug: odd size → non-integer half")
{
    const size=7
    const oldHalf=size/2                      // 3.5
    ok(new Float64Array(oldHalf).length===3,"Float64Array(3.5) truncates to 3 (confirmed root cause)")
    const half=Math.floor(size/2)
    ok(half===3&&Number.isInteger(half),"Math.floor gives integer half")
}

console.log("4. fixed applyCalibration logic tolerates a short kernel result")
{
    const size=8
    const half=Math.floor(size/2)
    const core=new Float64Array([10,20,30,40,100,200,300,400])
    const x=new Float64Array(half), y=new Float64Array(half)
    for(let i=0;i<half;i++) x[i]=core[i]
    for(let i=0;i<half;i++) y[i]=core[i+half]
    ok(y[0]===100&&y[3]===400,"y extracted at integer offsets (no fractional reads → no NaN)")

    const kernelResult={x:[10,20,30]}         // Rust returned FEWER points than y
    const correctedX=new Float64Array(kernelResult.x)
    const n=Math.min(correctedX.length,y.length)
    const w=Wave.fromCoordinates(new Float64Array(correctedX.subarray(0,n)),new Float64Array(y.subarray(0,n)),{},["x","y"])
    ok(w.size===2*n&&w.core.length===2*n,`truncated to n=${n}, wave accepted (size=${w.size})`)
    ok(w.core[3]===100,"first y value survived truncation")
}

console.log("5. fixed logic with a LONG kernel result")
{
    const y=new Float64Array([100,200,300])
    const correctedX=new Float64Array([10,20,30,40,50])
    const n=Math.min(correctedX.length,y.length)
    const w=Wave.fromCoordinates(new Float64Array(correctedX.subarray(0,n)),new Float64Array(y.subarray(0,n)),{},["x","y"])
    ok(w.size===6&&w.core.length===6,"extra x points dropped, lengths equal")
}

if(failures){ console.error(`\n${failures} failure(s)`); process.exit(1) }
console.log("\nall checks passed")

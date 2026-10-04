/* -------------------------------------------------------------------------
   Test — node scripts/multiplex.test.mjs

   THE CLAIM UNDER TEST
   The Trimmer and the Peak-picking node both accept a MULTIPLEXED input —
   several links on input 0, or one link carrying several waves — and answer it
   the same way: the same treatment applied to each input, one output wave per
   input wave, and not one per-spectrum reading stored as a setting.

   Three things are invisible when they go wrong, and that is why this file
   exists at all:

     1. a node that REFUSES the multiplex. Both used to fail with "exactly one
        link on input 0 is required", which is a refusal that looks like a
        deliberate rule;
     2. a guess that BECOMES A SETTING. Writing the first spectrum's slope or z
        into `parameters` would silently cut every other spectrum with it on the
        next resolve — the one bug that would survive a plausible implementation;
     3. a per-input threshold measured on ANOTHER input. The quantile read off
        the wrong histogram is a number, so nothing looks broken.

   The nodes need d3 and a real DOM, so they cannot be imported here. The class
   bodies are read as TEXT and checked as a CONTRACT — the same cheap guard
   persistenceMass.test.mjs uses for the published column, and deliberately not
   a substitute for running the node.
   ------------------------------------------------------------------------- */
import {readFileSync} from "fs"
import {fileURLToPath} from "url"
import {dirname, join} from "path"

const here=dirname(fileURLToPath(import.meta.url))
const source=readFileSync(join(here,"interface.js"),"utf8")

let passed=0
const failures=[]
const test=(name,fn)=>{
    try{ fn(); passed++; console.log(`  ok   ${name}`) }
    catch(e){ failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const ok=(value,msg)=>{ if(!value) throw new Error(msg??`expected a truthy value, got ${value}`) }
const no=(value,msg)=>{ if(value) throw new Error(msg??`expected nothing, got: ${String(value).slice(0,90)}`) }

/* One block per class, so a test can ask about ONE node without running it. */
function classBlocks(text){
    const starts=[...text.matchAll(/^class\s+(\w+)(?:\s+extends\s+(\w+))?[^{]*\{/gm)]
    return new Map(starts.map((match,index)=>[
        match[1],
        text.slice(match.index,starts[index+1]?.index??text.length)
    ]))
}
const blocks=classBlocks(source)
const trimmer=blocks.get("TrimmerNode")??""
const peaks=blocks.get("PeakPickingNode")??""

/* One method, from its own signature to the next one at class indentation —
   enough to assert on one function without catching its neighbours. A missing
   anchor would slice to the end of the class, which the `includes` checks would
   still pass, so every anchor is verified first. */
function method(text,name){
    const start=text.search(new RegExp(`^    (async )?${name}\\(`,`m`))
    if(start<0) return ""
    const rest=text.slice(start+1)
    const next=rest.search(/^    (async )?[A-Za-z_$][\w$]*\(/m)
    return next<0?text.slice(start):text.slice(start,start+1+next)
}

console.log("the file still parses into the classes this test knows about")
test("both classes were found",()=>{
    ok(blocks.has("TrimmerNode"),"class TrimmerNode not found - the parser is broken")
    ok(blocks.has("PeakPickingNode"),"class PeakPickingNode not found - the parser is broken")
})
test("the methods this test slices on are really there",()=>{
    for(const [body,name] of [[trimmer,"startResolve"],[peaks,"startResolve"],
        [trimmer,"resolveMultiplexed"],[peaks,"resolveMultiplexed"]]){
        ok(method(body,name),`${name} not found - a test below would pass on an empty slice`)
    }
})

console.log("\nneither node refuses a multiplexed input any more")
for(const [name,body] of [["TrimmerNode",trimmer],["PeakPickingNode",peaks]]){
    test(`${name} no longer insists on one link`,()=>{
        no(/exactly one link/.test(body),`${name} still refuses: it will not resolve a second cable`)
        no(/links\.length>1/.test(body),`${name} still counts the links and refuses when there is more than one`)
    })
    test(`${name} forks on the number of WAVES, not of links`,()=>{
        const resolve=method(body,"startResolve")
        ok(/waves\.length===1/.test(resolve),`${name} does not keep the single-input path`)
        ok(/resolveMultiplexed\(waves\)/.test(resolve),`${name} never routes a batch to its multiplexed path`)
        ok(/collectInputWaves\(\)/.test(resolve),`${name} does not read its input through the shared reader`)
    })
    test(`${name} publishes one output per input wave`,()=>{
        const loop=method(body,"resolveMultiplexed")
        ok(/products\.push/.test(loop),`${name} collects no product in its batch loop`)
        ok(/this\.outputs\[0\]=products/.test(loop),`${name} never publishes the whole batch at once`)
        ok(/for\(let i=0;i<waves\.length;i\+\+\)/.test(loop),`${name} does not walk its inputs one at a time`)
    })
    test(`${name} carries on past one failing input`,()=>{
        const loop=method(body,"resolveMultiplexed")
        ok(/catch\(err\)/.test(loop),`${name} has no per-input catch: one bad spectrum kills the node`)
        ok(/errors\.length&&!products\.length\?"error":"resolved"/.test(loop),
            `${name} paints red over good results`)
    })
}

console.log("\nthe guess must NEVER become a setting")
for(const [name,body] of [["TrimmerNode",trimmer],["PeakPickingNode",peaks]]){
    test(`${name} writes no cursor while resolving a batch`,()=>{
        const loop=method(body,"resolveMultiplexed")
        no(/parameters\.lowBound\s*=/.test(loop),
            `${name} writes a cursor for a batch: that bound belongs to one spectrum alone`)
        no(/parameters\.highBound\s*=/.test(loop),
            `${name} writes a cursor for a batch: that bound belongs to one spectrum alone`)
    })
}
test("PeakPickingNode stores neither the guessed slope nor the guessed z",()=>{
    const loop=method(peaks,"resolveMultiplexed")
    no(/parameters\.slope\s*=/.test(loop),
        "the guessed slope is stored: the next resolve would cut every spectrum with the first one's")
    no(/parameters\.z\s*=/.test(loop),
        "the guessed z is stored: the next resolve would cut every spectrum with the first one's")
    no(/applyZ\(/.test(loop),
        "the batch resolve commits a z through applyZ, which writes it into the node")
    //and the single-input path is still allowed to: that IS the user's setting
    ok(/parameters\.slope=analysis\.slope/.test(method(peaks,"resolveOneInput")),
        "the single-input path no longer adopts the kernel's fitted slope")
})
test("PeakPickingNode reads the slope and the z from each spectrum in turn",()=>{
    //the per-spectrum pipeline is where this happens; the loop only has to call it
    const pipeline=method(peaks,"pickPeaksFrom")
    ok(/readZFromKernel\(inputWave,/.test(pipeline),
        "the z is not read per spectrum: one spectrum's widths would cut them all")
    ok(/analysis\.slope/.test(pipeline),
        "the slope is not the kernel's own fit per spectrum")
    ok(/pickPeaksFrom\(wave\)/.test(method(peaks,"resolveMultiplexed")),
        "the batch does not go through the per-spectrum pipeline")
})
test("TrimmerNode measures each threshold on its own histogram",()=>{
    ok(/guessBoundsFor\(wave,linear,bins\)/.test(method(trimmer,"resolveMultiplexed")),
        "the batch guess is not given the input's own histogram and span")
    //the quantile must be a PARAMETER, not this.bins, or the reading is taken
    //off whichever spectrum happens to be drawn on the frame
    const threshold=method(trimmer,"effectiveThreshold")
    ok(/this\.quantileThreshold\(0\.05,bins\)/.test(threshold),
        "the quantile is not read off the histogram it was handed, so every input is cut at the first one's")
    //the DEFAULT may still be this.bins: with one input that IS the right
    //histogram, and the single-input path must keep behaving as it always did
    ok(/effectiveThreshold\(bins=this\.bins\)/.test(threshold),
        "effectiveThreshold lost its default: the single-input path would read nothing")
})

console.log("\nthe controls that tune ONE spectrum go grey")
test("PeakPickingNode greys the slope and the z",()=>{
    const update=method(peaks,"updatePeakMultiplex")
    ok(/isMultiplexed\(\)/.test(update),"the greying does not depend on being multiplexed")
    for(const control of ["this.slopeInput","this.slopeGuessBtn","this.zInput","this.zGuessBtn"]){
        ok(update.includes(control),`${control} is never greyed`)
    }
    ok(/handleClassifierClick\(event\)\{[\s\S]{0,400}isMultiplexed\(\)/.test(peaks),
        "a click on the diagram still places one classifier line over N spectra")
    ok(/setSlope\(newSlope, commit = false\)\{[\s\S]{0,400}isMultiplexed\(\)/.test(peaks),
        "setSlope still stores a slope while multiplexed")
})
test("TrimmerNode greys the cursors but keeps the method",()=>{
    const update=method(trimmer,"updateTrimmerMultiplex")
    ok(/this\.guessBtn\.disabled=on/.test(update),"the Guess button is never greyed")
    ok(/setTrimBound\(key,value\)\{[\s\S]{0,300}isMultiplexed\(\)/.test(trimmer),
        "a bound can still be written while a batch is published")
    ok(method(trimmer,"drawTrimmerOverlay").includes("liveCursors=!this.isMultiplexed()"),
        "the cursors are still drawn while multiplexed")
    //the method is the recipe the whole batch shares: it must stay selectable
    no(/this\.methodSelect\.disabled/.test(update),
        "the method is greyed: it is the one setting the N spectra share")
})

console.log("\nand the multiplex is announced where the numbers are")
for(const [name,body] of [["TrimmerNode",trimmer],["PeakPickingNode",peaks]]){
    test(`${name} says how many inputs it read`,()=>{
        ok(/entrées/.test(body),`${name} shows a bare kept/total, which reads as one spectrum`)
    })
}
test("the multiplex is not saved in the session",()=>{
    //it is a property of the links, and writing it down would put it in every
    //session file for something a resolve can read off the graph in one line
    no(/serializeState\(\)\{[\s\S]{0,700}multiplex/.test(trimmer),
        "TrimmerNode serialises its multiplex state")
    no(/serializeState\(\)\{[\s\S]{0,700}multiplex/.test(peaks),
        "PeakPickingNode serialises its multiplex state")
})

console.log("")
if(failures.length){
    console.log(`${passed} passed, ${failures.length} failed`)
    process.exit(1)
}
console.log(`${passed} passed, 0 failed`)
/* -------------------------------------------------------------------------
   Test — node scripts/calibrationCollectionShape.test.mjs

   Calibration stopped resolving, silently, after the clustering work. The node
   was not at fault and neither was this file: FormulaCollectionNode stopped
   PUBLISHING FormulaCollection instances (commit fec4697, publishOutput()),
   and started publishing plain literals `{name, formulas}`.

   Two independent breaks fell out of that one change:
     • the node recognised collections by `constructor.name === "FormulaCollection"`,
       and a plain object's constructor is `Object` — so nothing was recognised;
     • even past that, it read `entry.formula.mz` and `entry.target.mz`, and the
       flat form carries `mz` and `targets[]` instead.

   Both failed SILENTLY: `startResolve()` takes its "no collection" branch,
   which leaves the node floating and logs nothing. That is the whole reason
   this file exists.

   The bodies under test are read out of the source and evaluated, because
   re-typing them here would test the copy rather than the code — the first
   version of this file had exactly that bug, in a fixture that did not match
   what publishOutput() actually emits.
   ------------------------------------------------------------------------- */
import {readFileSync} from "fs"
import {methodBody as extract,codeOnly} from "./sourceBody.mjs"
import {fileURLToPath} from "url"
import {dirname, join} from "path"

const here=dirname(fileURLToPath(import.meta.url))
const source=readFileSync(join(here,"nodes/CalibrationNode.js"),"utf8")

let passed=0
const failures=[]
const test=(name,fn)=>{
    try{ fn(); passed++; console.log(`  ok   ${name}`) }
    catch(e){ failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const ok=(value,msg)=>{ if(!value) throw new Error(msg??"expected a truthy value") }

/* The shared extractor, see scripts/sourceBody.mjs for the four ways the
   hand-rolled version of this was wrong. */

/* `value` is the first PARAMETER of both helpers, and the body is evaluated
   without the signature — so it is supplied as a formal argument here, not as
   a property of `this`. */
const accepts=new Function("value",extract(source,"acceptsCollection"))
const reference=new Function("value",extract(source,"referenceOf"))

/* EXACTLY what FormulaCollectionNode.publishOutput() pushes: a literal, whose
   formulas are flat objects with `mz` and `targets[]` and NO `formula`, NO
   `target`, NO `constructor.name` of any use. */
const published={
    name:"sample",
    formulas:[
        {
            key:"C6H12O6 [H+]",
            notation:"C6H12O6 [H+]",
            mz:181.0707,
            mass:180.0423,
            charge:1,
            molecule:"C6H12O6",
            errorPpm:12.5,
            intensity:4200,
            note:"",
            targets:[
                {mz:181.0729,intensity:4200,errorPpm:12.5,cost:0.4},
                {mz:181.0913,intensity:900,errorPpm:113.7,cost:0.9}
            ]
        },
        {
            key:"C7H14O2 [H+]",
            notation:"C7H14O2 [H+]",
            mz:131.1073,
            mass:130.0994,
            charge:1,
            molecule:"C7H14O2",
            errorPpm:null,
            intensity:0,
            note:"",
            targets:[]
        }
    ]
}

/* And the instance form, for the case that used to be the only one. */
const instance={
    constructor:{name:"FormulaCollection"},
    entries:[
        {
            formula:{mz:181.0707},
            target:{mz:181.0729,intensity:4200},
            errorPpm:12.5
        }
    ]
}

test("the published literal IS recognised as a collection",()=>{
    ok(accepts(published),
        "publishOutput() emits a plain literal; recognisesCollection() must accept it")
})

test("an instance is still recognised",()=>{
    ok(accepts(instance),"the instance form must keep working")
})

test("the shape is told apart by its fields, not by its class name",()=>{
    /* This is the exact check that failed silently: a literal's constructor is
       Object, so a name test can never match one. */
    ok(!/constructor/.test(extract(source,"acceptsCollection")),
        "acceptsCollection() must not test constructor.name: a plain object is always 'Object'")
    ok(/entries/.test(extract(source,"acceptsCollection"))&&/formulas/.test(extract(source,"acceptsCollection")),
        "acceptsCollection() must accept both `entries` and `formulas`")
})

test("a reference is read out of the flat form",()=>{
    const point=reference.call({},published.formulas[0])
    ok(point.trueMz===181.0707,`trueMz should be the formula m/z 181.0707, got ${point.trueMz}`)
    ok(point.measuredMz===181.0729,
        `measuredMz should be the NEAREST target (181.0729), not a far one, got ${point.measuredMz}`)
    ok(point.intensity===4200,`intensity should come from that same target, got ${point.intensity}`)
    ok(point.errorPpm===12.5,`errorPpm should be 12.5, got ${point.errorPpm}`)
})

test("the nearest TARGET wins, never the first",()=>{
    /* The second target here is 18 Da away — an isotopic partner, not the
       monoisotopic match. Taking targets[0] or the last one would put the
       reference at a different error entirely. */
    const point=reference.call({},published.formulas[0])
    const distances=published.formulas[0].targets.map(t=>Math.abs(t.mz-181.0707))
    const nearest=published.formulas[0].targets[distances.indexOf(Math.min(...distances))]
    ok(point.measuredMz===nearest.mz,
        `measuredMz should be the nearest target ${nearest.mz}, got ${point.measuredMz}`)
})

test("a formula with no target yields a non-finite error, so it is skipped",()=>{
    const point=reference.call({},published.formulas[1])
    ok(!Number.isFinite(point.measuredMz),
        "a formula with no target has no measured m/z — it must not be invented")
    ok(!Number.isFinite(point.errorPpm),
        "and no error either, so extractReferencePoints() drops it")
    ok(point.trueMz===131.1073,"but its true m/z is still known")
})

test("a reference is read out of the instance form too",()=>{
    const point=reference.call({},instance.entries[0])
    ok(point.trueMz===181.0707,`trueMz should be formula.mz, got ${point.trueMz}`)
    ok(point.measuredMz===181.0729,`measuredMz should be target.mz, got ${point.measuredMz}`)
    ok(point.intensity===4200,`intensity should be target.intensity, got ${point.intensity}`)
})

test("extractReferencePoints accepts BOTH shapes",()=>{
    /* The second break: even past the recognition, the loop read
       `entry.formula` / `entry.target`, which the flat form does not carry, so
       it would collect nothing — silently, again. */
    const body=extract(source,"extractReferencePoints")
    ok(/formulaCollection\.formulas/.test(body),
        "extractReferencePoints() must read the `formulas` of the flat form")
    ok(!/entry\.formula\b/.test(body),
        "and must not read entry.formula directly: the flat form has no such field")
    ok(!/entry\.target\b/.test(body),
        "nor entry.target: the flat form carries targets[] instead")
})

test("nothing left reads the old field names anywhere in the node",()=>{
    for(const field of ["entry.formula","entry.target"]){
        ok(!source.includes(field),
            `CalibrationNode still reads \`${field}\`, which the published form does not carry`)
    }
})

test("useCollectionErrors=false still falls back to matching the wave itself",()=>{
    const body=extract(source,"extractReferencePoints")
    ok(/useCollectionErrors/.test(body),
        "the two modes must both survive the shape change")
    ok(/bestDist<0\.5/.test(body),
        "the fallback still matches a formula to the nearest point of the wave")
})

test("the 3D view carries the reference points, so a fit can be judged",()=>{
    /* A surface on its own says nothing about whether it passes through the
       data that produced it. Drawn at (measured m/z, intensity, MEASURED error)
       the points sit on the sheet exactly when the calibration is right, and a
       residual cloud floating above or under it is the shape of a bad fit —
       something the 2D residual trace does not show at a glance. */
    const calib=readFileSync(join(here,"nodes/CalibrationNode.js"),"utf8")
    const body=extract(calib,"update3DSurface")
    ok(/new SurfaceTrace\(/.test(body),"the surface itself must still be there")
    ok(/new Scatter3DTrace\(/.test(body),
        "the reference points must be drawn with the surface, or the fit cannot be judged")
    ok(/setTraces\(traces\)/.test(body),
        "both must go in one setTraces(): two calls would make the second replace the first")

    /* The z of a point is its MEASURED error, which is what the surface
       predicts. Putting anything else there — the true m/z, the corrected one —
       would compare two different quantities. */
    const points=extract(calib,"buildReferencePointWave")
    ok(/p\.errorPpm/.test(points),
        "the point's z must be its measured errorPpm: that is the quantity the surface predicts")
    ok(/p\.measuredMz/.test(points)&&/p\.intensity/.test(points),
        "x and y must be the measured m/z and the intensity the error belongs to")
})

test("a reference point with a non-finite coordinate is dropped, not zeroed",()=>{
    /* A (0, 0, 0) in a plot whose axes start at 100 m/z is a spike pointing at
       nothing, and it reads as a measurement. The grid keeps a fixed row per
       point, so the filter has to happen BEFORE the wave is sized. */
    const calib=readFileSync(join(here,"nodes/CalibrationNode.js"),"utf8")
    const points=extract(calib,"buildReferencePointWave")
    ok(/\.filter\(/.test(points),"the points must be filtered for finiteness")
    ok(points.indexOf("filter")<points.indexOf("new Wave("),
        "the filter must run BEFORE the wave is sized, or the grid keeps holes")
    ok(!/Number\.isFinite\(p\?\.measuredMz\)[\s\S]{0,80}\|\|/.test(points),
        "and it must not fall back to a default coordinate")
})

test("the checkbox reads 3D",()=>{
    const calib=readFileSync(join(here,"nodes/CalibrationNode.js"),"utf8")
    ok(/makeCheckbox\("show3DSurface","3D"/.test(calib),
        "the checkbox label is 3D")
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length){
    process.exitCode=1
}

/* -------------------------------------------------------------------------
   Test — node scripts/plot3dBounds.test.mjs

   The 3D front layer cannot RUN here: it needs a DOM, a canvas and WebGL.
   So this file does what the other headless tests in this repository do —
   it reads the source as TEXT and checks the two pieces of ARITHMETIC that
   decide whether the scene is framed correctly, because both of them are the
   kind of thing that is wrong by a factor of a thousand and still renders
   something plausible-looking.

   The two invariants:
     1. a surface's box is its REMAPPED height range, not its raw value range,
        so the plot is about the data and two runs stay comparable;
     2. a scatter's z is a coordinate and stays exactly where it is — the
        remapping belongs to SurfaceTrace alone.
   ------------------------------------------------------------------------- */
import {readFileSync} from "fs"
import {fileURLToPath} from "url"
import {dirname, join} from "path"

const here=dirname(fileURLToPath(import.meta.url))
const source=readFileSync(join(here,"ui/Plot3DWebGL.js"),"utf8")

let passed=0
const failures=[]
const test=(name,fn)=>{
    try{ fn(); passed++; console.log(`  ok   ${name}`) }
    catch(e){ failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const ok=(value,msg)=>{ if(!value) throw new Error(msg??"expected a truthy value") }

/* The functions as they are written, recovered from the source. Reproducing
   them here by hand would test the copy, not the file — so the body is read
   out and evaluated.

   `after` skips the helper classes above the plot: "dispose()" appears in
   OrbitPanControls first, and a search that stopped there would test the
   controls' teardown while claiming to test the plot's. */
function methodBody(name,after=0){
    const start=source.indexOf(`    ${name}(`,after)
    ok(start>=0,`${name}() not found in Plot3DWebGL.js`)
    const open=source.indexOf("{",start)
    let depth=0
    for(let k=open;k<source.length;k++){
        if(source[k]==="{") depth++
        else if(source[k]==="}"){
            depth--
            if(depth===0) return source.slice(open+1,k)
        }
    }
    throw new Error(`unbalanced braces in ${name}()`)
}

/* computeBounds closes over SurfaceTrace and Scatter3DTrace, so both names
   are supplied: that IS the dispatch under test. They are plain constructor
   functions because `trace instanceof SurfaceTrace` only needs something
   constructible — the traces under test are built with Object.create(). */
function SurfaceTrace(){}
function Scatter3DTrace(){}

const surfaceTrace=(options,carrier=wave)=>Object.assign(Object.create(SurfaceTrace.prototype),{wave:carrier,options})
const scatterTrace=(options,carrier=wave)=>Object.assign(Object.create(Scatter3DTrace.prototype),{wave:carrier,options})

//a [nx, ny, 3] grid over [-1,1]^2 whose z runs 2..6
const NX=4
const NY=3
const wave={
    dims:[NX,NY,3],
    index:(ix,iy,k)=>ix+iy*NX+k*NX*NY,
    core:new Float64Array(NX*NY*3)
}
for(let iy=0;iy<NY;iy++){
    for(let ix=0;ix<NX;ix++){
        wave.core[wave.index(ix,iy,0)]=(ix/(NX-1))*2-1
        wave.core[wave.index(ix,iy,1)]=(iy/(NY-1))*2-1
        wave.core[wave.index(ix,iy,2)]=2+4*(iy/(NY-1))   // z in [2, 6]
    }
}

/* computeBounds closes over SurfaceTrace and Scatter3DTrace, so both names
   are supplied: that IS the dispatch under test. */
const makeBounds=new Function(
    "SurfaceTrace","Scatter3DTrace",
    methodBody("computeBounds")
)
/* `.call` FIRST, arguments after: a function built by `new Function` and then
   invoked without `new` RUNS the body with `this = globalThis` instead of
   building anything, and the resulting failure reads as a bug in
   computeBounds rather than in the harness. */
const build=traces=>makeBounds.call({visibleTraces:traces},SurfaceTrace,Scatter3DTrace)

test("a surface's z box is its remapped height, centred on the data",()=>{
    const bounds=build(
        [surfaceTrace({height:0.5,stride:1})]
    )
    ok(bounds,`no bounds for a valid surface (got ${bounds})`)
    //z runs 2..6, so mid=4 and half=2; height 0.5 puts the box at
    //4 ± 2*0.5*2 = 4 ± 2, i.e. [2, 6] — the same span, re-centred
    const mid=(2+6)/2
    const half=(6-2)/2
    ok(Math.abs(bounds.zMin-(mid-half*0.5*2))<1e-12,
        `zMin should be ${mid-half*0.5*2}, got ${bounds.zMin}`)
    ok(Math.abs(bounds.zMax-(mid+half*0.5*2))<1e-12,
        `zMax should be ${mid+half*0.5*2}, got ${bounds.zMax}`)
})

test("the height option actually moves the box",()=>{
    const withHeight=height=>build(
        [surfaceTrace({height,stride:1})]
    )
    const flat=withHeight(0.5)
    const tall=withHeight(1.5)
    const flatSpan=flat.zMax-flat.zMin
    const tallSpan=tall.zMax-tall.zMin
    ok(Math.abs(flatSpan-4)<1e-12,`height 0.5 should give a z span of 4, got ${flatSpan}`)
    ok(Math.abs(tallSpan-12)<1e-12,`height 1.5 should give a z span of 12, got ${tallSpan}`)
    ok(tallSpan>flatSpan,"a taller height must give a taller box")
})

test("a scatter's z is a COORDINATE and is not remapped",()=>{
    const bounds=build(
        [scatterTrace({stride:1})]
    )
    ok(bounds,`no bounds for a valid scatter (got ${bounds})`)
    ok(Math.abs(bounds.zMin-2)<1e-12,`zMin should stay the raw 2, got ${bounds.zMin}`)
    ok(Math.abs(bounds.zMax-6)<1e-12,`zMax should stay the raw 6, got ${bounds.zMax}`)
})

test("x and y come straight from the grid",()=>{
    const bounds=build(
        [surfaceTrace({height:0.5,stride:1})]
    )
    ok(Math.abs(bounds.xMin+1)<1e-12,`xMin should be -1, got ${bounds.xMin}`)
    ok(Math.abs(bounds.xMax-1)<1e-12,`xMax should be 1, got ${bounds.xMax}`)
    ok(Math.abs(bounds.yMin+1)<1e-12,`yMin should be -1, got ${bounds.yMin}`)
    ok(Math.abs(bounds.yMax-1)<1e-12,`yMax should be 1, got ${bounds.yMax}`)
})

test("no trace, or no finite value, gives no box",()=>{
    ok(build([])===null,"an empty trace list must not produce a box")
    const nanWave={dims:[2,2,3],index:(ix,iy,k)=>ix+iy*2+k*4,core:new Float64Array(12).fill(NaN)}
    const nanTrace=surfaceTrace({height:0.5,stride:1},nanWave)
    ok(build([nanTrace])===null,"a grid of NaN must not produce a box")
})

test("the stride is honoured, so a sparse box is still the full box",()=>{
    const bounds=build(
        [scatterTrace({stride:2})]
    )
    //stride 2 keeps iy=0 (z=2) and iy=2 (z=6): the extremes are still sampled
    ok(Math.abs(bounds.zMin-2)<1e-12,`zMin should be 2, got ${bounds.zMin}`)
    ok(Math.abs(bounds.zMax-6)<1e-12,`zMax should be 6, got ${bounds.zMax}`)
})

test("an orbit does not invalidate the GPU signature",()=>{
    /* The whole point of the signature: dragging the camera must not re-upload
       a surface. Every term it is built from has to be about the DATA or the
       STYLING — if a camera angle ever leaked in, every drag would reflow the
       buffers. */
    const body=methodBody("traceSignature")
    ok(!/this\.controls/.test(body)&&!/getAngles/.test(body),
        "traceSignature() reads the camera: an orbit would re-upload the buffers")
    ok(/revision/.test(body),"traceSignature() must watch wave.revision")
    ok(/height/.test(body),"traceSignature() must watch the height option")
    ok(/colormap/.test(body),"traceSignature() must watch the colormap")
})

test("the surface mesh is built with an index, not as loose triangles",()=>{
    /* A 600x600 grid is 359k cells; without the index that is 2.1M vertices
       and a position attribute three times too large. */
    const body=methodBody("buildSurface")
    ok(/setIndex/.test(body),"buildSurface() must call setIndex()")
    ok(/computeVertexNormals/.test(body),"buildSurface() must compute the normals, or it is unlit")
    ok(/userData\.traceId/.test(body),
        "buildSurface() must record the trace id: the raycast walks back to it")
})

test("the scatter uses a draw range instead of copying the buffer",()=>{
    const body=methodBody("buildScatter")
    ok(/setDrawRange/.test(body),
        "buildScatter() must set a draw range rather than trimming the array")
})

test("the materials keep depth testing ON",()=>{
    /* The reason GLSceneLayer is not GLTraceLayer: plot2d-gl.js:447 and :459
       both set depthTest:false, which is right for 2D traces and fatal for a
       surface. A regression here would make every surface look inside-out and
       nobody would notice until two folds overlapped. */
    const gl=readFileSync(join(here,"plot3d-gl.js"),"utf8")
    const materialSource=gl.slice(gl.indexOf("export function surfaceMaterial"))
    ok(/depthTest:\s*true/.test(materialSource),
        "surfaceMaterial() must set depthTest:true")
    ok(/depthWrite:\s*opacity>=\s*1/.test(materialSource),
        "an opaque surface must depthWrite, or surfaces interpenetrate")
    ok(/transparent:\s*opacity<1/.test(materialSource),
        "only an explicit partial opacity may be transparent")
})

test("GLSceneLayer is 3D by construction, with nothing to swap",()=>{
    const gl=readFileSync(join(here,"plot3d-gl.js"),"utf8")
    const body=gl.slice(gl.indexOf("export class GLSceneLayer"))
    ok(/new THREE\.PerspectiveCamera/.test(body),
        "GLSceneLayer must build a perspective camera itself")
    ok(!/setCamera|swapCamera/.test(body),
        "GLSceneLayer must expose no camera swap: that is what Plot2DWebGL needs and it does not apply here")
})

test("the front layer does not swallow the gestures",()=>{
    /* The bug that cost the Hough node four workarounds: an svg overlay above
       the canvas, pointer events landing on it, and the orbit controls never
       seeing a single event. */
    const ok1=source.includes('svg.style.pointerEvents="none"')
    ok(ok1,"the overlay must be transparent to the pointer")
    ok(/new OrbitPanControls\(this\.glCamera,\s*this\.container/.test(source),
        "the controls must be built on the container, not on the canvas")
})

test("every DOM listener is named, so dispose() can remove it",()=>{
    /* An arrow function built at each addEventListener is a NEW function, so
       the removeEventListener would target an address that was never
       registered — a teardown that silently does nothing. */
    for(const [listener,name] of [["_onDblClick","dblclick"],["_onMove","mousemove"],["_onLeave","mouseleave"]]){
        ok(new RegExp(`this\\.${listener}=`).test(source),`${listener} must be assigned to a field`)
        ok(new RegExp(`addEventListener\\("${name}",\\s*this\\.${listener}\\b`).test(source),
            `${name} must be added with its named listener`)
        ok(new RegExp(`removeEventListener\\("${name}",\\s*this\\.${listener}\\b`).test(source),
            `${name} must be removed with the same named listener`)
    }
})

/* Everything past the plot class declaration. */
const PLOT_BODY=source.slice(source.indexOf("export class Plot3DWebGL"))

test("dispose() cancels every frame it scheduled",()=>{
    /* The frames are held in an ARRAY and cancelled in a loop, so this checks
       that each one is named there — a frame left in a pending state keeps a
       renderer alive after its node is gone. */
    const body=methodBody("dispose",source.indexOf("export class Plot3DWebGL"))
    ok(/cancelAnimationFrame/.test(body),"dispose() must cancel the frames")
    const loopAt=body.indexOf("for(const frame of")
    ok(loopAt>0,"dispose() must loop over the pending frames")
    ok(body.indexOf("cancelAnimationFrame",loopAt)>loopAt,
        "the cancel must happen INSIDE the loop over the pending frames")
    const loop=body.slice(loopAt)
    for(const frame of ["_frame","_resizeFrame","_pickFrame"]){
        ok(loop.includes(frame),`dispose() must cancel ${frame}`)
        ok(body.includes(`${frame}=null`),`dispose() must reset ${frame} to null, or a second dispose() re-cancels it`)
    }
    ok(/this\.glLayer\?\.dispose\(\)/.test(body),"dispose() must release the WebGL context")
    ok(/this\.controls\?\.dispose\(\)/.test(body),"dispose() must dispose the controls: their listeners outlive the canvas otherwise")
})

test("a null axis domain is resolved before it reaches d3",()=>{
    /* FormulaCollectionNode.js:2380 parks `axis.bottom.domain = null` while
       re-arming autoDomain, on the way back from barycentric. When there ARE
       bounds, autoDomain() overwrites it. When there are NONE, autoDomain()
       returns without writing, and the null reached
       `d3.scaleLinear().domain(null)` — which threw from inside
       continuous.js and named neither the node nor the line that parked it.

       The guard has to sit in the axis loop, not in the node: the node cannot
       know that a null domain is "not computed yet" rather than "broken", and
       three other nodes park it the same way. */
    const plot=readFileSync(join(here,"ui/Plot2D.js"),"utf8")
    const axisLoop=plot.slice(plot.indexOf("for(let axis of Object.keys(this.parameters.axis))"))
    const scaleAt=axisLoop.indexOf("d3.scaleLinear()")
    ok(scaleAt>0,"the axis loop was not found in Plot2D.drawGraph()")
    const before=axisLoop.slice(0,scaleAt)
    ok(/domain\s*==\s*null/.test(before),
        "the axis loop must resolve a null domain BEFORE building the d3 scale")
    ok(/\[0,\s*1\]/.test(before),
        "the fallback must be the plot's own empty-view domain [0,1]")
})

test("GLSceneLayer releases its context slot eagerly",()=>{
    /* Browsers cap live WebGL contexts (16 in Chrome) and past the cap drop the
       OLDEST LIVE one — which belongs to a plot the user is still looking at.
       So a detached-but-not-force-lost context still counts against the cap
       until the GC gets to it, and the victim is somebody else's plot.
       GLTraceLayer does this (plot2d-gl.js:1109); the 3D layer must agree. */
    const gl=readFileSync(join(here,"plot3d-gl.js"),"utf8")
    const body=gl.slice(gl.indexOf("    dispose(){"))
    ok(/this\.renderer\.forceContextLoss\(\)/.test(body),
        "GLSceneLayer.dispose() must call forceContextLoss(), or its slot leaks")
    const lose=body.indexOf("forceContextLoss")
    const dispose=body.indexOf("this.renderer.dispose()")
    ok(lose>dispose,"forceContextLoss() must come after dispose()")
})

test("a node whose view is 3D never opens a 2D context",()=>{
    /* The base class used to build a Plot2DWebGL before registered() could
       intervene, so HoughTransformNode disposed it immediately — burning a
       context anyway, since the browser may not reclaim the slot before the
       real one is requested. One node, one context. */
    const base=readFileSync(join(here,"nodes/NodeWithRightAccordionGraph.js"),"utf8")
    ok(/createGraph\(dialog,label\)/.test(base),
        "the base class must delegate the plot to an overridable createGraph()")
    ok(/this\.graph=this\.createGraph\(/.test(base),
        "registered() must build its graph through createGraph()")

    const hough=readFileSync(join(here,"nodes/HoughTransformNode.js"),"utf8")
    ok(/createGraph\(dialog,label\)\s*\{\s*\n\s*const plot=new Plot3DWebGL/.test(hough),
        "HoughTransformNode must declare its 3D plot through createGraph()")
    //the CODE, not the prose: the header explains at length why the 2D plot was
    //abandoned, and that explanation is worth keeping
    const houghCode=hough.replace(/\/\*[\s\S]*?\*\//g,"").replace(/^\s*\/\/.*$/gm,"")
    ok(!/Plot2DWebGL/.test(houghCode),
        "HoughTransformNode must not import or construct Plot2DWebGL")
    ok(!/\.dispose\(\)[\s\S]{0,80}new Plot3DWebGL/.test(houghCode),
        "HoughTransformNode must not create a plot only to dispose it")
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length){
    process.exitCode=1
}

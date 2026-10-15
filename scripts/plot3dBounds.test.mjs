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

/* THE EXTRACTOR. Everything below it is a use.

   Three ways this went wrong before it worked, all of them failures that read
   like product bugs rather than harness bugs, which is why they are recorded:

     1. the body started after the FIRST "{" — and `suicide(options={})` has a
        brace in its default value, so the extracted body was EMPTY and every
        check inside it failed for no reason at all;
     2. comments were counted as code — a `{height:460}` inside a comment closed
        a brace that never opened, and the walk stopped mid-comment;
     3. a CRLF checkout left a stray \r on the sliced body's first line, which
        failed every anchored check inside it.

   So: normalise the line endings, skip the signature, and blank the comments
   before walking. */
function extractBody(text,name,after=0){
    const clean0=text.replace(/\r\n/g,"\n")
    const start=clean0.indexOf(`    ${name}(`,after)
    ok(start>=0,`${name}() not found`)
    /* Find the ")" that closes the SIGNATURE — the first one not nested in a
       default value. A plain indexOf(")") is not enough: `f(cb = () => 0)` has
       one inside, and so does any default holding an object literal. Counting
       parenthesis depth from the "(" is the only version that survives both,
       and `computeBounds()` — no parameters at all — is the case that proves
       it: indexOf(")") lands on the empty call's own parenthesis, and the
       first "{" after it belongs to whatever code follows the method. */
    const openParen=clean0.indexOf("(",start)
    let parens=0
    let closeParen=-1
    for(let k=openParen;k<clean0.length;k++){
        const c=clean0[k]
        if(c==="(") parens++
        else if(c===")"){
            parens--
            if(parens===0){ closeParen=k; break }
        }
    }
    ok(closeParen>openParen,`${name}( has no closing parenthesis in its signature`)
    const open=clean0.indexOf("{",closeParen)
    ok(open>=0,`${name}() has no opening brace after its signature`)
    const clean=clean0.slice(open).replace(/\/\*[\s\S]*?\*\//g,m=>" ".repeat(m.length))
    let depth=0
    for(let k=0;k<clean.length;k++){
        if(clean[k]==="{") depth++
        else if(clean[k]==="}"){
            depth--
            /* `k` is the index OF the closing brace within `clean`, and `open` is
               the index OF the opening one within the same string. The body is
               everything strictly BETWEEN them: `open+1` … `open+k`, and
               `open+1+k` would swallow the brace and produce a fragment that
               fails to compile with "Unexpected token '}'" — which reads as a
               broken method rather than as an off-by-one in the extractor. */
            if(depth===0) return clean0.slice(open+1,open+k)
        }
    }
    throw new Error(`unbalanced braces in ${name}()`)
}

/* `after` skips the helper classes above the plot: "dispose()" appears in
   OrbitPanControls first, and a search that stopped there would test the
   controls' teardown while claiming to test the plot's. */
const methodBody=(name,after=0)=>extractBody(source,name,after)

/* The same, on a file this test does not own. */
const methodBodyOf=(text,name,after=0)=>extractBody(text,name,after)

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
const PLOT_AT=source.indexOf("export class Plot3DWebGL")

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

test("a hidden container does not freeze the viewport at one pixel",()=>{
    /* CalibrationNode's 3D box is a `display:none` sibling of its 2D box, and
       a hidden element has clientWidth/clientHeight of 0. `Math.max(1, …)`
       turned that into a 1x1 viewport — and it STAYS 1x1, because a
       ResizeObserver does not fire when an element starts being displayed: a
       hidden element is not observed at all. The surface would come back at one
       pixel and stay there until the window itself was resized. */
    const body=methodBody("syncViewport",source.indexOf("export class Plot3DWebGL"))
    ok(/if\(!\(width>0&&height>0\)\) return false/.test(body),
        "syncViewport() must refuse to resize a container that has no box")
    /* The two other Math.max(1, …) in this file clamp a trace STRIDE, which is
       a count and has no zero case worth skipping. Only the size clamp is the
       bug, so only it is forbidden here. */
    const code=body.replace(/\/\*[\s\S]*?\*\//g,"").replace(/^\s*\/\/.*$/gm,"")
    ok(!/Math\.max\(1,/.test(code),
        "and must not clamp a zero size to 1, which is what froze the viewport")

    const overlay=methodBody("drawOverlay",source.indexOf("export class Plot3DWebGL"))
    ok(overlay.indexOf("clientWidth>0")<overlay.length,
        "drawOverlay() must not project onto a container with no box")
})

test("the 3D surface is built lazily, and only in a 2D mode",()=>{
    const calib=readFileSync(join(here,"nodes/CalibrationNode.js"),"utf8")
    //the CODE, not the prose: the header of update3DSurface() explains at
    //length which two functions the old dead code called, and that account is
    //worth keeping
    const code=calib.replace(/\/\*[\s\S]*?\*\//g,"").replace(/^\s*\/\/.*$/gm,"")
    const body=methodBodyOf(calib,"update3DSurface")
    ok(/show3DSurface/.test(body)&&/\.is2D/.test(body),
        "the surface belongs to the 2D modes only")
    ok(/surfaceBuilt/.test(body),
        "the plot must be built on first use: a context spent on a permanently empty plot is a context the browser may sacrifice elsewhere")
    /* There are two setTraces() calls: the empty one on the "not wanted" branch,
       which runs BEFORE the lazy build and must, and the real one after. Only
       the second is the ordering that matters. */
    const build=body.indexOf("new Plot3DWebGL")
    const clear=body.indexOf("setTraces([])")
    const push=body.lastIndexOf(".setTraces(")
    ok(clear>=0&&clear<build,
        "the empty setTraces([]) on the not-wanted branch must come before the build")
    ok(build>0&&push>build,
        `the real traces must be pushed AFTER the plot exists (build=${build}, push=${push})`)
    ok(!/errorColor|add3DAxes/.test(code),
        "the two functions the old dead 3D code called, which exist nowhere in the repository")
})

test("CalibrationNode holds no private 3D GPU state any more",()=>{
    /* The view is a plot now, so the node has nothing to tear down but one
       dispose() call. Hand-rolled meshes in a node are what made that teardown
       grow a cancelAnimationFrame, a controls dispose and a geometry dispose. */
    const calib=readFileSync(join(here,"nodes/CalibrationNode.js"),"utf8")
    const code=calib.replace(/\/\*[\s\S]*?\*\//g,"").replace(/^\s*\/\/.*$/gm,"")
    ok(!/_surfaceMesh|_axisGroup|_orbitControls|_perspectiveCamera|_originalCamera/.test(code),
        "CalibrationNode still carries private 3D state")
    ok(!/THREE\./.test(code),"CalibrationNode still reaches for THREE directly")
    ok(!/cancelAnimationFrame/.test(code),
        "CalibrationNode still owns an animation frame: the plot's loop is the only one there should be")
    const suicide=methodBodyOf(calib,"suicide")
    /* `.includes`, not a regex: `surfacePlot?.dispose()` has a `?` in it, and a
       regex reads that as "zero or one s", so the anchor silently stopped
       matching the one line it was written to protect. */
    ok(suicide.includes("surfacePlot?.dispose?.()"),
        `suicide() must release the 3D plot: NodeWithAccordion only frees the accordion (got ${JSON.stringify(suicide.slice(-90))})`)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length){
    process.exitCode=1
}

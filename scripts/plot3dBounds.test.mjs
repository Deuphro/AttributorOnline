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
import {methodBody as methodBodyOf} from "./sourceBody.mjs"
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

/* computeBounds closes over SurfaceTrace, Scatter3DTrace AND the shared height
   mapping, so all three names are supplied. That IS the dispatch under test —
   and the third name is the point: computeBounds used to carry its OWN copy of
   the height arithmetic while the mesh used the plot's, so the two could
   disagree and nothing here would have seen it. */
const makeBounds=new Function(
    "SurfaceTrace","Scatter3DTrace","surfaceHeightMap",
    methodBodyOf(source,"computeBounds")
)
/* `.call` FIRST, arguments after: a function built by `new Function` and then
   invoked without `new` RUNS the body with `this = globalThis` instead of
   building anything, and the resulting failure reads as a bug in
   computeBounds rather than in the harness. */
const build=traces=>makeBounds.call({visibleTraces:traces},
    SurfaceTrace,Scatter3DTrace,surfaceHeightMap)
/* The mapping is EVALUATED FROM THE FILE, not retyped: the whole reason it
   lives at module level is that the box and the mesh share one implementation,
   and a transcription in the test would be a second implementation — the test
   would then agree with a broken mapping exactly as the bug happens. It closes
   over nothing, so its body stands alone. */
const surfaceHeightMap=new Function("wave","options",methodBodyOf(source,"surfaceHeightMap"))

test("a surface's z box runs from its floor to its peak",()=>{
    const bounds=build(
        [surfaceTrace({height:0.5,stride:1})]
    )
    ok(bounds,`no bounds for a valid surface (got ${bounds})`)
    /* z runs 2..6 and is mapped onto [0, height]: the floor of the data sits at
       the bottom of the cube and its peak at the top. It used to be centred,
       (z-mid)/span*height, which put every ordinary cell of a peaked surface on
       the bottom plane at once — the flat sheet with needles that made a Hough
       accumulator look like a plane of samples. */
    ok(Math.abs(bounds.zMin-0)<1e-12,
        `zMin should be the floor at 0, got ${bounds.zMin}`)
    ok(Math.abs(bounds.zMax-0.5)<1e-12,
        `zMax should be the peak at height 0.5, got ${bounds.zMax}`)
})

test("the height option actually moves the box",()=>{
    const withHeight=height=>build(
        [surfaceTrace({height,stride:1})]
    )
    const flat=withHeight(0.5)
    const tall=withHeight(1.5)
    const flatSpan=flat.zMax-flat.zMin
    const tallSpan=tall.zMax-tall.zMin
    ok(Math.abs(flatSpan-0.5)<1e-12,`height 0.5 should give a z span of 0.5, got ${flatSpan}`)
    ok(Math.abs(tallSpan-1.5)<1e-12,`height 1.5 should give a z span of 1.5, got ${tallSpan}`)
    ok(tallSpan>flatSpan,"a taller height must give a taller box")
})

test("the box and the mesh agree on a PEAKED range",()=>{
    /* THE CASE A LINEAR SCALE LOSES. One cell holding a hundred times the rest
       is the ordinary shape of a vote accumulator, and it is where a mapping
       and a box drift apart: if computeBounds and heightMapping each do their
       own arithmetic, one of them centres and the other does not, and the mesh
       sits somewhere its own axis denies. Both are asked here. */
    const NX=8,NY=8
    const peaked={
        dims:[NX,NY,3],
        index:(ix,iy,k)=>ix+iy*NX+k*NX*NY,
        core:new Float64Array(NX*NY*3)
    }
    for(let iy=0;iy<NY;iy++){
        for(let ix=0;ix<NX;ix++){
            peaked.core[peaked.index(ix,iy,2)]=(ix===3&&iy===5)?1000:0
        }
    }
    const trace=surfaceTrace({height:0.5,stride:1},peaked)
    const bounds=build([trace])
    ok(Math.abs(bounds.zMin)<1e-12,`the floor should sit at 0, got ${bounds.zMin}`)
    ok(Math.abs(bounds.zMax-0.5)<1e-12,`the peak should sit at the height, got ${bounds.zMax}`)
    const map=surfaceHeightMap(peaked,{height:0.5})
    ok(Math.abs(map.place(0))<1e-12,"place() must put the floor at the bottom")
    ok(Math.abs(map.place(1000)-0.5)<1e-12,"place() must put the peak at the top")
})

test("a log scale separates the cells a linear one flattens",()=>{
    /* Votes are integers spanning orders of magnitude. On a linear scale every
       cell under 1% of the peak normalises to within 1/100 of the floor and the
       ridges between them vanish; on a log scale they spread out. This is the
       difference between a surface you can read and a flat sheet. */
    const values=[0,1,3,10,30,100,300,1000]
    const NX=values.length,NY=2
    const w={
        dims:[NX,NY,3],
        index:(ix,iy,k)=>ix+iy*NX+k*NX*NY,
        core:new Float64Array(NX*NY*3)
    }
    for(let iy=0;iy<NY;iy++){
        for(let ix=0;ix<NX;ix++){
            w.core[w.index(ix,iy,2)]=values[ix]
        }
    }
    const linear=surfaceHeightMap(w,{height:1,scale:"linear"})
    const log=surfaceHeightMap(w,{height:1,scale:"log"})
    /* the cell at 1 vote: a hundredth of the range on a linear scale */
    ok(Math.abs(linear.normalise(1)-0.001)<1e-9,
        `a linear scale must leave 1 vote at the floor, got ${linear.normalise(1)}`)
    /* Not "above some number" — an arbitrary threshold would only encode the
       shift. The claim is a RATIO: log spends the bottom of the cube on the
       small votes, which is the whole point, and spends an order of magnitude
       less of it on them than a linear scale does. */
    ok(log.normalise(1)>10*linear.normalise(1),
        `log must lift 1 vote far clear of the floor: ${log.normalise(1)} against ${linear.normalise(1)}`)
    ok(log.normalise(1)<0.5,
        `and not so far that the low votes all crowd the ceiling, got ${log.normalise(1)}`)
    /* and the two must agree at the ends, or the floor and the peak move */
    for(const map of [linear,log]){
        ok(Math.abs(map.normalise(0))<1e-12,"the floor stays at the floor")
        ok(Math.abs(map.normalise(1000)-1)<1e-12,"the peak stays at the peak")
        ok(Math.abs(map.place(0))<1e-12,"place() puts the floor at the bottom")
        ok(Math.abs(map.place(1000)-1)<1e-12,"place() puts the peak at the top")
    }
    /* the inverse has to hold, or a hovered vertex is quoted in cube units */
    for(const map of [linear,log]){
        for(const v of values){
            const back=map.denormalise(map.normalise(v))
            ok(Math.abs(back-v)<1e-6,
                `denormalise(normalise(${v})) must be ${v}, got ${back}`)
        }
    }
})

test("a log scale still works on a range that starts NEGATIVE",()=>{
    /* An error surface is signed, so the log's argument has to be shifted by the
       floor: log() of a negative accumulator is NaN, and a NaN position drops
       the whole vertex out of the mesh — a hole in the surface, not a message. */
    const NX=4,NY=1
    const w={
        dims:[NX,NY,3],
        index:(ix,iy,k)=>ix+iy*NX+k*NX*NY,
        core:new Float64Array(NX*NY*3)
    }
    for(let ix=0;ix<NX;ix++) w.core[w.index(ix,0,2)]=-5+ix*10   // -5 … 25
    const map=surfaceHeightMap(w,{height:1,scale:"log"})
    for(let ix=0;ix<NX;ix++){
        const v=w.core[w.index(ix,0,2)]
        const placed=map.place(v)
        ok(Number.isFinite(placed),`place(${v}) must be a finite z, got ${placed}`)
    }
    ok(Math.abs(map.normalise(-5))<1e-12,"the floor stays at the floor")
    ok(Math.abs(map.normalise(25)-1)<1e-12,"the peak stays at the peak")
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
    const body=methodBodyOf(source,"traceSignature")
    ok(!/this\.controls/.test(body)&&!/getAngles/.test(body),
        "traceSignature() reads the camera: an orbit would re-upload the buffers")
    ok(/revision/.test(body),"traceSignature() must watch wave.revision")
    ok(/height/.test(body),"traceSignature() must watch the height option")
    ok(/colormap/.test(body),"traceSignature() must watch the colormap")
})

test("the surface mesh is built with an index, not as loose triangles",()=>{
    /* A 600x600 grid is 359k cells; without the index that is 2.1M vertices
       and a position attribute three times too large. */
    const body=methodBodyOf(source,"buildSurface")
    ok(/setIndex/.test(body),"buildSurface() must call setIndex()")
    ok(/computeVertexNormals/.test(body),"buildSurface() must compute the normals, or it is unlit")
    ok(/userData\.traceId/.test(body),
        "buildSurface() must record the trace id: the raycast walks back to it")
})

test("the scatter uses a draw range instead of copying the buffer",()=>{
    const body=methodBodyOf(source,"buildScatter")
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
    const body=methodBodyOf(source,"dispose",source.indexOf("export class Plot3DWebGL"))
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
    const body=methodBodyOf(source,"syncViewport",source.indexOf("export class Plot3DWebGL"))
    ok(/if\(!\(width>0&&height>0\)\) return false/.test(body),
        "syncViewport() must refuse to resize a container that has no box")
    /* The two other Math.max(1, …) in this file clamp a trace STRIDE, which is
       a count and has no zero case worth skipping. Only the size clamp is the
       bug, so only it is forbidden here. */
    const code=body.replace(/\/\*[\s\S]*?\*\//g,"").replace(/^\s*\/\/.*$/gm,"")
    ok(!/Math\.max\(1,/.test(code),
        "and must not clamp a zero size to 1, which is what froze the viewport")

    const overlay=methodBodyOf(source,"drawOverlay",source.indexOf("export class Plot3DWebGL"))
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

test("AttributionNode releases its forest plot when deleted",()=>{
    const attribution=readFileSync(join(here,"nodes/AttributionNode.js"),"utf8")
    const suicide=methodBodyOf(attribution,"suicide")
    ok(suicide.includes("forestPlot?.dispose?.()"),
        "suicide() must release the forest plot's WebGL context")
})

test("HoughTransformNode delegates graph disposal to its base",()=>{
    const hough=readFileSync(join(here,"nodes/HoughTransformNode.js"),"utf8")
    const suicide=methodBodyOf(hough,"suicide")
    ok(!suicide.includes("this.graph?.dispose?.()"),
        "NodeWithRightAccordionGraph already disposes graph before Node.suicide()")
    ok(suicide.includes("super.suicide(options)"),
        "HoughTransformNode must call its graph-owning base")
})

/* The COLORMAPS table is module-level, so its body is a constant and can be
   read out of the file and evaluated. The glow is specified to the decimal —
   transparent white at the base, white opaque at 3/4, Cherenkov blue at half
   opacity at the peak — so those are the numbers asserted, not a shape. */
const COLORMAP_AT=source.indexOf("const COLORMAPS={")
const colorMaps=new Function(`return ${source.slice(source.indexOf("=",COLORMAP_AT)+1,
    source.indexOf("\n}",COLORMAP_AT)+2)}`)()

test("a colormap that carries an alpha is declared with FOUR components",()=>{
    for(const name of ["viridis","grayscale","coolwarm"]){
        ok(colorMaps[name](0).length===3&&colorMaps[name](1).length===3,
            `${name} is opaque everywhere: a 4-component answer would make the whole mesh transparent for nothing`)
    }
    for(const t of [0,0.5,0.75,1]){
        ok(colorMaps.glow(t).length===4,`glow(${t}) must carry an alpha`)
    }
})

test("the glow is white and rising, then Cherenkov and over-driven",()=>{
    const glow=colorMaps.glow
    /* THE BASE: white, and invisible. Anything else tints the low ground. */
    const base=glow(0)
    ok(base.slice(0,3).every(v=>Math.abs(v-1)<1e-9),`the base must be white, got ${base}`)
    ok(Math.abs(base[3])<1e-9,`the base must be transparent, got alpha ${base[3]}`)
    /* OPAQUE WHITE AT THREE QUARTERS. The body of the surface is white and
       solid; if the ramp warmed up before that, the whole surface would be
       tinted and only a pinprick would be blue. */
    const threeQuarters=glow(0.75)
    ok(threeQuarters.slice(0,3).every(v=>Math.abs(v-1)<1e-9),
        `three quarters up must still be white, got ${threeQuarters}`)
    ok(Math.abs(threeQuarters[3]-1)<1e-9,
        `three quarters up must be fully opaque, got alpha ${threeQuarters[3]}`)
    /* THE PEAK IS EMISSIVE, which is a claim about the LIGHT, not the hue. A
       per-vertex colour above 1 is not clamped by three.js: it clips in the
       framebuffer, so a face the light rig reaches burns to white while a face
       in shadow keeps the blue. Asserting the channel alone would pass on any
       pale blue; what has to be asserted is that the peak EXCEEDS its own hue,
       which is the whole mechanism. */
    const peak=glow(1)
    ok(peak[2]>1,`the peak must be driven over 1 so lit faces clip to white, got ${peak[2]}`)
    ok(Math.abs(peak[3]-1)<1e-9,
        `the peak must be fully opaque: at a=0.5 over a dark panel the brightest cell in the grid cannot exceed half its own colour, and the body beside it is brighter — the peak was the darkest pixel of the surface`)
    /* and it must still be recognisably blue where the light does not reach,
       so the over-drive is on the HUE and not a fade to plain white */
    const ratio=peak[0]/peak[2]
    ok(ratio>0.1&&ratio<0.4,`the peak must keep a blue hue, r/b = ${ratio.toFixed(3)}`)
    /* ALPHA RISES AND STOPS. It used to fall again over the top quarter, and
       that is the arithmetic above; the rise itself must still hold, or the
       surface would have no transparent ground at all. */
    const alphas=[0,0.25,0.5,0.75,0.9,1].map(t=>glow(t)[3])
    for(let i=1;i<alphas.length;i++){
        ok(alphas[i]>=alphas[i-1],`alpha must never fall: ${alphas.join(", ")}`)
    }
    for(const t of [0.75,0.9,1]){
        ok(Math.abs(glow(t)[3]-1)<1e-9,`above 3/4 the surface is opaque, alpha(${t})=${glow(t)[3]}`)
    }
    /* and out of range it must clamp, not extrapolate into a negative alpha */
    ok(glow(-5)[3]>=0&&glow(5)[3]<=1,"the ramp must clamp outside [0,1]")
    ok(glow(5).every(Number.isFinite)&&glow(5)[3]<=1,
        "the over-drive must clamp too, or the top of the range is unbounded")
})

const COLOR_HEX=(rgb)=>"#"+rgb.slice(0,3)
    .map(v=>Math.round(Math.min(1,Math.max(0,v))*255).toString(16).padStart(2,"0"))
    .join("").toUpperCase()

test("Tcherenkov passes through its five stops, at its five places",()=>{
    /* THE SPECIFICATION, in hex and in t, because that is what it was given
       as. Asserting the numbers would pin the arithmetic; asserting the hex
       pins the COLOUR, which is the thing anybody looking at the plot will
       notice being wrong. */
    const expected=[
        [0.00,"#0070B4"],
        [0.15,"#E6E6FC"],
        [0.30,"#45C3EC"],
        [0.50,"#004F9E"],
        [1.00,"#001A7B"]
    ]
    for(const [t,hex] of expected){
        ok(COLOR_HEX(colorMaps.tcherenkov(t))===hex,
            `tcherenkov(${t}) must be ${hex}, got ${COLOR_HEX(colorMaps.tcherenkov(t))}`)
    }
})

test("Tcherenkov's alpha rises at the base and thins at the peak",()=>{
    /* A four-component ramp makes the ENTIRE mesh transparent — three.js's
       per-vertex alpha is a material-level switch, not a per-band one — so
       where the alpha sits is the whole visual decision.

       TWO SEGMENTS, NOT ONE CURVE: transparent at the base, opaque at 0.15
       where the palette turns pale, then a fifth at the peak. The turnaround
       point is the design, and it is checked at its exact t because a curve
       that peaked in the middle of the BODY would leave a hole through the
       surface rather than a soft edge at its top. */
    const ramp=t=>colorMaps.tcherenkov(t)
    for(const t of [0,0.075,0.15,0.3,0.5,0.75,1]){
        ok(ramp(t).length===4,`tcherenkov(${t}) must carry an alpha, got ${ramp(t).length} components`)
    }
    ok(Math.abs(ramp(0)[3])<1e-9,`the base must be fully transparent, got alpha ${ramp(0)[3]}`)
    ok(Math.abs(ramp(0.15)[3]-1)<1e-9,
        `opaque at 0.15, where the palette turns pale, got ${ramp(0.15)[3]}`)
    ok(Math.abs(ramp(1)[3]-0.2)<1e-9,`a fifth at the peak, got alpha ${ramp(1)[3]}`)
    /* up to 0.15, down after it, and nothing in between out of order */
    for(const [a,b] of [[0,0.0375],[0.0375,0.075],[0.075,0.1125],[0.1125,0.15]]){
        ok(ramp(b)[3]>ramp(a)[3],`alpha must rise to 0.15: ${ramp(a)[3]} -> ${ramp(b)[3]}`)
    }
    for(const [a,b] of [[0.15,0.3],[0.3,0.5],[0.5,0.75],[0.75,1]]){
        ok(ramp(b)[3]<ramp(a)[3],`alpha must thin above 0.15: ${ramp(a)[3]} -> ${ramp(b)[3]}`)
    }
    /* the fall has to be steady to the very top: a ramp that thinned and then
       came back would put a bright shell around the peak */
    ok(ramp(0.9)[3]>ramp(1)[3],`the thinning must reach the peak, got ${ramp(0.9)[3]} -> ${ramp(1)[3]}`)
    /* it interpolates the colours between the stops, rather than snapping into
       five plates — a stepped table reads as five colours, not a ramp */
    const between=COLOR_HEX(ramp(0.075).slice(0,3))
    ok(between!=="#0070B4"&&between!=="#E6E6FC",
        `t=0.075 is between two stops and must be a blend of them, got ${between}`)
    ok(Math.abs(ramp(0.075)[2]
        -(ramp(0)[2]+ramp(0.15)[2])/2)<1e-9,
    "the blend must be halfway at the halfway point, measured between the stops themselves")
    /* out of range it clamps rather than extrapolating off the ends */
    ok(COLOR_HEX(ramp(-1).slice(0,3))==="#0070B4","below the range it clamps to the first stop")
    ok(COLOR_HEX(ramp(2).slice(0,3))==="#001A7B","above the range it clamps to the last stop")
    ok(Math.abs(ramp(2)[3]-ramp(1)[3])<1e-9,"and the alpha clamps with them, or the peak gets brighter past 1")
})

test("buildSurface sizes its colour buffer to the ramp, not to three",()=>{
    /* A FOURTH component written into a THREE-component buffer is not an
       error. It is dropped, silently, and the surface comes out flat opaque —
       which is what a glow that does not glow looks like. So the itemSize has
       to be derived from the ramp, and the material has to be told, since
       three.js also ignores the alpha on a material that is not transparent. */
    const body=methodBodyOf(source,"buildSurface")
    ok(/length===4/.test(body),"buildSurface must ask the ramp whether it carries an alpha")
    ok(/new THREE\.BufferAttribute\(colors,\s*stride\)/.test(body),
        "the colour buffer's itemSize must follow the ramp, not a literal 3")
    ok(/vertexAlpha/.test(body),
        "and the material must be told, or three.js drops the alpha silently")
    const gl=readFileSync(join(here,"plot3d-gl.js"),"utf8")
    ok(/transparent:opacity<1\|\|vertexAlpha/.test(gl),
        "surfaceMaterial must flag a vertex-alpha mesh transparent")
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length){
    process.exitCode=1
}

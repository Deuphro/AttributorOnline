/* -------------------------------------------------------------------------
   Test — node scripts/plot3dDiagnose.test.mjs

   `Plot3DWebGL.diagnose()` exists because a black surface names nothing. Every
   value it reports is one whose wrongness silently produces black pixels and
   zero console output — lights missing from the scene, vertexColors off, a
   camera outside its own far plane, a container with no box. Each one is a
   plausible cause and each one throws nothing, so guessing costs a round trip
   per attempt.

   This checks the diagnostic itself: that it reports every one of those fields
   rather than a subset, because a diagnostic which quietly omits the actual
   cause is worse than none — it looks like an answer.
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

/* `after` skips the helper class above the plot: "update()" and "dispose()" both
   appear in OrbitPanControls first, and a search that stopped there would test
   the controls while claiming to test the plot. */
function methodBody(name,after=0){
    const text=source.replace(/\r\n/g,"\n")
    const start=text.indexOf(`    ${name}(`,after)
    ok(start>=0,`${name}() not found in Plot3DWebGL.js`)
    const openParen=text.indexOf("(",start)
    let parens=0
    let closeParen=-1
    for(let k=openParen;k<text.length;k++){
        if(text[k]==="(") parens++
        else if(text[k]===")"){
            parens--
            if(parens===0){ closeParen=k; break }
        }
    }
    const open=text.indexOf("{",closeParen)
    const clean=text.slice(open).replace(/\/\*[\s\S]*?\*\//g,m=>" ".repeat(m.length))
    let depth=0
    for(let k=0;k<clean.length;k++){
        if(clean[k]==="{") depth++
        else if(clean[k]==="}"){
            depth--
            if(depth===0) return text.slice(open+1,open+k)
        }
    }
    throw new Error(`unbalanced braces in ${name}()`)
}

const body=source.slice(source.indexOf("    diagnose(){"))
ok(body.length>0,"diagnose() not found in Plot3DWebGL.js")

test("the diagnostic names every silent cause of a black surface",()=>{
    /* Lights first: a MeshPhongMaterial with no light in the scene renders
       PURE BLACK and throws nothing. That was the whole of the "noir sur fond
       noir" report, and it is invisible from the outside. */
    for(const field of ["lightsInScene","objectsInScene"]){
        ok(body.includes(field),`diagnose() must report ${field}`)
    }
    ok(/isLight/.test(body),
        "diagnose() must actually walk the scene for lights, not report a constant")
})

test("it reports the material, which is where a lost vertexColors hides",()=>{
    for(const field of ["vertexColors","material","side","opacity"]){
        ok(body.includes(field),`diagnose() must report ${field}`)
    }
})

test("it reports the geometry that produced the vertices",()=>{
    /* firstColor is the decisive one: if the ramp came back as [0,0,0] the
       colormap is at fault, and if the positions are [NaN,...] the wave is. */
    ok(body.includes("firstColor"),"diagnose() must report the first vertex COLOUR")
    ok(body.includes("firstPosition"),"diagnose() must report the first vertex POSITION")
    ok(/boundingSphere/.test(body),
        "diagnose() must report the bounding sphere: a degenerate one frustum-culls the object away, silently")
    ok(/hasIndex/.test(body),"diagnose() must report whether the mesh is indexed")
})

test("it reports the two boxes, which disagree often",()=>{
    /* canvas (the GL backing store) and clientBox (the CSS box). A container
       that was display:none at construction leaves the first at the 300x150
       default while the second reads 0, and nothing ever says so. */
    ok(/canvas/.test(body)&&/clientWidth/.test(body),
        "diagnose() must report both the GL canvas size and the CSS box")
})

test("it reports the camera, whose far plane silently swallows the scene",()=>{
    ok(/camera/.test(body))
    ok(/near/.test(body)&&/far/.test(body),
        "diagnose() must report the near/far planes: a surface beyond `far` is not drawn and not reported")
})

test("it must not throw when the plot has nothing in it",()=>{
    /* A diagnostic that throws on an empty plot is useless exactly when it is
       most needed — the first draw, before anything has been set. */
    ok(/\?\?0|\?\[/.test(body)||/length\?\s*\?/.test(body)||/\|\|\s*\[\]/.test(body),
        "diagnose() must tolerate an empty scene rather than throwing on it")
})

test("the depth range follows the framing distance, not a constant",()=>{
    /* THE THIRD OF THE SAME FAMILY, and the one that actually hid the scene.
       The camera was built with near = depth/100 out of a 2000-unit budget, so
       near = 20. A Hough surface on [-1,1]^2 framed at ~4 units therefore sat
       ENTIRELY INSIDE THE NEAR PLANE: clipped, silently, not drawn at all. It
       only appeared once the camera was dragged far enough back to clear 20 —
       small, and long after the user had stopped expecting it. A near plane
       that is too far away never warns; the object is simply not there. */
    const gl=readFileSync(join(here,"plot3d-gl.js"),"utf8")
    const ctor=gl.slice(gl.indexOf("new THREE.PerspectiveCamera"))
    ok(!/depth\/100/.test(ctor),
        "the camera must not take its near plane from a fixed depth budget: it clips unit-sized scenes whole")
    ok(/setDepthRange\(distance\)/.test(gl),
        "GLSceneLayer must expose setDepthRange(): the scene scale is not knowable at construction")
    const range=gl.slice(gl.indexOf("    setDepthRange(distance){"))
    ok(/distance\*0\.01/.test(range),
        "near must be a fraction of the distance, so zooming out does not lose the near plane")
    ok(/distance\*100/.test(range),
        "far must scale too, or a distant view silently loses its far plane")

    /* And the layer must actually be told: a method nobody calls is the same
       as no method. */
    ok(/onDistance/.test(source),
        "the controls must report their distance, or setDepthRange() is never called")
    ok(/onDistance:distance=>this\.glLayer\?\.setDepthRange\(distance\)/.test(source),
        "and the distance must reach the layer")
})

test("the zoom limits are relative to the framed box",()=>{
    /* The same bug at the other end. maxDistance used to be a flat 80: fine
       for a [-1,1] Hough grid, and nowhere near enough for a calibration
       surface over m/z in the hundreds, where frame() asks for size*1.6 and
       was silently clamped. The scene then framed at a fraction of its own
       size and came out a speck. */
    const frame=source.slice(source.indexOf("    frame(box,{resetAngles"))
    ok(/this\.minDistance=size\*/.test(frame),
        "frame() must set minDistance from the box size")
    ok(/this\.maxDistance=size\*/.test(frame),
        "frame() must set maxDistance from the box size, or a large scene is clamped to a constant")
    ok(frame.indexOf("this.maxDistance=size*")<frame.indexOf("this._distance=size*"),
        "the limits must be set BEFORE the distance, or the very first frame is clamped by the old ones")
})

test("a left-drag ends in update(), or it does nothing at all",()=>{
    /* THE BUG THIS CAUGHT. `_onPointerMove` accumulated the deltas and never
       consumed them: update() was reached only from the wheel and from frame().
       The drag piled up deltas that nothing applied, so the scene did not
       move — and the symptom was nothing anyone would guess at, because the
       WHEEL appeared to zoom *and to rotate*: its single update() finally
       applied a large accumulated delta (12 %, under the damping that was
       still in place) while also changing the distance. "Drag does nothing,
       wheel spins it" reads like a camera bug, not a missing call. */
    const move=source.slice(source.indexOf("    _onPointerMove(e){"))
    const end=move.indexOf("    _onPointerUp(e){")
    const body=move.slice(0,end>0?end:move.length)
    ok(body.includes("this.update()"),
        "_onPointerMove must call update(): accumulating a delta nothing consumes is a drag that does nothing")
    const wheel=source.slice(source.indexOf("    _onWheel(e){"),source.indexOf("    update(){"))
    ok(wheel.includes("this.update()"),"_onWheel must call update() too")
})

test("there is no damping left half-wired",()=>{
    /* Damping applies a FRACTION of the accumulated delta per update() and
       keeps the rest — which only works if update() runs on every frame until
       the deltas decay. That is a permanent loop, and this plot renders ON
       DEMAND: an idle surface must cost nothing. So the delta is applied whole
       and zeroed, and the field is gone rather than left as a setting that
       silently does nothing. */
    ok(!/this\.damping/.test(source),
        "the damping field is still there but unused: a dead setting is worse than none")
    const update=source.slice(source.indexOf("    update(){"))
    const body=update.slice(0,update.indexOf("\n    }"))
    ok(/this\._deltaTheta=0/.test(body),
        "update() must zero the deltas it applied, or the next gesture inherits them")
    ok(!/dampingFactor|\*this\.damping/.test(body),
        "update() must apply the delta whole, not a fraction of it")
})

test("a face index is halved before it is read as a grid cell",()=>{
    /* TWO triangles per cell: buildSurface pushes `a,c,b, b,c,d` for each one.
       faceIndex therefore runs over 2*(nx-1)*(ny-1) while cells run over
       (nx-1)*(ny-1), so reading one as the other walked iy to twice the last
       row and getZ() returned undefined past the end of the attribute —
       "can't access property 'toPrecision', z is undefined", from a rAF
       callback whose stack points nowhere near the arithmetic. It only
       happened on SOME cells, which is why it looked arbitrary: the first
       triangle of each cell landed in range. */
    const build=methodBody("buildSurface",source.indexOf("export class Plot3DWebGL"))
    const triangles=(build.match(/indices\.push\(/g)||[]).length
    ok(triangles===1&&build.includes("a,c,b, b,c,d"),
        "buildSurface must emit exactly two triangles per cell, which is the premise of the halving")
    const pick=source.slice(source.indexOf("    requestPick(){"))
    ok(/Math\.floor\(hit\.faceIndex\/2\)/.test(pick),
        "requestPick() must divide the face index by two to get a cell")
    ok(/Number\.isFinite\(z\)/.test(pick),
        "and must not call toPrecision() on a value it has not checked: the crash was exactly that")
})

test("the orbit must redraw BOTH layers",()=>{
    /* The bug this caught: onChange asked for a WebGL frame only. The box, the
       twelve edges and the three sets of ticks live in the SVG overlay in
       WORLD coordinates — project() runs them through the camera, so they
       rotate with the scene, but only if the overlay is rebuilt. Asking for
       one layer alone left the box frozen in the middle of an orbiting
       surface, which reads to the user as "the drag does nothing". */
    const install=source.slice(source.indexOf("    installEvents(){"))
    const onChange=install.slice(install.indexOf("onChange:"),install.indexOf("onChange:")+400)
    ok(/requestFrame/.test(onChange),"the orbit must redraw the WebGL layer")
    ok(/requestOverlay/.test(onChange),
        "the orbit must ALSO redraw the SVG overlay, or the box stays frozen while the surface turns")
})

test("the overlay redraw is coalesced and cancelled on dispose",()=>{
    /* An orbit fires onChange on every pointermove; rebuilding the edges and
       the ticks per event is wasted work on a drag. */
    ok(/requestOverlay\(\)\s*\{\s*\n\s*if\(this\._overlayFrame/.test(source),
        "requestOverlay() must coalesce through a single pending frame")
    ok(source.includes("this._overlayFrame=null"),
        "the pending overlay frame must be reset, or a second call is a no-op forever")
    ok(/for\(const frame of \[[^\]]*_overlayFrame/.test(source),
        "dispose() must cancel the pending overlay frame")
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length){
    process.exitCode=1
}

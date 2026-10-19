import * as THREE from "https://unpkg.com/three@0.160.1/build/three.module.js"
import {CE,stylize} from "../util.js"
import {GLSceneLayer,GL3D_DEFAULTS,surfaceMaterial,scatterMaterial,THREE_CDN_3D} from "../plot3d-gl.js"
import {SurfaceTrace,Scatter3DTrace} from "../formats.js"

const PLOT3D_DEFAULTS={
    ...GL3D_DEFAULTS,
    //how many grid samples the axis ticks aim for, per axis
    ticks:6,
    //the box is padded by this fraction of its own size, so a surface never
    //touches the edge of the frame
    padding:0.08,
    //plus de hover : le raycast testait chaque triangle à chaque mousemove,
    //impraticable sur une grille 512×512 (≈500k triangles en JS pur)
}

/* The colormaps a SurfaceTrace can ask for. Kept as plain functions rather
   than interpolators so they cost nothing per vertex and cannot drift out of
   [0,1]: a surface that leaves the ramp is a surface whose neighbours no
   longer touch. */
const COLORMAPS={
    viridis:t=>{
        //a cheap 5-stop viridis: dark blue to green to yellow
        const x=Math.min(1,Math.max(0,t))
        const stops=[
            [0.267,0.005,0.329],
            [0.188,0.408,0.557],
            [0.208,0.718,0.473],
            [0.664,0.866,0.643],
            [0.993,0.906,0.144]
        ]
        const scaled=x*(stops.length-1)
        const index=Math.min(stops.length-2,Math.floor(scaled))
        const k=scaled-index
        const a=stops[index]
        const b=stops[index+1]
        return [a[0]+(b[0]-a[0])*k,a[1]+(b[1]-a[1])*k,a[2]+(b[2]-a[2])*k]
    },
    grayscale:t=>{
        const x=Math.min(1,Math.max(0,t))
        return [x*0.9+0.05,x*0.9+0.05,x*0.9+0.05]
    },
    coolwarm:t=>{
        const x=Math.min(1,Math.max(0,t))
        return x<0.5?[0.23+0.54*(x*2),0.30+0.10*(x*2),0.75-0.28*(x*2)]:[0.77+0.23*((x-0.5)*2),0.40+0.30*((x-0.5)*2),0.47-0.28*((x-0.5)*2)]
    },
    /* CHERENKOV. The only ramp here that carries an ALPHA, which is why it
       returns FOUR components and the others return three (see buildSurface).

       THE SHAPE. Transparent white at the base, rising to opaque white by three
       quarters of the range; above that the hue turns Cherenkov and the
       intensity is driven OVER one, so the peak reads as emission rather than
       as a tinted facet.

       WHY THE ALPHA STOPS RISING. An earlier version took the alpha back DOWN
       to a half at the peak, on the reasoning that a glow is thin where it is
       brightest. The arithmetic does not allow it: blending is
       src*a + dst*(1-a), so at a=0.5 over a panel that is nearly black, the
       brightest cell in the whole grid cannot exceed half its own colour — and
       the opaque white body beside it is brighter. The peak was the darkest
       pixel of the surface. Translucency is kept where it EARNS its place, on
       the lower half, where it lets the shape of the grid show through the
       ground; above three quarters it is opaque and it glows.

       WHY THE COLOUR GOES ABOVE 1. three.js does not clamp a per-vertex
       colour, and the framebuffer clips at the end: a component at 2.5 is
       white on every face the light rig reaches, and still carries its hue on
       the faces in shadow. That difference — a saturated core with a blue
       fringe, varying with the lighting — is what a photograph of something
       emitting light looks like, and no alpha and no blending mode produces it
       on their own. */
    glow:t=>{
        const x=Math.min(1,Math.max(0,t))
        const white=[1,1,1]
        /* #2a82ff — the blue of the Cherenkov glow rather than the cyan of a
           cold plasma: saturated, because it is the clipped faces that go
           white, and a desaturated blue would only go grey there. */
        const cherenkov=[0.165,0.510,1]
        if(x<0.75){
            /* THE BASE IS TRANSPARENT WHITE, and it stays white all the way
               up: a ramp that warmed up first would tint the whole body and
               leave only a pinprick blue. The ramp is in the ALPHA. */
            return [white[0],white[1],white[2],x/0.75]
        }
        const k=(x-0.75)/0.25
        const gain=1+2*k
        return [
            (white[0]+(cherenkov[0]-white[0])*k)*gain,
            (white[1]+(cherenkov[1]-white[1])*k)*gain,
            (white[2]+(cherenkov[2]-white[2])*k)*gain,
            1
        ]
    },
    /* TCHERENKOV — five stops, at five PLACES. The t values are NOT evenly
       spaced, which is the design: the pale band sits between 0.15 and 0.30,
       so a fifth of the range carries the near-white and the ramp spends the
       rest of its travel going DEEPER into blue. On a vote accumulator that
       reads correctly — the shoulder catches the slopes, and the dark end is
       the dense core of the peak rather than a bright cap.

       THE ALPHA. Fully transparent at the base, opaque at 0.15 — the same t where
       the palette turns pale — then thinning to 0.2 by the peak.

       The rise and the fall are both deliberate. The rise is what lets the
       surface come up out of the box instead of starting as a blue sheet; the
       fall is what makes the deep core of a peak see-through, so the shape
       around it stays readable when the peak is tall. Where it thins, the
       colour there is the darkest of the ramp (#001A7B), which is the one
       place a low alpha costs least.

       Both are only possible because a per-vertex alpha is NOT a local effect:
       three.js applies it through the material, so the whole mesh is
       transparent from the moment this ramp returns four components. That is
       the trade this ramp makes — a folded surface may show its own back faces
       through its front ones, which plot3d-gl.js argues against at length. */
    tcherenkov:t=>{
        const x=Math.min(1,Math.max(0,t))
        /* [t, r, g, b] — the three channels are the hex, 0..255 divided by 255,
           written out because a colour table that needs a hex parser to be read
           is a colour table nobody edits. */
        const stops=[
            [0.00,0.000,0.439,0.706],   //#0070B4
            [0.15,0.902,0.902,0.988],   //#E6E6FC
            [0.30,0.271,0.765,0.925],   //#45C3EC
            [0.50,0.000,0.310,0.620],   //#004F9E
            [1.00,0.000,0.102,0.482]    //#001A7B
        ]
        let i=0
        while(i<stops.length-2&&x>stops[i+1][0]) i++
        const a=stops[i]
        const b=stops[i+1]
        const span=b[0]-a[0]
        const k=span>0?(x-a[0])/span:0
        return [
            a[1]+(b[1]-a[1])*k,
            a[2]+(b[2]-a[2])*k,
            a[3]+(b[3]-a[3])*k,
            /* UP to opaque at 0.15, then DOWN to a fifth at the peak. Two
               segments rather than one curve because the turnaround point is
               the design: it sits where the palette turns pale, not in the
               middle of the body where it would leave a hole in the surface. */
            x<0.15?x/0.15:1-0.8*((x-0.15)/0.85)
        ]
    }
}

/* --- Orbit + pan ------------------------------------------------------
   The controls asked for: left-drag orbits, SHIFT+left-drag pans, wheel
   zooms, double-click reframes. The pan is on SHIFT rather than on the right
   button because a right-drag is already spoken for by the application's
   context menu, and on the middle button because nothing else claims it but
   it is not reachable on a trackpad.

   Every listener is NAMED. An arrow function built at each addEventListener
   is a NEW function, so the removeEventListener of dispose() would target an
   address that was never registered — a cleanup silently inoperative, which
   is the whole family of bug this note exists to prevent. */
class OrbitPanControls{
    constructor(camera,domElement,{onChange=null,onDistance=null}={}){
        this.camera=camera
        this.domElement=domElement
        this.target=new THREE.Vector3(0,0,0)
        this.onChange=onChange
        this.onDistance=onDistance
        /* Provisional, and overwritten by frame() before anything is ever
           drawn. They exist so a camera restored from a session — where frame()
           has not run yet — is still clamped to something sane instead of
           drifting to infinity. */
        this.minDistance=0.6
        this.maxDistance=80
        this.rotateSpeed=0.008
        this.zoomSpeed=0.0016
        this.panSpeed=0.0022
        this._mode=0            // 0 idle, 1 orbit, 2 pan
        this._theta=Math.PI/4
        this._phi=Math.PI/3
        this._distance=4
        /* The distance at which an ORTHOGRAPHIC camera is at zoom 1. An
           ortho frustum has no perspective divide: its magnification is
           camera.zoom alone, so a wheel that only moved the camera along its
           axis would be worth exactly nothing on screen. See update(). */
        this._orthoReference=4
        this._last=new THREE.Vector2()
        this._spherical=new THREE.Spherical()
        this._panOffset=new THREE.Vector3()
        this._scale=1
        this._deltaTheta=0
        this._deltaPhi=0
        this._bound={
            pointerdown:e=>this._onPointerDown(e),
            pointermove:e=>this._onPointerMove(e),
            pointerup:e=>this._onPointerUp(e),
            pointercancel:e=>this._onPointerUp(e),
            wheel:e=>this._onWheel(e),
            contextmenu:e=>e.preventDefault()
        }
        for(const [type,listener] of Object.entries(this._bound)){
            this.domElement.addEventListener(type,listener)
        }
        this.update()
    }
    /* SHIFT decides the mode, and it is read on pointerdown and NOT on
       pointermove: pressing shift halfway through a drag must not turn an
       orbit into a pan under the pointer. */
    _onPointerDown(e){
        if(e.button!==0) return
        this._mode=e.shiftKey?2:1
        this._last.set(e.clientX,e.clientY)
        this.domElement.setPointerCapture?.(e.pointerId)
        e.preventDefault()
    }
    _onPointerMove(e){
        if(!this._mode) return
        const dx=e.clientX-this._last.x
        const dy=e.clientY-this._last.y
        if(!dx&&!dy) return
        this._last.set(e.clientX,e.clientY)
        if(this._mode===1){
            this._deltaTheta-=dx*this.rotateSpeed
            this._deltaPhi-=dy*this.rotateSpeed
        }else{
            //pan in the camera plane, scaled by the distance so a pixel is a
            //pixel at any zoom
            const right=new THREE.Vector3().setFromMatrixColumn(this.camera.matrix,0)
            const up=new THREE.Vector3().setFromMatrixColumn(this.camera.matrix,1)
            this._panOffset.addScaledVector(right,-dx*this.pixelScale())
            this._panOffset.addScaledVector(up,dy*this.pixelScale())
        }
        /* THE MISSING update(). This is what made a left-drag do nothing at
           all: the deltas piled up here, and nothing consumed them, because
           update() was only reached from the wheel and from frame(). The
           symptom was peculiar enough to be worth writing down — the wheel
           appeared to ZOOM *and to ROTATE*, because the single update() it
           triggered finally applied a large accumulated delta, 12 % of it,
           while also changing the distance. "The drag does nothing but the
           wheel spins it" is not a shape of bug anyone would guess at.

           Every gesture therefore ends in update(), not every FRAME: the plot
           renders on demand, and there is no loop here to coast on. */
        this.update()
    }
    _onPointerUp(e){
        this._mode=0
        if(this.domElement.hasPointerCapture?.(e.pointerId)){
            this.domElement.releasePointerCapture(e.pointerId)
        }
    }
    _onWheel(e){
        e.preventDefault()
        const notches=-e.deltaY*(e.deltaMode===1?16:1)
        this._scale*=Math.exp(notches*this.zoomSpeed)
        this.update()
    }
    /* NO DAMPING, ON PURPOSE.

       Damping means applying a FRACTION of the accumulated delta per update()
       and keeping the rest for the next one — which only works if update() runs
       on every frame until the deltas decay to zero. That is a continuous loop
       burning a frame per plot forever, and this plot is explicitly
       render-on-demand: an idle surface should cost nothing.

       So the delta is applied in full, per gesture event, and zeroed. Direct
       manipulation with no lag is also the better feel here; damping mostly
       matters when a camera is chasing a moving target, and nothing here does. */
    /* World units per CSS pixel for a pan, at the target plane. The
       perspective form is the one panSpeed was tuned against and is left
       alone. The orthographic form CANNOT be derived from the distance — the
       distance does not enter the projection at all — so it is read off the
       frustum, which is also what makes a pan track the zoom: dolly in and the
       pan slows down with the scene instead of sliding it off the panel. */
    pixelScale(){
        const cam=this.camera
        if(cam.isOrthographicCamera){
            const visibleHeight=(cam.top-cam.bottom)/Math.max(cam.zoom,1e-6)
            return this.panSpeed*this._distance*visibleHeight/2
        }
        return this.panSpeed*this._distance
    }
    update(){
        this._theta+=this._deltaTheta
        this._phi+=this._deltaPhi
        this._deltaTheta=0
        this._deltaPhi=0
        this._distance*=this._scale
        this._scale=1
        this._phi=Math.max(0.02,Math.min(Math.PI-0.02,this._phi))
        this._distance=Math.max(this.minDistance,Math.min(this.maxDistance,this._distance))
        this._spherical.set(this._distance,this._phi,this._theta)
        this.camera.position.setFromSpherical(this._spherical).add(this.target).add(this._panOffset)
        this.camera.lookAt(this.target.clone().add(this._panOffset))
        this.camera.updateMatrixWorld()
        /* THE WHEEL ON AN ORTHOGRAPHIC CAMERA. There is no perspective divide
           to shorten the rays, so the frustum is fixed and the ONLY thing that
           magnifies is camera.zoom. Driving the camera along its axis instead
           — which is all update() used to do — produces an identical picture on
           every wheel notch: the zoom is not "weak" in orthographic mode, it
           is absent. The distance stays the single zoom quantity (so min and
           maxDistance keep bounding it, and getAngles still round-trips), and
           is projected onto the zoom here. */
        if(this.camera.isOrthographicCamera){
            this.camera.zoom=Math.max(1e-3,this._orthoReference/this._distance)
            this.camera.updateProjectionMatrix()
        }
        /* The depth range belongs to the distance, or the near plane eats the
           scene. It used to be a constant sized for a 2000-unit budget, which
           clipped a unit-sized surface whole — and a fixed far plane loses the
           scene just as silently once the camera backs off far enough. */
        this.onDistance?.(this._distance)
        this.onChange?.()
    }
    /* Re-frame on the given box, keeping the current viewing angles. Used on
       first draw and by the double-click reset.

       THE ZOOM LIMITS ARE SET FROM THE BOX, not left absolute. `maxDistance`
       used to be 80 — a number that happens to suit a [-1,1] Hough grid and
       is nowhere near enough for a calibration surface over m/z in the
       hundreds, where frame() asks for size*1.6 and got silently clamped to
       80. The result is the same bug at the other end: the scene framed at a
       fraction of its own size, so it comes out a speck. */
    frame(box,{resetAngles=false,angles=null}={}){
        this.target.set((box.xMin+box.xMax)/2,(box.yMin+box.yMax)/2,(box.zMin+box.zMax)/2)
        const size=Math.max(box.xMax-box.xMin,box.yMax-box.yMin,box.zMax-box.zMin,1e-6)
        this.minDistance=size*0.15
        this.maxDistance=size*40
        this._distance=size*1.6
        this._panOffset.set(0,0,0)
        this._scale=1
        if(resetAngles){
            if(angles){
                if(Number.isFinite(angles.theta)) this._theta=angles.theta
                if(Number.isFinite(angles.phi)) this._phi=angles.phi
                if(Number.isFinite(angles.distance)) this._distance=angles.distance
            }else{
                this._theta=Math.PI/4
                this._phi=Math.PI/3
            }
            this._deltaTheta=0
            this._deltaPhi=0
        }
        /* frame() is what establishes the framing, so it is also what
           establishes zoom 1 for an orthographic camera. In an ortho camera
           there is no near-to-far perspective to absorb a bigger distance:
           dollying out has to become a smaller zoom, or the framing the user
           asked for is silently not the framing they get. */
        this._orthoReference=this._distance
        this.update()
    }
    getAngles(){
        return {theta:this._theta,phi:this._phi,distance:this._distance,
            target:this.target.clone(),pan:this._panOffset.clone()}
    }
    setAngles({theta,phi,distance,target,pan}={}){
        if(Number.isFinite(theta)) this._theta=theta
        if(Number.isFinite(phi)) this._phi=phi
        if(Number.isFinite(distance)) this._distance=distance
        if(target) this.target.copy(target)
        if(pan) this._panOffset.copy(pan)
        this._deltaTheta=0
        this._deltaPhi=0
        this.update()
    }
    dispose(){
        for(const [type,listener] of Object.entries(this._bound)){
            this.domElement.removeEventListener(type,listener)
        }
        this._bound={}
    }
}

/* =====================================================================
   Plot3DWebGL — the FRONT half of the 3D sandwich.

   Deliberately NOT a subclass of Plot2D. The 2D base is a chart engine:
   log scales, axis-domain arithmetic, per-axis drags, a fitted auto-domain,
   a linear or logarithmic transform applied to every vertex. None of that
   applies to a scene, and inheriting it would mean carrying a dozen fields
   that are always at their defaults plus the 2D pan/zoom handlers that we
   would then have to suppress — which is exactly the debt the Hough node
   paid for by hijacking a Plot2DWebGL's camera.

   What IS shared, on purpose: the container/canvas/SVG sandwich of
   Plot2DWebGL, a `handleResize` hook the application's ResizeObserver drives,
   a `dispose()` that releases the WebGL context and every rAF, a `setTraces`
   that invalidates, and a render-on-demand loop rather than a permanent one.

   The overlay draws the FRAME: the box, the twelve edges, and the ticks and
   labels of the three axes, projected. Tick placement is the one genuinely
   3D piece of the front layer — an edge seen end-on projects to a point, so
   the ticks of that axis are laid on whichever of the box's parallel edges is
   currently the longest on screen.
   ===================================================================== */
/* THE HEIGHT MAPPING, ONCE.

   A surface's third column is a DISPLACEMENT, not a coordinate: an
   accumulator has no natural zero, and the structure worth seeing is relative
   to the surface's own range. So the value is normalised to t in [0,1] and the
   height placed on t*height — the floor of the data sits at the bottom of the
   cube and the peak at the top, with nothing under it and nothing over it.

   It was `(z-mid)/span*height`, centred. That reads better in prose and is
   worse on screen: when one cell of the range is a hundred times the others —
   which is the NORMAL shape of a Hough accumulator, where a single relation
   collects the votes of every pair at once — then mid sits up at half the peak,
   every ordinary cell falls to the bottom plane at once, and the surface comes
   out as a flat coloured sheet wearing a few needles.

   THE SHIFT K. The floor of the range is what it is — often ZERO votes, and
   log(0) is not a number, so the argument is shifted up by a thousandth of the
   span before the log. That thousandth is also the accumulator's own
   resolution: one vote against a peak of a million is exactly that, so a cell
   holding a single vote lands a tenth of the way up instead of on the floor
   with its neighbours, and the ridges between votes become visible. The shift
   is relative, so a range that starts NEGATIVE — an error surface is signed —
   works through the same code.

   ONE function, because the box and the mesh were deriving the same arithmetic
   separately, and the box is what the axis ticks are drawn from: two copies of
   a mapping disagree exactly where it matters, in the labels. */
export function surfaceHeightMap(wave,options={}){
    const [nx,ny]=wave.dims
    const range=options.heightRange
    let lo=range?range[0]:Infinity
    let hi=range?range[1]:-Infinity
    if(!range){
        for(let iy=0;iy<ny;iy++){
            for(let ix=0;ix<nx;ix++){
                const z=wave.core[wave.index(ix,iy,2)]
                if(!Number.isFinite(z)) continue
                if(z<lo) lo=z
                if(z>hi) hi=z
            }
        }
    }
    if(!(hi>lo)){ lo=Number.isFinite(lo)?lo:0; hi=lo+1 }
    const span=hi-lo
    const height=Number.isFinite(options.height)?options.height:0.5
    const log=options.scale==="log"
    const shift=span*1e-3||1
    const f=log?(v=>Math.log(v-lo+shift)):(v=>v-lo)
    const fLo=f(lo)
    const fSpan=f(hi)-fLo||1
    const t=v=>Math.min(1,Math.max(0,(f(v)-fLo)/fSpan))
    return {lo,hi,span,height,scale:log?"log":"linear",
        /* the colour: the position in the range, on the same scale as the height
           — a linear colour beside a log height would make the ridges lie */
        normalise:t,
        place:v=>t(v)*height,
        /* the inverse, for the hover readout: a world z has to be reported in
           the units the user gave, not in cube coordinates */
        denormalise:u=>log?(Math.exp(fLo+u*fSpan)-shift+lo):(lo+u*fSpan)}
}

export class Plot3DWebGL{
    constructor(data,title,origin,destination,defaultAngles=null){
        this.title=title
        this.data=data
        this.origin=origin
        this.destination=destination
        this.traces=[]
        this.parameters={}
        this.renderOptions={...PLOT3D_DEFAULTS}
        this.glLayer=null
        this.traceCanvas=null
        this.overlay=null
        this.controls=null
        this.axisLabels={x:"x",y:"y",z:"z"}
        /* AXIS RULES — planes at one fixed data coordinate, drawn in the SVG
           overlay and projected every frame like the box. The plot owns only
           their geometry; the caller owns what they mean (a Hough slope, a
           calibration level). Each rule: {axis:"x"|"y"|"z", value in DATA
           units, color, label}. Changed rules take effect on the next
           requestOverlay()/drawGraph — there is no watcher, by design. */
        this.axisRules=[]
        this.bounds=null
        this._orthographic=false
        this.defaultAngles=defaultAngles
        this._traces=[]           // what is currently on the GPU
        this._signature=null
        this._dataRevision=0
        this._frame=null
        this._resizeFrame=null
        this._overlayFrame=null
        this.container=CE("div",{className:"plot3d container",pilot:this},[])
        stylize(this.container,{position:"relative",width:"100%",height:"100%",zIndex:"0"})
        this.destination.appendChild(this.container)
        this.ensureCanvas()
        this.ensureOverlay()
        this.installEvents()
        this.container.handleResize=(e)=>this.handleResize(e)
        this._resizeHook=this.container.handleResize
        this.drawGraph()
    }

    /* --- setup, once ------------------------------------------------- */
    ensureCanvas(){
        if(this.glLayer) return this.glLayer
        let canvas=null
        try{
            canvas=CE("canvas",{className:"trace-layer gl3d"},[])
            stylize(canvas,{position:"absolute",left:"0px",top:"0px",display:"block"})
            this.traceCanvas=canvas
            this.glLayer=new GLSceneLayer(canvas,{
                pixelRatioCap:this.renderOptions.pixelRatioCap,
                depth:this.renderOptions.depth,
                background:this.renderOptions.background,
                backgroundAlpha:this.renderOptions.backgroundAlpha,
                lights:this.renderOptions.lights
            })
            this.glLayer.onContextRestored=()=>{
                //context loss wipes the GPU side: everything must be rebuilt
                this._signature=null
                this._traces=[]
                this.drawGraph()
            }
            this.glRenderer=this.glLayer.renderer
            this.glScene=this.glLayer.scene
            this.glCamera=this.glLayer.camera
        }catch(error){
            console.warn(`Plot3DWebGL: WebGL layer unavailable (${THREE_CDN_3D})`,error)
            canvas?.remove?.()
            this.traceCanvas=null
            this.glLayer=null
            this.renderOptions={...this.renderOptions,enabled:false}
        }
        //the canvas goes in first, so the SVG overlay stays above it
        if(this.traceCanvas&&this.container.firstChild!==this.traceCanvas){
            this.container.insertBefore(this.traceCanvas,this.container.firstChild)
        }
        for(const child of [...this.container.children]){
            if(child!==this.traceCanvas&&child.classList?.contains("gl3d")){
                child.remove()
            }
        }
        return this.glLayer
    }
    ensureOverlay(){
        const ns="http://www.w3.org/2000/svg"
        const svg=document.createElementNS(ns,"svg")
        svg.setAttribute("class","main")
        svg.style.position="absolute"
        svg.style.left="0px"
        svg.style.top="0px"
        svg.style.width="100%"
        svg.style.height="100%"
        //the overlay is transparent to the pointer: the gestures belong to the
        //canvas underneath, and an svg that swallows them is the bug this
        //placement exists to prevent
        svg.style.pointerEvents="none"
        this.container.appendChild(svg)
        this.overlay=svg
        return svg
    }
    /* The gestures live on the CONTAINER, not on the canvas: the overlay
       covers the canvas, so a canvas-level listener would never fire. The
       container is the element that reliably receives them, and it is the
       same element the application ResizeObserver walks. */
    installEvents(){
        //the controls are built ON the container and stay there: re-binding
        //them would tear down and rebuild the same listeners for nothing
        if(!this.controls&&this.glLayer){
            this.controls=new OrbitPanControls(this.glCamera,this.container,{
                /* BOTH layers, and that is the whole point. The box, the edges
                   and the ticks live in the SVG overlay, in WORLD coordinates;
                   `project()` runs them through the camera, so they rotate with
                   the scene — but only if the overlay is redrawn. Asking for a
                   WebGL frame alone left the box frozen in the middle of an
                   orbiting surface, which reads as "the drag does nothing". */
                onChange:()=>{
                    this.requestFrame()
                    this.requestOverlay()
                },
                //the depth range is the layer's business; the controls only
                //know how far away the camera is
                onDistance:distance=>this.glLayer?.setDepthRange(distance)
            })
        }
        /* TWO GESTURES, because one gesture was asked to do two unrelated things.
           Double-click REFRAMES: back to the angles the plot was given, so the
           node's chosen view is what the user gets back after an exploratory
           orbit. Shift+double-click switches the LENS, perspective to
           orthographic, and keeps the angles — a different lens is not a
           different viewpoint. Bundled into one gesture, every toggle threw
           the viewpoint away, which is why the two readings disagreed. */
        this._onDblClick=(e)=>{
            if(!this.glLayer) return
            if(e.shiftKey){
                this._orthographic=!this._orthographic
                this.setCameraType(this._orthographic)
            }else{
                this.controls.frame(Plot3DWebGL.WORLD_BOX,
                    {resetAngles:true,angles:this.defaultAngles??undefined})
            }
            this.requestFrame()
            this.drawOverlay()
        }
        this.container.addEventListener("dblclick",this._onDblClick)
    }
    /* Switch the GL layer's camera between Perspective and Orthographic,
       keeping the current viewing angles. Rebuilds the orbit controls on the
       new camera so orbit/pan/zoom keep working. */
    setCameraType(orthographic){
        const layer=this.glLayer
        if(!layer) return
        const old=layer.camera
        const kept=this.controls?.getAngles?.()??this.defaultAngles??null
        const aspect=(layer.width/layer.height)||1
        let camera
        if(orthographic){
            const size=1
            camera=new THREE.OrthographicCamera(-size*aspect,size*aspect,size,-size,0.01,1000)
        }else{
            camera=new THREE.PerspectiveCamera(45,aspect,0.01,1000)
        }
        camera.position.copy(old.position)
        camera.lookAt(0,0,0)
        camera.updateMatrixWorld()
        layer.camera=camera
        this.glCamera=camera
        this.controls?.dispose?.()
        this.controls=new OrbitPanControls(camera,this.container,{
            onChange:()=>{
                this.requestFrame()
                this.requestOverlay()
            },
            onDistance:distance=>layer?.setDepthRange(distance)
        })
        /* resetAngles with the angles we just read: a perspective/orthographic
           toggle is a change of lens, not of viewpoint. Without them the view
           would snap back to pi/4, pi/3 on every toggle. */
        this.controls.frame(Plot3DWebGL.WORLD_BOX,{resetAngles:true,angles:kept})
    }

    /* --- data -------------------------------------------------------- */
    setTraces(traces){
        this.traces=Array.isArray(traces)?traces:[]
        this._dataRevision++
        this.invalidateTraces()
        this.drawGraph()
    }
    /* An asynchronous producer replaces wave.core after the draw: a bump of
       the Wave's revision is enough for the signature to notice. */
    invalidateTraces(){
        this._signature=null
        this.requestFrame()
    }
    get visibleTraces(){
        return this.traces.filter(trace=>trace&&!trace.options?.hidden)
    }

    /* The box the whole scene is fitted to. Over all visible traces: the two
       axes a trace declares are read from its own labels, and a surface's
       height is mapped onto [0, height] by the shared height mapping, so the
       box is about the DATA, not about the raw value range. */
    computeBounds(){
        let xMin=Infinity,yMin=Infinity,zMin=Infinity
        let xMax=-Infinity,yMax=-Infinity,zMax=-Infinity
        let seen=false
        for(const trace of this.visibleTraces){
            const wave=trace.wave
            if(!(wave?.core)||!wave.dims?.length) continue
            const [nx,ny]=wave.dims
            const stride=Math.max(1,Math.trunc(trace.options?.stride??1))
            let traceZMin=Infinity
            let traceZMax=-Infinity
            for(let iy=0;iy<ny;iy+=stride){
                for(let ix=0;ix<nx;ix+=stride){
                    const x=wave.core[wave.index(ix,iy,0)]
                    const y=wave.core[wave.index(ix,iy,1)]
                    const z=wave.core[wave.index(ix,iy,2)]
                    if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(z)) continue
                    if(x<xMin) xMin=x
                    if(x>xMax) xMax=x
                    if(y<yMin) yMin=y
                    if(y>yMax) yMax=y
                    if(z<traceZMin) traceZMin=z
                    if(z>traceZMax) traceZMax=z
                    seen=true
                }
            }
            if(!Number.isFinite(traceZMin)) continue
            /* A surface's z is a DISPLACEMENT mapped onto [0, height] — through
               the SHARED mapping, not a second copy of the arithmetic. The box
               is what the overlay's tick labels are read off, so a second copy
               is a second answer: the mesh would sit somewhere its own axis said
               it was not. A scatter's z is a coordinate and stays where it is. */
            if(trace instanceof SurfaceTrace){
                const map=surfaceHeightMap(wave,trace.options??{})
                traceZMin=map.place(traceZMin)
                traceZMax=map.place(traceZMax)
            }
            if(traceZMin<zMin) zMin=traceZMin
            if(traceZMax>zMax) zMax=traceZMax
        }
        if(!seen) return null
        const bounds={xMin,xMax,yMin,yMax,zMin,zMax}
        /* DATA -> WORLD, ONE MAPPER PER AXIS.

           The camera frames a CUBE, not the raw extents, and each axis is
           mapped onto its own side of it. This is not a cosmetic choice: the
           axes of a real surface have nothing in common — CalibrationNode's
           error surface runs over m/z in the hundreds and INTENSITY in the
           millions, with an error in ppm barely a unit wide. In world units
           that box is 100 x 1e7 x 1, the m/z and error edges project to a few
           pixels, and two of the three axes silently vanish from the overlay
           while the surface degenerates to a sheet seen edge-on.

           Which is exactly what was reported: one surviving axis label, no
           surface. The per-axis guard below only hid the symptom; this is the
           cause. Each axis is therefore stretched to [-1,1] and the TICKS keep
           reporting the real values, so nothing is lost but the distortion. */
        const linear=(lo,hi)=>{
            const span=(hi-lo)||1
            return value=>((value-lo)/span)*2-1
        }
        this._axisWorld={
            x:linear(bounds.xMin,bounds.xMax),
            y:linear(bounds.yMin,bounds.yMax),
            z:linear(bounds.zMin,bounds.zMax)
        }
        return bounds
    }
    /* The cube every 3D plot is drawn in. Fixed, because it is a FRAME of
       reference, not a range: the data lives in units, the world does not. */
    static WORLD_MIN=-1
    static WORLD_MAX=1
    /* WHAT THE CAMERA FRAMES. The CUBE, always — never the data extents.
       Framing on the data worked while the world WAS the data, and broke the
       moment each axis got mapped onto its own side: a calibration surface
       spans 1e7 in intensity, so frame() placed the camera 1.6e7 units from an
       object two units across, which is nothing at all on screen. The bounds
       are for the TICKS now, not for the camera. */
    static WORLD_BOX={xMin:-1,xMax:1,yMin:-1,yMax:1,zMin:-1,zMax:1}

    /* --- GPU upload -------------------------------------------------- */
    /* Cheap O(#traces) fingerprint. The buffers are only rebuilt when the
       data, the styling or the box actually moved — an orbit changes neither,
       so dragging never re-uploads a 200k-vertex surface. */
    traceSignature(bounds){
        const parts=[this._dataRevision,this.traces.length,
            bounds?.xMin,bounds?.xMax,bounds?.yMin,bounds?.yMax,bounds?.zMin,bounds?.zMax]
        for(const trace of this.visibleTraces){
            const options=trace.options??{}
            const wave=trace.wave
            parts.push(
                trace.id??"",
                options.color??"",
                options.opacity??"",
                options.colormap??"",
                options.height??"",
                //the SCALE is part of the fingerprint, not the styling: changing
                //it moves every vertex, so a surface that kept the old buffers
                //would change colour and not shape
                options.scale??"",
                options.heightRange?JSON.stringify(options.heightRange):"",
                options.size??"",
                options.stride??1,
                wave?(wave.revision??0):0,
                wave?`${wave.dims[0]}x${wave.dims[1]}`:"0"
            )
        }
        return parts.join("|")
    }
    /* THE MOUNT POINT. Called with fresh bounds whenever the fingerprint
       changed; two early returns, and they are the reasons this function is
       short: a resize and an orbit never reach it. */
    syncScene(bounds){
        const signature=this.traceSignature(bounds)
        if(signature===this._signature) return false
        this._signature=signature
        const content=this.glLayer.content
        //release the previous batch BEFORE building the next: dropping the
        //objects without disposing their buffers leaks a geometry per draw
        for(const object of this._traces){
            content.remove(object)
            object.traverse(child=>{
                child.geometry?.dispose?.()
                const material=child.material
                if(Array.isArray(material)) material.forEach(m=>m.dispose?.())
                else material?.dispose?.()
            })
        }
        this._traces=[]
        if(!bounds) return true
        for(const trace of this.visibleTraces){
            const object=trace instanceof SurfaceTrace
                ?this.buildSurface(trace,bounds)
                :this.buildScatter(trace,bounds)
            if(!object) continue
            content.add(object)
            this._traces.push(object)
        }
        return true
    }
    /* Height remapping. The accumulator values have no natural zero — the
       interesting structure is RELATIVE to the surface's own range — so z is
       centred and scaled onto ±height about the box centre, and the colour is
       the un-remapped position in the range. */
    heightMapping(trace,bounds){
        return surfaceHeightMap(trace.wave,trace.options??{})
    }
    /* The inverse of the height mapping for ONE trace, so a picked vertex can be
       reported in data units. Without it the tooltip would quote the world
       coordinate — a 12.5 ppm error labelled "-0.42". */
    dataZOf(trace,worldZ){
        const mapping=this.heightMapping(trace,this.bounds)
        const height=mapping.height||1
        if(!Number.isFinite(worldZ)) return NaN
        return mapping.denormalise(worldZ/height)
    }
    buildSurface(trace,bounds){
        const wave=trace.wave
        const [nx,ny]=wave.dims
        const {normalise,place}=this.heightMapping(trace,bounds)
        const name=trace.options?.colormap
        const ramp=COLORMAPS[name]??COLORMAPS.viridis
        /* AN ALPHA CHANNEL IN THE RAMP. A ramp returns [r,g,b] or [r,g,b,a],
           and the itemSize of the colour buffer has to follow it — a 4-item
           attribute is how three.js reads a per-vertex alpha, and writing one
           into a 3-item buffer does not fail, it is silently dropped, so the
           glow would render as flat white and nobody would know why.

           It is asked of ONE vertex rather than of the whole grid: the ramp is
           read at the endpoints once, and a map that is opaque at both ends
           plainly has no alpha in it. */
        const hasAlpha=ramp(0).length===4||ramp(1).length===4
        const stride=hasAlpha?4:3
        const world=this.axisWorld()
        const positions=new Float32Array(nx*ny*3)
        const colors=new Float32Array(nx*ny*stride)
        for(let iy=0;iy<ny;iy++){
            for(let ix=0;ix<nx;ix++){
                const node=(iy*nx+ix)*3
                const colour=(iy*nx+ix)*stride
                const z=wave.core[wave.index(ix,iy,2)]
                positions[node]=world.x(wave.core[wave.index(ix,iy,0)])
                positions[node+1]=world.y(wave.core[wave.index(ix,iy,1)])
                positions[node+2]=world.z(Number.isFinite(z)?place(z):0)
                const c=ramp(normalise(z))
                colors[colour]=c[0]
                colors[colour+1]=c[1]
                colors[colour+2]=c[2]
                /* An opaque fallback, not a zero: a ramp that returned three
                   components on a four-component buffer would leave this at 0
                   and the surface would vanish, which is the same class of
                   silent failure as the itemSize itself. */
                if(stride===4) colors[colour+3]=c.length===4?c[3]:1
            }
        }
        //two triangles per cell, wound so the normal points up: with
        //DoubleSide it does not matter for visibility, but it does for the
        //lighting, and a surface lit from the wrong side is a dark surface
        const indices=[]
        for(let iy=0;iy<ny-1;iy++){
            for(let ix=0;ix<nx-1;ix++){
                const a=iy*nx+ix
                const b=iy*nx+ix+1
                const c=(iy+1)*nx+ix
                const d=(iy+1)*nx+ix+1
                indices.push(a,c,b, b,c,d)
            }
        }
        const geometry=new THREE.BufferGeometry()
        geometry.setAttribute("position",new THREE.BufferAttribute(positions,3))
        geometry.setAttribute("color",new THREE.BufferAttribute(colors,stride))
        geometry.setIndex(indices)
        geometry.computeVertexNormals()
        const opacity=Number.isFinite(trace.options?.opacity)?trace.options.opacity:1
        /* A VERTEX ALPHA IS A WHOLE-MESH DECISION. three.js only multiplies the
           vertex alpha into the fragment when the material is `transparent`,
           and the material is per-mesh: there is no such thing as one surface
           that is opaque in part and blended in part. So a ramp with an alpha
           makes the WHOLE mesh transparent.

           And depthWrite STAYS ON, which is the opposite of what a transparent
           material usually wants and deliberate here. The file header's reason
           for keeping it is the folded surface showing its own back faces; a
           surface with a glow is exactly the case where that fold is visible,
           because the glow invites the eye through it. The cost is that
           fragments are written in whatever order the mesh happens to be
           rasterised, so on a steep face a translucent peak can be culled by
           the opaque body behind it. `depthWrite` is an option so that is a
           choice rather than a law. */
        const mesh=new THREE.Mesh(geometry,surfaceMaterial({
            colors:true,opacity,vertexAlpha:hasAlpha,
            depthWrite:trace.options?.depthWrite}))
        mesh.name=trace.title??"surface"
        //the picking code needs to walk back from the hit to the grid cell
        mesh.userData.traceId=trace.id
        mesh.userData.grid={nx,ny}
        return mesh
    }
    buildScatter(trace,bounds){
        const wave=trace.wave
        const [nx,ny]=wave.dims
        const stride=Math.max(1,Math.trunc(trace.options?.stride??1))
        const count=Math.ceil(nx/stride)*Math.ceil(ny/stride)
        const world=this.axisWorld()
        const positions=new Float32Array(count*3)
        let written=0
        for(let iy=0;iy<ny;iy+=stride){
            for(let ix=0;ix<nx;ix+=stride){
                const x=wave.core[wave.index(ix,iy,0)]
                const y=wave.core[wave.index(ix,iy,1)]
                const z=wave.core[wave.index(ix,iy,2)]
                if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(z)) continue
                positions[written*3]=world.x(x)
                positions[written*3+1]=world.y(y)
                positions[written*3+2]=world.z(z)
                written++
            }
        }
        const geometry=new THREE.BufferGeometry()
        //a subarray VIEW on a possibly oversized buffer: the upload takes a
        //count, so nothing is copied just to trim the tail
        geometry.setAttribute("position",new THREE.BufferAttribute(positions,3))
        geometry.setDrawRange(0,written)
        const opacity=Number.isFinite(trace.options?.opacity)?trace.options.opacity:1
        const cloud=new THREE.Points(geometry,scatterMaterial({
            size:Number.isFinite(trace.options?.size)?trace.options.size:3,
            colors:false,
            opacity
        }))
        cloud.name=trace.title??"scatter"
        cloud.userData.traceId=trace.id
        if(trace.options?.color){
            cloud.material.color.set(trace.options.color)
        }
        return cloud
    }

    /* --- the frame: render on demand --------------------------------- */
    /* ONE loop, requested not imposed. Plot2DWebGL redraws when its data
       changes; here an orbit needs a new frame every time, and an idle plot
       needs none. requestFrame() is therefore the single entry point, and it
       coalesces: two calls in one frame draw once. */
    requestFrame(){
        if(this._frame!==null&&this._frame!==undefined) return
        this._frame=requestAnimationFrame(()=>{
            this._frame=null
            this.drawFrame()
        })
    }
    /* The front layer redraws on its own schedule, and coalesced: an orbit
       fires onChange on every pointermove, and rebuilding the twelve edges and
       the three sets of ticks per event is wasted work on a drag. */
    requestOverlay(){
        if(this._overlayFrame!==null&&this._overlayFrame!==undefined) return
        this._overlayFrame=requestAnimationFrame(()=>{
            this._overlayFrame=null
            this.drawOverlay()
        })
    }
    drawFrame(){
        if(!this.glLayer) return
        this.glLayer.render()
    }
    drawGraph(){
        if(!this.glLayer) return
        this.bounds=this.computeBounds()
        const firstDraw=!this._traces.length
        this.syncScene(this.bounds)
        if(firstDraw&&this.bounds&&this.controls){
            this.controls.frame(Plot3DWebGL.WORLD_BOX,{resetAngles:true,angles:this.defaultAngles})
        }
        this.syncViewport()
        this.drawOverlay()
        this.requestFrame()
    }
    syncViewport(){
        /* A container that is `display:none` has no box: clientWidth and
           clientHeight are 0, and `Math.max(1, …)` would silently freeze the
           viewport at 1x1. It would STAY frozen, because a ResizeObserver does
           not fire when an element starts being displayed — only when an
           observed element changes size, and a hidden one is not observed at
           all. The plot would therefore come back at one pixel and stay there
           until the window itself was resized.

           So a collapsed container is left alone: the size stays whatever it
           was, and whoever un-hides the container must call drawGraph() after
           the fact. CalibrationNode does exactly that — its 3D box is a hidden
           sibling of its 2D box, and update3DSurface() shows it before it
           plots. */
        const width=this.container.clientWidth
        const height=this.container.clientHeight
        if(!(width>0&&height>0)) return false
        if(this.glLayer.width===width&&this.glLayer.height===height) return false
        this.glLayer.setViewport(width,height)
        return true
    }
    handleResize(){
        //coalesced: a drag-resize must not redraw once per intermediate size
        if(this._resizeFrame!==null) return
        this._resizeFrame=requestAnimationFrame(()=>{
            this._resizeFrame=null
            this.syncViewport()
            this.drawOverlay()
            this.requestFrame()
        })
    }

    /* --- the FRONT layer: box, edges, ticks -------------------------- */
    /* The data -> world mappers, rebuilt with the bounds. Falls back to the
       identity so a plot with no data yet still projects something sane. */
    axisWorld(){
        return this._axisWorld??{
            x:value=>value,
            y:value=>value,
            z:value=>value
        }
    }
    project(x,y,z){
        const v=new THREE.Vector3(x,y,z).project(this.glCamera)
        return {
            x:(v.x*0.5+0.5)*this.container.clientWidth,
            y:(-v.y*0.5+0.5)*this.container.clientHeight,
            //behind the camera: the projection folds, and a tick there would
            //land mirrored on the opposite side
            behind:v.z>1
        }
    }
    drawOverlay(){
        const svg=this.overlay
        if(!svg) return
        //nothing to project onto while the container has no box: an empty viewBox
        //would be replaced by one pixel wide, and the next real draw would
        //correct it anyway
        if(!(this.container.clientWidth>0&&this.container.clientHeight>0)) return
        const width=this.container.clientWidth
        const height=this.container.clientHeight
        svg.setAttribute("viewBox",`0 0 ${width} ${height}`)
        while(svg.firstChild) svg.removeChild(svg.firstChild)
        const bounds=this.bounds
        if(!bounds) return
        this.drawBox(svg,bounds,width,height)
        this.drawRules(svg,width,height)
        this.drawTicks(svg,bounds,width,height)
    }
    /* The twelve edges of the CUBE, at the world corners. Not the data
       corners: those would be 100 x 1e7 x 1 for a real error surface, and a
       box that thin has no depth cues left to give. */
    drawBox(svg,bounds,width,height){
        const ns="http://www.w3.org/2000/svg"
        const group=document.createElementNS(ns,"g")
        group.setAttribute("class","gl3d-box")
        const lo=Plot3DWebGL.WORLD_MIN
        const hi=Plot3DWebGL.WORLD_MAX
        const corners=[]
        for(const x of [lo,hi]){
            for(const y of [lo,hi]){
                for(const z of [lo,hi]){
                    corners.push({x,y,z})
                }
            }
        }
        const edges=[
            [0,1],[2,3],[4,5],[6,7],
            [0,2],[1,3],[4,6],[5,7],
            [0,4],[1,5],[2,6],[3,7]
        ]
        for(const [i,j] of edges){
            const a=this.project(corners[i].x,corners[i].y,corners[i].z)
            const b=this.project(corners[j].x,corners[j].y,corners[j].z)
            const line=document.createElementNS(ns,"line")
            //the two edges that make the floor are dimmer, so the box reads as
            //a volume and not as a cage
            const isFloor=corners[i].z===Plot3DWebGL.WORLD_MIN&&corners[j].z===Plot3DWebGL.WORLD_MIN
            line.setAttribute("x1",a.x)
            line.setAttribute("y1",a.y)
            line.setAttribute("x2",b.x)
            line.setAttribute("y2",b.y)
            line.setAttribute("stroke",isFloor?"#4a5a6a":"#33404d")
            line.setAttribute("stroke-width","1")
            line.setAttribute("vector-effect","non-scaling-stroke")
            group.appendChild(line)
        }
        svg.appendChild(group)
    }
    /* AXIS RULES — the plane {axis = value} across the CUBE, as a projected
       quad. Four corners, the same world frame as the box, the same project()
       as the edges — so the rule follows the camera for free.

       A MESH WALL WOULD BE WRONG HERE: seen edge-on — which is exactly the
       face-on view the Hough node opens with — a filled plane degenerates to
       zero pixels, while an SVG polygon still strokes its own collapsed
       outline as a crisp line. The overlay also draws above the surface, so
       the rule stays readable wherever the relief stands. */
    drawRules(svg,width,height){
        const rules=Array.isArray(this.axisRules)?this.axisRules:[]
        if(!rules.length) return
        /* Filtrer les murs bleus (1er ordre) : ne garder que les oranges (2nd ordre). */
        const filtered=rules.filter(r=>r.color==="#FF8C00")
        if(!filtered.length) return
        const ns="http://www.w3.org/2000/svg"
        const group=document.createElementNS(ns,"g")
        group.setAttribute("class","gl3d-rules")
        const lo=Plot3DWebGL.WORLD_MIN
        const hi=Plot3DWebGL.WORLD_MAX
        const world=this.axisWorld()
        const isOrtho=this.cameraType===true
        /* Pour orthographique : empiler les étiquettes sur le bord HAUT du mur par bin x.
           Pour perspective : centrer sur le mur comme avant. */
        const labelSlots=isOrtho?new Map():[]
        for(const rule of filtered){
            if(!rule||!Number.isFinite(rule.value)) continue
            const axis=rule.axis==="y"?"y":rule.axis==="z"?"z":"x"
            const w=world[axis](rule.value)
            if(!Number.isFinite(w)) continue
            const at=(u,v)=>axis==="x"?{x:w,y:u,z:v}
                :axis==="y"?{x:u,y:w,z:v}
                :{x:u,y:v,z:w}
            const corners=[at(lo,lo),at(hi,lo),at(hi,hi),at(lo,hi)]
                .map(c=>this.project(c.x,c.y,c.z))
            if(corners.some(p=>p.behind)) continue
            const color=rule.color??"#FF8C00"
            const polygon=document.createElementNS(ns,"polygon")
            polygon.setAttribute("points",corners.map(p=>`${p.x},${p.y}`).join(" "))
            polygon.setAttribute("fill",color)
            polygon.setAttribute("fill-opacity","0.06")
            polygon.setAttribute("stroke",color)
            polygon.setAttribute("stroke-width","0.8")
            polygon.setAttribute("vector-effect","non-scaling-stroke")
            group.appendChild(polygon)
            this.drawRuleProfile(group,ns,rule,world)
            if(!rule.label) continue
            /* Position de l'étiquette. */
            let cx, cy
            const r=11+Math.max(0,rule.label.length-1)*4.5
            if(isOrtho){
                /* Bord HAUT du mur (y max des corners projetés). */
                const topY=Math.max(...corners.map(c=>c.y))
                const leftX=Math.min(...corners.map(c=>c.x))
                const rightX=Math.max(...corners.map(c=>c.x))
                cx=(leftX+rightX)/2
                /* Binner les x projetés (taille du bin ~ largeur pastille). */
                const binSize=24
                const xBin=Math.round(cx/binSize)*binSize
                /* Stack vertical par bin x. */
                let stack=labelSlots.get(xBin)
                if(!stack){
                    stack={x:xBin,y:topY}
                    labelSlots.set(xBin,stack)
                }
                cy=stack.y-r-4
                /* Vérifier TOUS les bins pour Y-overlap global (pas seulement voisins). */
                for(const [bin,other] of labelSlots){
                    if(bin===xBin) continue
                    const minY=other.y-other.r-4
                    if(cy>minY+r+4){
                        cy=minY-r-8
                    }
                }
                console.log("[drawRules ortho]", {label:rule.label, cx, xBin, topY, cy, stackY:stack.y, bins:labelSlots.size})
                stack.y=cy-r-8
            }else{
                /* Perspective : centre du mur + anti-chevauchement circulaire. */
                const mid={x:(corners[0].x+corners[1].x+corners[2].x+corners[3].x)/4,
                    y:(corners[0].y+corners[1].y+corners[2].y+corners[3].y)/4}
                cx=mid.x; cy=mid.y
                for(const dp of labelSlots){
                    const dx=dp.x-cx, dy=dp.y-cy
                    const dist=Math.hypot(dx,dy)
                    const minDist=dp.r+r+8
                    if(dist<minDist&&dist>0){
                        const push=minDist-dist
                        cx-=dx/dist*push
                        cy-=dy/dist*push
                    }
                }
                labelSlots.push({x:cx,y:cy,r})
            }
            const disc=document.createElementNS(ns,"circle")
            disc.setAttribute("cx",cx)
            disc.setAttribute("cy",cy)
            disc.setAttribute("r",String(r))
            disc.setAttribute("fill","rgba(2,8,20,0.82)")
            disc.setAttribute("stroke",color)
            disc.setAttribute("stroke-width","1.2")
            group.appendChild(disc)
            const text=document.createElementNS(ns,"text")
            text.setAttribute("x",cx)
            text.setAttribute("y",cy+4.5)
            text.setAttribute("text-anchor","middle")
            text.setAttribute("fill","#ffffff")
            text.setAttribute("font-size","13")
            text.setAttribute("font-weight","700")
            text.setAttribute("font-family","inherit")
            text.textContent=rule.label
            group.appendChild(text)
        }
        svg.appendChild(group)
    }
    /* LE PROFIL MUR × MESH — la courbe z(axe libre) à {axis = value}, tracée
       SUR le mur, dans la couleur du mur en trait épais. Le mur est un plan
       vertical, le mesh un champ de hauteur : leur intersection est une
       courbe, pas une surface — un polyline SVG projeté suffit, et il suit
       la caméra comme tout l'overlay (reprojeté à chaque drawOverlay).

       ÉCHANTILLONNAGE LE LONG DE LA GRILLE, PAS DU MONDE : pour un mur x=w,
       on balaye les ny lignes, et dans chaque ligne on encadre w par deux
       colonnes puis on interpole y et z (lerp en t). Si w sort de la ligne,
       pas de point — la courbe s'interrompt au lieu d'extrapoler. Les NaN
       coupent aussi : deux segments plutôt qu'un saut à travers le vide.

       L'ÉCHELLE LOG EST CELLE DU MESH : z passe par le même `place()` de
       surfaceHeightMap que buildSurface — en log le relief affiché est
       log, et une courbe linéaire flotterait au-dessus du relief au lieu
       de le longer. Les axes x/y restent linéaires (axisWorld), comme le
       mesh lui-même. Mur z=w : une courbe de niveau, pas un profil —
       extraction de contour, autre chantier — on ne trace rien. */
    drawRuleProfile(group,ns,rule,world){
        const axis=rule.axis==="y"?"y":rule.axis==="z"?"z":"x"
        if(axis==="z") return
        if(!Number.isFinite(rule.value)) return
        const trace=this.visibleTraces.find(t=>t instanceof SurfaceTrace&&t.wave?.core&&t.wave.dims?.length)
        if(!trace) return
        const wave=trace.wave
        const [nx,ny]=wave.dims
        if(!(nx>=2&&ny>=2)) return
        const {place}=surfaceHeightMap(wave,trace.options??{})
        const fixedW=world[axis](rule.value)
        if(!Number.isFinite(fixedW)) return
        /* Axe balayé et axe interpolé : mur x=w → on balaye les lignes (y),
           on encadre w dans les colonnes ; mur y=w → l'inverse. */
        const alongNy=axis==="x"
        const inner=alongNy?nx:ny
        const outer=alongNy?ny:nx
        const at=(o,i)=>alongNy?{fx:wave.core[wave.index(i,o,0)],u:wave.core[wave.index(i,o,1)],z:wave.core[wave.index(i,o,2)]}
            :{fx:wave.core[wave.index(o,i,1)],u:wave.core[wave.index(o,i,0)],z:wave.core[wave.index(o,i,2)]}
        const color=rule.color??"#46BEFF"
        const subpaths=[]
        let segment=[]
        const flush=()=>{
            if(segment.length>=2) subpaths.push("M"+segment.map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("L"))
            segment=[]
        }
        for(let o=0;o<outer;o++){
            /* Les DEUX colonnes qui encadrent rule.value dans cette rangée :
               balayage simple, O(inner) par rangée donc O(nx·ny) par mur —
               une passe grille, comme buildSurface, pas un tri. */
            let a=null,b=null
            let prev=null
            for(let i=0;i<inner;i++){
                const p=at(o,i)
                if(!Number.isFinite(p.fx)||!Number.isFinite(p.u)||!Number.isFinite(p.z)){ prev=null; continue }
                if(prev&&Number.isFinite(prev.fx)){
                    const lo=Math.min(prev.fx,p.fx),hi=Math.max(prev.fx,p.fx)
                    if(rule.value>=lo&&rule.value<=hi){ a=prev; b=p; break }
                }
                prev=p
            }
            if(!a||!b){
                /* w hors de la rangée : la courbe s'interrompt — flush, pas
                   d'extrapolation qui inventerait un relief hors grille. */
                flush()
                continue
            }
            const span=b.fx-a.fx
            const t=span!==0?(rule.value-a.fx)/span:0.5
            const u=a.u+(b.u-a.u)*t
            const z=a.z+(b.z-a.z)*t
            if(!Number.isFinite(u)||!Number.isFinite(z)){ flush(); continue }
            const point=axis==="x"
                ?{x:fixedW,y:world.y(u),z:world.z(place(z))}
                :{x:world.x(u),y:fixedW,z:world.z(place(z))}
            if(![point.x,point.y,point.z].every(Number.isFinite)){ flush(); continue }
            const p=this.project(point.x,point.y,point.z)
            if(p.behind){ flush(); continue }
            segment.push(p)
        }
        flush()
        if(!subpaths.length) return
        const path=document.createElementNS(ns,"path")
        path.setAttribute("d",subpaths.join(""))
        path.setAttribute("fill","none")
        path.setAttribute("stroke",color)
        path.setAttribute("stroke-width","2.2")
        path.setAttribute("stroke-linejoin","round")
        path.setAttribute("stroke-linecap","round")
        path.setAttribute("vector-effect","non-scaling-stroke")
        /* Opacité pleine : c'est la lecture du mur — le polygone à 0.12
           reste le fond, la courbe est l'encre. */
        group.appendChild(path)
    }
    /* Tick placement is the one piece of real 3D in the front layer. An axis
       is drawn on the box edge along it that is currently the LONGEST on
       screen: pick the other two and, edge-on, the ticks pile up on a single
       pixel and the labels explode. */
    /* Each axis is placed in WORLD space through its own mapper, but its LABELS
       stay in data units — which is the whole point of mapping per axis: the
       reader still sees 104.3 m/z and 4.2 ppm, while the cube is a cube. */
    drawTicks(svg,bounds,width,height){
        const ns="http://www.w3.org/2000/svg"
        const group=document.createElementNS(ns,"g")
        group.setAttribute("class","gl3d-ticks")
        const count=Math.max(2,Math.trunc(this.renderOptions.ticks??6))
        const world=this.axisWorld()
        const axes=[
            {key:"x",label:this.axisLabels.x??"x",range:[bounds.xMin,bounds.xMax],free:["y","z"]},
            {key:"y",label:this.axisLabels.y??"y",range:[bounds.yMin,bounds.yMax],free:["x","z"]},
            {key:"z",label:this.axisLabels.z??"z",range:[bounds.zMin,bounds.zMax],free:["x","y"]}
        ]
        const pick=(axis,at)=>{
            //the origin corner for this axis: min on the other two axes
            const corner={x:0,y:0,z:0}
            for(const key of axis.free){
                corner[key]=at===0?Plot3DWebGL.WORLD_MIN:Plot3DWebGL.WORLD_MAX
            }
            return corner
        }
        /* The edge an axis is drawn on, chosen against the edges the OTHER axes
           already took. Choosing each axis' longest edge independently is what
           produced two labels printed on top of each other: two axes can each
           own their longest edge and those edges can still project to the same
           patch of screen, because "longest" says nothing about separation.

           So every axis offers its two candidates, and each one is scored on
           length MINUS its distance to the axes already placed. A slightly
           shorter edge that is clear of the others beats a long one that lands
           on their labels. */
        const chosen=[]
        for(const axis of axes){
            let best=null
            for(const at of [0,1]){
                const from=pick(axis,at)
                const to={...from}
                to[axis.key]=Plot3DWebGL.WORLD_MAX
                const a=this.project(from.x,from.y,from.z)
                const b=this.project(to.x,to.y,to.z)
                if(a.behind||b.behind) continue
                const length=Math.hypot(b.x-a.x,b.y-a.y)
                if(!(length>0)) continue
                const mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2}
                let crowding=0
                for(const taken of chosen){
                    crowding=Math.max(crowding,1/Math.max(1,Math.hypot(mid.x-taken.x,mid.y-taken.y)))
                }
                const score=length/(1+crowding*length*0.05)
                if(!best||score>best.score) best={a,b,length,from,to,mid,score}
            }
            if(!best||best.length<24) continue
            chosen.push(best.mid)
            for(let k=0;k<=count;k++){
                const t=k/count
                //the LABEL reads in data units, the POSITION in world units
                const value=axis.range[0]+(axis.range[1]-axis.range[0])*t
                const corner={...best.from}
                corner[axis.key]=world[axis.key](value)
                const p=this.project(corner.x,corner.y,corner.z)
                if(p.behind) continue
                const tick=document.createElementNS(ns,"line")
                tick.setAttribute("x1",p.x)
                tick.setAttribute("y1",p.y)
                tick.setAttribute("x2",p.x+(p.x-best.a.x)/best.length*5)
                tick.setAttribute("y2",p.y+(p.y-best.a.y)/best.length*5)
                tick.setAttribute("stroke","#7d8b99")
                tick.setAttribute("stroke-width","1")
                group.appendChild(tick)
                const text=document.createElementNS(ns,"text")
                text.setAttribute("x",p.x+(p.x-best.a.x)/best.length*9)
                text.setAttribute("y",p.y+(p.y-best.a.y)/best.length*9+3)
                text.setAttribute("fill","#9fb0c0")
                text.setAttribute("font-size","10")
                text.setAttribute("font-family","inherit")
                text.textContent=formatTick(value)
                group.appendChild(text)
            }
            //the axis NAME, at the far end of the edge it is drawn on
            const name=document.createElementNS(ns,"text")
            name.setAttribute("x",best.b.x+(best.b.x-best.a.x)/best.length*16)
            name.setAttribute("y",best.b.y+(best.b.y-best.a.y)/best.length*16+3)
            name.setAttribute("fill","#c8d4de")
            name.setAttribute("font-size","11")
            name.setAttribute("font-weight","600")
            name.textContent=axis.label
            group.appendChild(name)
        }
        svg.appendChild(group)
    }

    /* --- persistence ------------------------------------------------- */
    serializeState(){
        /* VECTORS GO OUT AS ARRAYS. getAngles() hands back live THREE.Vector3
           instances; JSON turns their own fields into {x,y,z} objects, and a
           reader that spreads such an object dies with "not iterable" — taking
           the whole session import with it. The persisted contract is therefore
           [x,y,z], written here, once. */
        const angles=this.controls?this.controls.getAngles():null
        const array=(value)=>{
            if(value==null) return null
            if(Array.isArray(value)) return [...value]
            if(typeof value.toArray==="function") return value.toArray()
            const {x,y,z}=value
            return Number.isFinite(x)&&Number.isFinite(y)&&Number.isFinite(z)?[x,y,z]:null
        }
        return {
            axisLabels:{...this.axisLabels},
            orthographic:this._orthographic,
            camera:angles?{theta:angles.theta,phi:angles.phi,distance:angles.distance,
                target:array(angles.target),pan:array(angles.pan)}:null,
            traces:this.traces.map(trace=>({
                kind:trace.constructor.name,
                id:trace.id,
                title:trace.title,
                options:trace.options
            }))
        }
    }
    restoreState(state){
        if(!state) return
        if(state.axisLabels&&typeof state.axisLabels==="object"){
            this.axisLabels={...this.axisLabels,...state.axisLabels}
        }
        if(typeof state.orthographic==="boolean") this.setCameraType(state.orthographic)
        if(state.camera&&this.controls){
            /* A SERIALIZED CAMERA COMES BACK AS A PLAIN OBJECT: the vectors in
               it are not Vector3 any more. Depending on the path they arrive as
               [x,y,z], as {x,y,z} (JSON of a live Vector3's own fields), or as
               a still-live Vector3 — and spreading the object form threw
               "camera.target is not iterable" from inside importSession, which
               killed the WHOLE session restore rather than one camera. Each
               vector is therefore COERCED, never spread blindly. */
            const vector=(value)=>{
                if(value==null) return null
                if(Array.isArray(value)) return new THREE.Vector3(...value)
                const {x,y,z}=value
                return Number.isFinite(x)&&Number.isFinite(y)&&Number.isFinite(z)
                    ?new THREE.Vector3(x,y,z)
                    :null
            }
            const camera=state.camera
            this.controls.setAngles({
                theta:camera.theta,
                phi:camera.phi,
                distance:camera.distance,
                target:vector(camera.target),
                pan:vector(camera.pan)
            })
        }
        this._signature=null
        this.drawGraph()
    }

    getStats(){
        return {
            gl:this.glLayer?this.glLayer.getStats():null,
            traces:this.traces.length,
            visible:this.visibleTraces.length,
            bounds:this.bounds
        }
    }
    /* A ONE-LINE ANSWER TO "why is it black?". Every field here is one whose
       value silently produces a black surface when it is wrong — no lights in
       the scene, vertexColors off, a degenerate bounding sphere, a camera
       outside its own far plane — and none of them throws. Read in a console
       next to a surface that renders black, this names the cause in one run
       instead of one guess per round trip. */
    diagnose(){
        const layer=this.glLayer
        const objects=layer?layer.content.children:[]
        const camera=this.glCamera
        const lights=[]
        layer?.scene?.traverse(node=>{
            if(node.isLight) lights.push(`${node.type}@${node.intensity}`)
        })
        return {
            canvas:`${layer?.canvas?.width}x${layer?.canvas?.height}`,
            clientBox:`${this.container.clientWidth}x${this.container.clientHeight}`,
            objectsInScene:objects.length,
            lightsInScene:lights,
            camera:camera?`${camera.type} near=${camera.near} far=${camera.far} pos=${camera.position.toArray().map(v=>v.toFixed(2))}`:"none",
            traces:objects.map(o=>{
                const geometry=o.geometry
                const position=geometry?.getAttribute?.("position")
                const color=geometry?.getAttribute?.("color")
                const first=position?Array.from(position.array.slice(0,3)).map(v=>+v.toFixed(3)):null
                const firstColor=color?Array.from(color.array.slice(0,3)).map(v=>+v.toFixed(3)):null
                return {
                    type:o.type,
                    visible:o.visible,
                    material:o.material?.type,
                    vertexColors:o.material?.vertexColors,
                    side:o.material?.side,
                    opacity:o.material?.opacity,
                    hasIndex:!!geometry?.getIndex,
                    vertices:position?.count??0,
                    firstPosition:first,
                    firstColor:firstColor,
                    sphere:geometry?.boundingSphere?geometry.boundingSphere.radius:"not computed"
                }
            })
        }
    }

    dispose(){
        if(this.container&&this.container.handleResize===this._resizeHook){
            this.container.handleResize=null
        }
        this._resizeHook=null
        this.container.removeEventListener("dblclick",this._onDblClick)
        this.controls?.dispose()
        this.controls=null
        for(const frame of [this._frame,this._resizeFrame,this._overlayFrame]){
            if(frame!==null&&frame!==undefined) cancelAnimationFrame(frame)
        }
        this._frame=null
        this._resizeFrame=null
        this._overlayFrame=null
        this._traces=[]
        this._signature=null
        this.glLayer?.dispose()
        this.glLayer=null
        this.glRenderer=null
        this.glScene=null
        this.glCamera=null
        this.traceCanvas?.remove()
        this.traceCanvas=null
        this.overlay?.remove()
        this.overlay=null
    }
}

/* Ticks are read at a glance, so the precision follows the span instead of a
   fixed 3 decimals: a nanogram spread over 200 units and a kilojoule spread
   over 200 units do not want the same number of characters. */
function formatTick(value){
    const span=Math.abs(value)
    if(span===0) return "0"
    if(span>=1000||span<0.01) return value.toExponential(1)
    const decimals=Math.max(0,Math.min(6,3-Math.floor(Math.log10(span))))
    return value.toFixed(decimals)
}

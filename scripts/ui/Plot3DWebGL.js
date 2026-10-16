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
    //raycast hover, throttled to one hit test per frame
    pick:true,
    pickPixelRadius:6
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
            const scale=this.panSpeed*this._distance
            const right=new THREE.Vector3().setFromMatrixColumn(this.camera.matrix,0)
            const up=new THREE.Vector3().setFromMatrixColumn(this.camera.matrix,1)
            this._panOffset.addScaledVector(right,-dx*scale)
            this._panOffset.addScaledVector(up,dy*scale)
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
    frame(box,{resetAngles=false}={}){
        this.target.set((box.xMin+box.xMax)/2,(box.yMin+box.yMax)/2,(box.zMin+box.zMax)/2)
        const size=Math.max(box.xMax-box.xMin,box.yMax-box.yMin,box.zMax-box.zMin,1e-6)
        this.minDistance=size*0.15
        this.maxDistance=size*40
        this._distance=size*1.6
        this._panOffset.set(0,0,0)
        this._scale=1
        if(resetAngles){
            this._theta=Math.PI/4
            this._phi=Math.PI/3
            this._deltaTheta=0
            this._deltaPhi=0
        }
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
export class Plot3DWebGL{
    constructor(data,title,origin,destination){
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
        this.bounds=null
        this._traces=[]           // what is currently on the GPU
        this._signature=null
        this._dataRevision=0
        this._frame=null
        this._resizeFrame=null
        this._overlayFrame=null
        this._pickFrame=null
        this._pickEvent=null
        this._hover=null
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
        this._onDblClick=()=>{
            if(!this.bounds||!this.controls) return
            this.controls.frame(Plot3DWebGL.WORLD_BOX,{resetAngles:true})
            this.requestFrame()
            this.drawOverlay()
        }
        this._onMove=(e)=>{
            if(!this.renderOptions.pick) return
            this._pickEvent={x:e.clientX,y:e.clientY}
            this.requestPick()
        }
        this._onLeave=()=>{
            this._pickEvent=null
            if(this._hover){
                this._hover=null
                this.drawOverlay()
                this.requestFrame()
            }
        }
        this.container.addEventListener("dblclick",this._onDblClick)
        this.container.addEventListener("mousemove",this._onMove,{passive:true})
        this.container.addEventListener("mouseleave",this._onLeave)
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
       height is remapped onto ±height about the box centre, so the box is
       about the DATA, not about the raw value range. */
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
            /* A surface's z is a DISPLACEMENT, centred and scaled onto ±height
               about the box centre, so the box is about the data and not about
               the raw value range — which is what makes two runs comparable.
               A scatter's z is a coordinate and stays where it is. */
            if(trace instanceof SurfaceTrace){
                const height=Number.isFinite(trace.options?.height)?trace.options.height:0.5
                const mid=(traceZMin+traceZMax)/2
                const half=(traceZMax-traceZMin)/2||1
                traceZMin=mid-half*height*2
                traceZMax=mid+half*height*2
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
        const wave=trace.wave
        const [nx,ny]=wave.dims
        const range=trace.options?.heightRange
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
        const span=hi-lo||1
        const mid=(lo+hi)/2
        const height=Number.isFinite(trace.options?.height)?trace.options.height:0.5
        return {lo,hi,span,mid,height,normalise:z=>Math.min(1,Math.max(0,(z-lo)/span)),place:z=>((z-mid)/span)*height}
    }
    /* The inverse of the height mapping for ONE trace, so a picked vertex can be
       reported in data units. Without it the tooltip would quote the world
       coordinate — a 12.5 ppm error labelled "-0.42". */
    dataZOf(trace,worldZ){
        const mapping=this.heightMapping(trace,this.bounds)
        const height=mapping.height||1
        if(!Number.isFinite(worldZ)) return NaN
        return mapping.mid+(worldZ/height)*mapping.span
    }
    buildSurface(trace,bounds){
        const wave=trace.wave
        const [nx,ny]=wave.dims
        const {normalise,place}=this.heightMapping(trace,bounds)
        const ramp=COLORMAPS[trace.options?.colormap]??COLORMAPS.viridis
        const world=this.axisWorld()
        const positions=new Float32Array(nx*ny*3)
        const colors=new Float32Array(nx*ny*3)
        for(let iy=0;iy<ny;iy++){
            for(let ix=0;ix<nx;ix++){
                const node=(iy*nx+ix)*3
                const z=wave.core[wave.index(ix,iy,2)]
                positions[node]=world.x(wave.core[wave.index(ix,iy,0)])
                positions[node+1]=world.y(wave.core[wave.index(ix,iy,1)])
                positions[node+2]=world.z(Number.isFinite(z)?place(z):0)
                const [r,g,b]=ramp(normalise(z))
                colors[node]=r
                colors[node+1]=g
                colors[node+2]=b
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
        geometry.setAttribute("color",new THREE.BufferAttribute(colors,3))
        geometry.setIndex(indices)
        geometry.computeVertexNormals()
        const opacity=Number.isFinite(trace.options?.opacity)?trace.options.opacity:1
        const mesh=new THREE.Mesh(geometry,surfaceMaterial({colors:true,opacity}))
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
            this.controls.frame(Plot3DWebGL.WORLD_BOX,{resetAngles:true})
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
        this.drawTicks(svg,bounds,width,height)
        this.drawHover(svg,width,height)
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
    /* The hover marker: a ring drawn at the projected position of the point
       the raycast hit, plus its value. The raycast itself is the source of
       truth — there is no 2D index to rebuild on every upload. */
    drawHover(svg,width,height){
        if(!this._hover) return
        const ns="http://www.w3.org/2000/svg"
        const group=document.createElementNS(ns,"g")
        group.setAttribute("class","gl3d-hover")
        const p=this.project(this._hover.x,this._hover.y,this._hover.z)
        if(p.behind) return
        const radius=this.renderOptions.pickPixelRadius??6
        const ring=document.createElementNS(ns,"circle")
        ring.setAttribute("cx",p.x)
        ring.setAttribute("cy",p.y)
        ring.setAttribute("r",radius)
        ring.setAttribute("fill","none")
        ring.setAttribute("stroke","#ffd479")
        ring.setAttribute("stroke-width","1.5")
        group.appendChild(ring)
        const text=document.createElementNS(ns,"text")
        text.setAttribute("x",p.x+radius+4)
        text.setAttribute("y",p.y-radius-2)
        text.setAttribute("fill","#ffd479")
        text.setAttribute("font-size","10")
        text.setAttribute("font-family","inherit")
        text.textContent=this._hover.label
        group.appendChild(text)
        svg.appendChild(group)
    }
    /* One raycast per frame at most. A mousemove fires far more often than a
       surface can usefully be re-tested, and the throttle is what keeps the
       hover free on a 200k-vertex grid. */
    requestPick(){
        if(this._pickFrame!==null) return
        this._pickFrame=requestAnimationFrame(()=>{
            this._pickFrame=null
            const event=this._pickEvent
            if(!event||!this.glLayer||!this.renderOptions.pick) return
            const hit=this.glLayer.raycast(event.x,event.y)
            const previous=this._hover
            if(!hit){
                if(previous){
                    this._hover=null
                    this.drawOverlay()
                    this.requestFrame()
                }
                return
            }
            const object=hit.object
            const grid=object.userData?.grid
            let label=object.userData?.traceId??""
            if(grid&&Number.isInteger(hit.faceIndex)){
                /* A CELL, not a face — and that halving is the whole fix.
                   buildSurface emits TWO triangles per grid cell, so faceIndex
                   runs over 2*(nx-1)*(ny-1) while cells run over (nx-1)*(ny-1).
                   Reading a face index as a cell therefore walked iy up to
                   twice the last row, and `getZ()` past the end of the
                   attribute returned undefined: "can't access property
                   'toPrecision', z is undefined", thrown from a rAF callback
                   where the stack points nowhere near the arithmetic.

                   And it only showed on SOME cells, which is why it looked
                   arbitrary: the first triangle of each cell landed in range. */
                const cell=Math.floor(hit.faceIndex/2)
                const ix=cell%(grid.nx-1)
                const iy=Math.floor(cell/(grid.nx-1))
                const index=iy*grid.nx+ix
                const z=Number.isInteger(index)?object.geometry.attributes.position.getZ(index):NaN
                /* The buffer holds the WORLD z — after the per-axis mapping —
                   so reading it straight would label a 12.5 ppm error as
                   "-0.42". The tooltip reports DATA units, like the ticks. */
                const trace=this.visibleTraces.find(t=>t.id===object.userData?.traceId)
                const dataZ=trace?this.dataZOf(trace,z):NaN
                label=Number.isFinite(dataZ)?`z ${dataZ.toPrecision(4)}`:""
                this._hover={x:hit.point.x,y:hit.point.y,z:hit.point.z,label}
            }else{
                this._hover={x:hit.point.x,y:hit.point.y,z:hit.point.z,
                    label:label?`${label}`:""}
            }
            this.drawOverlay()
            this.requestFrame()
        })
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
        this.container.removeEventListener("mousemove",this._onMove)
        this.container.removeEventListener("mouseleave",this._onLeave)
        this.controls?.dispose()
        this.controls=null
        for(const frame of [this._frame,this._resizeFrame,this._overlayFrame,this._pickFrame]){
            if(frame!==null&&frame!==undefined) cancelAnimationFrame(frame)
        }
        this._frame=null
        this._resizeFrame=null
        this._overlayFrame=null
        this._pickFrame=null
        this._pickEvent=null
        this._hover=null
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

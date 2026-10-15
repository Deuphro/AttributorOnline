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
    constructor(camera,domElement,{onChange=null}={}){
        this.camera=camera
        this.domElement=domElement
        this.target=new THREE.Vector3(0,0,0)
        this.onChange=onChange
        this.minDistance=0.6
        this.maxDistance=80
        this.rotateSpeed=0.008
        this.zoomSpeed=0.0016
        this.panSpeed=0.0022
        this.damping=0.12
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
        this.onChange?.()
    }
    update(){
        if(this.damping>0){
            this._theta+=this._deltaTheta*this.damping
            this._phi+=this._deltaPhi*this.damping
            this._deltaTheta*=1-this.damping
            this._deltaPhi*=1-this.damping
            this._distance*=1+(this._scale-1)*this.damping
            this._scale=1+(this._scale-1)*(1-this.damping)
            this._panOffset.multiplyScalar(1-this.damping)
        }else{
            this._theta+=this._deltaTheta
            this._phi+=this._deltaPhi
            this._deltaTheta=0
            this._deltaPhi=0
            this._scale=1
            this._distance*=this._scale
            this._scale=1
        }
        this._phi=Math.max(0.02,Math.min(Math.PI-0.02,this._phi))
        this._distance=Math.max(this.minDistance,Math.min(this.maxDistance,this._distance))
        this._spherical.set(this._distance,this._phi,this._theta)
        this.camera.position.setFromSpherical(this._spherical).add(this.target).add(this._panOffset)
        this.camera.lookAt(this.target.clone().add(this._panOffset))
        this.camera.updateMatrixWorld()
        this.onChange?.()
    }
    /* Re-frame on the given box, keeping the current viewing angles. Used on
       first draw and by the double-click reset. */
    frame(box,{resetAngles=false}={}){
        this.target.set((box.xMin+box.xMax)/2,(box.yMin+box.yMax)/2,(box.zMin+box.zMax)/2)
        const size=Math.max(box.xMax-box.xMin,box.yMax-box.yMin,box.zMax-box.zMin,1e-6)
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
        this._pickFrame=null
        this._pickEvent=null
        this._hover=null
        this._hidden=[]
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
                onChange:()=>this.requestFrame()
            })
        }
        this._onDblClick=()=>{
            if(!this.bounds||!this.controls) return
            this.controls.frame(this.bounds,{resetAngles:true})
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
        return {xMin,xMax,yMin,yMax,zMin,zMax}
    }

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
    buildSurface(trace,bounds){
        const wave=trace.wave
        const [nx,ny]=wave.dims
        const {normalise,place}=this.heightMapping(trace,bounds)
        const ramp=COLORMAPS[trace.options?.colormap]??COLORMAPS.viridis
        const positions=new Float32Array(nx*ny*3)
        const colors=new Float32Array(nx*ny*3)
        for(let iy=0;iy<ny;iy++){
            for(let ix=0;ix<nx;ix++){
                const node=(iy*nx+ix)*3
                const z=wave.core[wave.index(ix,iy,2)]
                positions[node]=wave.core[wave.index(ix,iy,0)]
                positions[node+1]=wave.core[wave.index(ix,iy,1)]
                positions[node+2]=Number.isFinite(z)?place(z):0
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
        const positions=new Float32Array(count*3)
        let written=0
        for(let iy=0;iy<ny;iy+=stride){
            for(let ix=0;ix<nx;ix+=stride){
                const x=wave.core[wave.index(ix,iy,0)]
                const y=wave.core[wave.index(ix,iy,1)]
                const z=wave.core[wave.index(ix,iy,2)]
                if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(z)) continue
                positions[written*3]=x
                positions[written*3+1]=y
                positions[written*3+2]=z
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
            this.controls.frame(this.bounds,{resetAngles:true})
        }
        this.syncViewport()
        this.drawOverlay()
        this.requestFrame()
    }
    syncViewport(){
        const width=Math.max(1,this.container.clientWidth)
        const height=Math.max(1,this.container.clientHeight)
        if(this.glLayer.width===width&&this.glLayer.height===height) return
        this.glLayer.setViewport(width,height)
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
    drawBox(svg,bounds,width,height){
        const ns="http://www.w3.org/2000/svg"
        const group=document.createElementNS(ns,"g")
        group.setAttribute("class","gl3d-box")
        //the twelve edges of the data box: without them a floating surface has
        //nothing to be read against, and the depth cues have to come from the
        //lighting alone
        const corners=[]
        for(const x of [bounds.xMin,bounds.xMax]){
            for(const y of [bounds.yMin,bounds.yMax]){
                for(const z of [bounds.zMin,bounds.zMax]){
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
            const isFloor=corners[i].z===bounds.zMin&&corners[j].z===bounds.zMin
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
    drawTicks(svg,bounds,width,height){
        const ns="http://www.w3.org/2000/svg"
        const group=document.createElementNS(ns,"g")
        group.setAttribute("class","gl3d-ticks")
        const count=Math.max(2,Math.trunc(this.renderOptions.ticks??6))
        const axes=[
            {key:"x",label:this.axisLabels.x??"x",range:[bounds.xMin,bounds.xMax],free:["y","z"]},
            {key:"y",label:this.axisLabels.y??"y",range:[bounds.yMin,bounds.yMax],free:["x","z"]},
            {key:"z",label:this.axisLabels.z??"z",range:[bounds.zMin,bounds.zMax],free:["x","y"]}
        ]
        const pick=(axis,at)=>{
            //the origin corner for this axis: min on the other two axes
            const corner={x:0,y:0,z:0}
            for(const key of axis.free){
                corner[key]=at===0?bounds[`${key}Min`]:bounds[`${key}Max`]
            }
            return corner
        }
        for(const axis of axes){
            let best=null
            for(const at of [0,1]){
                const from=pick(axis,at)
                const to={...from}
                to[axis.key]=axis.range[1]
                const a=this.project(from.x,from.y,from.z)
                const b=this.project(to.x,to.y,to.z)
                if(a.behind||b.behind) continue
                const length=Math.hypot(b.x-a.x,b.y-a.y)
                if(!best||length>best.length) best={a,b,length,from,to}
            }
            if(!best||best.length<24) continue
            for(let k=0;k<=count;k++){
                const t=k/count
                const value=axis.range[0]+(axis.range[1]-axis.range[0])*t
                const corner={...best.from}
                corner[axis.key]=value
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
                //the face index names the cell, so the grid coordinates come
                //back without a nearest-point search
                const cell=hit.faceIndex
                const ix=cell%(grid.nx-1)
                const iy=Math.floor(cell/(grid.nx-1))
                const z=object.geometry.attributes.position.getZ(iy*grid.nx+ix)
                label=`z ${z.toPrecision(4)}`
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
        return {
            axisLabels:{...this.axisLabels},
            camera:this.controls?this.controls.getAngles():null,
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
            //a serialized camera comes back as a plain object: the vectors in
            //it are not Vector3 any more
            const camera=state.camera
            this.controls.setAngles({
                theta:camera.theta,
                phi:camera.phi,
                distance:camera.distance,
                target:camera.target?new THREE.Vector3(...camera.target):null,
                pan:camera.pan?new THREE.Vector3(...camera.pan):null
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
        for(const frame of [this._frame,this._resizeFrame,this._pickFrame]){
            if(frame!==null&&frame!==undefined) cancelAnimationFrame(frame)
        }
        this._frame=null
        this._resizeFrame=null
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

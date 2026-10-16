import {Wave,SurfaceTrace,Scatter3DTrace} from "../formats.js"
import {NodeWithRightAccordionGraph} from "./NodeWithRightAccordionGraph.js"
import {Plot3DWebGL} from "../ui/Plot3DWebGL.js"
import {CE,stylize} from "../util.js"
import {wavesFromInput} from "../utils/index.js"
import {computePool} from "../workerPool.js"

/* =====================================================================
   HoughTransformNode — the Hough accumulator of (slope, intercept), as a
   surface on [-1,1]^2.

   THE SHAPE OF THE NODE, settled first:
     • one input, one output;
     • the input is multiplexed (any number of XY waves on input 0) and
       every wave is accumulated into the SAME surface;
     • the output is ONE wave, a 3-column grid [x, y, z] already mapped
       on [-1,1]^2, which is exactly what a Rust kernel would return and
       what a BufferGeometry wants.

   THE ACCUMULATION IS THE KERNEL'S: `startResolve` flattens every accepted
   XY wave into one [masses…, intensities…] core — the layout `houghPrepare`
   splits in half — and runs `computePool.run("houghTransform", …)`. The
   worker answers with the grid, the pair count and how many peaks were fed;
   all three reach the readout and the metadata, so a refusal (<2 usable
   peaks) is NAMED instead of passing for a flat "no relation found". The
   grid sizes, the (slope, intercept) box and the view stay the node's.

   THE VIEW is a Plot3DWebGL — the 3D counterpart of Plot2DWebGL, built on
   GLSceneLayer. It used to hijack a Plot2DWebGL, and that cost four
   workarounds: a perspective camera swapped over the orthographic one (and
   over Plot2DWebGL's own `glCamera` alias), a `svg.main` hidden because it
   covered the canvas and ate the pointer, margins pinched to 8 because they
   were reserved for axes that meant nothing, and a capture-phase listener on
   the dialog to get the events back. None of that is here any more: the 3D
   layer is perspective by construction, the overlay is transparent to the
   pointer, there are no 2D margins, and the gestures live on the container.
   ===================================================================== */

/* THE (SLOPE, INTERCEPT) DOMAIN, kept in one place because three things must
   agree on it: what the node asks the kernel for, what the axis labels claim,
   and what the metadata of the output wave records. The wave's x,y are
   NORMALISED onto [-1,1] — each axis linearly mapped from this box — and the
   box travels with the wave, so the mapping stays reversible.

   The domain is deliberately NARROW: slopes within ±0.001, intercepts within
   ±0.2. A pair whose line falls outside votes for NOTHING (the kernel drops
   it, and the readout's pair count says how many survived), so this box IS
   the question the surface answers. The defaults below double as the kernel
   default (worker: bounds ?? [-0.001,0.001,-0.2,0.2]), restated here so the
   node owns what it asks for rather than inheriting it. */

export class HoughTransformNode extends NodeWithRightAccordionGraph{
    constructor(title,origin,destinationFlow,position={x:180,y:10}){
        //one multiplexed input, one grid output
        super(title,[[]],[[]],origin,destinationFlow,position)
        this.status="floating"
        /* grid sizes, how tall the surface is drawn, and which colormap.
           Plain numbers on `parameters` because serializeState() owns them. */
        this.parameters.gridX=64
        this.parameters.gridY=48
        this.parameters.heightScale=0.55
        this.parameters.colormap="viridis"
        this.parameters.showScatter=false
        /* The (slope, intercept) box the kernel is asked for. Editable from
           the inspector and persisted with the session. */
        this.parameters.slopeMin=-0.001
        this.parameters.slopeMax=0.001
        this.parameters.interceptMin=-0.2
        this.parameters.interceptMax=0.2
        this.surface=null
        this.collectedWaves=[]
        /* Monotonic ticket — FKMDNode's pattern: a resolve waiting on the
           worker must not be overwritten by a newer one that started while it
           was still in flight. */
        this.resolveRun=0
        this.kernelErrors=[]
        const inputAnchors=this.DOMelt.querySelectorAll('.input.anchor')
        if(inputAnchors[0]) inputAnchors[0].innerHTML='<title>Input: one or more XY waves (X=mass, Y=intensity), accumulated together</title>'
        const outputAnchors=this.DOMelt.querySelectorAll('.output.anchor')
        if(outputAnchors[0]) outputAnchors[0].innerHTML='<title>Output: one grid wave [x, y, z] on [-1,1]^2</title>'
    }
    /* THE 3D PLOT IS THE ONLY ONE THIS NODE HAS. Declared here rather than
       created after super.registered(): the base class would otherwise open a
       Plot2DWebGL first, and disposing it a moment later still burns a WebGL
       context. Browsers cap those per page — Chrome at 16 — and past the cap
       it drops the OLDEST LIVE one, which belongs to a plot the user is still
       looking at. So one node, one context, from the start. */
    /* The (slopeMin, slopeMax, interceptMin, interceptMax) box the kernel is
       asked for. Read through this so the inspector and the kernel always agree. */
    bounds(){
        return [this.parameters.slopeMin,this.parameters.slopeMax,
                this.parameters.interceptMin,this.parameters.interceptMax]
    }
    /* The Hough surface lies on a VERTICAL plane of the cube, so the camera
       belongs in the horizontal one: theta 0, phi pi/2 looks the surface
       face-on. The plot's own pi/4, pi/3 is a 30-degree oblique and turns the
       surface nearly edge-on. */
    createGraph(dialog,label){
        const plot=new Plot3DWebGL([],`${label} surface`,this.origin,dialog.DOMelt.content,
            {theta:0,phi:Math.PI/2})
        const b=this.bounds()
        plot.axisLabels={x:`slope [${b[0]}, ${b[1]}]`,y:`intercept [${b[2]}, ${b[3]}]`,z:"intensity"}
        return plot
    }
    registered(e){
        if(e.detail.msg.caster!==this||this.accordion){
            return
        }
        super.registered(e)
        this.setupUI()
        //the first resolve runs the kernel on NO input at all: it publishes a
        //zeroed grid whose readout names the refusal, so the view is never an
        //empty grey box — and never a flat surface without saying why
        this.startResolve().then(()=>this.resolveChildren())
    }

    /* --- inspector ---------------------------------------------------- */
    setupUI(){
        if(!this.accordion) return
        const content=this.accordion.DOMelt.content
        content.replaceChildren()
        this.accordion.setSizingMode("content")
        stylize(content,{
            display:"grid",
            "grid-template-columns":"auto minmax(0, 1fr)",
            padding:"4px",
            gap:"4px",
            "align-items":"center",
            "font-size":"0.85em"
        })
        const numberField=(label,key,min,max)=>{
            const caption=CE("label",{},[label])
            const input=CE("input",{type:"number",value:this.parameters[key],min,max,step:1},[])
            stylize(input,{width:"100%","box-sizing":"border-box",fontFamily:"inherit","font-size":"0.9em"})
            input.addEventListener("change",()=>{
                const value=Math.max(min,Math.min(max,Math.trunc(Number(input.value))||min))
                this.parameters[key]=value
                input.value=value
                this.startResolve().then(()=>this.resolveChildren())
            })
            content.append(caption,input)
            return input
        }
        const decimalField=(label,key,min,max,step=0.0001,decimals=4)=>{
            const caption=CE("label",{},[label])
            const input=CE("input",{type:"number",value:this.parameters[key].toFixed(decimals),min,max,step},[])
            stylize(input,{width:"100%","box-sizing":"border-box",fontFamily:"inherit","font-size":"0.9em"})
            input.addEventListener("change",()=>{
                const value=Math.max(min,Math.min(max,Number(input.value)||this.parameters[key]))
                this.parameters[key]=value
                input.value=value.toFixed(decimals)
                this.startResolve().then(()=>this.resolveChildren())
            })
            content.append(caption,input)
            return input
        }
        this.gridXInput=numberField("grid x","gridX",8,256)
        this.gridYInput=numberField("grid y","gridY",8,256)
        this.slopeMinInput=decimalField("slope min","slopeMin",-1,1)
        this.slopeMaxInput=decimalField("slope max","slopeMax",-1,1)
        this.interceptMinInput=decimalField("intercept min","interceptMin",-10,10)
        this.interceptMaxInput=decimalField("intercept max","interceptMax",-10,10)
        const heightCaption=CE("label",{},["height"])
        this.heightInput=CE("input",{type:"range",min:0.05,max:1,step:0.05,value:this.parameters.heightScale},[])
        stylize(this.heightInput,{width:"100%"})
        this.heightInput.addEventListener("input",()=>{
            this.parameters.heightScale=Number(this.heightInput.value)
            //the height is a TRACE OPTION, not the data: the grid does not
            //change, so no resolve and no re-upload of the wave
            this.applyTraces()
        })
        content.append(heightCaption,this.heightInput)
        const mapCaption=CE("label",{},["colormap"])
        this.mapInput=CE("select",{},[])
        for(const [value,label] of [["viridis","viridis"],["coolwarm","cool / warm"],["grayscale","grayscale"]]){
            this.mapInput.append(CE("option",{value},[label]))
        }
        this.mapInput.value=this.parameters.colormap
        stylize(this.mapInput,{width:"100%",fontFamily:"inherit","font-size":"0.9em"})
        this.mapInput.addEventListener("change",()=>{
            this.parameters.colormap=this.mapInput.value
            this.applyTraces()
        })
        content.append(mapCaption,this.mapInput)
        const scatterCaption=CE("label",{},["pairs"])
        this.scatterInput=CE("input",{type:"checkbox"},[])
        this.scatterInput.checked=!!this.parameters.showScatter
        stylize(this.scatterInput,{justifySelf:"start"})
        this.scatterInput.addEventListener("change",()=>{
            this.parameters.showScatter=this.scatterInput.checked
            this.applyTraces()
        })
        content.append(scatterCaption,this.scatterInput)
        const hint=CE("div",{style:{"grid-column":"1 / -1",opacity:"0.7"}},["drag: orbit · shift+drag: pan · wheel: zoom · double-click: reframe · shift+double-click: perspective ↔ orthographic"])
        content.append(hint)
        this.readout=CE("div",{style:{"grid-column":"1 / -1","white-space":"pre-wrap",opacity:"0.85"}},[])
        content.append(this.readout)
    }
    renderReadout(){
        if(!this.readout) return
        if(!this.surface){
            this.readout.textContent="no surface"
            return
        }
        const {nx,ny}=this.surface
        const lines=[
            `grid ${nx} x ${ny} = ${nx*ny} nodes`,
            `z in [${this.surface.zMin.toFixed(4)}, ${this.surface.zMax.toFixed(4)}]`,
            `inputs accumulated: ${this.collectedWaves.length}`,
            `peaks fed: ${this.surface.prepared} of ${this.surface.points} points`,
            `pairs used: ${this.surface.pairs}`,
            `domain: slope [${this.surface.bounds[0]}, ${this.surface.bounds[1]}] intercept [${this.surface.bounds[2]}, ${this.surface.bounds[3]}]`
        ]
        if(this.collectedWaves.length&&!this.kernelErrors.length&&this.surface.prepared<2){
            lines.push("refused: fewer than 2 usable peaks — the zeros are the kernel's answer, not a relation")
        }
        for(const err of this.kernelErrors??[]){
            lines.push(`kernel: ${err}`)
        }
        if(this.skippedInputs){
            lines.push(`${this.skippedInputs} entrée(s) ignorée(s): pas une wave XY`)
        }
        this.readout.textContent=lines.join("\n")
    }

    /* --- resolve ------------------------------------------------------ */
    /* THE KERNEL RUNS HERE, off the UI thread, and its answer may land after a
       newer resolve has started: every await is followed by the ticket check,
       so a stale reply is dropped instead of repainting an old grid over a new
       one. `startResolve` never REJECTS — a kernel failure becomes a status
       and a readout line, not an unhandled promise in somebody else's
       `.then()`. */
    async startResolve(){
        this.collectInputWaves()
        const run=++this.resolveRun
        this.kernelErrors=[]
        let answer=null
        if(this.collectedWaves.length){
            const {nx,ny}=this.gridSize()
            try{
                answer=await computePool.run("houghTransform",{
                    core:this.houghCore(),
                    params:{nx,ny,keep:0,bounds:this.bounds()}
                })
            }catch(err){
                if(run!==this.resolveRun) return
                this.kernelErrors=[err.message??String(err)]
            }
        }
        if(run!==this.resolveRun) return
        this.buildSurface(answer)
        this.outputs[0]=[this.surfaceWave]
        this.setStatus(this.kernelErrors.length?"error"
            :this.collectedWaves.length?"resolved":"floating")
        this.applyTraces()
        this.renderReadout()
    }
    /* ONE FLAT [masses…, intensities…] CORE — the layout `houghPrepare` splits
       in half. A single XY wave is already columnar that way, but concatenating
       N wave cores would interleave the two planes, so the halves are rebuilt
       per wave through `index()`, the only accessor the layout guarantees. */
    houghCore(){
        let total=0
        for(const wave of this.collectedWaves) total+=Math.floor(wave.core.length/2)
        const core=new Float64Array(total*2)
        let offset=0
        for(const wave of this.collectedWaves){
            const n=Math.floor(wave.core.length/2)
            for(let i=0;i<n;i++){
                core[offset+i]=wave.core[wave.index(i,0)]
                core[total+offset+i]=wave.core[wave.index(i,1)]
            }
            offset+=n
        }
        return core
    }
    /* THE GRID SIZE, clamped ONCE: the kernel returns a grid sized by the nx/ny
       it was given, and buildSurface must slice it with the SAME numbers — two
       independent clamps that ever disagree would turn into a wrong-length
       grid (or worse, a silently transposed one). */
    gridSize(){
        return {
            nx:Math.max(2,Math.trunc(this.parameters.gridX)||64),
            ny:Math.max(2,Math.trunc(this.parameters.gridY)||48)
        }
    }
    collectInputWaves(){
        const {waves,skipped}=wavesFromInput(this.inputs[0])
        const accepted=[]
        for(const wave of waves){
            //the accumulator is a relation between peaks, so only an XY wave
            //means anything on this input
            if(wave.degree===2&&wave.dims[1]===2){
                accepted.push(wave)
            }
        }
        this.collectedWaves=accepted
        this.skippedInputs=skipped+(waves.length-accepted.length)
        return accepted
    }
    /* The grid, as a 3-column Wave: dims [gridX, gridY, 3], x and y on
       [-1,1], z whatever the kernel produced. Built through the canonical
       `index()` helper so the Wave owns the layout and the geometry is derived
       from it, never the other way round.

       THE KERNEL ORDERS ITS GRID CELL(y)*nx+CELL(x) — slope across x,
       intercept up y — which is this very loop: cell (ix,iy) reads
       grid[iy*nx+ix]. A missing or wrong-length grid (<2 usable peaks, stale
       wasm, a recorded failure) is written as zeros, and the metadata says
       WHICH case it is: a flat surface must never pass for "no relation
       found" without the readout naming the refusal. */
    buildSurface(answer=null){
        const {nx,ny}=this.gridSize()
        const grid=answer?.grid
        const usable=grid instanceof Float64Array&&grid.length===nx*ny
        const prepared=Math.trunc(Number(answer?.prepared))||0
        const pairs=Math.trunc(Number(answer?.count))||0
        const wave=new Wave(nx,ny,3)
        wave.labels=Wave.normalizeLabels(["slope","intercept","intensity"])
        let zMin=Infinity
        let zMax=-Infinity
        for(let iy=0;iy<ny;iy++){
            const v=(iy/(ny-1))*2-1
            for(let ix=0;ix<nx;ix++){
                const u=(ix/(nx-1))*2-1
                const z=usable?grid[iy*nx+ix]:0
                if(z<zMin) zMin=z
                if(z>zMax) zMax=z
                wave.core[wave.index(ix,iy,0)]=u
                wave.core[wave.index(ix,iy,1)]=v
                wave.core[wave.index(ix,iy,2)]=z
            }
        }
        if(!(zMax>zMin)) zMax=zMin+1
        wave.metadata={
            title:`${this.title} (Hough surface)`,
            "hough-surface":true,
            nx,
            ny,
            zMin,
            zMax,
            domain:"[-1,1]^2",
            bounds:[...this.bounds()],
            source:usable?"kernel (computePool houghTransform)"
                :this.kernelErrors.length?`kernel error: ${this.kernelErrors[0]}`
                :answer?"kernel refused the inputs"
                :"no kernel run (no usable input)",
            prepared,
            pairs,
            collected:this.collectedWaves.length
        }
        wave.touch()
        let points=0
        for(const w of this.collectedWaves) points+=Math.floor(w.core.length/2)
        this.surface={nx,ny,wave,zMin,zMax,prepared,pairs,points,bounds:this.bounds()}
        this.surfaceWave=wave
        return wave
    }
    setStatus(status){
        this.status=status
        dispatchEvent(this.events.broadcast.nodeStatusChanged.call(this,status))
    }

    /* Pushing the traces. Separate from buildSurface on purpose: height and
       colormap are TRACE OPTIONS, and changing them re-lays the same wave
       instead of rebuilding it — a 64x48 grid is cheap, but the separation is
       what keeps that true when the kernel makes it 600x600. */
    applyTraces(){
        if(!this.graph||!this.surfaceWave) return
        const traces=[]
        traces.push(new SurfaceTrace({
            id:"hough-surface",
            title:"Hough accumulator",
            wave:this.surfaceWave,
            options:{
                colormap:this.parameters.colormap,
                height:this.parameters.heightScale,
                //the data's own range, so a change of grid resolution cannot
                //shift what a colour means
                heightRange:[this.surface.zMin,this.surface.zMax]
            }
        }))
        if(this.parameters.showScatter){
            /* The SAME wave read as a cloud rather than a mesh: it exercises
               Scatter3DTrace on identical data, and shows that the two traces
               agree on the geometry. It is NOT the contributing peak pairs —
               those do not exist until the Rust kernel produces them, and
               claiming otherwise here would be a lie the readout repeats. */
            traces.push(new Scatter3DTrace({
                id:"hough-nodes",
                title:"grid nodes",
                wave:this.surfaceWave,
                options:{size:2,color:"#ffffff",stride:2,opacity:0.75}
            }))
        }
        this.graph.setTraces(traces)
    }

    /* --- persistence -------------------------------------------------- */
    serializeState(){
        return {
            gridX:this.parameters.gridX,
            gridY:this.parameters.gridY,
            heightScale:this.parameters.heightScale,
            colormap:this.parameters.colormap,
            showScatter:this.parameters.showScatter,
            slopeMin:this.parameters.slopeMin,
            slopeMax:this.parameters.slopeMax,
            interceptMin:this.parameters.interceptMin,
            interceptMax:this.parameters.interceptMax,
            plot:this.graph?.serializeState?.()??null
        }
    }
    restoreState(state){
        if(!state) return
        for(const key of ["gridX","gridY","heightScale","slopeMin","slopeMax","interceptMin","interceptMax"]){
            if(Number.isFinite(state[key])) this.parameters[key]=state[key]
        }
        if(typeof state.colormap==="string") this.parameters.colormap=state.colormap
        if(typeof state.showScatter==="boolean") this.parameters.showScatter=state.showScatter
        if(this.gridXInput) this.gridXInput.value=this.parameters.gridX
        if(this.gridYInput) this.gridYInput.value=this.parameters.gridY
        if(this.slopeMinInput) this.slopeMinInput.value=this.parameters.slopeMin.toFixed(4)
        if(this.slopeMaxInput) this.slopeMaxInput.value=this.parameters.slopeMax.toFixed(4)
        if(this.interceptMinInput) this.interceptMinInput.value=this.parameters.interceptMin.toFixed(4)
        if(this.interceptMaxInput) this.interceptMaxInput.value=this.parameters.interceptMax.toFixed(4)
        if(this.heightInput) this.heightInput.value=this.parameters.heightScale
        if(this.mapInput) this.mapInput.value=this.parameters.colormap
        if(this.scatterInput) this.scatterInput.checked=this.parameters.showScatter
        this.startResolve().then(()=>{
            /* The camera is restored AFTER the traces: framing needs the box,
               and the box only exists once there is something in the scene.
               It is BEST-EFFORT: a camera that refuses to restore must not
               take the session import down with it (the rejection would abort
               importSession, leaving every later node uncreated) nor skip the
               children's resolve. */
            try{ this.graph?.restoreState?.(state.plot) }catch(err){
                console.warn(`[${this.title}] camera restore skipped:`,err)
            }
            this.resolveChildren()
        })
    }
    suicide(options={}){
        this.graph?.dispose?.()
        super.suicide(options)
    }
}

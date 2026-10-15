import {Wave,SurfaceTrace,Scatter3DTrace} from "../formats.js"
import {NodeWithRightAccordionGraph} from "./NodeWithRightAccordionGraph.js"
import {Plot3DWebGL} from "../ui/Plot3DWebGL.js"
import {CE,stylize} from "../util.js"
import {wavesFromInput} from "../utils/index.js"

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

   STEP 1 IS A SCAFFOLD: the surface is SYNTHETIC (see `syntheticSurface`).
   The ports, the Wave layout, the grid contract and the view are real; only
   the accumulation is a placeholder, and only `syntheticSurface()` has to be
   replaced when the Rust kernel lands.

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

/* --- Synthetic stand-in for the accumulator -----------------------------
   A Hough surface is a set of ridges along the lines the pairs of peaks
   agree on, over a noise floor. This reproduces that topology — a floor,
   four ridges of different width, amplitude and tilt, and a shallow bowl so
   the floor is not a perfectly flat plane — so the mesh, the colormap and
   the height mapping can be judged on something with the right SHAPE before
   any real data exists.

   Deterministic on purpose: (u,v) -> value, no random state, so the same
   parameters always give the same picture. */
const SYNTHETIC_RIDGES=[
    //amplitude, half-width, tilt of the ridge in the (u,v) plane, offset
    {amplitude:1.00, width:0.035, tilt: 0.10, offset:-0.45},
    {amplitude:0.62, width:0.055, tilt:-0.55, offset: 0.30},
    {amplitude:0.38, width:0.090, tilt: 0.00, offset: 0.05},
    {amplitude:0.22, width:0.030, tilt: 1.20, offset: 0.70}
]

function syntheticSurface(u,v){
    let value=0.015
    for(const ridge of SYNTHETIC_RIDGES){
        //distance from the point to the ridge line, in grid units
        const d=(v-ridge.offset-ridge.tilt*u)/Math.sqrt(1+ridge.tilt*ridge.tilt)
        value+=ridge.amplitude*Math.exp(-0.5*(d/ridge.width)**2)
    }
    value+=0.04*(u*u+v*v)
    return value
}

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
        this.surface=null
        this.collectedWaves=[]
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
    createGraph(dialog,label){
        const plot=new Plot3DWebGL([],`${label} surface`,this.origin,dialog.DOMelt.content)
        plot.axisLabels={x:"slope",y:"intercept",z:"intensity"}
        return plot
    }
    registered(e){
        if(e.detail.msg.caster!==this||this.accordion){
            return
        }
        super.registered(e)
        this.setupUI()
        //no kernel yet, so the synthetic surface is what a resolve produces:
        //running it here means the view is never an empty grey box
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
        this.gridXInput=numberField("grid x","gridX",8,256)
        this.gridYInput=numberField("grid y","gridY",8,256)
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
        const hint=CE("div",{style:{"grid-column":"1 / -1",opacity:"0.7"}},["drag: orbit · shift+drag: pan · wheel: zoom · double-click: reframe"])
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
            `inputs accumulated: ${this.collectedWaves.length}`
        ]
        if(this.skippedInputs){
            lines.push(`${this.skippedInputs} entrée(s) ignorée(s): pas une wave XY`)
        }
        this.readout.textContent=lines.join("\n")
    }

    /* --- resolve ------------------------------------------------------ */
    async startResolve(){
        this.collectInputWaves()
        this.buildSurface()
        this.outputs[0]=[this.surfaceWave]
        this.setStatus("resolved")
        this.applyTraces()
        this.renderReadout()
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
       [-1,1], z whatever the accumulator produced. This is the shape the Rust
       kernel will return too. Built through the canonical `index()` helper so
       the Wave owns the layout and the geometry is derived from it, never the
       other way round. */
    buildSurface(){
        const nx=Math.max(2,Math.trunc(this.parameters.gridX)||64)
        const ny=Math.max(2,Math.trunc(this.parameters.gridY)||48)
        const wave=new Wave(nx,ny,3)
        wave.labels=Wave.normalizeLabels(["slope","intercept","intensity"])
        let zMin=Infinity
        let zMax=-Infinity
        for(let iy=0;iy<ny;iy++){
            const v=(iy/(ny-1))*2-1
            for(let ix=0;ix<nx;ix++){
                const u=(ix/(nx-1))*2-1
                const z=syntheticSurface(u,v)
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
            source:"synthetic (step 1 scaffold)",
            collected:this.collectedWaves.length
        }
        wave.touch()
        this.surface={nx,ny,wave,zMin,zMax}
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
            plot:this.graph?.serializeState?.()??null
        }
    }
    restoreState(state){
        if(!state) return
        for(const key of ["gridX","gridY","heightScale"]){
            if(Number.isFinite(state[key])) this.parameters[key]=state[key]
        }
        if(typeof state.colormap==="string") this.parameters.colormap=state.colormap
        if(typeof state.showScatter==="boolean") this.parameters.showScatter=state.showScatter
        if(this.gridXInput) this.gridXInput.value=this.parameters.gridX
        if(this.gridYInput) this.gridYInput.value=this.parameters.gridY
        if(this.heightInput) this.heightInput.value=this.parameters.heightScale
        if(this.mapInput) this.mapInput.value=this.parameters.colormap
        if(this.scatterInput) this.scatterInput.checked=this.parameters.showScatter
        this.startResolve().then(()=>{
            //the camera is restored AFTER the traces: framing needs the box,
            //and the box only exists once there is something in the scene
            this.graph?.restoreState?.(state.plot)
            this.resolveChildren()
        })
    }
    suicide(options={}){
        this.graph?.dispose?.()
        super.suicide(options)
    }
}

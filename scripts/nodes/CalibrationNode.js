import {NodeWithAccordion} from "../core/index.js"
import {Plot2DWebGL} from "../ui/Plot2DWebGL.js"
import {Plot3DWebGL} from "../ui/Plot3DWebGL.js"
import {Wave,XYTrace,SurfaceTrace,Scatter3DTrace} from "../formats.js"
import {computePool} from "../workerPool.js"
import {CE,stylize} from "../util.js"
import {wavesFromInput} from "../utils/index.js"
import {matchingTracePoints,pointCoordinates,traceSourceInfo} from "../utils/plotPointSync.js"

export class CalibrationNode extends NodeWithAccordion{
    constructor(title,origin,destinationFlow,position={x:180,y:10}){
        super(
            title,
            [[],[]],
            [[]],
            origin,
            destinationFlow,
            position
        )
        this.status="floating"
        this.parameters.calibrationMode="cubic"
        this.parameters.calibrationCoeffs=null
        this.parameters.useCollectionErrors=true
        this.parameters.show3DSurface=false
        this.lastInputWaves={formulas:null,xy:null}
        this.calibrationResult=null
        this.resolveRun=0
        this.multiplexCount=0
        this.skippedInputs=0
        this.multiplexTotals=null
        this.graphContainer=null
        this.surfaceBuilt=false
        this.surfacePlot=null
        this.surfaceHost=null
        this.events.broadcast.pinSync=this.createPinSyncEvent.bind(this)
        this.events.broadcast.hoverSync=this.createHoverSyncEvent.bind(this)
        this.events.listen.pinSync=this.handlePinSync.bind(this)
        this.events.listen.hoverSync=this.handleHoverSync.bind(this)
        this.events.listen.massCalcTraceSync=this.handleMassCalcTraceSync.bind(this)

        const inputAnchors=this.DOMelt.querySelectorAll('.input.anchor')
        if(inputAnchors[0]) inputAnchors[0].innerHTML='<title>Input 0: FormulaCollection(s) — reference formulas with errorPpm from attribution</title>'
        if(inputAnchors[1]) inputAnchors[1].innerHTML='<title>Input 1: XY Wave(s) — spectra to calibrate</title>'
        const outputAnchors=this.DOMelt.querySelectorAll('.output.anchor')
        if(outputAnchors[0]) outputAnchors[0].innerHTML='<title>Output: calibrated XY Wave(s)</title>'
    }
    createPinSyncEvent(info){
        return new CustomEvent("pinSync",{detail:{msg:info,emitter:this}})
    }
    createHoverSyncEvent(info){
        return new CustomEvent("hoverSync",{detail:{msg:info,emitter:this}})
    }
    handlePinSync(e){
        if(e.detail.emitter===this) return
        this.applyPinSync(e.detail.msg)
    }
    handleHoverSync(e){
        if(e.detail.emitter===this) return
        this.applyHoverSync(e.detail.msg)
    }
    onGraphPinChange(info){
        const trace=this.graph?.traces.find(t=>t.id===info.traceId)
        const sourceInfo=traceSourceInfo(trace,info.tracePoint)
        const syncInfo={
            ...info,
            traceTitle:trace?.title??info.traceTitle,
            ...sourceInfo,
            pointSelected:true
        }
        dispatchEvent(this.events.broadcast.pinSync(syncInfo))
    }
    onGraphHoverChange(info){
        const trace=this.graph?.traces.find(t=>t.id===info?.traceId)
        if(!trace) return
        const sourceInfo=traceSourceInfo(trace,info.tracePoint)
        const syncInfo={
            traceId:info.traceId,
            tracePoint:info.tracePoint,
            traceTitle:trace?.title,
            x:info.x,
            y:info.y,
            px:info.px,
            py:info.py,
            ...sourceInfo
        }
        dispatchEvent(this.events.broadcast.hoverSync(syncInfo))
    }
    applyHoverSync(info){
        if(!this.graph) return
        if(info===null){
            this.graph.hidePickHover?.()
            return
        }
        const matches=matchingTracePoints(this.graph.traces,info)
        if(!matches.length) return
        const {trace,pointIndex}=matches[0]
        const {x,y}=pointCoordinates(this.graph,trace,pointIndex,info.x,info.y)
        this.graph.showPickHover?.({trace,tracePoint:pointIndex,x,y})
    }
    applyPinSync(info){
        if(!this.graph) return
        for(const {trace,pointIndex} of matchingTracePoints(this.graph.traces,info)){
            const pin=this.graph.pickPins.find(item=>item.traceId===trace.id&&item.tracePoint===pointIndex)
            if(info.added){
                if(!pin) this.graph.addPickPin({trace,tracePoint:pointIndex,x:info.x,y:info.y,px:0,py:0})
            }else if(pin){
                this.graph.removePickPin(pin)
            }
        }
    }
    handleMassCalcTraceSync(e){
        if(e.detail.emitter===this) return
        this.applyMassCalcTrace(e.detail.msg)
    }
    applyMassCalcTrace(info){
        if(!this.graph || !info.trace) return
        //Reconstruct wave from canonical core layout [x0..xN, y0..yN]
        const traceData=info.trace
        const core=traceData.wave.core
        const count=traceData.wave.dims[0]
        const x=new Float64Array(count)
        const y=new Float64Array(count)
        for(let i=0;i<count;i++){
            x[i]=core[i]
            y[i]=core[i+count]
        }
        const wave=Wave.fromCoordinates(x,y,traceData.wave.metadata,traceData.wave.labels)
        const trace=new XYTrace({
            id:traceData.id,
            title:traceData.title,
            wave,
            options:traceData.options
        })
        this.graph.traces=this.graph.traces.filter(t=>!t.id.startsWith("masscalc:"))
        this.graph.traces.push(trace)
        this.graph.drawGraph()
    }

    registered(e){
        if(e.detail.msg.caster !== this || this.accordion){
            return
        }
        super.registered(e)
        this.setupAccordionUI()
    }

    /* DEUX FORMES ACCUEILLIES, ET LA SECONDE EST CELLE QUI CIRCULE.

       FormulaCollectionNode ne publie plus des instances de `FormulaCollection`
       depuis le commit de clustering (fec4697): `publishOutput()` pousse un
       littéral `{name, formulas}`, où chaque formule est un objet PLAT
       (key, notation, mz, mass, charge, molecule, errorPpm, intensity, note,
       targets[]). Ce n'est donc plus `instanceof FormulaCollection`, ni même
       `constructor.name === "FormulaCollection"` — un littéral a toujours
       `constructor.name === "Object"`.

       Ce test échouait donc en silence: `collections` restait vide, et
       startResolve() partait sur son chemin « pas de collection » en
       laissant le nœud floating, sans lever ni logger quoi que ce soit. C'est
       la rupture qui a cassé Calibration, et elle est dans les DONNÉES, pas
       dans ce nœud.

       `acceptsCollection` distingue les deux formes par ce qu'elles ont, pas
       par leur classe: une instance a `entries`, un littéral a `formulas`. */
    acceptsCollection(value){
        if(!value||typeof value!=="object") return false
        if(Array.isArray(value.entries)) return true
        return Array.isArray(value.formulas)
    }
    /* Ce que ce nœud consomme d'UNE formule, quelle que soit sa forme.

       Une entrée d'instance porte un `formula` (le m/z VRAI) et un `target`
       (le m/z mesuré, déjà choisi par `nearestTarget`). La forme plate porte
       `mz` et `targets[]`, et aucun des deux: la cible la plus proche est donc
       choisie ICI, car la publication plate a déjà jeté la valeur unique par
       colonne que `match()` calculait.

       `entry.errorPpm` de la forme plate EST déjà cette erreur de cible la
       plus proche : elle est donc préférée au recalcul, et le recalcul ne sert
       que d'entrée de secours pour une entrée dont l'erreur n'a jamais été
       remplie. */
    referenceOf(value){
        //une entrée d'instance: elle porte déjà les deux côtés
        if(value.formula){
            return {trueMz:value.formula.mz,measuredMz:value.target?.mz,
                intensity:value.target?.intensity,errorPpm:value.errorPpm}
        }
        const target=(value.targets??[]).reduce((best,current)=>{
            if(!Number.isFinite(current?.mz)) return best
            if(!best) return current
            const distance=Math.abs(current.mz-value.mz)
            return distance<Math.abs(best.mz-value.mz)?current:best
        },null)
        return {
            trueMz:value.mz,
            measuredMz:target?.mz,
            intensity:target?.intensity,
            errorPpm:Number.isFinite(value.errorPpm)?value.errorPpm:target?.errorPpm
        }
    }
    collectFormulaCollections(){
        const collections=[]
        if(this.inputs[0] instanceof Map){
            for(const values of this.inputs[0].values()){
                for(const linkOutputs of values instanceof Array?values:[values]){
                    for(const value of linkOutputs instanceof Array?linkOutputs:[linkOutputs]){
                        if(this.acceptsCollection(value)){
                            collections.push(value)
}

                    }
                }
            }
        }
        return collections
    }

    collectInputWaves(){
        const {waves,skipped}=wavesFromInput(this.inputs[1])
        return {waves,skipped}
    }

    isMultiplexed(){
        return this.multiplexCount>1
    }

    setupAccordionUI(){
        if(!this.accordion) return
        const content=this.accordion.DOMelt.content
        content.replaceChildren()
        stylize(content,{
            display:"grid",
            /* FIVE rows for FOUR children, on purpose. `auto auto` are the mode
               and display sections, `minmax(0, 1fr)` is the graph, and the last
               `auto` is the row BOTH graph containers share: the 2D box and the
               3D box are siblings that alternate on display:none, so exactly
               one of them is ever laid out. An unnamed auto row would place the
               3D box into the 1fr row, and the two graphs would fight over the
               same space — one of them collapsing to nothing. */
            "grid-template-rows":"auto auto minmax(0, 1fr) auto",
            minHeight:"0",
            height:"100%",
            overflow:"hidden",
            padding:"4px",
            gap:"4px"
        })
        this.accordion.setSizingMode("viewport",{height:460})
        this.accordion.DOMelt.container.style.maxHeight="75%"

        const modeSection=CE("div",{className:"cal-section"},[])
        modeSection.append(CE("div",{className:"cal-caption"},["Calibration"]))

        this.modeSelect=CE("select",{
            title:"Calibration surface type (2D: m/z × intensity)",
            style:{width:"100%",padding:"2px",fontSize:"0.85em"}
        },[])
        for(const [key,label] of [
            ["linear2d","Linear 2D: a·m + b·w + c  (m=m/z, w=intensity)"],
            ["quadratic2d","Quadratic 2D: a·m² + b·w² + c·m·w + d·m + e·w + f"],
            ["cubic2d","Cubic 2D: full 3rd order (10 coeffs)"],
            ["linear","Linear 1D (legacy): a·x + b"],
            ["quadratic","Quadratic 1D (legacy): a·x² + b·x + c"],
            ["cubic","Cubic 1D (legacy): a·x³ + b·x² + c·x + d"]
        ]){
            this.modeSelect.append(new Option(label,key))
        }
        this.modeSelect.value=this.parameters.calibrationMode
        this.modeSelect.addEventListener("change",()=>{
            this.parameters.calibrationMode=this.modeSelect.value
            const is2D=this.parameters.calibrationMode.endsWith("2d")
            if(this.show3DSurfaceCheckbox) this.show3DSurfaceCheckbox.wrap.style.display=is2D?"flex":"none"
            if(!is2D) this.parameters.show3DSurface=false
            this.startResolve()
        })
        modeSection.append(this.modeSelect)

        const optionRow=CE("div",{
            style:{display:"flex",gap:"8px",flexWrap:"wrap",fontSize:"0.85em",marginTop:"4px"}
        },[])
        this.useCollectionErrorsCheckbox=this.makeCheckbox("useCollectionErrors","Use collection errorPpm",this.parameters.useCollectionErrors)
        this.recomputeBtn=CE("button",{
            type:"button",
            title:"Recompute reference points by nearest-neighbor matching (ignores collection errors)",
            style:{cursor:"pointer",padding:"2px 6px",fontSize:"0.85em"}
        },["Recompute refs"])
        this.recomputeBtn.addEventListener("click",()=>this.startResolve())
        optionRow.append(this.useCollectionErrorsCheckbox.wrap,this.recomputeBtn)
        modeSection.append(optionRow)

        const infoRow=CE("div",{
            className:"cal-row",
            style:{display:"grid",gridTemplateColumns:"minmax(0,1fr) auto auto",fontSize:"0.85em",gap:"4px"}
        },[])
        this.coeffLabel=CE("span",{className:"cal-readout",title:"Fitted calibration coefficients (m=m/z, w=intensity)"},["—"])
        this.rmseLabel=CE("span",{className:"cal-readout",title:"Root mean square error of fit (ppm)"},[""])
        this.pointsLabel=CE("span",{className:"cal-readout",title:"Number of reference points used"},[""])
        infoRow.append(this.coeffLabel,this.rmseLabel,this.pointsLabel)
        modeSection.append(infoRow)

        const displaySection=CE("div",{className:"cal-section"},[])
        displaySection.append(CE("div",{className:"cal-caption"},["Display"]))
        const displayRow=CE("div",{
            style:{display:"flex",gap:"8px",flexWrap:"wrap",fontSize:"0.85em"}
        },[])
        this.show3DSurfaceCheckbox=this.makeCheckbox("show3DSurface","3D",false)
        this.show3DSurfaceCheckbox.wrap.style.display="none"
        displayRow.append(this.show3DSurfaceCheckbox.wrap)
        displaySection.append(displayRow)

        this.graphContainer=CE("div",{
            className:"calibration-graph-container",
            style:{position:"relative",width:"100%",height:"100%",minHeight:"200px",overflow:"hidden"}
        },[])
        /* The 3D view: a SIBLING of the 2D one, in its own container, not a
           mode of the same plot. They show different things — measured points
           with residuals, against a sampled error field — and they need
           different containers, different plots and different teardown. The
           plot itself is built LAZILY in update3DSurface(), so this box only
           declares where it will go. */
        this.surfaceHost=CE("div",{
            className:"calibration-graph-container",
            style:{
                position:"relative",
                width:"100%",
                height:"100%",
                minHeight:"200px",
                overflow:"hidden",
                display:"none"
            }
        },[])

        content.append(modeSection,displaySection,this.graphContainer,this.surfaceHost)

        this.graph=new Plot2DWebGL([],`${this.title} graph`,this.origin,this.graphContainer,{onPinChange:this.onGraphPinChange.bind(this),onHoverChange:this.onGraphHoverChange.bind(this)})
        this.graph.parameters.axis.bottom.label="m/z"
        this.graph.parameters.axis.bottom.autoLabel=false
        this.graph.parameters.axis.left.label="Error (ppm)"
        this.graph.parameters.axis.left.autoLabel=false
        this.graph.parameters.axis.left.scale="linear"
        this.graph.parameters.axis.bottom.scale="linear"
        this.surfaceBuilt=false

        const origDrawGraph=this.graph.drawGraph.bind(this.graph)
        this.graph.drawGraph=()=>{
            origDrawGraph()
            this.drawCalibrationOverlay()
        }
        this.updateCalibrationPlot()
        this.graph.drawGraph()
    }

    makeCheckbox(param,label,checked){
        const wrap=CE("label",{
            style:{display:"flex",alignItems:"center",gap:"4px",cursor:"pointer"}
        },[])
        const input=CE("input",{
            type:"checkbox",
            checked,
            style:{width:"16px",height:"16px",cursor:"pointer"}
        },[])
        input.addEventListener("change",()=>{
            this.parameters[param]=input.checked
            //the checkbox may drive either plot, so BOTH are asked rather than
            //the one this listener happened to be built for
            this.graph?.drawGraph()
            if(param==="show3DSurface"){
                this.update3DSurface()
            }
        })
        wrap.append(input,CE("span",{},label))
        return {wrap,input}
    }

    async startResolve(){
        const links=(this.destination?.linkList??[]).filter(link=>link.outputNode===this)
        if(links.some(link=>link.inputAnchor.id!=="0" && link.inputAnchor.id!=="1")){
            this.fail("only inputs 0 and 1 are read by this node")
            return
        }

        const formulaCollections=this.collectFormulaCollections()
        const {waves,skipped}=this.collectInputWaves()

        this.skippedInputs=skipped
        this.multiplexCount=waves.length
        this.updateMultiplexUI()

        if(!formulaCollections.length || !waves.length){
            this.status="floating"
            this.outputs[0]=[]
            this.lastInputWaves={formulas:null,xy:null}
            this.calibrationResult=null
            this.updateUI()
            return
        }

        if(waves.length===1){
            this.multiplexTotals=null
            await this.resolveOneInput(formulaCollections[0],waves[0])
        }else{
            await this.resolveMultiplexed(formulaCollections,waves)
        }
    }

    async resolveOneInput(formulaCollection,xyWave){
        this.status="pending"
        this.lastInputWaves={formulas:formulaCollection,xy:xyWave}

        try{
            const calibration=await this.computeCalibration(formulaCollection,xyWave)
            this.calibrationResult=calibration
            this.status="resolved"
            await this.applyCalibration(xyWave,calibration)
            this.updateUI()
        }catch(err){
            this.fail(`calibration failed: ${err?.message??String(err)}`)
        }
    }

    async computeCalibration(formulaCollection,xyWave){
        const stride=xyWave.degree===2&&xyWave.dims[1]===2?2:1
        const half=Math.floor(xyWave.size/2)
        const x=new Float64Array(half)
        const y=new Float64Array(half)
        if(xyWave.core.length>=xyWave.size){
            for(let i=0;i<half;i++) x[i]=xyWave.core[i]
            for(let i=0;i<half;i++) y[i]=xyWave.core[i+half]
        }

        const refPoints=this.extractReferencePoints(formulaCollection,x,y)
        if(refPoints.length<3){
            throw new Error("Need at least 3 reference points for 2D calibration")
        }

        const is2D=this.parameters.calibrationMode.endsWith("2d")
        const kernelMode=is2D?this.parameters.calibrationMode:this.parameters.calibrationMode

        let result
        if(is2D){
            result=await computePool.run("calibrationFit2D",{
                measuredMz:refPoints.map(p=>p.measuredMz),
                intensity:refPoints.map(p=>p.intensity),
                errorPpm:refPoints.map(p=>p.errorPpm),
                mode:kernelMode
            })
        }else{
            result=await computePool.run("calibrationFit",{
                refX:refPoints.map(p=>p.measuredMz),
                refY:refPoints.map(p=>p.trueMz),
                mode:kernelMode
            })
        }

        return {
            coeffs:result.coeffs,
            rmse:result.rmse,
            refPoints,
            mode:this.parameters.calibrationMode,
            is2D
        }
    }

    extractReferencePoints(formulaCollection,x,y){
        const points=[]
        if(!formulaCollection) return points
        /* BOTH SHAPES AGAIN. An instance exposes `entries`, the flat published
           form exposes `formulas`; before the clustering change only the first
           existed, and this loop simply found nothing in the second — the same
           silent-failure mode as collectFormulaCollections(). */
        const rows=Array.isArray(formulaCollection.entries)
            ?formulaCollection.entries
            :(formulaCollection.formulas??[])

        if(this.parameters.useCollectionErrors){
            for(const row of rows){
                const {trueMz,measuredMz,intensity,errorPpm}=this.referenceOf(row)
                if(!Number.isFinite(trueMz)) continue
                if(!Number.isFinite(errorPpm)) continue
                if(!Number.isFinite(measuredMz)) continue
                if(!Number.isFinite(intensity)) continue
                points.push({trueMz,measuredMz,intensity,errorPpm})
            }
        }else{
            for(const row of rows){
                const {trueMz}=this.referenceOf(row)
                if(!Number.isFinite(trueMz)) continue
                const targetMz=trueMz
                let bestIdx=-1
                let bestDist=Infinity
                for(let i=0;i<x.length;i++){
                    const dist=Math.abs(x[i]-targetMz)
                    if(dist<bestDist){
                        bestDist=dist
                        bestIdx=i
                    }
                }
                if(bestIdx>=0 && bestDist<0.5){
                    const measuredMz=x[bestIdx]
                    const intensity=y[bestIdx]
                    const errorPpm=(measuredMz-targetMz)/targetMz*1e6
                    points.push({trueMz:targetMz,measuredMz,intensity,errorPpm})
                }
            }
        }
        return points
    }

    async applyCalibration(xyWave,calibration){
        const stride=xyWave.degree===2&&xyWave.dims[1]===2?2:1
        const half=Math.floor(xyWave.size/2)
        const x=new Float64Array(half)
        const y=new Float64Array(half)
        if(xyWave.core.length>=xyWave.size){
            for(let i=0;i<half;i++) x[i]=xyWave.core[i]
            for(let i=0;i<half;i++) y[i]=xyWave.core[i+half]
        }

        let result
        if(calibration.is2D){
            result=await computePool.run("calibrationApply2D",{
                x:Array.from(x),
                y:Array.from(y),
                coeffs:calibration.coeffs,
                mode:calibration.mode
            })
        }else{
            result=await computePool.run("calibrationApply",{
                x:Array.from(x),
                coeffs:calibration.coeffs,
                mode:calibration.mode
            })
        }

        const correctedX=new Float64Array(result.x)
        const n=Math.min(correctedX.length,y.length)
        const sourcePointIndices=Array.isArray(xyWave.metadata?.sourcePointIndices)
            ?xyWave.metadata.sourcePointIndices.slice(0,n)
            :Array.from({length:n},(_,index)=>index)
        this.outputs[0]=[Wave.fromCoordinates(new Float64Array(correctedX.subarray(0,n)),new Float64Array(y.subarray(0,n)),{
            title:`${this.title} (calibrated)`,
            sourceWave:xyWave.metadata?.sourceWave??xyWave.metadata?.title,
            sourceWaveId:xyWave.metadata?.sourceWaveId,
            sourcePointIndices,
            mode:calibration.mode,
            coeffs:calibration.coeffs,
            rmse:calibration.rmse
        },["x","y"])]
    }

    async resolveMultiplexed(formulaCollections,waves){
        const run=++this.resolveRun
        this.status="pending"
        const products=[]
        const errors=[]
        let totalRefPoints=0
        let firstCalibration=null

        for(let i=0;i<waves.length;i++){
            if(run!==this.resolveRun) return
            if(i>0) await new Promise(resolve=>setTimeout(resolve,0))
            if(run!==this.resolveRun) return

            const formulaCollection=formulaCollections[i%formulaCollections.length]
            const wave=waves[i]
            const label=wave.metadata?.title??`input ${i+1}`

            try{
                const calibration=await this.computeCalibration(formulaCollection,wave)
                const corrected=await this.applyCalibrationToWave(wave,calibration)
                if(corrected) products.push(corrected)
                totalRefPoints+=calibration.refPoints.length
                if(!firstCalibration) firstCalibration=calibration
            }catch(err){
                errors.push(`${label}: ${err?.message??String(err)}`)
            }
        }

        if(run!==this.resolveRun) return
        this.outputs[0]=products
        this.multiplexTotals={inputs:waves.length,totalRefPoints,errors}
        if(firstCalibration) this.calibrationResult=firstCalibration
        this.status=errors.length&&!products.length?"error":"resolved"
        if(errors.length) console.error("[CalibrationNode] some inputs failed:",errors)
        this.updateUI()
    }

    async applyCalibrationToWave(xyWave,calibration){
        const stride=xyWave.degree===2&&xyWave.dims[1]===2?2:1
        const half=Math.floor(xyWave.size/2)
        const x=new Float64Array(half)
        const y=new Float64Array(half)
        if(xyWave.core.length>=xyWave.size){
            for(let i=0;i<half;i++) x[i]=xyWave.core[i]
            for(let i=0;i<half;i++) y[i]=xyWave.core[i+half]
        }

        let result
        if(calibration.is2D){
            result=await computePool.run("calibrationApply2D",{
                x:Array.from(x),
                y:Array.from(y),
                coeffs:calibration.coeffs,
                mode:calibration.mode
            })
        }else{
            result=await computePool.run("calibrationApply",{
                x:Array.from(x),
                coeffs:calibration.coeffs,
                mode:calibration.mode
            })
        }

        const correctedX=new Float64Array(result.x)
        const n=Math.min(correctedX.length,y.length)
        const sourcePointIndices=Array.isArray(xyWave.metadata?.sourcePointIndices)
            ?xyWave.metadata.sourcePointIndices.slice(0,n)
            :Array.from({length:n},(_,index)=>index)
        return Wave.fromCoordinates(new Float64Array(correctedX.subarray(0,n)),new Float64Array(y.subarray(0,n)),{
            title:`${this.title} (calibrated)`,
            sourceWave:xyWave.metadata?.sourceWave??xyWave.metadata?.title,
            sourceWaveId:xyWave.metadata?.sourceWaveId,
            sourcePointIndices,
            mode:calibration.mode,
            coeffs:calibration.coeffs,
            rmse:calibration.rmse,
            source:xyWave.metadata?.title
        },["x","y"])
    }

    updateMultiplexUI(){
        const on=this.isMultiplexed()
        if(this.modeSelect) this.modeSelect.disabled=on
        if(this.recomputeBtn) this.recomputeBtn.disabled=on
    }

    buildCalibrationTraces(){
        if(!this.calibrationResult) return []
        const c=this.calibrationResult
        const refPoints=c.refPoints
        if(!refPoints || !refPoints.length) return []

        const traces=[]

        const refX=refPoints.map(p=>p.measuredMz)
        const refY=refPoints.map(p=>p.errorPpm)
        const refWave=Wave.fromCoordinates(new Float64Array(refX),new Float64Array(refY),{title:"Reference points"},["m/z","Error (ppm)"])
        traces.push(new XYTrace({
            id:"ref-points",
            title:"Reference points",
            wave:refWave,
            options:{color:"rgba(255,255,255,0.25)",mode:"points",marker:{shape:"circle",size:5},line:{size:0}}
        }))

        if(c.coeffs && c.coeffs.length){
            const mzMin=Math.min(...refPoints.map(p=>p.measuredMz))
            const mzMax=Math.max(...refPoints.map(p=>p.measuredMz))
            const n=200
            const fitX=new Float64Array(n)
            const fitY=new Float64Array(n)
            for(let i=0;i<n;i++){
                const mz=mzMin+(mzMax-mzMin)*i/(n-1)
                fitX[i]=mz
                let intensity=1
                if(c.is2D && refPoints.length>0){
                    intensity=refPoints[0].intensity
                }
                let errorPpm=0
                if(c.is2D){
                    errorPpm=this.evalErrorSurface(mz,intensity)
                }else{
                    const corrected=this.applyCoeffsToArray([mz],c.coeffs,c.mode)[0]
                    errorPpm=(mz-corrected)/corrected*1e6
                }
                fitY[i]=errorPpm
            }
            const fitWave=Wave.fromCoordinates(fitX,fitY,{title:"Fitted curve"},["m/z","Error (ppm)"])
            traces.push(new XYTrace({
                id:"fit-curve",
                title:"Fitted curve",
                wave:fitWave,
                options:{color:"#2ecc71",mode:"lines-between-points",line:{size:2}}
            }))
        }

        const resX=refPoints.map(p=>p.measuredMz)
        const resY=refPoints.map(p=>{
            let corrected
            if(c.is2D){
                corrected=this.applyCoeffs2DToArrays([p.measuredMz],[p.intensity],c.coeffs,c.mode)[0]
            }else{
                corrected=this.applyCoeffsToArray([p.measuredMz],c.coeffs,c.mode)[0]
            }
            return (corrected-p.trueMz)/p.trueMz*1e6
        })
        const resWave=Wave.fromCoordinates(new Float64Array(resX),new Float64Array(resY),{title:"Residuals"},["m/z","Residual (ppm)"])
        traces.push(new XYTrace({
            id:"residuals",
            title:"Residuals",
            wave:resWave,
            options:{color:"#f39c12",mode:"points",marker:{shape:"cross",size:6},line:{size:0}}
        }))

        return traces
    }

    updateCalibrationPlot(){
        const traces=this.buildCalibrationTraces()
        if(traces.length){
            this.graph.setTraces(traces)
        }
    }

    /* -----------------------------------------------------------------
       The 3D error surface.

       WHAT THIS WAS: about 150 lines of hand-rolled mesh and camera-swapping
       inside the node, and none of it had ever run. It called `errorColor()`
       and `add3DAxes()`, neither of which exists anywhere in the repository,
       and it read `this.graph.glLayer` while this class extends
       NodeWithAccordion — whose `graph` is a Plot2DWebGL created in the
       INSPECTOR, not in a dialog. The first missing function threw, behind a
       reachability guard that silently returned before reaching it. So the
       checkbox did nothing, and nothing said why.

       WHAT IT IS: a Plot3DWebGL of its own, in its own container, switched by
       the same checkbox. Three lessons are baked into that:

         • the 3D view is a TRACE TYPE on a real plot, not a set of private
           meshes a node pokes into somebody else's scene;
         • `errorColor` became the plot's `colormap`, which is where a colormap
           belongs — it is a rendering choice, and it now works for the Hough
           surface and every future surface for free;
         • no camera is swapped and no loop is started here. OrbitPanControls
           and the render-on-demand loop belong to the plot, which is why this
           node has nothing to restore on teardown but one `dispose()`.

       The plot is built LAZILY and only once. A WebGL context is a
       browser-wide resource capped at 16 in Chrome, past which the browser
       drops the OLDEST LIVE one — belonging to a plot the user is still
       looking at. Three of the six calibration modes (linear/quadratic/cubic
       1D) have no (m/z, intensity) surface to show, so building this for them
       would spend a context on a permanently hidden, permanently empty plot.

       Unchecking empties it but KEEPS it: ticking and unticking is a gesture
       the user does by reflex, and rebuilding a context each time would make
       it stutter. The context is released in suicide(), the only moment the
       node is certain never to be asked again.
       ----------------------------------------------------------------- */
    update3DSurface(){
        const wanted=!!this.parameters.show3DSurface&&!!this.calibrationResult?.is2D
        /* BOTH BOXES TOGGLE, and that is the correction. They are two grid
           rows: the 2D one holds `1fr`, the 3D one an `auto` line below it.
           Showing the 3D alone left the 2D on screen at full height and crushed
           the 3D into the leftover strip — which is not "the 3D is missing" but
           "the 3D is one axis label wide". A pair of views that alternate must
           alternate BOTH sides of the swap, not just the one being opened. */
        if(this.surfaceHost) this.surfaceHost.style.display=wanted?"block":"none"
        if(this.graphContainer) this.graphContainer.style.display=wanted?"none":"block"
        if(!wanted){
            this.surfacePlot?.setTraces([])
            return
        }
        if(!this.surfaceBuilt){
            this.surfaceBuilt=true
            this.surfacePlot=new Plot3DWebGL([],`${this.title} surface`,this.origin,this.surfaceHost)
            this.surfacePlot.axisLabels={x:"m/z",y:"intensity",z:"error (ppm)"}
        }
        if(!this.surfacePlot) return
        const wave=this.buildErrorSurfaceWave()
        if(!wave) return
        const traces=[
            new SurfaceTrace({
                id:"error-surface",
                title:"Error surface",
                wave,
                options:{
                    colormap:"coolwarm",
                    height:0.5,
                    //anchored to the data, so two calibrations are comparable by
                    //eye; errorSurfaceRange() supplies the floor
                    heightRange:this.errorSurfaceRange(wave)
                }
            })
        ]
        /* The REFERENCE POINTS, in the same space as the surface, which is the
           only way to read a fit in 3D: a surface on its own says nothing about
           whether it passes through the data that produced it. Drawn at
           (measured m/z, intensity, measured error), they sit on the surface
           exactly when the calibration is right — and a residual cloud floating
           above or under the sheet is the shape of a bad fit, visible at a
           glance and impossible to see in the 2D residual trace alone. */
        const points=this.buildReferencePointWave()
        if(points){
            traces.push(new Scatter3DTrace({
                id:"reference-points",
                title:"Reference points",
                wave:points,
                options:{size:4,color:"#ffffff",opacity:0.95}
            }))
        }
        this.surfacePlot.setTraces(traces)
    }
    /* The reference points as a degenerate grid — one row — because that is the
       carrier Plot3DWebGL already knows. Each point's z is its MEASURED error,
       which is what the surface predicts, so the two are directly comparable.

       A point with a non-finite coordinate is DROPPED rather than written as
       zero: a (0, 0, 0) at the corner of a plot whose axes start at 100 m/z is a
       spike pointing at nothing, and it would be read as a measurement. */
    buildReferencePointWave(){
        const refs=this.calibrationResult?.refPoints
        if(!refs||!refs.length) return null
        const usable=refs.filter(p=>Number.isFinite(p?.measuredMz)
            &&Number.isFinite(p?.intensity)
            &&Number.isFinite(p?.errorPpm))
        if(!usable.length) return null
        const wave=new Wave(usable.length,1,3)
        wave.labels=Wave.normalizeLabels(["m/z","intensity","error (ppm)"])
        for(let ix=0;ix<usable.length;ix++){
            const p=usable[ix]
            wave.core[wave.index(ix,0,0)]=p.measuredMz
            wave.core[wave.index(ix,0,1)]=p.intensity
            wave.core[wave.index(ix,0,2)]=p.errorPpm
        }
        wave.metadata={title:"Calibration reference points",source:"measured",count:usable.length}
        wave.touch()
        return wave
    }
    /* The (m/z, intensity) grid the fitted polynomial is sampled on, in the
       [nx, ny, 3] layout every grid wave in the project uses. The domain is
       the span of the REFERENCE points, padded: sampling exactly to the
       extremes would put the whole surface on the box boundary and the
       interesting middle in a single cell. */
    buildErrorSurfaceWave(nx=40,ny=32){
        const refs=this.calibrationResult?.refPoints
        if(!refs||!refs.length) return null
        let mzMin=Infinity,mzMax=-Infinity
        let inMin=Infinity,inMax=-Infinity
        for(const p of refs){
            if(!Number.isFinite(p?.measuredMz)||!Number.isFinite(p?.intensity)) continue
            if(p.measuredMz<mzMin) mzMin=p.measuredMz
            if(p.measuredMz>mzMax) mzMax=p.measuredMz
            if(p.intensity<inMin) inMin=p.intensity
            if(p.intensity>inMax) inMax=p.intensity
        }
        if(!(Number.isFinite(mzMin)&&Number.isFinite(inMin))) return null
        //a flat axis has zero extent; a zero pad would leave the domain at one
        //value and d3/the box would divide by it
        const padMz=(mzMax-mzMin)*0.08||Math.abs(mzMin)*0.01||1
        const padIn=(inMax-inMin)*0.08||Math.abs(inMin)*0.01||1
        mzMin-=padMz; mzMax+=padMz
        inMin-=padIn; inMax+=padIn
        const wave=new Wave(nx,ny,3)
        wave.labels=Wave.normalizeLabels(["m/z","intensity","error (ppm)"])
        for(let iy=0;iy<ny;iy++){
            const intensity=inMin+(inMax-inMin)*iy/(ny-1)
            for(let ix=0;ix<nx;ix++){
                const mz=mzMin+(mzMax-mzMin)*ix/(nx-1)
                wave.core[wave.index(ix,iy,0)]=mz
                wave.core[wave.index(ix,iy,1)]=intensity
                wave.core[wave.index(ix,iy,2)]=this.evalErrorSurface(mz,intensity)
            }
        }
        wave.metadata={title:"Calibration error surface",source:"fitted polynomial",nx,ny}
        wave.touch()
        this.errorSurfaceDomain={mzMin,mzMax,inMin,inMax}
        return wave
    }
    /* The ppm span of the surface, so the colormap is anchored to the data.
       The floor matters: a perfect fit makes every error equal, and a range of
       zero would divide the whole normalisation by nothing. */
    errorSurfaceRange(wave){
        let lo=Infinity
        let hi=-Infinity
        const [nx,ny]=wave.dims
        for(let iy=0;iy<ny;iy++){
            for(let ix=0;ix<nx;ix++){
                const z=wave.core[wave.index(ix,iy,2)]
                if(!Number.isFinite(z)) continue
                if(z<lo) lo=z
                if(z>hi) hi=z
            }
        }
        if(!Number.isFinite(lo)||!Number.isFinite(hi)) return [0,1]
        if(!(hi>lo)) hi=lo+1
        return [lo,hi]
    }


    updateUI(){
        if(this.calibrationResult){
            const c=this.calibrationResult
            this.coeffLabel.textContent=this.formatCoefficients(c)
            this.rmseLabel.textContent=c.rmse?`RMSE: ${c.rmse.toPrecision(4)} ppm`:""
            this.pointsLabel.textContent=c.refPoints?`${c.refPoints.length} pts`:""
        }else{
            this.coeffLabel.textContent="—"
            this.rmseLabel.textContent=""
            this.pointsLabel.textContent=""
        }

        if(this.isMultiplexed() && this.multiplexTotals){
            this.pointsLabel.textContent=`${this.multiplexCount} entrées · ${this.multiplexTotals.totalRefPoints} pts totaux`
        }

        if(this.useCollectionErrorsCheckbox){
            this.useCollectionErrorsCheckbox.input.checked=this.parameters.useCollectionErrors
        }
        if(this.show3DSurfaceCheckbox){
            this.show3DSurfaceCheckbox.input.checked=this.parameters.show3DSurface
            const is2D=this.parameters.calibrationMode.endsWith("2d")
            this.show3DSurfaceCheckbox.wrap.style.display=is2D?"flex":"none"
        }

        this.updateCalibrationPlot()
        this.update3DSurface()
        this.graph?.drawGraph()
    }

    formatCoefficients(calibration){
        if(!calibration.coeffs || !calibration.coeffs.length) return "—"
        const c=calibration.coeffs
        const mode=calibration.mode
        if(mode==="linear2d"){
            return `m: ${c[0].toPrecision(4)}, w: ${c[1].toPrecision(4)}, d: ${c[2].toPrecision(4)}`
        }else if(mode==="quadratic2d"){
            return `m²: ${c[0].toPrecision(4)}, w²: ${c[1].toPrecision(4)}, m·w: ${c[2].toPrecision(4)}, m: ${c[3].toPrecision(4)}, w: ${c[4].toPrecision(4)}, d: ${c[5].toPrecision(4)}`
        }else if(mode==="cubic2d"){
            return `m³: ${c[0].toPrecision(4)}, m²w: ${c[1].toPrecision(4)}, mw²: ${c[2].toPrecision(4)}, w³: ${c[3].toPrecision(4)}, m²: ${c[4].toPrecision(4)}, mw: ${c[5].toPrecision(4)}, w²: ${c[6].toPrecision(4)}, m: ${c[7].toPrecision(4)}, w: ${c[8].toPrecision(4)}, d: ${c[9].toPrecision(4)}`
        }else if(mode==="linear"){
            return `a: ${c[0].toPrecision(4)}, b: ${c[1].toPrecision(4)}`
        }else if(mode==="quadratic"){
            return `a: ${c[0].toPrecision(4)}, b: ${c[1].toPrecision(4)}, c: ${c[2].toPrecision(4)}`
        }else if(mode==="cubic"){
            return `a: ${c[0].toPrecision(4)}, b: ${c[1].toPrecision(4)}, c: ${c[2].toPrecision(4)}, d: ${c[3].toPrecision(4)}`
        }
        return c.map(v=>v.toPrecision(4)).join(", ")
    }

    drawCalibrationOverlay(){
        const graph=this.graph
        if(!graph?.graphSVG || !this.lastInputWaves.xy) return

        const zone=graph.graphzone
        if(!(zone.width>0&&zone.height>0)) return

        const {xScale,yScale}=graph.plotScales()
        const anchor=graph.graphSVG.select(".anchor")

        let calLayer=anchor.select(".calibration-overlay")
        if(calLayer.empty()) calLayer=anchor.append("g").attr("class","calibration-overlay")
        calLayer.selectAll("*").remove()

        const xyWave=this.lastInputWaves.xy
        const stride=xyWave.degree===2&&xyWave.dims[1]===2?2:1
        const half=Math.floor(xyWave.size/2)
        const x=new Float64Array(half)
        const y=new Float64Array(half)
        if(xyWave.core.length>=xyWave.size){
            for(let i=0;i<half;i++) x[i]=xyWave.core[i]
            for(let i=0;i<half;i++) y[i]=xyWave.core[i+half]
        }

        if(this.parameters.showRaw && x.length){
            const rawTrace=calLayer.selectAll(".raw-trace").data([null])
            rawTrace.join("path")
                .attr("class","raw-trace")
                .attr("stroke","#7f8c8d")
                .attr("stroke-width",1)
                .attr("fill","none")
                .attr("opacity",0.5)
                .attr("d",this.pathFromArrays(x,y,xScale,yScale))
        }

        if(this.calibrationResult && this.parameters.showCorrected){
            let correctedX
            if(this.calibrationResult.is2D){
                correctedX=this.applyCoeffs2DToArrays(x,y,this.calibrationResult.coeffs,this.calibrationResult.mode)
            }else{
                correctedX=this.applyCoeffsToArray(x,this.calibrationResult.coeffs,this.calibrationResult.mode)
            }
            const correctedTrace=calLayer.selectAll(".corrected-trace").data([null])
            correctedTrace.join("path")
                .attr("class","corrected-trace")
                .attr("stroke","#2ecc71")
                .attr("stroke-width",1.5)
                .attr("fill","none")
                .attr("d",this.pathFromArrays(correctedX,y,xScale,yScale))
        }

        if(this.calibrationResult && this.calibrationResult.refPoints.length){
            const residuals=this.calibrationResult.refPoints.map(p=>{
                let corrected
                if(this.calibrationResult.is2D){
                    corrected=this.applyCoeffs2DToArrays([p.measuredMz],[p.intensity],this.calibrationResult.coeffs,this.calibrationResult.mode)[0]
                }else{
                    corrected=this.applyCoeffsToArray([p.measuredMz],this.calibrationResult.coeffs,this.calibrationResult.mode)[0]
                }
                return {x:p.measuredMz,residual:corrected-p.trueMz}
            })

            const resLayer=calLayer.selectAll(".residual").data(residuals)
            resLayer.join("line")
                .attr("class","residual")
                .attr("x1",d=>xScale(d.x))
                .attr("x2",d=>xScale(d.x))
                .attr("y1",d=>yScale(d.residual))
                .attr("y2",d=>yScale(0))
                .attr("stroke","#e74c3c")
                .attr("stroke-width",1)
                .attr("stroke-dasharray","4,2")
        }

        if(this.calibrationResult && this.calibrationResult.is2D){
            this.drawErrorSurface(calLayer,xScale,yScale)
        }
    }

    drawErrorSurface(layer,xScale,yScale){
        if(!this.calibrationResult || !this.calibrationResult.refPoints.length) return

        const refPoints=this.calibrationResult.refPoints
        const mzMin=Math.min(...refPoints.map(p=>p.measuredMz))
        const mzMax=Math.max(...refPoints.map(p=>p.measuredMz))
        const intMin=Math.min(...refPoints.map(p=>p.intensity))
        const intMax=Math.max(...refPoints.map(p=>p.intensity))

        const nx=30, ny=20
        const grid=[]
        for(let ix=0;ix<nx;ix++){
            const mz=mzMin+(mzMax-mzMin)*ix/(nx-1)
            for(let iy=0;iy<ny;iy++){
                const intensity=intMin+(intMax-intMin)*iy/(ny-1)
                const error=this.evalErrorSurface(mz,intensity)
                grid.push({mz,intensity,error})
            }
        }

        const errorMin=Math.min(...grid.map(p=>p.error))
        const errorMax=Math.max(...grid.map(p=>p.error))

        const colorScale=d3.scaleSequential(d3.interpolateRdBu)
            .domain([errorMax,errorMin])

        const cellWidth=xScale(mzMin+(mzMax-mzMin)/nx)-xScale(mzMin)
        const cellHeight=yScale(intMin)-yScale(intMin+(intMax-intMin)/ny)

        layer.selectAll(".error-cell")
            .data(grid)
            .join("rect")
            .attr("class","error-cell")
            .attr("x",d=>xScale(d.mz)-cellWidth/2)
            .attr("y",d=>yScale(d.intensity)-cellHeight/2)
            .attr("width",Math.max(1,cellWidth))
            .attr("height",Math.max(1,cellHeight))
            .attr("fill",d=>colorScale(d.error))
            .attr("opacity",0.3)
    }

    evalErrorSurface(mz,intensity){
        const c=this.calibrationResult.coeffs
        const mode=this.calibrationResult.mode
        if(mode==="linear2d"){
            return c[0]*mz+c[1]*intensity+c[2]
        }else if(mode==="quadratic2d"){
            return c[0]*mz*mz+c[1]*intensity*intensity+c[2]*mz*intensity+c[3]*mz+c[4]*intensity+c[5]
        }else if(mode==="cubic2d"){
            return c[0]*mz*mz*mz+c[1]*mz*mz*intensity+c[2]*mz*intensity*intensity+c[3]*intensity*intensity*intensity
                +c[4]*mz*mz+c[5]*mz*intensity+c[6]*intensity*intensity+c[7]*mz+c[8]*intensity+c[9]
        }
        return 0
    }

    applyCoeffs2DToArrays(x,y,coeffs,mode){
        const result=new Float64Array(x.length)
        for(let i=0;i<x.length;i++){
            const xi=x[i]
            const yi=y[i]
            let errorPpm=0
            if(mode==="linear2d"){
                errorPpm=coeffs[0]*xi+coeffs[1]*yi+coeffs[2]
            }else if(mode==="quadratic2d"){
                errorPpm=coeffs[0]*xi*xi+coeffs[1]*yi*yi+coeffs[2]*xi*yi+coeffs[3]*xi+coeffs[4]*yi+coeffs[5]
            }else if(mode==="cubic2d"){
                errorPpm=coeffs[0]*xi*xi*xi+coeffs[1]*xi*xi*yi+coeffs[2]*xi*yi*yi+coeffs[3]*yi*yi*yi
                    +coeffs[4]*xi*xi+coeffs[5]*xi*yi+coeffs[6]*yi*yi+coeffs[7]*xi+coeffs[8]*yi+coeffs[9]
            }
            result[i]=xi/(1+errorPpm/1e6)
        }
        return result
    }

    applyCoeffsToArray(x,coeffs,mode){
        if(!coeffs || !coeffs.length) return x
        const result=new Float64Array(x.length)
        for(let i=0;i<x.length;i++){
            const xi=x[i]
            if(mode==="linear"){
                result[i]=coeffs[0]*xi+coeffs[1]
            }else if(mode==="quadratic"){
                result[i]=coeffs[0]*xi*xi+coeffs[1]*xi+coeffs[2]
            }else if(mode==="cubic"){
                result[i]=coeffs[0]*xi*xi*xi+coeffs[1]*xi*xi+coeffs[2]*xi+coeffs[3]
            }else{
                result[i]=xi
            }
        }
        return result
    }

    pathFromArrays(x,y,xScale,yScale){
        if(!x.length) return ""
        let path=`M${xScale(x[0])},${yScale(y[0])}`
        for(let i=1;i<x.length;i++){
            if(Number.isFinite(x[i]) && Number.isFinite(y[i])){
                path+=`L${xScale(x[i])},${yScale(y[i])}`
            }
        }
        return path
    }

    fail(message){
        this.status="error"
        this.outputs[0]=[]
        this.calibrationResult=null
        this.lastInputWaves={formulas:null,xy:null}
        console.error(`[CalibrationNode] ${message}`)
        this.graph?.setTraces([])
        this.graph?.drawGraph()
    }

    serializeState(){
        return {
            calibrationMode:this.parameters.calibrationMode,
            calibrationCoeffs:this.parameters.calibrationCoeffs,
            useCollectionErrors:this.parameters.useCollectionErrors,
            show3DSurface:this.parameters.show3DSurface,
            status:this.status,
            /* the 3D camera. Orbiting to a readable angle and then reloading the
               session to find it reset would be the kind of small betrayal
               that makes people distrust a reload. */
            surfacePlot:this.surfacePlot?.serializeState?.()??null
        }
    }

    restoreState(state){
        if(!state) return
        if(state.calibrationMode) this.parameters.calibrationMode=state.calibrationMode
        if(state.calibrationCoeffs) this.parameters.calibrationCoeffs=state.calibrationCoeffs
        if(state.useCollectionErrors!==undefined) this.parameters.useCollectionErrors=state.useCollectionErrors
        if(state.show3DSurface!==undefined) this.parameters.show3DSurface=state.show3DSurface
        if(this.modeSelect) this.modeSelect.value=this.parameters.calibrationMode
        if(this.useCollectionErrorsCheckbox) this.useCollectionErrorsCheckbox.input.checked=this.parameters.useCollectionErrors
        if(this.show3DSurfaceCheckbox) this.show3DSurfaceCheckbox.input.checked=this.parameters.show3DSurface
        /* The camera is applied from restoreAfterImport, not here: framing needs
           the box, and the box only exists once there is something in the
           scene — which means after the first resolve. Applying it now would
           frame an empty plot and then be overwritten by that first framing. */
        this._restoredSurfaceCamera=state.surfacePlot?.camera??null
    }
    restoreAfterImport(){
        super.restoreAfterImport?.()
        this.updateCalibrationPlot()
        this.update3DSurface()
        const camera=this._restoredSurfaceCamera
        if(camera&&this.surfacePlot){
            this.surfacePlot.restoreState({camera})
            this._restoredSurfaceCamera=null
        }
    }

    /* Le CONTEXTE WEBGL, libéré avec le nœud — même raison et même surcharge que
       `TrimmerNode`: ces deux nœuds étendent `NodeWithAccordion`, qui ne libère
       que l'accordéon, alors que c'est `NodeWithAccordionGraph` qui appelle
       `graph.dispose()`. Sans cela, chaque suppression laissait un contexte
       OpenGL vivant — et, à 16 contextes, le navigateur en sacrifiait un autre,
       celui d'un nœud encore affiché.

       La vue 3D est libérée aussi, et c'est désormais TOUT ce qu'il y a à
       faire: le plot possède son contexte, ses tampons, son overlay et sa
       boucle de rendu, donc un seul `dispose()` suffit. L'ancien code annulait
       ici un `_animationFrame`, disposait des contrôles et vidait une géométrie
       à la main — parce que la vue était un ensemble de maillages privés que
       ce nœud avait construits lui-même. Ce n'est plus le cas, et ce code
       disparaît avec. */
    suicide(options={}){
        this.graph?.dispose?.()
        this.surfacePlot?.dispose?.()
        super.suicide(options)
    }
}

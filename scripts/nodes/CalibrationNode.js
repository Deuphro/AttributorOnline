import {NodeWithAccordion} from "../core/index.js"
import {Plot2DWebGL} from "../ui/Plot2DWebGL.js"
import {Wave,XYTrace} from "../formats.js"
import {computePool} from "../workerPool.js"
import {CE,stylize} from "../util.js"
import {wavesFromInput} from "../utils/index.js"

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
        this.parameters.calibrationMode="linear2d"
        this.parameters.calibrationCoeffs=null
        this.parameters.useCollectionErrors=true
        this.parameters.showRaw=true
        this.parameters.showCorrected=true
        this.parameters.showResiduals=false
        this.parameters.showErrorSurface=false
        this.lastInputWaves={formulas:null,xy:null}
        this.calibrationResult=null
        this.resolveRun=0
        this.multiplexCount=0
        this.skippedInputs=0
        this.multiplexTotals=null

        const inputAnchors=this.DOMelt.querySelectorAll('.input.anchor')
        if(inputAnchors[0]) inputAnchors[0].innerHTML='<title>Input 0: FormulaCollection(s) — reference formulas with errorPpm from attribution</title>'
        if(inputAnchors[1]) inputAnchors[1].innerHTML='<title>Input 1: XY Wave(s) — spectra to calibrate</title>'
        const outputAnchors=this.DOMelt.querySelectorAll('.output.anchor')
        if(outputAnchors[0]) outputAnchors[0].innerHTML='<title>Output: calibrated XY Wave(s)</title>'
    }

    registered(e){
        if(e.detail.msg.caster !== this || this.accordion){
            return
        }
        super.registered(e)
        this.setupAccordionUI()
    }

    collectFormulaCollections(){
        const collections=[]
        if(this.inputs[0] instanceof Map){
            for(const values of this.inputs[0].values()){
                for(const linkOutputs of values instanceof Array?values:[values]){
                    for(const value of linkOutputs instanceof Array?linkOutputs:[linkOutputs]){
                        if(value && value.constructor?.name==="FormulaCollection"){
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
            ["linear2d","Linear 2D: a*x + b*y + c"],
            ["quadratic2d","Quadratic 2D: a*x² + b*y² + c*x*y + d*x + e*y + f"],
            ["cubic2d","Cubic 2D: full 3rd order (10 coeffs)"],
            ["linear","Linear 1D (legacy): a*x + b"],
            ["quadratic","Quadratic 1D (legacy): a*x² + b*x + c"],
            ["cubic","Cubic 1D (legacy): a*x³ + b*x² + c*x + d"]
        ]){
            this.modeSelect.append(new Option(label,key))
        }
        this.modeSelect.value=this.parameters.calibrationMode
        this.modeSelect.addEventListener("change",()=>{
            this.parameters.calibrationMode=this.modeSelect.value
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
        this.coeffLabel=CE("span",{className:"cal-readout",title:"Fitted calibration coefficients"},["—"])
        this.rmseLabel=CE("span",{className:"cal-readout",title:"Root mean square error of fit (ppm)"},[""])
        this.pointsLabel=CE("span",{className:"cal-readout",title:"Number of reference points used"},[""])
        infoRow.append(this.coeffLabel,this.rmseLabel,this.pointsLabel)
        modeSection.append(infoRow)

        const displaySection=CE("div",{className:"cal-section"},[])
        displaySection.append(CE("div",{className:"cal-caption"},["Display"]))
        const displayRow=CE("div",{
            style:{display:"flex",gap:"8px",flexWrap:"wrap",fontSize:"0.85em"}
        },[])
        this.showRawCheckbox=this.makeCheckbox("showRaw","Raw",this.parameters.showRaw)
        this.showCorrectedCheckbox=this.makeCheckbox("showCorrected","Corrected",this.parameters.showCorrected)
        this.showResidualsCheckbox=this.makeCheckbox("showResiduals","Residuals",this.parameters.showResiduals)
        this.showErrorSurfaceCheckbox=this.makeCheckbox("showErrorSurface","Error surface",this.parameters.showErrorSurface)
        displayRow.append(this.showRawCheckbox.wrap,this.showCorrectedCheckbox.wrap,this.showResidualsCheckbox.wrap,this.showErrorSurfaceCheckbox.wrap)
        displaySection.append(displayRow)

        const graphContainer=CE("div",{
            className:"calibration-graph-container",
            style:{position:"relative",width:"100%",height:"100%",minHeight:"200px",overflow:"hidden"}
        },[])

        content.append(modeSection,displaySection,graphContainer)

        this.graph=new Plot2DWebGL([],`${this.title} graph`,this.origin,graphContainer)
        this.graph.parameters.axis.bottom.label="m/z"
        this.graph.parameters.axis.bottom.autoLabel=false
        this.graph.parameters.axis.left.label="Intensity"
        this.graph.parameters.axis.left.autoLabel=false
        this.graph.parameters.axis.left.scale="linear"
        this.graph.parameters.axis.bottom.scale="linear"

        const origDrawGraph=this.graph.drawGraph.bind(this.graph)
        this.graph.drawGraph=()=>{
            origDrawGraph()
            this.drawCalibrationOverlay()
        }

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
            this.graph?.drawGraph()
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
        if(!formulaCollection || !formulaCollection.entries) return points

        if(this.parameters.useCollectionErrors){
            for(const entry of formulaCollection.entries){
                if(!entry.formula || !Number.isFinite(entry.formula.mz)) continue
                if(!Number.isFinite(entry.errorPpm)) continue
                if(!entry.target || !Number.isFinite(entry.target.mz)) continue
                if(!Number.isFinite(entry.target.intensity)) continue

                const trueMz=entry.formula.mz
                const measuredMz=entry.target.mz
                const intensity=entry.target.intensity
                const errorPpm=entry.errorPpm

                points.push({trueMz,measuredMz,intensity,errorPpm})
            }
        }else{
            for(const entry of formulaCollection.entries){
                if(!entry.formula || !Number.isFinite(entry.formula.mz)) continue
                const targetMz=entry.formula.mz
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
        this.outputs[0]=[Wave.fromCoordinates(new Float64Array(correctedX.subarray(0,n)),new Float64Array(y.subarray(0,n)),{
            title:`${this.title} (calibrated)`,
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
        return Wave.fromCoordinates(new Float64Array(correctedX.subarray(0,n)),new Float64Array(y.subarray(0,n)),{
            title:`${this.title} (calibrated)`,
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

    updateUI(){
        if(this.calibrationResult){
            const c=this.calibrationResult
            this.coeffLabel.textContent=c.coeffs?c.coeffs.map(v=>v.toPrecision(4)).join(", "):""
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

        this.graph?.drawGraph()
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

        if(this.calibrationResult && this.parameters.showResiduals && this.calibrationResult.refPoints.length){
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

        if(this.calibrationResult && this.parameters.showErrorSurface && this.calibrationResult.is2D){
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
            showRaw:this.parameters.showRaw,
            showCorrected:this.parameters.showCorrected,
            showResiduals:this.parameters.showResiduals,
            showErrorSurface:this.parameters.showErrorSurface,
            status:this.status
        }
    }

    restoreState(state){
        if(!state) return
        if(state.calibrationMode) this.parameters.calibrationMode=state.calibrationMode
        if(state.calibrationCoeffs) this.parameters.calibrationCoeffs=state.calibrationCoeffs
        if(state.useCollectionErrors!==undefined) this.parameters.useCollectionErrors=state.useCollectionErrors
        if(state.showRaw!==undefined) this.parameters.showRaw=state.showRaw
        if(state.showCorrected!==undefined) this.parameters.showCorrected=state.showCorrected
        if(state.showResiduals!==undefined) this.parameters.showResiduals=state.showResiduals
        if(state.showErrorSurface!==undefined) this.parameters.showErrorSurface=state.showErrorSurface
        if(this.modeSelect) this.modeSelect.value=this.parameters.calibrationMode
        if(this.useCollectionErrorsCheckbox) this.useCollectionErrorsCheckbox.input.checked=this.parameters.useCollectionErrors
        if(this.showRawCheckbox) this.showRawCheckbox.input.checked=this.parameters.showRaw
        if(this.showCorrectedCheckbox) this.showCorrectedCheckbox.input.checked=this.parameters.showCorrected
        if(this.showResidualsCheckbox) this.showResidualsCheckbox.input.checked=this.parameters.showResiduals
        if(this.showErrorSurfaceCheckbox) this.showErrorSurfaceCheckbox.input.checked=this.parameters.showErrorSurface
    }
}
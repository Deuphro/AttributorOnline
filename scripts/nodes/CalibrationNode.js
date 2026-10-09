import {NodeWithAccordion} from "../core/index.js"
import {Plot2DWebGL} from "../ui/Plot2DWebGL.js"
import {Wave,XYTrace} from "../formats.js"
import {computePool} from "../workerPool.js"
import {CE,stylize} from "../util.js"
import {wavesFromInput} from "../utils/index.js"
import * as THREE from "https://unpkg.com/three@0.160.1/build/three.module.js"

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
        this._surfaceMesh=null

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

class SimpleOrbitControls{
    constructor(camera,domElement){
        this.camera=camera
        this.domElement=domElement
        this.target=new THREE.Vector3(0,0,0)
        this.enableDamping=false
        this.dampingFactor=0.05
        this.rotateSpeed=1.0
        this.zoomSpeed=1.0
        this.panSpeed=1.0
        this.minDistance=0.1
        this.maxDistance=Infinity
        this._state=0
        this._spherical=new THREE.Spherical()
        this._sphericalDelta=new THREE.Spherical()
        this._scale=1
        this._panOffset=new THREE.Vector3()
        this._rotateStart=new THREE.Vector2()
        this._rotateEnd=new THREE.Vector2()
        this._zoomStart=new THREE.Vector2()
        this._zoomEnd=new THREE.Vector2()
        this._panStart=new THREE.Vector2()
        this._panEnd=new THREE.Vector2()

        this.domElement.addEventListener('pointerdown',this._onPointerDown.bind(this))
        this.domElement.addEventListener('pointermove',this._onPointerMove.bind(this))
        this.domElement.addEventListener('pointerup',this._onPointerUp.bind(this))
        this.domElement.addEventListener('wheel',this._onWheel.bind(this))
        this.domElement.addEventListener('contextmenu',e=>e.preventDefault())
    }

    update(){
        if(this.enableDamping){
            this._spherical.theta+=this._sphericalDelta.theta*this.dampingFactor
            this._spherical.phi+=this._sphericalDelta.phi*this.dampingFactor
            this._sphericalDelta.theta*=1-this.dampingFactor
            this._sphericalDelta.phi*=1-this.dampingFactor
            this._scale+= (this._scale-1)*this.dampingFactor
            this._panOffset.multiplyScalar(1-this.dampingFactor)
        }else{
            this._sphericalDelta.set(0,0,0)
            this._scale=1
            this._panOffset.set(0,0,0)
        }
        const offset=new THREE.Vector3().subVectors(this.camera.position,this.target)
        offset.applyQuaternion(this._getRotationQuaternion())
        offset.multiplyScalar(this._scale)
        offset.add(this._panOffset)
        this.camera.position.copy(this.target).add(offset)
        this.camera.lookAt(this.target)
    }

    _getRotationQuaternion(){
        const quat=new THREE.Quaternion().setFromEuler(new THREE.Euler(0,0,0,'YXZ'))
        const q=new THREE.Quaternion()
        q.setFromAxisAngle(new THREE.Vector3(0,1,0),this._spherical.theta)
        quat.multiply(q)
        q.setFromAxisAngle(new THREE.Vector3(1,0,0),this._spherical.phi)
        quat.multiply(q)
        return quat
    }

    _onPointerDown(event){
        if(event.button===0){
            this._state=1
            this._rotateStart.set(event.clientX,event.clientY)
        }else if(event.button===2){
            this._state=2
            this._panStart.set(event.clientX,event.clientY)
        }
        this.domElement.setPointerCapture(event.pointerId)
    }

    _onPointerMove(event){
        if(this._state===1){
            this._rotateEnd.set(event.clientX,event.clientY)
            const delta=new THREE.Vector2().subVectors(this._rotateEnd,this._rotateStart).multiplyScalar(this.rotateSpeed*0.005)
            this._sphericalDelta.theta-=delta.x
            this._sphericalDelta.phi-=delta.y
            this._rotateStart.copy(this._rotateEnd)
        }else if(this._state===2){
            this._panEnd.set(event.clientX,event.clientY)
            const delta=new THREE.Vector2().subVectors(this._panEnd,this._panStart).multiplyScalar(this.panSpeed*0.002)
            this._panOffset.x-=delta.x
            this._panOffset.y+=delta.y
            this._panStart.copy(this._panEnd)
        }
    }

    _onPointerUp(event){
        this._state=0
        this.domElement.releasePointerCapture(event.pointerId)
    }

    _onWheel(event){
        event.preventDefault()
        const scale=event.deltaY>0?1.1:0.9
        this._scale*=scale
    }

    dispose(){
        this.domElement.removeEventListener('pointerdown',this._onPointerDown)
        this.domElement.removeEventListener('pointermove',this._onPointerMove)
        this.domElement.removeEventListener('pointerup',this._onPointerUp)
        this.domElement.removeEventListener('wheel',this._onWheel)
    }
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
        this.show3DSurfaceCheckbox=this.makeCheckbox("show3DSurface","3D Surface",false)
        this.show3DSurfaceCheckbox.wrap.style.display="none"
        displayRow.append(this.show3DSurfaceCheckbox.wrap)
        displaySection.append(displayRow)

        const graphContainer=CE("div",{
            className:"calibration-graph-container",
            style:{position:"relative",width:"100%",height:"100%",minHeight:"200px",overflow:"hidden"}
        },[])

        content.append(modeSection,displaySection,graphContainer)

        this.graph=new Plot2DWebGL([],`${this.title} graph`,this.origin,graphContainer)
        this.graph.parameters.axis.bottom.label="m/z"
        this.graph.parameters.axis.bottom.autoLabel=false
        this.graph.parameters.axis.left.label="Error (ppm)"
        this.graph.parameters.axis.left.autoLabel=false
        this.graph.parameters.axis.left.scale="linear"
        this.graph.parameters.axis.bottom.scale="linear"

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

    update3DSurface(){
        if(!this.parameters.show3DSurface || !this.calibrationResult || !this.calibrationResult.is2D){
            this.clear3DSurface()
            return
        }
        if(!this.graph.glLayer){
            return
        }
        const c=this.calibrationResult
        const refPoints=c.refPoints
        if(!refPoints || !refPoints.length){
            this.clear3DSurface()
            return
        }

        const mzMin=Math.min(...refPoints.map(p=>p.measuredMz))
        const mzMax=Math.max(...refPoints.map(p=>p.measuredMz))
        const intMin=Math.min(...refPoints.map(p=>p.intensity))
        const intMax=Math.max(...refPoints.map(p=>p.intensity))

        const nx=50, ny=40
        const positions=new Float32Array(nx*ny*3)
        const colors=new Float32Array(nx*ny*3)
        const indices=[]
        let idx=0

        for(let ix=0;ix<nx;ix++){
            const mz=mzMin+(mzMax-mzMin)*ix/(nx-1)
            for(let iy=0;iy<ny;iy++){
                const intensity=intMin+(intMax-intMin)*iy/(ny-1)
                const error=this.evalErrorSurface(mz,intensity)
                const x=((mz-mzMin)/(mzMax-mzMin))*2-1
                const y=((intensity-intMin)/(intMax-intMin))*2-1
                const z=(error/20)*0.5
                positions[idx*3]=x
                positions[idx*3+1]=y
                positions[idx*3+2]=z
                const t=Math.min(1,Math.max(0,(error+20)/40))
                const color=this.errorColor(t)
                colors[idx*3]=color[0]
                colors[idx*3+1]=color[1]
                colors[idx*3+2]=color[2]
                idx++
            }
        }

        for(let ix=0;ix<nx-1;ix++){
            for(let iy=0;iy<ny-1;iy++){
                const a=ix*ny+iy
                const b=ix*ny+iy+1
                const c2=(ix+1)*ny+iy
                const d=(ix+1)*ny+iy+1
                indices.push(a,b,c2, b,c2,d)
            }
        }

        const geometry=new THREE.BufferGeometry()
        geometry.setAttribute('position',new THREE.BufferAttribute(positions,3))
        geometry.setAttribute('color',new THREE.BufferAttribute(colors,3))
        geometry.setIndex(indices)
        geometry.computeVertexNormals()

        const material=new THREE.MeshPhongMaterial({
            vertexColors:true,
            side:THREE.DoubleSide,
            transparent:true,
            opacity:0.8,
            shininess:30
        })

        if(this._surfaceMesh){
            this.graph.glLayer.scene.remove(this._surfaceMesh)
            this._surfaceMesh.geometry.dispose()
            this._surfaceMesh.material.dispose()
        }

        this._surfaceMesh=new THREE.Mesh(geometry,material)
        this.graph.glLayer.scene.add(this._surfaceMesh)

        this.add3DAxes(mzMin,mzMax,intMin,intMax)
        this.setup3DCamera()
    }

    setup3DCamera(){
        if(!this.graph.glLayer) return
        const layer=this.graph.glLayer
        layer.canvas.style.pointerEvents="auto"
        if(!this._perspectiveCamera){
            this._perspectiveCamera=new THREE.PerspectiveCamera(45,layer.canvas.width/layer.canvas.height,0.1,100)
            this._perspectiveCamera.position.set(2.5,2.5,2.5)
            this._perspectiveCamera.lookAt(0,0,0)
            this._perspectiveCamera.updateProjectionMatrix()
        }else{
            this._perspectiveCamera.aspect=layer.canvas.width/layer.canvas.height
            this._perspectiveCamera.updateProjectionMatrix()
        }
        this._originalCamera=layer.camera
        layer.camera=this._perspectiveCamera
        if(!this._orbitControls){
            this._orbitControls=new SimpleOrbitControls(this._perspectiveCamera,layer.canvas)
            this._orbitControls.enableDamping=true
            this._orbitControls.dampingFactor=0.05
            this._orbitControls.target.set(0,0,0)
        }
        this._animate3D()
    }

    _animate3D(){
        if(!this.parameters.show3DSurface || !this.graph.glLayer){
            this.restore2DCamera()
            return
        }
        if(this._orbitControls) this._orbitControls.update()
        this.graph.glLayer.renderer.render(this.graph.glLayer.scene,this.graph.glLayer.camera)
        this._animationFrame=requestAnimationFrame(()=>this._animate3D())
    }

    restore2DCamera(){
        if(this._animationFrame){
            cancelAnimationFrame(this._animationFrame)
            this._animationFrame=null
        }
        if(this._orbitControls){
            this._orbitControls.dispose()
            this._orbitControls=null
        }
        if(this._originalCamera && this.graph.glLayer){
            this.graph.glLayer.camera=this._originalCamera
            this.graph.glLayer.canvas.style.pointerEvents="none"
            this._originalCamera=null
        }
    }

    clear3DSurface(){
        this.restore2DCamera()
        if(this._surfaceMesh){
            this.graph.glLayer?.scene.remove(this._surfaceMesh)
            this._surfaceMesh.geometry.dispose()
            this._surfaceMesh.material.dispose()
            this._surfaceMesh=null
        }
        if(this._axisGroup){
            this.graph.glLayer?.scene.remove(this._axisGroup)
            this._axisGroup=null
        }
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
            status:this.status
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
    }
}
import {CE,stylize} from "../util.js"
import {Wave} from "../formats.js"
import {NodeWithAccordion} from "../core/index.js"
import {computePool} from "../workerPool.js"

export class ThermoRawNode extends NodeWithAccordion{
    constructor(title,origin,destinationFlow,position={x:180,y:10}){
        super(title,[],[[]],origin,destinationFlow,position)
        this.parameters.source={
            fileName:"",
            raw:new Uint8Array(0),
            spectra:[],
            selectedScan:0
        }
    }
    registered(e){
        if(e.detail.msg.caster !== this){
            return
        }
        super.registered(e)
        this.renderAccordion()
    }
    serializeState(){
        return {
            source:this.parameters.source,
            status:this.status
        }
    }
    restoreState(state){
        if(state?.source){
            this.parameters.source={...state.source}
        }
        if(this.parameters.source.spectra?.length){
            const waves=this.parameters.source.spectra.map((spec,idx)=>{
                if(spec.mz.length===0) return null
                return Wave.fromCoordinates(
                    new Float64Array(spec.mz),
                    new Float64Array(spec.intensity),
                    {title:this.title,fileName:this.parameters.source.fileName,scanNumber:spec.scanNumber,rt:spec.rt,msLevel:spec.msLevel},
                    ["m/z","intensity"]
                )
            }).filter(w=>w!==null)
            this.outputs[0]=waves
        }else{
            this.outputs[0]=[]
        }
        this.status=state?.status??(this.parameters.source.spectra?.length?"resolved":"floating")
        this.renderAccordion()
    }
    async startResolve(){
        const spectra=this.parameters.source?.spectra
        if(!Array.isArray(spectra)||!spectra.length){
            this.outputs[0]=[]
            this.status="floating"
            return
        }
        console.log("[ThermoRawNode] startResolve, spectra:", spectra)
        const waves=spectra.map((spec,idx)=>{
            console.log("[ThermoRawNode] spec", idx, ":", spec)
            if(!spec.mz || spec.mz.length===0) return null
            return Wave.fromCoordinates(
                new Float64Array(spec.mz),
                new Float64Array(spec.intensity),
                {title:this.title,fileName:this.parameters.source.fileName,scanNumber:spec.scanNumber,rt:spec.rt,msLevel:spec.msLevel},
                ["m/z","intensity"]
            )
        }).filter(w=>w!==null)
        console.log("[ThermoRawNode] waves:", waves)
        this.outputs[0]=waves
        this.status="resolved"
    }
    clear(){
        this.updateLabel("")
        this.parameters.source.fileName=""
        this.parameters.source.raw=new Uint8Array(0)
        this.parameters.source.spectra=[]
        this.parameters.source.selectedScan=0
        this.outputs[0]=[]
        dispatchEvent(this.events.broadcast.nodeStatusChanged.call(this,"floating"))
        this.renderAccordion()
    }
    updateLabel(fileName){
        const label=fileName||"Thermo .raw file"
        this.title=label
        this.events.label=label
        this.DOMelt.querySelector("#nodeTitle").textContent=label
        if(this.accordion){
            this.accordion.title=label
            this.accordion.DOMelt.handler.querySelector(".accordion.handler.label").textContent=label
        }
        this.fitWidthToTitle()
    }
    renderAccordion(){
        if(!this.accordion){
            return
        }
        this.accordion.DOMelt.content.replaceChildren()
        if(this.status==="resolved"){
            this.accordion.setSizingMode("viewport",{height:360})
            const spectra=this.parameters.source.spectra
            const opts=this.parameters.source.options||{}
            const waves=this.outputs[0]||[]
            const totalPeaks=waves.reduce((sum,w)=>sum+(w.dims?w.dims[0]:0),0)
            
            const loadedScans = String(spectra.filter(s=>s.mz.length>0).length)
            const scanRange = (opts.firstScan||1) + " - " + (opts.lastScan||"all")
            const msLevel = opts.msLevelFilter===0?"All":("MS"+opts.msLevelFilter)
            const rtRange = (opts.rtMin||"auto") + " - " + (opts.rtMax||"auto") + " min"
            
            const summary=CE("div",{style:{padding:"10px",border:"1px solid #444",borderRadius:"5px"}},[
                CE("h4",{style:{margin:"0 0 10px 0",fontSize:"14px"}},[this.parameters.source.fileName]),
                CE("div",{style:{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:"8px",fontSize:"13px"}},[
                    CE("div",{},[CE("strong",{},["Scans:"]),CE("span",{style:{marginLeft:"5px"}},[loadedScans])]),
                    CE("div",{},[CE("strong",{},["Peaks:"]),CE("span",{style:{marginLeft:"5px"}},[String(totalPeaks)])]),
                    CE("div",{},[CE("strong",{},["Type:"]),CE("span",{style:{marginLeft:"5px"}},[opts.dataType||"auto"])]),
                    CE("div",{},[CE("strong",{},["Scan range:"]),CE("span",{style:{marginLeft:"5px"}},[scanRange])]),
                    CE("div",{},[CE("strong",{},["MS level:"]),CE("span",{style:{marginLeft:"5px"}},[msLevel])]),
                    CE("div",{},[CE("strong",{},["RT range:"]),CE("span",{style:{marginLeft:"5px"}},[rtRange])]),
                ])
            ])
            
            const resolvedContent=CE("div",{style:{
                display:"grid",
                "grid-template-rows":"minmax(0, 1fr) auto",
                "min-height":"0",
                height:"100%",
                overflow:"hidden"
            }},[])
            this.accordion.DOMelt.content.appendChild(resolvedContent)
            resolvedContent.appendChild(summary)
            resolvedContent.appendChild(CE("button",{pilot:this,handleClick:e=>e.target.pilot.clear()},["Clear"]))
            return
        }
        
        const previewStyle={
            margin:"5px",
            borderRadius:"5px",
            border:"1px solid white",
            padding:"5px",
            minHeight:"0",
            overflow:"auto"
        }
        const fileInfo=CE("div",{style:previewStyle},[
            this.parameters.source.fileName
                ?`File: ${this.parameters.source.fileName} (${(this.parameters.source.raw.length/1024/1024).toFixed(2)} MB)`
                :"No file loaded"
        ])
        const dropzone=CE("div",{className:"dropzone"},["Drop a Thermo .raw file here"])
        dropzone.addEventListener("dragover",e=>{
            e.preventDefault()
            dropzone.classList.add("dragover")
        })
        dropzone.addEventListener("dragleave",()=>dropzone.classList.remove("dragover"))
        dropzone.addEventListener("drop",e=>{
            e.preventDefault()
            dropzone.classList.remove("dragover")
            this.readFile(e.dataTransfer.files[0])
        })
        const loader=CE("input",{type:"file",accept:".raw",handleChange:e=>this.readFile(e.target.files[0])},["Select a .raw file"])
        
        if(!this.parameters.source.raw.length){
            this.accordion.setSizingMode("content")
            this.accordion.DOMelt.content.appendChild(CE("div",{style:{
                display:"grid",
                gap:"8px",
                padding:"10px"
            }},[
                fileInfo,
                dropzone,
                loader
            ]))
            return
        }
        
        if(!this.parameters.source.scanMetadata){
            this.quickScanMetadata()
        }
        
        const meta=this.parameters.source.scanMetadata
        if(!meta){
            this.accordion.setSizingMode("content")
            const loading=CE("div",{style:previewStyle},["Scanning file metadata..."])
            this.accordion.DOMelt.content.appendChild(CE("div",{style:{
                display:"grid",gap:"8px",padding:"10px"
            }},[fileInfo,loading]))
            return
        }
        
        const options=this.parameters.source.options||{
            dataType:"auto",
            firstScan:meta.firstScan,
            lastScan:meta.lastScan,
            msLevelFilter:0,
            rtMin:meta.rtMin,
            rtMax:meta.rtMax
        }
        this.parameters.source.options=options
        
        const dataTypeSelect=CE("select",{value:options.dataType,handleInput:e=>{
            options.dataType=e.target.value
        },style:{fontSize:"13px"}},[
            CE("option",{value:"auto"},["Auto (centroid -> profile)"]),
            CE("option",{value:"centroid"},["Centroid only"]),
            CE("option",{value:"profile"},["Profile only (centroided)"]),
            CE("option",{value:"profile_raw"},["Profile raw (all points)"])
        ])
        
        const firstScanInput=CE("input",{type:"number",min:meta.firstScan,max:meta.lastScan,value:options.firstScan,style:{width:"80px",fontSize:"13px"},handleInput:e=>{
            options.firstScan=Math.max(meta.firstScan,Math.min(meta.lastScan,parseInt(e.target.value)||meta.firstScan))
        }},[])
        const lastScanInput=CE("input",{type:"number",min:meta.firstScan,max:meta.lastScan,value:options.lastScan||meta.lastScan,style:{width:"80px",fontSize:"13px"},handleInput:e=>{
            options.lastScan=Math.max(meta.firstScan,Math.min(meta.lastScan,parseInt(e.target.value)||meta.lastScan))
        }},[])
        
        const msLevelsPresent=meta.msLevelsPresent||[1]
        const msLevelOptions=[CE("option",{value:"0"},["All MS levels"])]
        for(const ml of msLevelsPresent){
            msLevelOptions.push(CE("option",{value:String(ml)},[`MS${ml} only`]))
        }
        const msLevelSelect=CE("select",{value:String(options.msLevelFilter),handleInput:e=>{
            options.msLevelFilter=parseInt(e.target.value)
        },style:{fontSize:"13px"}},msLevelOptions)
        
        const rtMinInput=CE("input",{type:"number",step:"0.01",min:meta.rtMin,max:meta.rtMax,value:options.rtMin||"",style:{width:"80px",fontSize:"13px"},placeholder:`${meta.rtMin.toFixed(2)}`,handleInput:e=>{
            const v=parseFloat(e.target.value)
            options.rtMin=isNaN(v)?0:Math.max(meta.rtMin,Math.min(meta.rtMax,v))
        }},[])
        const rtMaxInput=CE("input",{type:"number",step:"0.01",min:meta.rtMin,max:meta.rtMax,value:options.rtMax||"",style:{width:"80px",fontSize:"13px"},placeholder:`${meta.rtMax.toFixed(2)}`,handleInput:e=>{
            const v=parseFloat(e.target.value)
            options.rtMax=isNaN(v)?0:Math.max(meta.rtMin,Math.min(meta.rtMax,v))
        }},[])
        
        const loadButton=CE("button",{pilot:this,handleClick:async e=>{
            e.target.disabled=true
            e.target.textContent="Loading..."
            await e.target.pilot.loadRawFile()
            e.target.disabled=false
            e.target.textContent="Load spectra"
            e.target.pilot.renderAccordion()
        }},["Load spectra"])
        
        const metaInfo=CE("div",{style:{...previewStyle,fontSize:"12px",padding:"8px"}},[
            `Scans: ${meta.firstScan}-${meta.lastScan} (${meta.scanCount} total) | `+
            `RT: ${meta.rtMin.toFixed(2)}-${meta.rtMax.toFixed(2)} min | `+
            `MS levels: ${msLevelsPresent.join(", ")} | `+
            `Centroid: ${meta.centroidScanCount} | Profile: ${meta.profileScanCount}`
        ])
        
        this.accordion.setSizingMode("content")
        this.accordion.DOMelt.content.appendChild(CE("div",{style:{
            display:"grid",
            gap:"8px",
            padding:"10px"
        }},[
            fileInfo,
            metaInfo,
            CE("label",{style:{display:"grid",gap:"4px",fontSize:"13px"}},["Data type",dataTypeSelect]),
            CE("label",{style:{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"5px",fontSize:"13px"}},["First scan",firstScanInput,"Last scan",lastScanInput]),
            CE("label",{style:{display:"grid",gap:"4px",fontSize:"13px"}},["MS level filter",msLevelSelect]),
            CE("label",{style:{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"5px",fontSize:"13px"}},["RT min (min)",rtMinInput,"RT max (min)",rtMaxInput]),
            loadButton
        ]))
    }
    readFile(file){
        if(!file||!file.name.endsWith(".raw")){
            return
        }
        const reader=new FileReader()
        reader.onload=()=>{
            this.parameters.source.fileName=file.name
            this.updateLabel(file.name)
            this.parameters.source.raw=new Uint8Array(reader.result)
            this.parameters.source.scanMetadata=null
            this.renderAccordion()
            this.quickScanMetadata()
        }
        reader.readAsArrayBuffer(file)
    }
    quickScanMetadata(){
        if(!this.parameters.source.raw.length) return
        import("../workerPool.js").then(({computePool})=>{
            computePool.run("parseThermoRaw",{
                data:Array.from(this.parameters.source.raw),
                options:{dataType:"auto",firstScan:1,lastScan:0,msLevelFilter:0,rtMin:0,rtMax:0,metadataOnly:true}
            }).then(result=>{
                if(result.scanMetadata){
                    this.parameters.source.scanMetadata=result.scanMetadata
                    this.renderAccordion()
                }
            }).catch(err=>{
                console.error("Quick scan failed:",err)
            })
        })
    }
    async loadRawFile(){
        if(!this.parameters.source.raw.length){
            return
        }
        const {computePool}=await import("../workerPool.js")
        const options=this.parameters.source.options||{
            dataType:"auto",
            firstScan:1,
            lastScan:0,
            msLevelFilter:0,
            rtMin:0,
            rtMax:0
        }
        try{
            const result=await computePool.run("parseThermoRaw",{
                data:Array.from(this.parameters.source.raw),
                options:options
            })
            console.log("[ThermoRawNode] worker result:", result)
            if(result.spectra&&result.spectra.length>0){
                this.parameters.source.spectra=result.spectra.map(s=>({
                    mz:s.mz,
                    intensity:s.intensity,
                    scanNumber:s.scan_number,
                    rt:s.rt,
                    msLevel:s.ms_level
                }))
            }else{
                this.parameters.source.spectra=[]
            }
            await this.startResolve()
        }catch(err){
            console.error("Failed to parse Thermo .raw file:",err)
            this.parameters.source.spectra=[]
            this.outputs[0]=[]
            this.status="floating"
        }
    }
    suicide(options={}){
        super.suicide(options)
    }
    restoreAfterImport(){
        super.restoreAfterImport()
        if(this.parameters.source.spectra?.length){
            this.startResolve().then(()=>this.renderAccordion())
        }else if(this.parameters.source.raw?.length){
            this.loadRawFile().then(()=>this.resolveChildren()).then(()=>this.renderAccordion())
        }
    }
}
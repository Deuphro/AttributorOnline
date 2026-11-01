import {CE} from "../util.js"
import {Wave} from "../formats.js"
import {NodeWithAccordion} from "../core/index.js"
import {computePool} from "../workerPool.js"
import {SOCKET} from "../socketTypes.js"

/* Import a Bruker BAF acquisition (.d folder holding .baf + .baf_idx +
   .baf_xtr). Unlike the Thermo node, the source is THREE files: the browser
   cannot hand a path to the worker, so the node reads them as ArrayBuffers and
   passes them together. The decoding itself lives in src/bruker.rs. */
export class BrukerBafNode extends NodeWithAccordion{
    static menuTitle="Bruker BAF"
    static socketTypes={
        inputs:[],
        outputs:[SOCKET.WAVE]
    }
    constructor(title,origin,destinationFlow,position={x:180,y:10}){
        super(title,[],[[]],origin,destinationFlow,position)
        this.parameters.source={
            sourceWaveId:globalThis.crypto?.randomUUID?.()??`source-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            fileName:"",
            files:null,
            mode:"profile",
            spectra:[],
            wave:null,
            metadata:[],
            calibration:null,
            maxima:null,
            pointCount:0,
            mzMin:null,
            mzMax:null,
            maxIntensity:null,
            error:""
        }
    }
    sourceWaveId(){
        return this.parameters.source.sourceWaveId
    }
    registered(e){
        if(e.detail.msg.caster !== this){
            return
        }
        super.registered(e)
        this.renderAccordion()
    }
    serializeState(){
        /* The .baf payload itself is not written here: the three raw files are
           tens of megabytes, and a session that carried them would be larger
           than the data it describes. The parsed spectrum travels instead, and
           restoreState rebuilds the wave from it. */
        return {
            source:{
                sourceWaveId:this.parameters.source.sourceWaveId,
                fileName:this.parameters.source.fileName,
                mode:this.parameters.source.mode,
                spectra:this.parameters.source.spectra.map(spec=>({
                    mz:Array.from(spec.mz),
                    intensity:Array.from(spec.intensity),
                    pointCount:spec.pointCount,
                    maxIntensity:spec.maxIntensity
                })),
                wave:this.parameters.source.wave,
                metadata:this.parameters.source.metadata,
                calibration:this.parameters.source.calibration,
                maxima:this.parameters.source.maxima,
                pointCount:this.parameters.source.pointCount,
                mzMin:this.parameters.source.mzMin,
                mzMax:this.parameters.source.mzMax,
                maxIntensity:this.parameters.source.maxIntensity
            },
            status:this.status
        }
    }
    restoreState(state){
        if(state?.source){
            const savedId=state.source.sourceWaveId
            this.parameters.source={...this.parameters.source,...state.source,files:null}
            if(savedId) this.parameters.source.sourceWaveId=savedId
        }
        const source=this.parameters.source
        if(!source.wave&&source.spectra?.length){
            const spec=source.spectra[0]
            const mz=spec.mz||[]
            source.wave={
                pointCount:spec.pointCount??mz.length,
                mzMin:mz.length?mz[0]:null,
                mzMax:mz.length?mz[mz.length-1]:null,
                maxIntensity:spec.maxIntensity??null,
                mode:source.mode||"profile"
            }
        }
        if(source.spectra?.length){
            this.startResolve()
        }else{
            this.outputs[0]=[]
        }
        this.status=state?.status??(source.spectra?.length?"resolved":"floating")
        this.renderAccordion()
    }
    async startResolve(){
        const spectra=this.parameters.source?.spectra
        if(!Array.isArray(spectra)||!spectra.length){
            this.outputs[0]=[]
            this.status="floating"
            return
        }
        const waves=spectra.map(spec=>{
            if(!spec.mz||spec.mz.length===0) return null
            return Wave.fromCoordinates(
                new Float64Array(spec.mz),
                new Float64Array(spec.intensity),
                {
                    title:this.title,
                    fileName:this.parameters.source.fileName,
                    sourceWaveId:this.sourceWaveId()
                },
                ["m/z","intensity"]
            )
        }).filter(w=>w!==null)
        this.outputs[0]=waves
        this.status="resolved"
    }
    clear(){
        this.updateLabel("")
        this.parameters.source={
            ...this.parameters.source,
            fileName:"",
            files:null,
            spectra:[],
            metadata:[],
            calibration:null,
            maxima:null,
            pointCount:0,
            mzMin:null,
            mzMax:null,
            maxIntensity:null,
            error:""
        }
        this.outputs[0]=[]
        this.status="floating"
        dispatchEvent(this.events.broadcast.nodeStatusChanged.call(this,"floating"))
        this.renderAccordion()
    }
    updateLabel(fileName){
        const label=fileName||"Bruker .d (BAF)"
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
        this.accordion.setSizingMode("content")
        if(this.status==="resolved"){
            this.renderResolved()
            return
        }
        this.renderLoader()
    }
    renderResolved(){
        const source=this.parameters.source
        const waves=this.outputs[0]||[]
        const totalPeaks=waves.reduce((sum,w)=>sum+(w.dims?w.dims[0]:0),0)
        const wave=source.wave
        const calibration=source.calibration
        const rows=[
            ["File",source.fileName||"Bruker .d"],
            ["Data",source.mode==="peaks"?"Bruker peak list":"Full profile"],
            ["Points",String(wave?.pointCount??(totalPeaks||source.pointCount||0))],
            ["m/z",`${formatNumber(wave?.mzMin??source.mzMin)} to ${formatNumber(wave?.mzMax??source.mzMax)}`],
            ["Metadata",String(source.metadata?.length??0)]
        ]
        const maxIntensity=wave?.maxIntensity??source.maxIntensity
        if(Number.isFinite(maxIntensity)){
            rows.push(["Max intensity",maxIntensity.toExponential(3)])
        }
        if(calibration){
            rows.push(["Calibration",`mode ${calibration.calibMode}, fhigh ${formatNumber(calibration.frequencyHigh)}, size ${calibration.size}`])
        }

        const summary=CE("div",{style:{padding:"10px",border:"1px solid #444",borderRadius:"5px"}},[
            CE("h4",{style:{margin:"0 0 10px 0",fontSize:"14px"}},[source.fileName||"Bruker .d"]),
            CE("div",{style:{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:"8px",fontSize:"13px"}},
                rows.map(([label,value])=>CE("div",{},[CE("strong",{},[`${label}:`]),CE("span",{style:{marginLeft:"5px"}},[value])]))
            )
        ])

        const content=CE("div",{style:{display:"grid",gap:"8px"}},[summary])
        if(source.metadata?.length){
            content.appendChild(this.buildMetadataDetails(source.metadata))
        }
        content.appendChild(CE("button",{pilot:this,handleClick:e=>e.target.pilot.clear()},["Clear"]))
        this.accordion.DOMelt.content.appendChild(content)
    }
    buildMetadataDetails(metadata){
        const details=CE("details",{style:{border:"1px solid #444",borderRadius:"5px",padding:"6px"}},[])
        details.appendChild(CE("summary",{style:{cursor:"pointer",fontSize:"13px"}},[`Metadata (${metadata.length})`]))
        const list=CE("div",{style:{display:"grid",gap:"3px",maxHeight:"260px",overflow:"auto",marginTop:"6px",fontSize:"12px"}},[])
        for(const entry of metadata){
            list.appendChild(CE("div",{style:{display:"grid",gridTemplateColumns:"minmax(140px,1fr) 2fr",gap:"6px"}},[
                CE("span",{style:{color:"#9ab"}},[entry.displayName||entry.parameterName||String(entry.rowIndex)]),
                CE("span",{},[String(entry.stringValue??"")])
            ]))
        }
        details.appendChild(list)
        return details
    }
    renderLoader(){
        const source=this.parameters.source
        const previewStyle={
            margin:"5px",
            borderRadius:"5px",
            border:"1px solid white",
            padding:"5px",
            minHeight:"0",
            overflow:"auto"
        }
        const fileInfo=CE("div",{style:previewStyle},[
            source.fileName
                ?`Folder: ${source.fileName}${source.pointCount?` (${source.pointCount.toLocaleString()} profile points)`:""}`
                :"No Bruker .d folder loaded"
        ])

        const dropzone=CE("div",{className:"dropzone"},["Drop a Bruker .d folder here"])
        dropzone.addEventListener("dragover",e=>{
            e.preventDefault()
            dropzone.classList.add("dragover")
        })
        dropzone.addEventListener("dragleave",()=>dropzone.classList.remove("dragover"))
        dropzone.addEventListener("drop",async e=>{
            e.preventDefault()
            dropzone.classList.remove("dragover")
            const files=await filesFromDataTransfer(e.dataTransfer)
            this.readBrukerDirectory(files)
        })

        const loader=CE("input",{type:"file",accept:".baf,.baf_idx,.baf_xtr"},["Select the BAF files"])
        loader.multiple=true
        loader.webkitdirectory=true
        loader.addEventListener("change",e=>{
            this.readBrukerDirectory(Array.from(e.target.files||[]))
            e.target.value=""
        })

        const modeSelect=CE("select",{value:source.mode,style:{fontSize:"13px"},handleInput:e=>{
            if(e.target.value===source.mode) return
            source.mode=e.target.value
            source.spectra=[]
            source.wave=null
            source.maxIntensity=null
            this.outputs[0]=[]
            this.status="floating"
            dispatchEvent(this.events.broadcast.nodeStatusChanged.call(this,"floating"))
            this.renderAccordion()
        }},[
            CE("option",{value:"profile"},[
                `Full profile${source.pointCount?` (${source.pointCount.toLocaleString()} points)`:""}`
            ]),
            CE("option",{value:"peaks"},[
                `Bruker peak list${source.maxima?.pointCount?` (${source.maxima.pointCount.toLocaleString()} peaks)`:""}`
            ])
        ])

        const children=[
            fileInfo,
            dropzone,
            CE("div",{style:{fontSize:"12px",opacity:0.75}},[
                "The folder must contain analysis.baf, analysis.baf_idx and analysis.baf_xtr. "+
                "Use the folder picker, or drop the .d folder itself."
            ]),
            loader
        ]

        if(source.files){
            children.push(CE("label",{style:{display:"grid",gap:"4px",fontSize:"12px"}},[
                "Data to publish",
                modeSelect
            ]))
        }

        if(source.error){
            children.push(CE("div",{style:{...previewStyle,border:"1px solid #c66",color:"#f99"}},[source.error]))
        }
        if(source.files){
            const loadButton=CE("button",{pilot:this,handleClick:async e=>{
                e.target.disabled=true
                e.target.textContent="Loading..."
                await e.target.pilot.loadBrukerFile()
                e.target.disabled=false
                e.target.textContent="Load spectrum"
                e.target.pilot.renderAccordion()
            }},["Load spectrum"])
            children.push(loadButton)
            if(source.pointCount){
                children.push(CE("div",{style:{...previewStyle,fontSize:"12px",padding:"8px"}},[
                    `File: ${source.fileName} | Points: ${source.pointCount.toLocaleString()} | `+
                    `m/z: ${formatNumber(source.mzMin)}-${formatNumber(source.mzMax)} | `+
                    `Metadata: ${source.metadata?.length??0}`
                ]))
            }
        }

        this.accordion.DOMelt.content.appendChild(CE("div",{style:{
            display:"grid",
            gap:"8px",
            padding:"10px"
        }},children))
    }
    async readBrukerDirectory(files){
        const source=this.parameters.source
        source.error=""
        if(!files?.length){
            source.error="No files found. Drop the .d folder itself, not only the .baf file."
            this.renderAccordion()
            return
        }
        const baf=files.find(file=>/\.baf$/i.test(file.name))
        if(!baf){
            source.error="No .baf file found in the selection."
            this.renderAccordion()
            return
        }
        const idx=files.find(file=>file.name.toLowerCase()===(baf.name+"_idx").toLowerCase())
            ||files.find(file=>/\.baf_idx$/i.test(file.name))
        const xtr=files.find(file=>file.name.toLowerCase()===(baf.name+"_xtr").toLowerCase())
            ||files.find(file=>/\.baf_xtr$/i.test(file.name))
        if(!idx||!xtr){
            source.error=`Found ${baf.name}, but the matching .baf_idx and .baf_xtr are missing.`
            this.renderAccordion()
            return
        }

        source.fileName=baf.webkitRelativePath?.split("/")[0]||baf.name
        this.updateLabel(source.fileName)
        try{
            const [bafBytes,idxBytes,xtrBytes]=await Promise.all([
                readFileAsBytes(baf),
                readFileAsBytes(idx),
                readFileAsBytes(xtr)
            ])
            source.files={baf:bafBytes,idx:idxBytes,xtr:xtrBytes}
            source.spectra=[]
            source.metadata=[]
            source.calibration=null
            source.maxima=null
            source.pointCount=0
            source.mzMin=null
            source.mzMax=null
            source.maxIntensity=null
            this.outputs[0]=[]
            this.status="floating"
            this.renderAccordion()
            await this.quickScanMetadata()
        }catch(err){
            console.error("Failed to read Bruker BAF files:",err)
            source.error=String(err?.message||err)
            this.renderAccordion()
        }
    }
    async quickScanMetadata(){
        const files=this.parameters.source.files
        if(!files) return
        try{
            const result=await computePool.run("parseBrukerBaf",{
                files,
                options:{metadataOnly:true}
            })
            this.parameters.source.metadata=result.metadata??[]
            this.parameters.source.calibration=result.calibration??null
            this.parameters.source.maxima=result.maxima??null
            this.parameters.source.pointCount=result.pointCount??0
            this.parameters.source.mzMin=result.mzMin??null
            this.parameters.source.mzMax=result.mzMax??null
            this.renderAccordion()
        }catch(err){
            console.error("Quick scan failed:",err)
            this.parameters.source.error=String(err?.message||err)
            this.renderAccordion()
        }
    }
    async loadBrukerFile(){
        const source=this.parameters.source
        if(!source.files){
            return
        }
        try{
            const usePeakList=source.mode==="peaks"
            const result=await computePool.run("parseBrukerBaf",{
                files:source.files,
                options:usePeakList?{peakList:true}:{}
            })
            const data=usePeakList?result.peakList:result.spectrum
            if(data){
                source.spectra=[{
                    /* Typed arrays stay in memory: a BAF profile can hold 15M
                       points, and Array.from would box every one of them just
                       to hand them to Wave, which takes the typed array as is.
                       serializeState converts only when a session is written. */
                    mz:data.mz,
                    intensity:data.intensity,
                    pointCount:data.pointCount,
                    maxIntensity:data.maxIntensity
                }]
                source.maxIntensity=data.maxIntensity
            }else{
                source.spectra=[]
            }
            source.metadata=result.metadata??source.metadata
            source.calibration=result.calibration??source.calibration
            /* pointCount stays the profile count from the metadata scan: the
               mode selector uses it to label the "Full profile" option even
               when the published wave is the peak list. The m/z range follows
               the data actually loaded, which differs between the two. */
            source.pointCount=result.pointCount??source.pointCount
            source.mzMin=data?.mzMin??result.mzMin??source.mzMin
            source.mzMax=data?.mzMax??result.mzMax??source.mzMax
            await this.startResolve()
        }catch(err){
            console.error("Failed to parse Bruker BAF files:",err)
            source.spectra=[]
            source.error=String(err?.message||err)
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
        }else if(this.parameters.source.files){
            this.loadBrukerFile().then(()=>this.renderAccordion())
        }
    }
}

function formatNumber(value){
    if(!Number.isFinite(value)) return "—"
    return value.toLocaleString(undefined,{maximumFractionDigits:6})
}

function readFileAsBytes(file){
    return new Promise((resolve,reject)=>{
        const reader=new FileReader()
        reader.onload=()=>resolve(new Uint8Array(reader.result))
        reader.onerror=()=>reject(reader.error||new Error(`Cannot read ${file.name}`))
        reader.readAsArrayBuffer(file)
    })
}

function entryToFiles(entry,out){
    if(!entry) return Promise.resolve()
    if(entry.isFile){
        return new Promise((resolve,reject)=>{
            entry.file(file=>{
                out.push(file)
                resolve()
            },reject)
        })
    }
    if(entry.isDirectory){
        const reader=entry.createReader()
        return new Promise((resolve,reject)=>{
            const readBatch=()=>{
                reader.readEntries(async entries=>{
                    if(!entries.length){
                        resolve()
                        return
                    }
                    for(const child of entries){
                        await entryToFiles(child,out)
                    }
                    readBatch()
                },reject)
            }
            readBatch()
        })
    }
    return Promise.resolve()
}

async function filesFromDataTransfer(dataTransfer){
    const items=Array.from(dataTransfer?.items||[])
    const entries=items.map(item=>item.webkitGetAsEntry?.()).filter(Boolean)
    if(entries.length){
        const out=[]
        for(const entry of entries){
            await entryToFiles(entry,out)
        }
        return out
    }
    return Array.from(dataTransfer?.files||[])
}

import {CE,stylize} from "../util.js"
import {Wave} from "../formats.js"
import {NodeWithAccordion} from "../core/index.js"
import {Table} from "../ui/index.js"

export class DelimitedTextNode extends NodeWithAccordion{
    constructor(title,origin,destinationFlow,position={x:180,y:10}){
        super(title,[],[[]],origin,destinationFlow,position)
        this.parameters.source={
            lineSeparator:"\\r\\n|\\r|\\n",
            columnSeparator:"\\t|,|\\s",
            fileName:"",
            raw:"",
            pairs:[],
            labels:["x","y"]
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
            this.parameters.source={labels:["x","y"],...state.source}
        }
        this.updateLabel(this.parameters.source.fileName)
        if(this.parameters.source.pairs?.length){
            this.outputs[0]=[Wave.fromPairs(this.parameters.source.pairs,{title:this.title,fileName:this.parameters.source.fileName},this.parameters.source.labels)]
        }else{
            this.outputs[0]=[]
        }
        this.status=state?.status??(this.parameters.source.pairs?.length?"resolved":"floating")
        this.renderAccordion()
    }
    async startResolve(){
        if(!this.parameters.source.pairs.length){
            this.outputs[0]=[]
            this.status="floating"
            return
        }
        this.outputs[0]=[Wave.fromPairs(this.parameters.source.pairs,{title:this.title,fileName:this.parameters.source.fileName},this.parameters.source.labels)]
        this.status="resolved"
    }
    setColumnLabels(labels){
        this.parameters.source.labels=Wave.normalizeLabels(labels)
        const wave=this.outputs[0]?.[0]
        if(wave instanceof Wave){
            wave.labels=[...this.parameters.source.labels]
        }
        this.status="floating"
        dispatchEvent(this.events.broadcast.nodeStatusChanged.call(this,this.status))
    }
    clear(){
        this.updateLabel("")
        this.parameters.source.fileName=""
        this.parameters.source.raw=""
        this.parameters.source.pairs=[]
        this.parameters.source.labels=["x","y"]
        this.outputs[0]=[]
        dispatchEvent(this.events.broadcast.nodeStatusChanged.call(this,"floating"))
        this.renderAccordion()
    }
    parseRaw(){
        const {raw,lineSeparator,columnSeparator}=this.parameters.source
        const pairs=[]
        for(const line of raw.split(RegExp(lineSeparator))){
            const values=line.split(RegExp(columnSeparator)).map(value=>Number.parseFloat(value))
            if(Number.isFinite(values[0])&&Number.isFinite(values[1])){
                pairs.push([values[0],values[1]])
            }
        }
        return pairs
    }
    updateLabel(fileName){
        const label=fileName||"Delimited text"
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
        this.table?.dispose()
        this.table=null
        this.accordion.setSizingMode("content")
        if(this.status==="resolved"){
            this.accordion.setSizingMode("viewport",{height:360})
            const columnLabels=Wave.normalizeLabels(this.parameters.source.labels)
            this.parameters.source.labels=[...columnLabels]
            const resolvedContent=CE("div",{style:{
                display:"grid",
                "grid-template-rows":"minmax(0, 1fr) auto",
                "min-height":"0",
                height:"100%",
                overflow:"hidden"
            }},[])
            this.accordion.DOMelt.content.appendChild(resolvedContent)
            this.table=new Table(this.parameters.source.pairs,[...columnLabels],this.origin,resolvedContent,{mutable:{hRuler:true},onTitleChange:(labels)=>this.setColumnLabels(labels)})
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
        const rawPreview=CE("div",{style:previewStyle},["Raw preview"])
        const procPreview=CE("div",{style:previewStyle},["XY preview"])
        const updatePreview=()=>{
            rawPreview.textContent=this.parameters.source.raw.slice(0,500)
            procPreview.textContent=this.parameters.source.raw?JSON.stringify(this.parseRaw().slice(0,15)):"XY preview"
        }
        const readFile=file=>{
            if(!file){
                return
            }
            const reader=new FileReader()
            reader.onload=()=>{
                this.parameters.source.fileName=file.name
                this.updateLabel(file.name)
                this.parameters.source.raw=reader.result
                updatePreview()
            }
            reader.readAsText(file)
        }
        const dropzone=CE("div",{className:"dropzone"},["Drop a text file here"])
        dropzone.addEventListener("dragover",e=>{
            e.preventDefault()
            dropzone.classList.add("dragover")
        })
        dropzone.addEventListener("dragleave",()=>dropzone.classList.remove("dragover"))
        dropzone.addEventListener("drop",e=>{
            e.preventDefault()
            dropzone.classList.remove("dragover")
            readFile(e.dataTransfer.files[0])
        })
        const loader=CE("input",{type:"file",handleChange:e=>readFile(e.target.files[0])},["Select a text file"])
        const lineSeparator=CE("select",{value:this.parameters.source.lineSeparator,handleInput:e=>{
            this.parameters.source.lineSeparator=e.target.value
            updatePreview()
        }},[
            CE("option",{value:"\\r|\\n|\\r\\n"},["auto/guess"]),
            CE("option",{value:"\\r\\n"},["CRLF"]),
            CE("option",{value:"\\r"},["CR"]),
            CE("option",{value:"\\n"},["LF"])
        ])
        const columnSeparator=CE("select",{value:this.parameters.source.columnSeparator,handleInput:e=>{
            this.parameters.source.columnSeparator=e.target.value
            updatePreview()
        }},[
            CE("option",{value:"\\t|,|\\s"},["auto/guess"]),
            CE("option",{value:"\\t"},["tab"]),
            CE("option",{value:","},["comma"]),
            CE("option",{value:"\\s+"},["whitespace"])
        ])
        const validate=CE("button",{pilot:this,handleClick:async e=>{
            e.target.pilot.parameters.source.pairs=e.target.pilot.parseRaw()
            await e.target.pilot.startResolve()
            e.target.pilot.renderAccordion()
        }},["Load"])
        this.accordion.DOMelt.content.appendChild(CE("div",{style:{
            display:"grid",
            gap:"5px",
            minHeight:"0",
            height:"100%",
            overflow:"hidden",
            gridTemplateRows:"auto auto minmax(0, 1fr) auto auto"
        }},[
            dropzone,
            loader,
            CE("div",{style:{display:"grid",gridTemplateColumns:"1fr 1fr",minHeight:"0",overflow:"hidden"}},[rawPreview,procPreview]),
            CE("label",{},["Lines separator",lineSeparator]),
            CE("label",{},["Columns separator",columnSeparator]),
            validate
        ]))
        updatePreview()
    }
    suicide(options={}){
        this.table?.dispose()
        this.table=null
        super.suicide(options)
    }
    restoreAfterImport(){
        super.restoreAfterImport()
        if(this.parameters.source.raw){
            this.parameters.source.pairs=this.parseRaw()
            this.startResolve().then(()=>this.renderAccordion())
        }
    }
}
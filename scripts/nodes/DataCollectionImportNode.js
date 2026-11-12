import {CE,stylize} from "../util.js"
import {Wave} from "../formats.js"
import {Accordion} from "../ui/Accordion.js"
import {NodeWithAccordionGraph} from "./NodeWithAccordionGraph.js"

export class DataCollectionImportNode extends NodeWithAccordionGraph{
    constructor(title,origin,destinationFlow,position={x:180,y:10}){
        super(title,[],[[],[]],origin,destinationFlow,position)
        /* Identifiant d'instance: rend le name des radios unique pour ce nœud,
           sinon deux DataCollectionImportNode partagent les mêmes boutons radio
           et cliquer sur l'un décoche l'autre. */
        this._dcId=crypto.randomUUID()
        this.parameters.dataItems=[]
        this.parameters.selectedForOutput=null
        this.parameters.selectedForMultiplex=[]
this.parameters.enabledScans={}   // <-- ID: booléen par scan pour DataCollectionImportNode
    }
    serializeState(){
        const graphState=super.serializeState?.()??{}
        return {
            dataItems:this.parameters.dataItems.map(item=>({
                ...item,
                sourceWaveId:item.sourceWaveId,
                raw:item.raw?Array.from(item.raw):undefined,
                wave:undefined
            })),
            selectedForOutput:this.parameters.selectedForOutput,
            enabledScans:this.parameters.enabledScans,
            selectedForMultiplex:this.parameters.selectedForMultiplex,
            status:this.status,
            ...graphState
        }
    }
    restoreState(state){
        if(!state) return
        /* L'état du graphe (axes, traces) est restauré par la classe parente. */
        super.restoreState(state)
        this.parameters.dataItems=state.dataItems?.map(item=>({
            ...item,
            raw:item.raw?new Uint8Array(item.raw):undefined,
            wave:undefined
        }))||[]
        this.parameters.selectedForOutput=state.selectedForOutput??null
        this.parameters.selectedForMultiplex=state.selectedForMultiplex??[]
        this.parameters.enabledScans=state.enabledScans??{}
        this.setStatus(state.status??"floating")
        this.rebuildWaves()
        this.renderAccordion()
    }
    rebuildWaves(){
        for(const item of this.parameters.dataItems){
            if(item.type==="raw"&&item.spectra){
                const enabledIdx=this.parameters.enabledScans[item.id]||{}
                item.wave=item.spectra.map((spec,idx)=>{
                    if(!spec.mz||spec.mz.length===0) return null
                    if(enabledIdx[idx]===false) return null
                    return Wave.fromCoordinates(
                        new Float64Array(spec.mz),
                        new Float64Array(spec.intensity),
                        {title:item.name,fileName:item.fileName,scanNumber:spec.scanNumber,rt:spec.rt,msLevel:spec.msLevel,sourceWaveId:`${item.sourceWaveId}:scan-${spec.scanNumber??idx}`},
                        ["m/z","intensity"]
                    )
                }).filter(w=>w!==null)
            }else if(item.type==="text"&&item.pairs){
                item.wave=[Wave.fromPairs(item.pairs,{title:item.name,fileName:item.fileName,sourceWaveId:item.sourceWaveId},item.labels)]
            }
        }
        this.publishOutputs()
    }
    publishOutputs(){
        const multiplexWaves=[]
        for(const item of this.parameters.dataItems){
            if(this.parameters.selectedForMultiplex.includes(item.id)&&item.wave){
                multiplexWaves.push(...item.wave)
            }
        }
        this.outputs[0]=multiplexWaves
        let singleWave=null
        if(this.parameters.selectedForOutput){
            const item=this.parameters.dataItems.find(i=>i.id===this.parameters.selectedForOutput)
            if(item?.wave?.length){
                singleWave=item.wave[0]
            }
        }
        this.outputs[1]=singleWave?[singleWave]:[]
        this.resolveChildren()
    }
    async startResolve(){
        this.setStatus("pending")
        for(const item of this.parameters.dataItems){
            if(item.type==="raw"&&item.raw?.length&&!item.spectra){
                await this.loadRawItem(item)
            }
        }
        this.rebuildWaves()
        this.setStatus("resolved")
        this.renderAccordion()
    }
    async loadRawItem(item){
        const {computePool}=await import("../workerPool.js")
        const options=item.options||{
            dataType:"auto",firstScan:1,lastScan:0,msLevelFilter:0,rtMin:0,rtMax:0
        }
        try{
            const result=await computePool.run("parseThermoRaw",{
                data:Array.from(item.raw),
                options
            })
            if(result.spectra&&result.spectra.length>0){
                item.spectra=result.spectra.map(s=>({
                    mz:s.mz,intensity:s.intensity,scanNumber:s.scan_number,rt:s.rt,msLevel:s.ms_level
                }))
                // Initialise enabledScans pour cet item (tous à true par défaut)
                this.parameters.enabledScans[item.id]=result.spectra.map(()=>true)
            }else{
                item.spectra=[]
                this.parameters.enabledScans[item.id]={}
            }
        }catch(err){
            console.error("Failed to parse Thermo .raw file:",err)
            item.spectra=[]
            this.parameters.enabledScans[item.id]={}
        }
    }
    registered(e){
        const {channel, registrationName, label, caster} = e.detail.msg
        if(caster !== this || this.accordion){
            return
        }
        /* PAS DE DIALOG CENTRAL, PAS DE GRAPHE: ce nœud est un importateur,
           pas un traceur. Seul le panneau d'accordéon lui est nécessaire. */
        this.accordion=new Accordion(
            label,
            this.origin,
            this.origin.main.querySelector(".vertical.left.content")
        )
        channel.register(`${registrationName}:accordion`,this.accordion,label)
        this.renderAccordion()
    }
    suicide(options={}){
        /* graph et graphDialog n'existent pas (jamais créés par registered()).
           super.suicide() = NodeWithAccordionGraph.suicide() tente
           this.graph?.dispose?.() et this.graphDialog?.suicide() — des no-ops
           grâce au chaînage optionnel — puis this.accordion?.suicide() et
           Node.suicide() pour le nettoyage du graphe de flux. */
        super.suicide(options)
    }
    renderAccordion(){
        if(!this.accordion) return
        this.accordion.DOMelt.content.replaceChildren()
        this.accordion.setSizingMode("content")
        const content=CE("div",{style:{display:"grid",gap:"8px",minHeight:"0"}},[])
        const dropzone=CE("div",{className:"dropzone",style:{padding:"20px",textAlign:"center",border:"2px dashed #555",borderRadius:"5px",cursor:"pointer"}},[
            "Drop .raw or text files here"
        ])
        dropzone.addEventListener("dragover",e=>{e.preventDefault();dropzone.classList.add("dragover")})
        dropzone.addEventListener("dragleave",()=>dropzone.classList.remove("dragover"))
        dropzone.addEventListener("drop",e=>{
            e.preventDefault()
            dropzone.classList.remove("dragover")
            for(const file of e.dataTransfer.files) this.readFile(file)
        })
        const loader=CE("input",{type:"file",multiple:true,accept:".raw,.txt,.csv,.tsv",style:{display:"none"}},[ ])
        loader.addEventListener("change",e=>{
            for(const file of e.target.files) this.readFile(file)
            e.target.value=""
        })
        dropzone.addEventListener("click",()=>loader.click())
        content.appendChild(dropzone)
        if(this.parameters.dataItems.length){
            content.appendChild(this.buildDataToolbar())
            content.appendChild(this.buildDataList())
        }
        this.accordion.DOMelt.content.appendChild(content)
    }
    readFile(file){
        if(!file) return
        const isRaw=file.name.endsWith(".raw")
        const reader=new FileReader()
        reader.onload=()=>{
            const id=crypto.randomUUID()
            const sourceWaveId=globalThis.crypto?.randomUUID?.()??`source-${Date.now()}-${Math.random().toString(36).slice(2)}`
            const item={
                id,
                sourceWaveId,
                name:file.name,
                fileName:file.name,
                type:isRaw?"raw":"text",
                raw:isRaw?new Uint8Array(reader.result):undefined,
                text:isRaw?undefined:reader.result,
                spectra:undefined,
                pairs:undefined,
                labels:["x","y"],
                options:isRaw?{dataType:"auto",firstScan:1,lastScan:0,msLevelFilter:0,rtMin:0,rtMax:0}:undefined,
                lineSeparator:"\\r\\n|\\r|\\n",
                columnSeparator:"\\t|,|\\s"
            }
            if(!isRaw){
                item.pairs=this.parseText(item.text,item)
            }
            this.parameters.dataItems.push(item)
            this.parameters.selectedForMultiplex.push(id)
            if(!this.parameters.selectedForOutput){
                this.parameters.selectedForOutput=id
            }
            this.rebuildWaves()
            this.renderAccordion()
        }
        if(isRaw) reader.readAsArrayBuffer(file)
        else reader.readAsText(file)
    }
    parseText(text,item){
        /* Chaque item garde SES séparateurs: on ne lit pas ceux de l'item
           précédent (bug: le deuxième fichier chargé était parsé avec les
           séparateurs du premier). */
        const {lineSeparator,columnSeparator}=item||{}
        const pairs=[]
        for(const line of text.split(RegExp(lineSeparator||"\\r\\n|\\r|\\n"))){
            const values=line.split(RegExp(columnSeparator||"\\t|,|\\s")).map(v=>Number.parseFloat(v))
            if(Number.isFinite(values[0])&&Number.isFinite(values[1])){
                pairs.push([values[0],values[1]])
            }
        }
        return pairs
    }
    buildDataToolbar(){
        const row=CE("div",{style:{display:"flex",gap:"6px",alignItems:"center"}},[])
        const button=(label,title,selected)=>{
            const element=CE("button",{type:"button",title},[label])
            stylize(element,{
                fontSize:"0.8em",lineHeight:"1",padding:"2px 8px",cursor:"pointer",
                color:"inherit",background:"rgba(255,255,255,0.08)",
                border:"1px solid rgba(255,255,255,0.15)",borderRadius:"2px"
            })
            element.addEventListener("click",()=>this.setAllMultiplexSelected(selected))
            return element
        }
        row.append(
            button("Select all","Select every file for the multiplex output",true),
            button("Deselect all","Clear the multiplex selection",false)
        )
        return row
    }
    /* LA SÉLECTION MULTIPLEX EST UN ENSEMBLE D'IDs: tout cocher revient à le
       remplir de tous les items, tout décocher à le vider. On republie et on
       redessine, sinon les cases resteraient dans leur ancien état. */
    setAllMultiplexSelected(selected){
        this.parameters.selectedForMultiplex=selected
            ?this.parameters.dataItems.map(item=>item.id)
            :[]
        this.publishOutputs()
        this.renderAccordion()
    }
    buildDataList(){
        const list=CE("div",{style:{display:"grid",gap:"4px",minHeight:"0",maxHeight:"400px",overflow:"auto"}},[])
        for(const item of this.parameters.dataItems){
            list.appendChild(this.buildDataRow(item))
        }
        return list
    }
    buildDataRow(item){
        const isSelectedMultiplex=this.parameters.selectedForMultiplex.includes(item.id)
        const isSelectedOutput=this.parameters.selectedForOutput===item.id
        const row=CE("div",{style:{display:"grid",gridTemplateColumns:"24px 24px 1fr auto",gap:"6px",alignItems:"center",padding:"4px",border:"1px solid #333",borderRadius:"3px",background:isSelectedOutput?"rgba(120,180,255,0.15)":"transparent"}},[])
        // Checkbox multiplex (tous les scans de l'item)
        const checkMultiplex=CE("input",{type:"checkbox",checked:isSelectedMultiplex,style:{width:"18px",height:"18px",cursor:"pointer"}},[])
        checkMultiplex.addEventListener("change",()=>{
            if(checkMultiplex.checked){
                this.parameters.selectedForMultiplex.push(item.id)
            }else{
                this.parameters.selectedForMultiplex=this.parameters.selectedForMultiplex.filter(id=>id!==item.id)
            }
            this.publishOutputs()
        })
        // Radio single output
        const radioOutput=CE("input",{type:"radio",name:`dc-single-output-${this._dcId}`,checked:isSelectedOutput,style:{width:"18px",height:"18px",cursor:"pointer"}},[])
        radioOutput.addEventListener("change",()=>{
            this.parameters.selectedForOutput=item.id
            this.publishOutputs()
            this.renderAccordion()
        })
        // Infos du fichier
        let infoText=`${item.name} — `
        if(item.type==="raw"){
            const totalPeaks=item.spectra?.reduce((sum,s)=>sum+(s.mz?.length||0),0)||0
            const scanCount=item.spectra?.length||0
            infoText+=`${scanCount} scan(s), ${totalPeaks} peak(s)`
        }else{
            infoText+=`${item.pairs?.length||0} point(s)`
        }
        const info=CE("div",{style:{fontSize:"13px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}},[infoText])
        // Bouton supprimer
        const removeBtn=CE("button",{type:"button",title:"Remove this file"},["✕"])
        stylize(removeBtn,{
            fontSize:"0.8em",lineHeight:"1",padding:"2px",cursor:"pointer",
            color:"inherit",background:"rgba(255,255,255,0.08)",
            border:"1px solid rgba(255,255,255,0.15)",borderRadius:"2px"
        })
        removeBtn.addEventListener("click",()=>{
            this.parameters.dataItems=this.parameters.dataItems.filter(i=>i.id!==item.id)
            this.parameters.selectedForMultiplex=this.parameters.selectedForMultiplex.filter(id=>id!==item.id)
            if(this.parameters.selectedForOutput===item.id){
                this.parameters.selectedForOutput=this.parameters.dataItems[0]?.id||null
            }
            this.rebuildWaves()
            this.renderAccordion()
        })
        // Affichage des scans pour les items raw
        let scanList=null
        if(item.type==="raw"&&item.spectra){
            const enabledIdx=this.parameters.enabledScans[item.id]||{}
            /* `gridColumn:"1 / -1"` EST LA CORRECTION DE MISE EN PAGE: sans lui
               la liste des scans est le 5e enfant d'une grille à 4 colonnes et
               tombe dans la colonne de 24 px, où « scan » et son numéro se
               séparent sur deux lignes. */
            scanList=CE("div",{style:{
                display:"grid",gap:"3px",marginTop:"4px",gridColumn:"1 / -1"
            }},[])
            const smallButton=(label,title)=>{
                const element=CE("button",{type:"button",title},[label])
                stylize(element,{
                    fontSize:"11px",lineHeight:"1",padding:"1px 6px",cursor:"pointer",
                    color:"inherit",background:"rgba(255,255,255,0.08)",
                    border:"1px solid rgba(255,255,255,0.15)",borderRadius:"2px"
                })
                return element
            }
            const scanToolbar=CE("div",{style:{
                display:"flex",gap:"6px",alignItems:"center"
            }},[])
            const selectAllScans=smallButton("Select all","Enable every scan of this file")
            selectAllScans.addEventListener("click",()=>this.setAllScansEnabled(item,true))
            const deselectAllScans=smallButton("Deselect all","Disable every scan of this file")
            deselectAllScans.addEventListener("click",()=>this.setAllScansEnabled(item,false))
            scanToolbar.append(selectAllScans,deselectAllScans)
            scanList.appendChild(scanToolbar)
            item.spectra.forEach((spec,idx)=>{
                const isEnabled=enabledIdx[idx]!==false
                const points=spec.mz?.length??spec.intensity?.length??0
                const scanLabel=CE("span",{style:{fontSize:"11px",color:"#888"}},[
                    `scan ${idx+1} · ${points} point(s)`
                ])
                const scanCb=CE("input",{type:"checkbox",checked:isEnabled,style:{width:"14px",height:"14px",cursor:"pointer"}},[])
                scanCb.addEventListener("change",()=>{
                    this.parameters.enabledScans[item.id][idx]=scanCb.checked
                    this.rebuildWaves()
                    this.renderAccordion()
                })
                scanList.appendChild(CE("div",{style:{display:"flex",alignItems:"center",gap:"4px",fontSize:"12px",whiteSpace:"nowrap"}},[scanCb,scanLabel]))
            })
        }
        row.append(checkMultiplex,radioOutput,info,removeBtn)
        if(scanList) row.appendChild(scanList)
        return row
    }
    setAllScansEnabled(item,enabled){
        const enabledIdx={}
        item.spectra?.forEach((_,idx)=>{ enabledIdx[idx]=enabled })
        this.parameters.enabledScans[item.id]=enabledIdx
        this.rebuildWaves()
        this.renderAccordion()
    }
    /* L'ÉTAT DU NŒUD, diffusé comme dans les nœuds voisins (DelimitedTextNode,
       ThermoRawNode, AttributionNode). Un changement de statut sans cet événement
       ne change pas la couleur du nœud sur le graphe. */
    setStatus(status){
        this.status=status
        dispatchEvent(this.events.broadcast.nodeStatusChanged.call(this,status))
    }
}

import {NodeWithAccordion} from "../core/index.js"
import {Accordion} from "../ui/Accordion.js"
import {Dialog} from "../ui/Dialog.js"
import {Plot3DWebGL} from "../ui/Plot3DWebGL.js"
import {Wave,Scatter3DTrace,Segment3DTrace} from "../formats.js"
import {Formula,Stoichiometry,FormulaCollection} from "../chemistry.js"
import {CE,stylize} from "../util.js"
import {traceColor} from "./formulaCollectionHelpers.js"
import {SOCKET} from "../socketTypes.js"
import {columnLatticeBasis,quotientRepresentative} from "../math/integerLattice.js"

const AXIS_KEYS=["x","y","z"]
const AXIS_VIEW_ANGLES={
    X:{theta:Math.PI/2,phi:Math.PI/2},
    Y:{theta:0,phi:0.02},
    Z:{theta:0,phi:Math.PI/2}
}

/* One hue per quotient class, walked by the golden angle so neighbouring class
   numbers are never neighbouring colours. The classes are not ordered in any
   meaningful way — they are residue ids — so a ramp would imply a progression
   that does not exist. */
const GROUP_HUE_STEP=0.6180339887498949
const hslToHex=(hue,saturation,lightness)=>{
    const channel=(p,q,t)=>{
        if(t<0) t+=1
        if(t>1) t-=1
        if(t<1/6) return p+(q-p)*6*t
        if(t<1/2) return q
        if(t<2/3) return p+(q-p)*(2/3-t)*6
        return p
    }
    const q=lightness<0.5?lightness*(1+saturation):lightness+saturation-lightness*saturation
    const p=2*lightness-q
    return "#"+[channel(p,q,hue+1/3),channel(p,q,hue),channel(p,q,hue-1/3)]
        .map(value=>Math.round(Math.max(0,Math.min(1,value))*255).toString(16).padStart(2,"0"))
        .join("")
}
const groupColor=index=>hslToHex((index*GROUP_HUE_STEP)%1,0.62,0.56)

export class StoichiometricAnalysisNode extends NodeWithAccordion{
    static socketTypes={
        inputs:[SOCKET.FORMULA_COLLECTION,SOCKET.FORMULA_COLLECTION],
        outputs:[]
    }
    constructor(title,origin,destinationFlow,position={x:180,y:10}){
        super(title,[[],[]],[],origin,destinationFlow,position)
        this.parameters.elements=["C","H","O","N"]
        this.parameters.projection={
            x:0,y:1,z:2,showCloud:true,showProjections:true,pointSize:3,
            orthographic:false,axis:null,
            colorBy:"collection",showPatternVectors:false
        }
        this.parameters.pca={x:0,y:1,z:2}
        this.parameters.fit={}

        this.parameters.patterns=["CH2"]
        this.patternErrors=[]
        this.projectionLevels=[]
        this.stoichiometricDimensions=[]
        this.inputCollections=[]
        this.collectionPoints=[]
        this.pointTotal=0
        this.diagnostics=[]
        this.loadedTable=null
        this.formulaCache=new Map()
        this.patternCache=new Map()
        this.compositionCache=new Map()
        this.latticeCache=new Map()
        this.viewPanels={}
        this.plot=null
        this.axisButtons={}
        this._viewApplied=false
        const anchors=this.DOMelt.querySelectorAll(".input.anchor")
        if(anchors[0]){
            anchors[0].innerHTML="<title>Formula collections (multiplexed)</title>"
        }
        if(anchors[1]){
            anchors[1].innerHTML="<title>Formula collection (optional, one)</title>"
        }
    }

    async table(){
        if(this.origin?.table){
            this.loadedTable=this.origin.table
            return this.loadedTable
        }
        const loaded=await this.origin?.tableReady
        this.loadedTable=loaded??this.loadedTable??null
        return this.loadedTable
    }

    elements(){
        return Array.isArray(this.parameters.elements)?this.parameters.elements:[]
    }

    availableElements(){
        return (this.loadedTable?.elements??[])
            .map(element=>element.symbol)
            .filter(Boolean)
    }

    setStatus(status){
        this.status=status
        dispatchEvent(this.events.broadcast.nodeStatusChanged.call(this,status))
    }

    registered(e){
        super.registered(e)
        const {channel,registrationName,label,caster}=e.detail.msg
        if(caster!==this||this.accordionRight){
            return
        }
        const rightContent=this.origin.main.querySelector(".vertical.right.content")
        this.accordionRight=new Accordion(`${label} — analysis`,this.origin,rightContent)
        this.accordionRight.setSizingMode("content")
        channel.register(`${registrationName}:analysis`,this.accordionRight,`${label} — analysis`)
        this.analysisDialog=new Dialog(`${label} — views`,this.origin,this.origin.midCentralContent)
        const dismisser=this.analysisDialog.DOMelt.dismisser
        if(dismisser){
            dismisser.handleClick=undefined
            dismisser.classList.add("disabled")
            dismisser.setAttribute("aria-disabled","true")
        }
        stylize(this.analysisDialog.DOMelt.window,{
            top:"0px",
            left:"0px",
            width:"100%",
            height:"100%"
        })
        channel.register(`${registrationName}:views`,this.analysisDialog,`${label} — views`)
        this.setupAnalysisDialog(label)
        this.setupRightPanel()
        this.setupUI()
        this.setAnalysisVisible(true)
        this.renderAll()
    }

    setupRightPanel(){
        const content=this.accordionRight.DOMelt.content
        content.replaceChildren()
        stylize(content,{display:"grid",gridTemplateColumns:"minmax(0,1fr)",gap:"6px",padding:"4px"})
        this.projectionControls=CE("div",{className:"sa-projections"},[])
        this.pcaControls=CE("div",{className:"sa-series"},[])
        this.fitControls=this.placeholderSection(
            "Model fit",
            "No model definition is available yet.",
            "Fit model"
        )
        content.append(this.projectionControls,this.pcaControls,this.fitControls)
    }

    placeholderSection(title,text,buttonLabel){
        const box=CE("div",{className:"sa-placeholder"},[])
        stylize(box,{
            display:"grid",
            gap:"5px",
            padding:"5px 6px",
            border:"1px solid rgba(255,255,255,0.14)",
            borderRadius:"4px",
            background:"rgba(255,255,255,0.025)",
            opacity:"0.85"
        })
        const heading=CE("div",{},[title])
        stylize(heading,{fontWeight:"600",fontSize:"0.85em"})
        const note=CE("div",{},[text])
        stylize(note,{fontSize:"0.78em",opacity:"0.65",lineHeight:"1.3"})
        const button=CE("button",{type:"button",disabled:true},[buttonLabel])
        stylize(button,{fontSize:"0.78em",opacity:"0.6"})
        box.append(heading,note,button)
        return box
    }

    setupAnalysisDialog(label){
        const content=this.analysisDialog.DOMelt.content
        stylize(content,{
            display:"grid",
            gridTemplateRows:"minmax(0,1fr)",
            padding:"0",
            overflow:"hidden"
        })
        const scroller=CE("div",{className:"sa-views"},[])
        stylize(scroller,{
            height:"100%",
            overflowY:"auto",
            overflowX:"hidden",
            display:"grid",
            gap:"6px",
            alignContent:"start",
            padding:"6px",
            boxSizing:"border-box"
        })
        content.appendChild(scroller)
        this.viewPanels.main=this.discreetAccordion(`${label} — 3D view`,{
            onUnfold:()=>requestAnimationFrame(()=>this.plot?.handleResize?.())
        })
        this.viewPanels.compression=this.discreetAccordion(`${label} — stoichiometric series`,{folded:true})
        this.viewPanels.models=this.discreetAccordion(`${label} — fitted models`,{folded:true})
        for(const panel of Object.values(this.viewPanels)){
            scroller.appendChild(panel.DOMelt.container)
        }
        this.setupMainView()
        this.setupCompressionView()
        this.setupModelsView()
    }

    discreetAccordion(title,{folded=false,onUnfold=null}={}){
        const container=CE("div",{className:"sa-discreet-panel"},[])
        stylize(container,{
            display:"flex",
            flexDirection:"column",
            minHeight:"0",
            minWidth:"0",
            overflow:"hidden",
            border:"1px solid rgba(255,255,255,0.12)",
            borderRadius:"4px",
            background:"rgba(255,255,255,0.025)"
        })
        const head=CE("div",{className:"sa-discreet-head",role:"button"},[])
        head.setAttribute("tabindex","0")
        stylize(head,{
            display:"flex",
            alignItems:"center",
            gap:"6px",
            cursor:"pointer",
            padding:"3px 6px",
            borderRadius:"3px",
            border:"1px solid rgba(255,255,255,0.12)",
            background:"rgba(255,255,255,0.05)",
            fontSize:"0.72em",
            fontWeight:"bold",
            opacity:"0.85",
            userSelect:"none",
            flex:"0 0 auto"
        })
        const caret=CE("span",{},["▾"])
        stylize(caret,{width:"1em",display:"inline-block",textAlign:"center"})
        const label=CE("span",{},[title])
        stylize(label,{flex:"1 1 auto"})
        const hint=CE("span",{},["click to fold"])
        stylize(hint,{fontWeight:"normal",opacity:"0.5"})
        head.append(caret,label,hint)
        const content=CE("div",{className:"sa-discreet-content"},[])
        stylize(content,{
            minHeight:"0",
            minWidth:"0",
            flex:"1 1 auto",
            overflow:"auto"
        })
        container.append(head,content)
        let isFolded=!!folded
        const apply=()=>{
            content.style.display=isFolded?"none":"block"
            caret.textContent=isFolded?"▸":"▾"
            hint.textContent=isFolded?"click to unfold":"click to fold"
            head.setAttribute("aria-expanded",isFolded?"false":"true")
        }
        const toggle=()=>{
            isFolded=!isFolded
            apply()
            if(!isFolded){
                onUnfold?.()
            }
        }
        head.addEventListener("click",toggle)
        head.addEventListener("keydown",event=>{
            if(event.key==="Enter"||event.key===" "){
                event.preventDefault()
                toggle()
            }
        })
        apply()
        return {
            DOMelt:{container,head,content,caret,hint},
            toggle,
            fold:()=>{isFolded=true; apply()},
            unfold:()=>{isFolded=false; apply(); onUnfold?.()},
            get folded(){return isFolded},
            suicide:()=>container.remove()
        }
    }

    setupMainView(){
        const content=this.viewPanels.main.DOMelt.content
        content.replaceChildren()
        stylize(content,{
            display:"grid",
            gridTemplateRows:"auto minmax(0,1fr)",
            gap:"4px",
            padding:"4px"
        })
        this.plotSummary=CE("div",{className:"sa-plot-summary"},[])
        stylize(this.plotSummary,{fontSize:"0.85em",opacity:"0.9",lineHeight:"1.3"})
        this.plotHost=CE("div",{className:"sa-plot-host"},[])
        stylize(this.plotHost,{
            position:"relative",
            minHeight:"320px",
            height:"min(60vh, 560px)",
            border:"1px solid rgba(255,255,255,0.14)",
            borderRadius:"4px",
            overflow:"hidden"
        })
        content.append(this.plotSummary,this.plotHost)
        this.plot?.dispose?.()
        this.plot=new Plot3DWebGL([],`${this.title} — 3D`,this.origin,this.plotHost)
        this.plot.axisLabels={x:"—",y:"—",z:"—"}
        this._viewApplied=false
    }

    setupCompressionView(){
        const content=this.viewPanels.compression.DOMelt.content
        content.replaceChildren()
        stylize(content,{display:"grid",gap:"8px",padding:"8px",fontSize:"0.85em",lineHeight:"1.35"})
        this.seriesSummary=CE("div",{},[])
        this.seriesLevels=CE("div",{className:"sa-series-levels"},[])
        stylize(this.seriesLevels,{display:"grid",gap:"10px"})
        content.append(this.seriesSummary,this.seriesLevels)
        this.renderProjectionLevels()
    }

    setupModelsView(){
        const content=this.viewPanels.models.DOMelt.content
        content.replaceChildren()
        stylize(content,{display:"grid",gap:"6px",padding:"8px",fontSize:"0.9em",lineHeight:"1.35"})
        content.append(CE("div",{},[
            "Fitted models on sub-graphs will live here."
        ]))
        const placeholder=CE("div",{},["No model fitted yet."])
        stylize(placeholder,{
            padding:"10px",
            border:"1px dashed rgba(255,255,255,0.2)",
            borderRadius:"4px",
            opacity:"0.65"
        })
        content.appendChild(placeholder)
    }

    setupUI(){
        const content=this.accordion.DOMelt.content
        content.replaceChildren()
        this.accordion.setSizingMode("content")
        stylize(content,{display:"grid",gridTemplateColumns:"minmax(0,1fr)",gap:"6px",padding:"4px"})
        this.inputRecap=CE("div",{className:"sa-inputs"},[])
        stylize(this.inputRecap,{
            display:"grid",
            gap:"4px",
            padding:"5px 6px",
            border:"1px solid rgba(255,255,255,0.14)",
            borderRadius:"4px",
            background:"rgba(255,255,255,0.025)",
            fontSize:"0.85em"
        })
        content.appendChild(this.inputRecap)
        this.viewsButton=CE("button",{type:"button",title:"Show or hide the central analysis views"},["Hide analysis views"])
        stylize(this.viewsButton,{width:"100%",padding:"3px 6px",boxSizing:"border-box"})
        this.viewsButton.addEventListener("click",()=>{
            this.setAnalysisVisible(this.analysisDialog?.DOMelt?.window?.style.display==="none")
        })
        content.appendChild(this.viewsButton)
        const patternBox=CE("div",{className:"sa-patterns"},[])
        stylize(patternBox,{
            display:"grid",
            gap:"4px",
            padding:"5px 6px 6px",
            border:"1px solid rgba(255,255,255,0.14)",
            borderRadius:"4px",
            background:"rgba(255,255,255,0.025)"
        })
        const patternCaption=CE("div",{},["Ordered stoichiometric patterns"])
        stylize(patternCaption,{fontSize:"0.8em",opacity:"0.85"})
        const patternAddRow=CE("div",{},[])
        stylize(patternAddRow,{display:"grid",gridTemplateColumns:"minmax(0,1fr) auto",gap:"4px"})
        this.patternInput=CE("input",{
            type:"text",
            placeholder:"CH2, H2, O...",
            title:"Add a stoichiometric pattern; order defines cascade depth"
        },[])
        stylize(this.patternInput,{minWidth:"0",padding:"3px 5px",boxSizing:"border-box"})
        const addPatternButton=CE("button",{type:"button",title:"Add pattern"},["+"])
        const addPattern=()=>{
            if(this.addPattern(this.patternInput.value)){
                this.patternInput.value=""
            }
        }
        this.patternInput.addEventListener("keydown",event=>{
            if(event.key==="Enter"){
                event.preventDefault()
                addPattern()
            }
        })
        addPatternButton.addEventListener("click",addPattern)
        patternAddRow.append(this.patternInput,addPatternButton)
        this.patternRows=CE("div",{className:"sa-pattern-rows"},[])
        stylize(this.patternRows,{display:"grid",gap:"3px"})
        patternBox.append(patternCaption,patternAddRow,this.patternRows)
        content.appendChild(patternBox)
        const elementBox=CE("div",{className:"sa-elements"},[])
        stylize(elementBox,{
            display:"grid",
            gap:"4px",
            padding:"5px 6px 6px",
            border:"1px solid rgba(255,255,255,0.14)",
            borderRadius:"4px",
            background:"rgba(255,255,255,0.025)"
        })
        const caption=CE("div",{},["Elements used as dimensions"])
        stylize(caption,{fontSize:"0.8em",opacity:"0.85"})
        const addRow=CE("div",{},[])
        stylize(addRow,{display:"grid",gridTemplateColumns:"minmax(0,1fr) auto",gap:"4px"})
        this.elementInput=CE("select",{title:"Choose an element to include in the analysis"},[])
        stylize(this.elementInput,{minWidth:"0",padding:"3px 5px",boxSizing:"border-box"})
        const addButton=CE("button",{type:"button",title:"Add selected element"},["+"])
        addButton.addEventListener("click",()=>this.addElement(this.elementInput.value))
        addRow.append(this.elementInput,addButton)
        this.elementRows=CE("div",{className:"sa-element-rows"},[])
        stylize(this.elementRows,{display:"grid",gap:"3px",minHeight:"1px"})
        elementBox.append(caption,addRow,this.elementRows)
        content.appendChild(elementBox)
        this.readout=CE("div",{className:"sa-readout"},[])
        stylize(this.readout,{
            whiteSpace:"pre-wrap",
            fontFamily:"monospace",
            fontSize:"0.75em",
            lineHeight:"1.3",
            opacity:"0.8",
            minHeight:"1px"
        })
        content.appendChild(this.readout)
        this.table().then(()=>{
            if(this.elementRows){
                this.recompute()
                this.renderPatterns()
                this.renderElements()
                this.renderProjectionControls()
                this.renderProjectionLevels()
            }
        })
    }

    async startResolve(){
        this.setStatus("pending")
        await this.table()
        this.formulaCache.clear()
        this.patternCache.clear()
        this.collectInputs()
        this.recompute()
        this.renderAll()
        this.setStatus(this.inputCollections.length?"resolved":"floating")
        this.origin?.saveSessionSoon?.()
    }

    collectInputs(){
        this.inputCollections=[]
        this.diagnostics=[]
        for(let index=0;index<this.inputs.length;index++){
            this.walkAnchor(this.inputs[index],index)
        }
    }

    walkAnchor(anchor,anchorIndex){
        if(!(anchor instanceof Map)){
            return
        }
        for(const [parent,values] of anchor){
            const source=parent?.title??parent?.events?.registrationName??`input ${anchorIndex+1}`
            for(const value of values??[]){
                this.interpretValue(value,source,anchorIndex)
            }
        }
    }

    interpretValue(value,source,anchorIndex){
        if(value===null||value===undefined){
            return
        }
        if(value instanceof FormulaCollection){
            this.addCollection(value.name??source,value.entries??[],value.points??[],anchorIndex,source)
            return
        }
        if(Array.isArray(value)){
            if(value.length&&(value[0] instanceof FormulaCollection||value[0]?.formulas||value[0]?.entries)){
                for(const item of value){
                    this.interpretValue(item,source,anchorIndex)
                }
                return
            }
            this.addCollection(source,value,[],anchorIndex,source)
            return
        }
        if(value instanceof Formula||value instanceof Stoichiometry){
            this.addCollection(source,[value],[],anchorIndex,source)
            return
        }
        if(typeof value==="string"){
            this.addCollection(source,[value],[],anchorIndex,source)
            return
        }
        if(typeof value==="object"){
            const formulas=value.formulas??value.entries??value.items
            if(Array.isArray(formulas)){
                this.addCollection(value.name??value.title??source,formulas,value.points??[],anchorIndex,source)
                return
            }
            if(value.key!==undefined||value.notation!==undefined||value.formula!==undefined){
                this.addCollection(source,[value],[],anchorIndex,source)
                return
            }
            this.diagnostics.push(`${source}: nothing readable (${value.constructor?.name??typeof value})`)
            return
        }
        this.diagnostics.push(`${source}: nothing readable (${typeof value})`)
    }

    addCollection(name,rawFormulas,points,anchorIndex,source){
        if(anchorIndex===1&&this.inputCollections.some(collection=>collection.anchor===1)){
            this.diagnostics.push(`${source}: optional input keeps only the first collection`)
            return
        }
        const seen=new Set()
        const records=[]
        for(const raw of rawFormulas??[]){
            const formula=this.formulaFromEntry(raw)
            if(!formula||seen.has(formula.key)){
                continue
            }
            seen.add(formula.key)
            const asFinite=value=>value===null||value===undefined||value===""?NaN:Number(value)
            const targets=Array.isArray(raw?.targets)
                ?raw.targets
                :raw?.target?[raw.target]:[]
            const targetIntensity=targets.reduce((total,target)=>
                total+(Number.isFinite(asFinite(target?.intensity))?asFinite(target.intensity):0),0)
            const suppliedIntensity=asFinite(raw?.intensity)
            records.push({
                formula,
                intensity:Number.isFinite(suppliedIntensity)?suppliedIntensity:targetIntensity,
                targets:targets.map(target=>({
                    mz:asFinite(target?.mz),
                    intensity:asFinite(target?.intensity),
                    errorPpm:asFinite(target?.errorPpm),
                    index:target?.index
                }))
            })
        }
        this.inputCollections.push({
            name:String(name??"collection"),
            source:String(source??""),
            anchor:anchorIndex,
            records,
            formulas:records.map(record=>record.formula),
            pointCount:Array.isArray(points)?points.length:0
        })
    }

    formulaFromEntry(raw){
        if(raw instanceof Formula||raw instanceof Stoichiometry){
            return raw
        }
        if(typeof raw==="string"){
            return this.parseFormula(raw)
        }
        if(raw&&typeof raw==="object"){
            if(raw.formula instanceof Formula||raw.formula instanceof Stoichiometry){
                return raw.formula
            }
            const text=raw.notation??raw.key??(typeof raw.formula==="string"?raw.formula:null)
            if(text){
                return this.parseFormula(String(text))
            }
        }
        return null
    }

    parseFormula(text){
        if(!this.loadedTable){
            this.diagnostics.push("periodic table not loaded")
            return null
        }
        if(this.formulaCache.has(text)){
            return this.formulaCache.get(text)
        }
        let formula=null
        try{
            formula=Formula.parse(String(text),this.loadedTable)
        }catch(error){
            this.diagnostics.push(`cannot read formula "${text}": ${error?.message??error}`)
        }
        this.formulaCache.set(text,formula)
        return formula
    }

    /* The MODEL half: everything that depends on the inputs and the ordered
       patterns — compositions, the cumulative integer lattices, the quotient
       classes. It deliberately does NOT look at `parameters.elements`: the
       chosen dimensions of the 3D view are a projection of the same
       stoichiometry, not a different one. Keeping the two apart is what makes
       changing an axis cheap instead of rebuilding every lattice. */
    recomputeModel(){
        this.patternErrors=[]
        const patterns=this.patterns().map((text,index)=>({
            text,
            index,
            formula:this.parsePattern(text)
        }))
        const formulaRecords=this.inputCollections.flatMap(collection=>
            collection.records.map(record=>({...record,collection}))
        )
        const usedSymbols=new Set()
        for(const record of formulaRecords){
            for(const symbol of this.compositionOf(record.formula).keys()){
                usedSymbols.add(symbol)
            }
        }
        for(const pattern of patterns){
            if(!pattern.formula||!this.compositionOf(pattern.formula).size){
                this.patternErrors.push(`pattern "${pattern.text}" has no readable stoichiometry`)
                continue
            }
            for(const symbol of this.compositionOf(pattern.formula).keys()){
                usedSymbols.add(symbol)
            }
        }
        this.stoichiometricDimensions=(this.loadedTable?.elements??[])
            .filter(element=>usedSymbols.has(element.symbol))
            .map(element=>element.symbol)
        const dimensionIndex=new Map(this.stoichiometricDimensions.map((symbol,index)=>[symbol,index]))
        const vectorCache=new Map()
        const vectorFor=formula=>{
            const cacheKey=formula?.key??String(formula)
            if(vectorCache.has(cacheKey)){
                return vectorCache.get(cacheKey)
            }
            const vector=new Array(this.stoichiometricDimensions.length).fill(0)
            for(const [symbol,count] of this.compositionOf(formula)){
                const index=dimensionIndex.get(symbol)
                if(index!==undefined){
                    vector[index]=count
                }
            }
            vectorCache.set(cacheKey,vector)
            return vector
        }
        this.collectionPoints=this.inputCollections.map(collection=>({
            ...collection,
            points:collection.records.map(record=>({
                key:record.formula.key,
                notation:String(record.formula),
                formula:record.formula,
                collection,
                intensity:record.intensity,
                targets:record.targets,
                counts:this.compositionOf(record.formula),
                stoichiometry:vectorFor(record.formula)
            }))
        }))
        this.projectionLevels=[]
        const prefix=[]
        const prefixTexts=[]
        let parentGroups=null
        const dimensionSignature=this.stoichiometricDimensions.join(",")
        const latticeCache=this.latticeCache??(this.latticeCache=new Map())
        for(const pattern of patterns){
            if(!pattern.formula||!this.compositionOf(pattern.formula).size){
                continue
            }
            prefix.push(vectorFor(pattern.formula))
            prefixTexts.push(pattern.text)
            if(!this.stoichiometricDimensions.length){
                continue
            }
            const matrix=this.stoichiometricDimensions.map((_,rowIndex)=>
                prefix.map(vector=>vector[rowIndex])
            )
            const cacheKey=`${dimensionSignature}#${prefixTexts.join("|")}`
            let lattice=latticeCache.get(cacheKey)
            if(!lattice){
                lattice=columnLatticeBasis(matrix)
                latticeCache.set(cacheKey,lattice)
            }
            const previousLattice=parentGroups?.lattice??null
            const gainedRank=lattice.rank-(previousLattice?.rank??0)
            const groups=new Map()
            for(const collection of this.collectionPoints){
                for(const point of collection.points){
                    const representative=quotientRepresentative(point.stoichiometry,lattice)
                    const key=representative.join(",")
                    const parentKey=previousLattice
                        ?quotientRepresentative(point.stoichiometry,previousLattice).join(",")
                        :"root"
                    let group=groups.get(key)
                    if(!group){
                        group={key,parentKey,representative,formulas:[],intensity:0,targetCount:0}
                        groups.set(key,group)
                    }
                    group.formulas.push(point)
                    group.intensity+=Number.isFinite(point.intensity)?point.intensity:0
                    group.targetCount+=point.targets.length
                }
            }
            this.projectionLevels.push({
                pattern:pattern.text,
                index:pattern.index,
                lattice,
                rank:lattice.rank,
                quotientIndex:lattice.index,
                freeDimensions:lattice.dimension-lattice.rank,
                gainedRank,
                redundant:gainedRank===0,
                vectors:prefix.map(vector=>[...vector]),
                patternTexts:[...prefixTexts],
                groups:[...groups.values()].sort((left,right)=>
                    right.formulas.length-left.formulas.length||left.key.localeCompare(right.key)
                )
            })
            const previous=this.projectionLevels.length>1
                ?this.projectionLevels[this.projectionLevels.length-2].groups
                :[]
            const parentIndices=new Map(previous.map((group,index)=>[group.key,index+1]))
            for(const group of this.projectionLevels[this.projectionLevels.length-1].groups){
                group.parentNumber=parentIndices.get(group.parentKey)??null
            }
            parentGroups=this.projectionLevels[this.projectionLevels.length-1]
        }
        this.pointTotal=this.collectionPoints.reduce((total,collection)=>total+collection.points.length,0)
    }

    /* The PROJECTION half: the per-element coordinate arrays the 3D view reads.
       Only this runs when the selected elements change. */
    recomputeProjection(){
        const elements=this.elements()
        for(const collection of this.collectionPoints){
            for(const point of collection.points){
                point.values=elements.map(symbol=>point.counts?.get(symbol)||0)
            }
        }
    }

    recompute(){
        this.recomputeModel()
        this.recomputeProjection()
    }

    /* The written stoichiometry of a formula, keyed by element symbol, cached
       by the formula's identity. It is read once per formula per model rebuild
       instead of once per element per point per level. */
    compositionOf(formula){
        if(!formula){
            return new Map()
        }
        const cacheKey=formula.key??String(formula)
        const cache=this.compositionCache??(this.compositionCache=new Map())
        if(cache.has(cacheKey)){
            return cache.get(cacheKey)
        }
        const counts=new Map()
        for(const [element,count] of this.writtenElementCounts(formula)){
            const symbol=element?.symbol
            if(!symbol){
                continue
            }
            counts.set(symbol,(counts.get(symbol)||0)+(Number(count)||0))
        }
        cache.set(cacheKey,counts)
        return counts
    }

    parsePattern(text){
        if(!this.loadedTable){
            return null
        }
        if(this.patternCache.has(text)){
            return this.patternCache.get(text)
        }
        let formula=null
        try{
            formula=Formula.parse(String(text),this.loadedTable)
        }catch{}
        this.patternCache.set(text,formula)
        return formula
    }

    writtenElementCounts(formula){
        const counts=new Map()
        const composition=formula?.written
        if(!(composition instanceof Map)){
            return counts
        }
        for(const [element,byA] of composition){
            let count=0
            if(byA instanceof Map){
                for(const value of byA.values()){
                    count+=Number(value)||0
                }
            }else{
                count=Number(byA)||0
            }
            if(count){
                counts.set(element,count)
            }
        }
        return counts
    }

    countElement(formula,symbol){
        for(const [element,count] of this.writtenElementCounts(formula)){
            if(element.symbol===symbol){
                return count
            }
        }
        return 0
    }

    setAnalysisVisible(visible){
        if(!this.analysisDialog){
            return
        }
        this.analysisDialog.DOMelt.window.style.display=visible?"grid":"none"
        if(this.viewsButton){
            this.viewsButton.textContent=visible?"Hide analysis views":"Open analysis views"
        }
        if(visible){
            this.analysisDialog.DOMelt.window.focus?.()
            requestAnimationFrame(()=>this.plot?.handleResize?.())
        }
    }

    renderAll(){
        if(!this.accordion){
            return
        }
        this.renderInputRecap()
        this.renderPatterns()
        this.renderElements()
        this.renderProjectionControls()
        this.renderProjectionLevels()
        this.renderReadout()
        this.refreshPlot()
    }

    renderPatterns(){
        if(!this.patternRows){
            return
        }
        this.patternRows.replaceChildren()
        const patterns=this.patterns()
        if(!patterns.length){
            const empty=CE("div",{},["No patterns: all formulas remain separate."])
            stylize(empty,{fontSize:"0.8em",opacity:"0.65"})
            this.patternRows.appendChild(empty)
            return
        }
        patterns.forEach((pattern,index)=>{
            const row=CE("div",{},[])
            stylize(row,{
                display:"grid",
                gridTemplateColumns:"minmax(0,1fr) auto auto auto",
                alignItems:"center",
                gap:"3px",
                padding:"3px 4px",
                border:"1px solid rgba(255,255,255,0.12)",
                borderRadius:"3px",
                background:"rgba(255,255,255,0.035)"
            })
            const formula=CE("span",{},[`${index+1}. ${pattern}`])
            stylize(formula,{fontFamily:"monospace",fontSize:"0.82em"})
            const up=CE("button",{type:"button",title:"Move pattern up",disabled:index===0},["↑"])
            const down=CE("button",{type:"button",title:"Move pattern down",disabled:index===patterns.length-1},["↓"])
            const remove=CE("button",{type:"button",title:`Remove ${pattern}`},["×"])
            for(const button of [up,down,remove]){
                stylize(button,{padding:"0 4px",lineHeight:"1.2",minWidth:"0"})
            }
            up.addEventListener("click",()=>this.movePattern(index,index-1))
            down.addEventListener("click",()=>this.movePattern(index,index+1))
            remove.addEventListener("click",()=>this.removePattern(index))
            row.append(formula,up,down,remove)
            const parsed=this.parsePattern(pattern)
            if(!parsed||!this.writtenElementCounts(parsed).size){
                row.title=`Pattern ${pattern} has no readable stoichiometry`
                row.style.borderColor="rgba(255,120,100,0.6)"
            }
            this.patternRows.appendChild(row)
        })
    }

    renderProjectionLevels(){
        if(!this.seriesSummary||!this.seriesLevels){
            return
        }
        this.seriesSummary.textContent=this.patterns().length
            ?`${this.pointTotal} formula${this.pointTotal===1?"":"s"} · ${this.stoichiometricDimensions.length} dimension${this.stoichiometricDimensions.length===1?"":"s"} · cumulative integer-lattice quotients`
            :"Add an ordered pattern to build stoichiometric groups."
        this.seriesLevels.replaceChildren()
        const dimensionCaption=this.stoichiometricDimensions.length
            ?`[${this.stoichiometricDimensions.join(", ")}]`
            :"[]"
        /* ONE FOLDER PER RANK. The levels are cumulative, so rank only grows;
           grouping consecutive levels by rank leaves each rank a single
           collapsible block whose header sits right where the previous rank
           ends. Folding rank 1 therefore reveals rank 2 without scrolling
           through rank 1's groups first. Levels that add no rank (redundant
           patterns) fall into the same folder as their parent rank. */
        const rankFolders=[]
        const rankFolderByRank=new Map()
        for(const level of this.projectionLevels){
            let folder=rankFolderByRank.get(level.rank)
            if(!folder){
                folder={
                    rank:level.rank,
                    dimension:level.lattice.dimension,
                    levels:[],
                    groupCount:0
                }
                rankFolderByRank.set(level.rank,folder)
                rankFolders.push(folder)
            }
            folder.levels.push(level)
            folder.groupCount+=level.groups.length
        }
        for(const rankFolder of rankFolders){
            const folder=CE("details",{className:"sa-rank-folder"},[])
            folder.open=true
            stylize(folder,{display:"grid",gap:"6px",padding:"4px 0",borderTop:"2px solid rgba(255,255,255,0.22)"})
            const free=Math.max(0,rankFolder.dimension-rankFolder.rank)
            const folderSummary=CE("summary",{},[
                `Rank ${rankFolder.rank}/${rankFolder.dimension} · ${rankFolder.groupCount} group${rankFolder.groupCount===1?"":"s"} · ${free} free dimension${free===1?"":"s"} · ${rankFolder.levels.length} pattern${rankFolder.levels.length===1?"":"s"}`
            ])
            stylize(folderSummary,{cursor:"pointer",fontWeight:"700",padding:"2px 0"})
            folder.appendChild(folderSummary)
            for(const level of rankFolder.levels){
                const section=CE("section",{className:"sa-series-level"},[])
                stylize(section,{display:"grid",gap:"4px",paddingTop:"6px",borderTop:"1px solid rgba(255,255,255,0.14)"})
                const quotient=level.quotientIndex===null
                    ?"infinite quotient"
                    :`index ${this.formatIntensity(level.quotientIndex)}`
                const heading=CE("div",{},[
                    `After ${level.index+1}: ${level.pattern} · ${level.groups.length} group${level.groups.length===1?"":"s"}`,
                    ` · rank ${level.rank}/${level.lattice.dimension} · ${quotient} · +${level.gainedRank} constraint${level.gainedRank===1?"":"s"}`
                ])
                stylize(heading,{
                    fontWeight:"600",
                    opacity:level.redundant?"0.6":"1"
                })
                section.appendChild(heading)
                if(level.redundant){
                    const warning=CE("div",{},[
                        "This pattern adds no new class: it lies in the cumulative lattice."
                    ])
                    stylize(warning,{fontSize:"0.78em",opacity:"0.7",fontStyle:"italic"})
                    section.appendChild(warning)
                }
                if(!level.groups.length){
                    section.appendChild(CE("div",{},["No formulas in this level."]))
                }
                for(const [groupIndex,group] of level.groups.entries()){
                    const details=CE("details",{},[])
                    stylize(details,{padding:"3px 5px",border:"1px solid rgba(255,255,255,0.12)",borderRadius:"3px",background:"rgba(255,255,255,0.025)"})
                    const parent=group.parentNumber?` · from group ${group.parentNumber}`:""
                    const summary=CE("summary",{},[
                        `Group ${groupIndex+1}${parent} · ${group.formulas.length} formula${group.formulas.length===1?"":"s"} · ΣI ${this.formatIntensity(group.intensity)} · ${group.targetCount} targets`
                    ])
                    stylize(summary,{cursor:"pointer"})
                    details.appendChild(summary)
                    const representative=CE("div",{},[`representative ${dimensionCaption} = [${group.representative.join(", ")}]`])
                    stylize(representative,{
                        fontFamily:"monospace",
                        fontSize:"0.78em",
                        opacity:"0.8",
                        padding:"2px 0 0 0"
                    })
                    details.appendChild(representative)
                    const members=CE("div",{},[])
                    stylize(members,{display:"grid",gap:"3px",padding:"5px 0 2px 8px"})
                    for(const point of group.formulas){
                        const formulaRow=CE("div",{},[])
                        stylize(formulaRow,{display:"grid",gridTemplateColumns:"minmax(0,1fr) auto",gap:"6px",alignItems:"baseline"})
                        const label=CE("span",{},[`${point.notation} · ${point.collection.name}`])
                        stylize(label,{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"})
                        const intensity=CE("span",{},[`I ${this.formatIntensity(point.intensity)}`])
                        stylize(intensity,{fontFamily:"monospace",fontSize:"0.78em",whiteSpace:"nowrap"})
                        formulaRow.append(label,intensity)
                        members.appendChild(formulaRow)
                        if(point.targets.length){
                            const targets=CE("details",{},[])
                            const targetSummary=CE("summary",{},[`${point.targets.length} measured target${point.targets.length===1?"":"s"}`])
                            stylize(targetSummary,{cursor:"pointer",fontSize:"0.8em",opacity:"0.75"})
                            const targetRows=point.targets.map(target=>{
                                const mz=Number.isFinite(target.mz)?target.mz.toFixed(5):"—"
                                const targetIntensity=this.formatIntensity(target.intensity)
                                const error=Number.isFinite(target.errorPpm)?` · ${target.errorPpm.toFixed(2)} ppm`:""
                                return CE("div",{},[`m/z ${mz} · I ${targetIntensity}${error}`])
                            })
                            stylize(targets,{paddingLeft:"12px"})
                            targets.append(targetSummary,...targetRows)
                            members.appendChild(targets)
                        }
                    }
                    details.appendChild(members)
                    section.appendChild(details)
                }
                folder.appendChild(section)
            }
            this.seriesLevels.appendChild(folder)
        }
    }

    formatIntensity(value){
        return Number.isFinite(value)?new Intl.NumberFormat(undefined,{maximumSignificantDigits:5}).format(value):"0"
    }

    patterns(){
        return Array.isArray(this.parameters.patterns)?this.parameters.patterns:[]
    }

    addPattern(value){
        const pattern=String(value??"").trim()
        if(!pattern||this.patterns().includes(pattern)){
            return false
        }
        this.setPatterns([...this.patterns(),pattern])
        return true
    }

    removePattern(index){
        if(index<0||index>=this.patterns().length){
            return
        }
        const patterns=this.patterns().slice()
        patterns.splice(index,1)
        this.setPatterns(patterns)
    }

    movePattern(from,to){
        const patterns=this.patterns().slice()
        if(from<0||from>=patterns.length||to<0||to>=patterns.length){
            return
        }
        const [pattern]=patterns.splice(from,1)
        patterns.splice(to,0,pattern)
        this.setPatterns(patterns)
    }

    setPatterns(patterns){
        this.parameters.patterns=patterns
        this.patternCache.clear()
        this.recompute()
        this.renderAll()
        this.origin?.saveSessionSoon?.()
    }

    renderInputRecap(){
        if(!this.inputRecap){
            return
        }
        this.inputRecap.replaceChildren()
        const title=CE("div",{},["Inputs"])
        stylize(title,{fontWeight:"600",opacity:"0.9"})
        this.inputRecap.appendChild(title)
        if(!this.inputCollections.length){
            const empty=CE("div",{},["Nothing connected yet."])
            stylize(empty,{opacity:"0.65"})
            this.inputRecap.appendChild(empty)
            return
        }
        this.inputCollections.forEach((collection,index)=>{
            const row=CE("div",{},[])
            stylize(row,{
                display:"grid",
                gridTemplateColumns:"minmax(0,1fr) auto",
                gap:"6px",
                alignItems:"baseline",
                padding:"3px 0",
                borderTop:"1px solid rgba(255,255,255,0.08)"
            })
            const left=CE("div",{},[])
            const name=CE("div",{},[`${index+1}. ${collection.name}`])
            stylize(name,{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"})
            const source=CE("div",{},[
                `${collection.source}${collection.anchor===1?" · optional input":""}`
            ])
            stylize(source,{fontSize:"0.85em",opacity:"0.6",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"})
            left.append(name,source)
            const right=CE("div",{},[
                `${collection.formulas.length} formula${collection.formulas.length===1?"":"s"}`
            ])
            stylize(right,{fontFamily:"monospace",fontSize:"0.78em",opacity:"0.8",whiteSpace:"nowrap"})
            row.append(left,right)
            this.inputRecap.appendChild(row)
        })
        const summary=CE("div",{},[
            `${this.pointTotal} formula${this.pointTotal===1?"":"s"} · ${this.elements().length} element${this.elements().length===1?"":"s"}`
        ])
        stylize(summary,{fontSize:"0.8em",opacity:"0.65",paddingTop:"3px"})
        this.inputRecap.appendChild(summary)
    }

    renderElements(){
        if(!this.elementRows||!this.elementInput){
            return
        }
        const selected=this.elements()
        const available=this.availableElements()
        this.elementInput.replaceChildren()
        this.elementInput.appendChild(CE("option",{value:""},[
            available.length?"Choose element...":"Loading elements..."
        ]))
        for(const symbol of available){
            if(!selected.includes(symbol)){
                this.elementInput.appendChild(CE("option",{value:symbol},[symbol]))
            }
        }
        this.elementInput.disabled=!available.some(symbol=>!selected.includes(symbol))
        this.elementRows.replaceChildren()
        if(!selected.length){
            const empty=CE("div",{},["No elements selected."])
            stylize(empty,{opacity:"0.6",fontSize:"0.85em",padding:"3px 0"})
            this.elementRows.appendChild(empty)
            return
        }
        selected.forEach((symbol,index)=>{
            const row=CE("div",{className:"sa-element-row"},[])
            stylize(row,{
                display:"flex",
                justifyContent:"space-between",
                alignItems:"center",
                padding:"3px 4px",
                border:"1px solid rgba(255,255,255,0.12)",
                borderRadius:"3px",
                background:"rgba(255,255,255,0.035)"
            })
            const text=CE("span",{},[`${symbol} · ${this.elementName(symbol)}`])
            stylize(text,{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"})
            const remove=CE("button",{type:"button",title:`Remove ${symbol}`},["×"])
            stylize(remove,{padding:"0",lineHeight:"1.1",minWidth:"0"})
            remove.addEventListener("click",event=>{
                event.stopPropagation()
                this.removeElement(index)
            })
            row.append(text,remove)
            this.elementRows.appendChild(row)
        })
    }

    elementName(symbol){
        return this.loadedTable?.elements?.find(element=>element.symbol===symbol)?.name??symbol
    }

    renderProjectionControls(){
        if(!this.projectionControls){
            return
        }
        this.projectionControls.replaceChildren()
        stylize(this.projectionControls,{
            display:"grid",
            gap:"5px",
            padding:"5px 6px",
            border:"1px solid rgba(255,255,255,0.14)",
            borderRadius:"4px",
            background:"rgba(255,255,255,0.025)"
        })
        const title=CE("div",{},["Projections"])
        stylize(title,{fontWeight:"600",fontSize:"0.85em"})
        this.projectionControls.appendChild(title)
        this.axisButtons={}
        this.orthoButton=CE("button",{type:"button",title:"Toggle perspective / orthographic projection"},["Perspective"])
        stylize(this.orthoButton,{fontSize:"0.78em",padding:"2px 5px"})
        this.orthoButton.addEventListener("click",()=>this.toggleOrthographic())
        const viewRow=CE("div",{},[])
        stylize(viewRow,{display:"flex",gap:"4px",flexWrap:"wrap",alignItems:"center"})
        viewRow.appendChild(this.orthoButton)
        for(const axis of Object.keys(AXIS_VIEW_ANGLES)){
            const button=CE("button",{
                type:"button",
                title:`Look along ${axis}; the other two axes become a 2D scatter`
            },[axis])
            stylize(button,{fontSize:"0.78em",padding:"2px 6px",minWidth:"1.9em"})
            button.addEventListener("click",()=>this.pointAlongAxis(axis))
            this.axisButtons[axis]=button
            viewRow.appendChild(button)
        }
        this.projectionControls.appendChild(viewRow)
        this.updateViewButtons()
        const elements=this.elements()
        if(!elements.length){
            const empty=CE("div",{},["Add an element to choose axes."])
            stylize(empty,{fontSize:"0.8em",opacity:"0.6"})
            this.projectionControls.appendChild(empty)
            return
        }
        const axisGrid=CE("div",{},[])
        stylize(axisGrid,{display:"grid",gridTemplateColumns:"auto minmax(0,1fr)",gap:"3px 6px",alignItems:"center"})
        for(const key of AXIS_KEYS){
            const label=CE("label",{},[`${key.toUpperCase()} axis`])
            stylize(label,{fontSize:"0.8em",opacity:"0.8"})
            const select=CE("select",{},[])
            stylize(select,{minWidth:"0",padding:"2px 4px"})
            const none=CE("option",{value:"-1"},["(none)"])
            select.appendChild(none)
            elements.forEach((symbol,index)=>{
                select.appendChild(CE("option",{value:String(index)},[`${index+1}. ${symbol}`]))
            })
            const value=this.axisValue(key)
            select.value=String(value)
            select.addEventListener("change",()=>{
                this.parameters.projection[key]=Number(select.value)
                this.refreshPlot()
                this.origin?.saveSessionSoon?.()
            })
            axisGrid.append(label,select)
        }
        this.projectionControls.appendChild(axisGrid)
        const checks=CE("div",{},[])
        stylize(checks,{display:"grid",gap:"3px",fontSize:"0.8em"})
        checks.appendChild(this.checkboxRow(
            "Show formula cloud",
            this.parameters.projection.showCloud!==false,
            checked=>{
                this.parameters.projection.showCloud=checked
                this.refreshPlot()
                this.origin?.saveSessionSoon?.()
            }
        ))
        checks.appendChild(this.checkboxRow(
            "Show XY / XZ / YZ projections",
            this.parameters.projection.showProjections!==false,
            checked=>{
                this.parameters.projection.showProjections=checked
                this.refreshPlot()
                this.origin?.saveSessionSoon?.()
            }
        ))
        const sizeRow=CE("div",{},[])
        stylize(sizeRow,{display:"grid",gridTemplateColumns:"1fr auto",gap:"6px",alignItems:"center"})
        const sizeLabel=CE("label",{},["Point size"])
        const sizeInput=CE("input",{type:"number",min:"1",max:"12",step:"1"},[])
        stylize(sizeInput,{width:"4em",padding:"1px 3px"})
        sizeInput.value=String(this.pointSize())
        sizeInput.addEventListener("change",()=>{
            const value=Number(sizeInput.value)
            this.parameters.projection.pointSize=Number.isFinite(value)?Math.max(1,Math.min(12,value)):3
            sizeInput.value=String(this.pointSize())
            this.refreshPlot()
            this.origin?.saveSessionSoon?.()
        })
        sizeRow.append(sizeLabel,sizeInput)
        checks.appendChild(sizeRow)
        const colourRow=CE("div",{},[])
        stylize(colourRow,{display:"grid",gridTemplateColumns:"1fr minmax(0,1.4fr)",gap:"6px",alignItems:"center"})
        const colourLabel=CE("label",{},["Colour by"])
        const colourSelect=CE("select",{},[])
        stylize(colourSelect,{minWidth:"0",padding:"2px 4px"})
        colourSelect.appendChild(CE("option",{value:"collection"},["Formula collection"]))
        for(const level of this.projectionLevels){
            colourSelect.appendChild(CE("option",{value:String(level.index)},[
                `Level ${level.index+1} · ${level.pattern} (${level.groups.length})`
            ]))
        }
        const colourValue=this.colorLevel()?String(this.colorLevel().index):"collection"
        colourSelect.value=colourValue
        colourSelect.addEventListener("change",()=>{
            this.parameters.projection.colorBy=colourSelect.value==="collection"
                ?"collection"
                :Number(colourSelect.value)
            this.refreshPlot()
            this.origin?.saveSessionSoon?.()
        })
        colourRow.append(colourLabel,colourSelect)
        checks.appendChild(colourRow)
        if(this.projectionLevels.length){
            checks.appendChild(this.checkboxRow(
                "Show pattern vectors",
                this.parameters.projection.showPatternVectors===true,
                checked=>{
                    this.parameters.projection.showPatternVectors=checked
                    this.refreshPlot()
                    this.origin?.saveSessionSoon?.()
                }
            ))
        }
        this.projectionControls.appendChild(checks)
    }

    toggleOrthographic(){
        if(!this.plot){
            return
        }
        this.plot.setCameraType(!this.plot._orthographic)
        this.plot.requestFrame?.()
        this.plot.drawOverlay?.()
        this.parameters.projection.orthographic=!!this.plot._orthographic
        this.updateViewButtons()
        this.origin?.saveSessionSoon?.()
    }

    pointAlongAxis(axis){
        const angles=AXIS_VIEW_ANGLES[axis]
        if(!this.plot||!angles){
            return
        }
        if(!this.plot._orthographic){
            this.plot.setCameraType(true)
        }
        this.plot.controls?.frame(Plot3DWebGL.WORLD_BOX,{resetAngles:true,angles})
        this.plot.requestFrame?.()
        this.plot.drawOverlay?.()
        this.parameters.projection.orthographic=true
        this.parameters.projection.axis=axis.toLowerCase()
        this.updateViewButtons()
        this.origin?.saveSessionSoon?.()
    }

    updateViewButtons(){
        if(this.orthoButton){
            const orthographic=!!this.plot?._orthographic
            this.orthoButton.textContent=orthographic?"Orthographic":"Perspective"
            this.orthoButton.setAttribute("aria-pressed",String(orthographic))
            stylize(this.orthoButton,{
                borderColor:orthographic?"rgba(172,255,47,0.8)":"",
                boxShadow:orthographic?"0 0 0 1px rgba(172,255,47,0.35)":"none"
            })
        }
        const active=this.parameters.projection?.axis??null
        for(const [axis,button] of Object.entries(this.axisButtons??{})){
            const selected=axis.toLowerCase()===active
            button.setAttribute("aria-pressed",String(selected))
            stylize(button,{
                borderColor:selected?"rgba(172,255,47,0.8)":"",
                boxShadow:selected?"0 0 0 1px rgba(172,255,47,0.35)":"none"
            })
        }
    }

    applyRestoredView(){
        if(this._viewApplied||!this.plot){
            return
        }
        this._viewApplied=true
        const orthographic=this.parameters.projection?.orthographic===true
        if(orthographic!==!!this.plot._orthographic){
            this.plot.setCameraType(orthographic)
        }
        const axis=String(this.parameters.projection?.axis??"").toUpperCase()
        const angles=AXIS_VIEW_ANGLES[axis]
        if(angles&&this.plot.controls){
            this.plot.controls.frame(Plot3DWebGL.WORLD_BOX,{resetAngles:true,angles})
            this.plot.requestFrame?.()
            this.plot.drawOverlay?.()
        }
        this.updateViewButtons()
    }

    checkboxRow(label,checked,onChange){
        const row=CE("label",{},[])
        stylize(row,{display:"flex",gap:"5px",alignItems:"center",cursor:"pointer"})
        const input=CE("input",{type:"checkbox"},[])
        input.checked=checked
        input.addEventListener("change",()=>onChange(input.checked))
        row.append(input,CE("span",{},[label]))
        return row
    }

    renderReadout(){
        if(!this.readout){
            return
        }
        const lines=[]
        if(!this.loadedTable){
            lines.push("periodic table not loaded")
        }
        lines.push(...this.patternErrors)
        lines.push(...this.diagnostics.slice(0,20))
        if(this.diagnostics.length>20){
            lines.push(`… ${this.diagnostics.length-20} more diagnostic(s)`)
        }
        this.readout.textContent=lines.join("\n")
    }

    axisValue(key){
        const count=this.elements().length
        const value=this.parameters.projection?.[key]
        if(value===-1){
            return -1
        }
        if(Number.isInteger(value)&&value>=0&&value<count){
            return value
        }
        const defaults={x:0,y:1,z:2}
        const fallback=defaults[key]??0
        return fallback<count?fallback:-1
    }

    pointSize(){
        const value=Number(this.parameters.projection?.pointSize)
        return Number.isFinite(value)?Math.max(1,Math.min(12,value)):3
    }

    waveFor(points,axes,labels,constants=[0,0,0]){
        const wave=new Wave(points.length,1,3)
        wave.labels=Wave.normalizeLabels(labels,["x","y","z"])
        const core=wave.core
        points.forEach((point,index)=>{
            const values=point.values
            for(let axis=0;axis<3;axis++){
                const sourceIndex=axes[axis]
                core[wave.index(index,0,axis)]=sourceIndex>=0
                    ?Number(values[sourceIndex])||0
                    :Number(constants[axis])||0
            }
        })
        return wave
    }

    colorLevel(){
        const colorBy=this.parameters.projection?.colorBy
        if(colorBy==="collection"||colorBy===undefined||colorBy===null){
            return null
        }
        const levelIndex=Number(colorBy)
        if(!Number.isFinite(levelIndex)){
            return null
        }
        return this.projectionLevels.find(level=>level.index===levelIndex)??null
    }

    /* The 3D view of a cumulative lattice: the generator of every pattern up to
       the chosen level, anchored at the origin of the elemental space. These are
       the directions the quotient ignores, so drawing them beside the classes
       says exactly what the projection is collapsing. */
    patternVectorTraces(level,axes,labels){
        if(!level){
            return []
        }
        const elements=this.elements()
        const dimensionIndex=new Map(this.stoichiometricDimensions.map((symbol,index)=>[symbol,index]))
        const origin=elements.map(()=>0)
        const traces=[]
        level.vectors.forEach((vector,patternIndex)=>{
            const values=elements.map(symbol=>{
                const index=dimensionIndex.get(symbol)
                return index===undefined?0:Number(vector[index])||0
            })
            if(!values.some(value=>value!==0)){
                return
            }
            traces.push(new Segment3DTrace({
                id:`sa-pattern-${level.index}-${patternIndex}`,
                title:`${level.patternTexts[patternIndex]} — pattern vector`,
                wave:this.waveFor([{values:origin},{values}],axes,labels),
                options:{color:traceColor(patternIndex),opacity:0.9}
            }))
        })
        return traces
    }

    refreshPlot(){
        if(!this.plot){
            return
        }
        const elements=this.elements()
        const axes=AXIS_KEYS.map(key=>this.axisValue(key))
        const labels=axes.map(index=>index>=0?elements[index]:"—")
        this.plot.axisLabels={x:labels[0],y:labels[1],z:labels[2]}
        if(!axes.some(index=>index>=0)){
            this.plot.setTraces([])
            this.applyRestoredView()
            if(this.plotSummary){
                this.plotSummary.textContent=`${this.pointTotal} formula${this.pointTotal===1?"":"s"} · no axis selected`
            }
            return
        }
        const colorLevel=this.colorLevel()
        const groupIndex=colorLevel?new Map():null
        if(colorLevel){
            colorLevel.groups.forEach((group,index)=>{
                for(const point of group.formulas){
                    groupIndex.set(point,index)
                }
            })
        }
        const mins=[Infinity,Infinity,Infinity]
        for(const collection of this.collectionPoints){
            for(const point of collection.points){
                axes.forEach((axis,index)=>{
                    if(axis>=0){
                        mins[index]=Math.min(mins[index],Number(point.values[axis])||0)
                    }
                })
            }
        }
        for(let index=0;index<3;index++){
            if(!Number.isFinite(mins[index])){
                mins[index]=0
            }
        }
        const traces=[]
        const pointSize=this.pointSize()
        this.collectionPoints.forEach((collection,index)=>{
            if(!collection.points.length){
                return
            }
            const color=traceColor(index)
            const pointColors=groupIndex
                ?collection.points.map(point=>groupColor(groupIndex.get(point)??0))
                :null
            const cloudOptions={size:pointSize,color,opacity:0.92}
            if(pointColors){
                cloudOptions.pointColors=pointColors
            }
            if(this.parameters.projection.showCloud!==false){
                traces.push(new Scatter3DTrace({
                    id:`sa-cloud-${index}`,
                    title:collection.name,
                    wave:this.waveFor(collection.points,axes,labels),
                    options:{...cloudOptions}
                }))
            }
            if(this.parameters.projection.showProjections!==false){
                const planes=[
                    {name:"XY",waveAxes:[axes[0],axes[1],-1],constants:[0,0,mins[2]]},
                    {name:"XZ",waveAxes:[axes[0],-1,axes[2]],constants:[0,mins[1],0]},
                    {name:"YZ",waveAxes:[-1,axes[1],axes[2]],constants:[mins[0],0,0]}
                ]
                for(const plane of planes){
                    traces.push(new Scatter3DTrace({
                        id:`sa-${plane.name}-${index}`,
                        title:`${collection.name} — ${plane.name}`,
                        wave:this.waveFor(collection.points,plane.waveAxes,labels,plane.constants),
                        options:{...cloudOptions,size:Math.max(1,pointSize-1),opacity:0.35}
                    }))
                }
            }
        })
        if(this.parameters.projection.showPatternVectors===true){
            const vectorLevel=colorLevel??this.projectionLevels[this.projectionLevels.length-1]??null
            traces.push(...this.patternVectorTraces(vectorLevel,axes,labels))
            for(let index=0;index<3;index++){
                mins[index]=Math.min(mins[index],0)
            }
        }
        this.plot.setTraces(traces)
        this.applyRestoredView()
        if(this.plotSummary){
            const used=AXIS_KEYS
                .map((key,index)=>axes[index]>=0?`${key.toUpperCase()}=${elements[axes[index]]}`:null)
                .filter(Boolean)
                .join(" · ")
            const parts=[`${this.pointTotal} formula${this.pointTotal===1?"":"s"}`]
            if(used){
                parts.push(used)
            }
            if(colorLevel){
                parts.push(`coloured by level ${colorLevel.index+1} (${colorLevel.pattern}) · ${colorLevel.groups.length} class${colorLevel.groups.length===1?"":"es"}`)
            }
            if(this.parameters.projection.showPatternVectors===true&&this.projectionLevels.length){
                parts.push("pattern vectors shown")
            }
            if(elements.length>3){
                parts.push("other elements held out of the 3D view")
            }
            if(!traces.length){
                parts.push("no formula to plot")
            }
            this.plotSummary.textContent=parts.join(" · ")
        }
    }

    addElement(raw){
        const symbol=String(raw??"").trim()
        if(!this.availableElements().includes(symbol)){
            return false
        }
        const list=this.elements()
        if(list.includes(symbol)){
            return false
        }
        this.setElements([...list,symbol])
        return true
    }

    removeElement(index){
        const list=this.elements()
        if(index<0||index>=list.length){
            return
        }
        list.splice(index,1)
        this.setElements(list)
    }

    setElements(list){
        const previous=this.elements()
        const axisElements=AXIS_KEYS.map(key=>{
            const index=this.parameters.projection[key]
            return Number.isInteger(index)?previous[index]??null:null
        })
        this.parameters.elements=list
        AXIS_KEYS.forEach((key,axis)=>{
            const selected=axisElements[axis]
            if(selected!==null){
                this.parameters.projection[key]=list.indexOf(selected)
            }
        })
        this.recomputeProjection()
        this.renderProjectionUI()
        this.origin?.saveSessionSoon?.()
    }

    /* A change of the selected elements touches the axes and the plotted
       coordinates only. The quotient classes — and their DOM — are a property
       of the patterns and the inputs, so they are left alone. */
    renderProjectionUI(){
        if(!this.accordion){
            return
        }
        this.renderElements()
        this.renderProjectionControls()
        this.renderReadout()
        this.refreshPlot()
    }

    syncUI(){
        if(!this.accordion){
            return
        }
        this.renderAll()
    }

    serializeState(){
        return {
            elements:[...this.elements()],
            patterns:[...this.patterns()],
            projection:{
                ...this.parameters.projection,
                orthographic:this.plot?._orthographic??this.parameters.projection.orthographic===true
            },
            pca:{...this.parameters.pca},
            fit:{...this.parameters.fit}
        }
    }

    restoreState(state){
        if(!state){
            return
        }
        if(Array.isArray(state.elements)){
            const available=this.availableElements()
            this.parameters.elements=state.elements
                .map(symbol=>String(symbol))
                .filter(symbol=>!available.length||available.includes(symbol))
        }
        if(Array.isArray(state.patterns)){
            this.parameters.patterns=state.patterns.map(pattern=>String(pattern))
            this.patternCache.clear()
        }
        if(state.projection&&typeof state.projection==="object"){
            this.parameters.projection={...this.parameters.projection,...state.projection}
        }
        if(state.pca&&typeof state.pca==="object"){
            this.parameters.pca={...this.parameters.pca,...state.pca}
        }
        if(state.fit&&typeof state.fit==="object"){
            this.parameters.fit={...this.parameters.fit,...state.fit}
        }
        this._viewApplied=false
        this.recompute()
        this.syncUI()
    }

    suicide(options={}){
        this.plot?.dispose?.()
        this.plot=null
        for(const panel of Object.values(this.viewPanels)){
            panel?.suicide?.()
        }
        this.viewPanels={}
        this.analysisDialog?.suicide?.()
        this.analysisDialog=null
        this.accordionRight?.suicide?.()
        this.accordionRight=null
        super.suicide(options)
    }
}

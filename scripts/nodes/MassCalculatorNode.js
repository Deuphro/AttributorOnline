import {Node} from "../core/index.js"
import {Dialog} from "../ui/Dialog.js"
import {Plot2D} from "../ui/Plot2D.js"
import {Formula,Stoichiometry,loadTable} from "../chemistry.js"
import {CE,stylize} from "../util.js"
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm"

export class MassCalculatorNode extends Node{
    constructor(title,origin,destinationFlow,position={x:180,y:10}){
        super(title,[],[],origin,destinationFlow,position)
        this.status="floating"
        this.parameters.formula=""
        this.parameters.charge=0
        this.parameters.ratio=0.01
        this.parameters.mzWindow={mz:null,ppm:5}
        this.parameters.showLabels=true
        this.dialog=null
        this.plot=null
        this.tablePromise=null
        this.elements=[]
        this.currentStoich=null
        this.elementButtons=new Map()
    }

    async ensureTable(){
        if(this.tablePromise) return this.tablePromise
        this.tablePromise=loadTable().then(table=>{
            this.elements=table.elements
            return table
        })
        return this.tablePromise
    }

    registered(e){
        const {channel,registrationName,label,caster}=e.detail.msg
        if(caster!==this||this.dialog){
            return
        }
        this.dialog=new Dialog(label,this.origin,this.origin.botContent[0])
        this.dialog.DOMelt.dismisser.remove()
        stylize(this.dialog.DOMelt.window,{
            top:"0%",
            right:"0%",
            width:"42%",
            height:"100%"
        })
        channel.register(`${registrationName}:masscalc`,this.dialog,`${label} mass calc`)
        this.render()
    }

    async render(){
        await this.ensureTable()
        const content=this.dialog.DOMelt.content
        content.replaceChildren()
        stylize(content,{
            display:"grid",
            "grid-template-rows":"auto 1fr auto",
            height:"100%",
            minHeight:"0",
            overflow:"hidden",
            padding:"4px",
            gap:"4px"
        })

        const formulaBar=this.buildFormulaBar()
        const centerWrap=this.buildCenterArea()
        const infoBar=this.buildInfoBar()

        content.append(formulaBar,centerWrap,infoBar)
        this.updateAll()
    }

    buildCenterArea(){
        const wrap=CE("div",{style:{display:"grid",gridTemplateColumns:"auto 1fr",gap:"8px",height:"100%",minHeight:"0"}},[])
        const periodicTable=this.buildPeriodicTable()
        const plotArea=this.buildPlotArea()
        stylize(periodicTable,{height:"100%",minHeight:"0",overflow:"auto"})
        stylize(plotArea,{height:"100%",minHeight:"0"})
        wrap.append(periodicTable,plotArea)
        return wrap
    }

    buildFormulaBar(){
        const wrap=CE("div",{style:{display:"grid",gap:"4px","grid-template-columns":"auto 1fr auto auto auto 1fr",alignItems:"center"}},[])

        const formulaLabel=CE("label",{style:{fontSize:"0.85em",color:"var(--text-muted)"}},["Formula"])
        this.formulaInput=CE("input",{
            type:"text",
            value:this.parameters.formula,
            placeholder:"C6H12O6  or  C6H12O6 [H+]",
            title:"Enter formula with optional ionisation group in brackets. Examples: C6H12O6, C6H12O6 [H+], C6H12O6 [Na+], C6H12O6 [-]"
        },[])
        this.formulaInput.addEventListener("input",()=>{
            this.parameters.formula=this.formulaInput.value.trim()
            this.debouncedUpdateFromFormula()
        })
        this.formulaInput.addEventListener("keydown",(e)=>{
            if(e.key==="Enter") this.updateFromFormula()
        })

        const chargeLabel=CE("label",{style:{fontSize:"0.85em",color:"var(--text-muted)"}},["Charge"])
        this.chargeInput=CE("input",{
            type:"number",
            value:this.parameters.charge,
            min:-5,
            max:5,
            step:1,
            style:{width:"50px"},
            title:"Ion charge (overrides bracket group if both present)"
        },[])
        this.chargeInput.addEventListener("change",()=>{
            this.parameters.charge=parseInt(this.chargeInput.value)||0
            this.updateFromFormula()
        })

        const ratioLabel=CE("label",{style:{fontSize:"0.85em",color:"var(--text-muted)"}},["Threshold"])
        this.ratioInput=CE("input",{
            type:"number",
            value:this.parameters.ratio,
            min:0,
            max:1,
            step:0.001,
            style:{width:"60px"},
            title:"Isotopic probability threshold relative to max (0 = all, 1 = most probable only)"
        },[])
        this.ratioInput.addEventListener("change",()=>{
            this.parameters.ratio=parseFloat(this.ratioInput.value)||0
            this.updateAll()
        })

        const clearBtn=CE("button",{type:"button",style:{fontSize:"0.75em",padding:"2px 6px"}},["Clear"])
        clearBtn.addEventListener("click",()=>{
            this.parameters.formula=""
            this.parameters.charge=0
            this.currentStoich=null
            this.updateAll()
        })

        wrap.append(formulaLabel,this.formulaInput,chargeLabel,this.chargeInput,ratioLabel,this.ratioInput,clearBtn)
        return wrap
    }

    buildPeriodicTable(){
        const wrap=CE("div",{style:{display:"flex",flexDirection:"column",overflow:"auto",minHeight:"0"}},[])
        const table=CE("div",{style:{display:"grid",gridTemplateColumns:"repeat(18, 1fr)",gap:"2px"}},[])

        const periods=this.getPeriodLayout()

        for(const period of periods){
            for(const z of period){
                if(z===null){
                    table.appendChild(CE("div",{style:{visibility:"hidden"}},[]))
                }else{
                    const el=this.elements.find(e=>e.Z===z)
                    if(el){
                        table.appendChild(this.buildElementButton(el))
                    }else{
                        table.appendChild(CE("div",{style:{visibility:"hidden"}},[]))
                    }
                }
            }
        }

        wrap.appendChild(table)
        return wrap
    }

    getPeriodLayout(){
        return [
            [1,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,2],
            [3,4,null,null,null,null,null,null,null,null,null,null,null,5,6,7,8,10],
            [11,12,null,null,null,null,null,null,null,null,null,null,null,13,14,15,16,18],
            [19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36],
            [37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54],
            [55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86],
            [87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118]
        ]
    }

    buildElementButton(element){
        const count=this.currentStoich?.counts?.get(element)||0
        const isIon=this.currentStoich?.ionisation?.some(t=>t.group?.has(element))||false

        const btn=CE("button",{
            type:"button",
            title:`${element.name} (${element.symbol}) - Z=${element.Z}\nLeft click: add\nRight click: remove\nCount: ${count}${isIon?" (in ion group)":""}`,
            style:{
                padding:"0",
                fontSize:"0.7em",
                aspectRatio:"1",
                minWidth:"32px",
                maxWidth:"32px",
                minHeight:"32px",
                maxHeight:"32px",
                background:count>0?isIon?"rgba(255,100,100,0.3)":"rgba(100,200,100,0.3)":"var(--surface)",
                border:"1px solid var(--border)",
                borderRadius:"3px",
                color:count>0?isIon?"#ff8888":"#88ff88":"var(--text)",
                whiteSpace:"nowrap",
                cursor:"pointer",
                display:"flex",
                alignItems:"center",
                justifyContent:"center",
                lineHeight:"1"
            }
        },[`${element.symbol}${count>0?count:""}`])

        btn.addEventListener("click",(e)=>{
            e.preventDefault()
            this.modifyElement(element,1)
        })
        btn.addEventListener("contextmenu",(e)=>{
            e.preventDefault()
            this.modifyElement(element,-1)
        })
        this.elementButtons.set(element.symbol,btn)
        return btn
    }

    async modifyElement(element,delta){
        const table=await this.ensureTable()
        if(!this.currentStoich){
            this.currentStoich=new Stoichiometry({composition:new Map(),table})
        }
        const currentCount=this.currentStoich.counts.get(element)||0
        const newCount=Math.max(0,currentCount+delta)

        const newComposition=new Map(this.currentStoich.composition)
        if(newCount>0){
            const rule=this.currentStoich.rule||"mostProbable"
            const A=element.pickA(rule)
            const byA=new Map([[A,newCount]])
            newComposition.set(element,byA)
        }else{
            newComposition.delete(element)
        }

        this.currentStoich=new Stoichiometry({
            composition:newComposition,
            ionisation:this.currentStoich.ionisation,
            charge:this.currentStoich.charge,
            rule:this.currentStoich.rule,
            table
        })

        this.parameters.formula=this.currentStoich.toString()
        if(this.formulaInput) this.formulaInput.value=this.parameters.formula
        this.updateAll()
    }

    buildPlotArea(){
        const wrap=CE("div",{style:{display:"grid",gridTemplateRows:"auto minmax(0,1fr)",gap:"4px",minHeight:"0"}},[])
        const controls=CE("div",{style:{display:"flex",gap:"8px",alignItems:"center",flexWrap:"wrap"}},[])

        const mzLabel=CE("label",{style:{fontSize:"0.8em",color:"var(--text-muted)"}},["m/z center"])
        this.mzCenterInput=CE("input",{type:"number",step:"any",style:{width:"80px"},placeholder:"auto"},[])
        this.mzCenterInput.addEventListener("change",()=>{
            const val=parseFloat(this.mzCenterInput.value)
            this.parameters.mzWindow.mz=Number.isFinite(val)?val:null
            this.updatePlot()
        })

        const ppmLabel=CE("label",{style:{fontSize:"0.8em",color:"var(--text-muted)"}},["±ppm"])
        this.ppmInput=CE("input",{type:"number",value:5,min:0.1,max:100,step:0.1,style:{width:"50px"}},[])
        this.ppmInput.addEventListener("change",()=>{
            this.parameters.mzWindow.ppm=parseFloat(this.ppmInput.value)||5
            this.updatePlot()
        })

        const showAllBtn=CE("button",{type:"button",style:{fontSize:"0.75em",padding:"2px 6px"}},["Show All"])
        showAllBtn.addEventListener("click",()=>{
            this.parameters.mzWindow.mz=null
            this.mzCenterInput.value=""
            this.updatePlot()
        })

        const peakLabelsCheckbox=CE("input",{type:"checkbox",id:"peakLabels",checked:true},[])
        peakLabelsCheckbox.addEventListener("change",()=>{
            this.parameters.showLabels=peakLabelsCheckbox.checked
            this.updatePlot()
        })
        const peakLabelsLabel=CE("label",{htmlFor:"peakLabels",style:{fontSize:"0.75em",cursor:"pointer"}},["Labels"])

        controls.append(mzLabel,this.mzCenterInput,ppmLabel,this.ppmInput,showAllBtn,peakLabelsCheckbox,peakLabelsLabel)
        wrap.appendChild(controls)

        this.plotContainer=CE("div",{style:{width:"100%",height:"100%",minHeight:"0",overflow:"hidden"}},[])
        wrap.appendChild(this.plotContainer)

        this._resizeObserver=new ResizeObserver(()=>{
            if(this.plot){
                this.plot.drawGraph()
            }else if(this.currentStoich && this.plotContainer.clientWidth>0 && this.plotContainer.clientHeight>0){
                this.updatePlot()
            }
        })
        this._resizeObserver.observe(this.plotContainer)

        return wrap
    }

    buildInfoBar(){
        const wrap=CE("div",{style:{display:"grid",gridTemplateColumns:"repeat(4, 1fr)",gap:"4px",fontSize:"0.85em"}},[])

        this.monoMassEl=CE("div",{style:{color:"var(--accent)"}},["Mono: —"])
        this.avgMassEl=CE("div",{style:{color:"var(--text)"}},["Avg: —"])
        this.mzEl=CE("div",{style:{color:"var(--accent)"}},["m/z: —"])
        this.formulaEl=CE("div",{style:{color:"var(--text-muted)",fontFamily:"monospace"}},["—"])

        wrap.append(this.monoMassEl,this.avgMassEl,this.mzEl,this.formulaEl)
        return wrap
    }

    debouncedUpdateFromFormula(){
        clearTimeout(this._formulaDebounce)
        this._formulaDebounce=setTimeout(()=>this.updateFromFormula(),300)
    }

    async updateFromFormula(){
        if(!this.parameters.formula){
            this.currentStoich=null
            this.updateAll()
            return
        }
        try{
            const table=await this.ensureTable()
            const parsed=Formula.parse(this.parameters.formula,{table})
            if(parsed){
                this.currentStoich=parsed.root
                if(this.parameters.charge!==0){
                    this.currentStoich=new Stoichiometry({
                        composition:this.currentStoich.composition,
                        ionisation:this.currentStoich.ionisation,
                        charge:this.parameters.charge,
                        rule:this.currentStoich.rule,
                        table
                    })
                }
                this.formulaInput.value=this.currentStoich.toString()
                if(this.chargeInput) this.chargeInput.value=this.currentStoich.charge
                this.updateAll()
            }
        }catch(err){
            console.warn("Formula parse error:",err)
        }
    }

    updateAll(){
        this.updatePeriodicTable()
        this.updateInfo()
        this.updatePlot()
    }

    updatePeriodicTable(){
        for(const [symbol,btn] of this.elementButtons){
            const el=this.elements.find(e=>e.symbol===symbol)
            if(el){
                const count=this.currentStoich?.counts?.get(el)||0
                const isIon=this.currentStoich?.ionisation?.some(t=>t.group?.has(el))||false
                btn.textContent=`${el.symbol}${count>0?count:""}`
                btn.style.background=count>0?isIon?"rgba(255,100,100,0.3)":"rgba(100,200,100,0.3)":"var(--surface)"
                btn.style.color=count>0?isIon?"#ff8888":"#88ff88":"var(--text)"
                btn.title=`${el.name} (${el.symbol}) - Z=${el.Z}\nLeft click: add\nRight click: remove\nCount: ${count}${isIon?" (in ion group)":""}`
            }
        }
    }

    computeAverageMass(stoich){
        let m=0
        for(const [el,byA] of stoich.composition){
            m+=el.averageMass*stoich.counts.get(el)
        }
        return m-stoich.charge*Stoichiometry.electronMass
    }

    updateInfo(){
        if(!this.currentStoich){
            this.monoMassEl.textContent="Mono: —"
            this.avgMassEl.textContent="Avg: —"
            this.mzEl.textContent="m/z: —"
            this.formulaEl.textContent="—"
            return
        }
        const mono=this.currentStoich.mass
        const avg=this.computeAverageMass(this.currentStoich)
        const mz=this.currentStoich.mz
        this.monoMassEl.textContent=`Mono: ${mono.toFixed(4)}`
        this.avgMassEl.textContent=`Avg: ${avg.toFixed(4)}`
        this.mzEl.textContent=`m/z: ${mz.toFixed(4)}`
        this.formulaEl.textContent=this.currentStoich.toString()
    }

    updatePlot(){
        if(!this.currentStoich||!this.plotContainer) return

        try{
            const isotopologues=[...this.currentStoich.isotopologues({
                ratio:this.parameters.ratio,
                within:this.parameters.mzWindow.mz?{...this.parameters.mzWindow}:null,
                limit:200
            })]

            if(isotopologues.length===0){
                this.plotContainer.textContent="No isotopologues in range"
                if(this.plot) this.plot.container.textContent=""
                return
            }

            const masses=isotopologues.map(i=>i.mz)
            const probs=isotopologues.map(i=>Math.exp(i.logProbability))
            const maxProb=Math.max(...probs)
            const normalized=probs.map(p=>p/maxProb)

            const trace={
                x:masses,
                y:normalized,
                mode:"markers",
                marker:{size:6,color:"var(--accent)"},
                name:"Isotopic distribution"
            }

            if(this.plot){
                this.plot.data=[trace]
                this.plot.drawGraph()
            }else if(this.plotContainer.clientWidth>0 && this.plotContainer.clientHeight>0){
                this.plot=new Plot2D([trace],"Isotopic Distribution",this.origin,this.plotContainer)
            }else{
                // Container not ready yet, clear and wait for resize
                this.plotContainer.textContent=""
                return
            }

            if(this.parameters.mzWindow.mz){
                const {mz,ppm}=this.parameters.mzWindow
                const half=mz*ppm*1e-6
                this.plot.parameters.axis.bottom.domain=[mz-half,mz+half]
                this.plot.parameters.axis.bottom.autoDomain=false
                this.plot.drawGraph()
            }

            if(this.parameters.showLabels && this.plot && this.plot.svg){
                this.addPeakLabels(isotopologues)
            }

        }catch(err){
            console.error("Plot update error:",err)
            this.plotContainer.textContent="Error generating plot"
        }
    }

    addPeakLabels(isotopologues){
        if(!this.plot?.svg) return
        const svg=this.plot.svg
        svg.selectAll(".peak-label").remove()

        const gz=this.plot.graphzone
        const margins=this.plot.parameters.margins
        const xScale=d3.scaleLinear()
            .domain(this.plot.parameters.axis.bottom.domain)
            .range([margins.left, gz.width+margins.left])
        const yScale=d3.scaleLinear()
            .domain(this.plot.parameters.axis.left.domain)
            .range([gz.height+margins.top, margins.top])

        for(const iso of isotopologues){
            if(iso.logProbability<-20) continue
            const x=xScale(iso.mz)
            const y=yScale(Math.exp(iso.logProbability)/Math.exp(isotopologues[0].logProbability))
            if(x<margins.left||x>gz.width+margins.left||y<margins.top||y>gz.height+margins.top) continue

            svg.append("text")
                .attr("class","peak-label")
                .attr("x",x)
                .attr("y",y-4)
                .attr("text-anchor","middle")
                .attr("font-size","8px")
                .attr("fill","var(--text-muted)")
                .text(iso.notation)
        }
    }

    serializeState(){
        return {
            formula:this.parameters.formula,
            charge:this.parameters.charge,
            ratio:this.parameters.ratio,
            mzWindow:this.parameters.mzWindow,
            showLabels:this.parameters.showLabels
        }
    }

    restoreState(state){
        if(!state) return
        this.parameters.formula=state.formula||""
        this.parameters.charge=state.charge||0
        this.parameters.ratio=state.ratio??0.01
        this.parameters.mzWindow=state.mzWindow||{mz:null,ppm:5}
        this.parameters.showLabels=state.showLabels??true
        if(this.dialog){
            this.render()
        }
    }

    suicide(options={}){
        this._resizeObserver?.disconnect()
        this.dialog?.suicide()
        super.suicide(options)
    }
}
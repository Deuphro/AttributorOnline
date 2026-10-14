import {Node} from "../core/index.js"
import {Dialog} from "../ui/Dialog.js"
import {Plot2D} from "../ui/Plot2D.js"
import {Formula,Stoichiometry,loadTable} from "../chemistry.js"
import {Wave,XYTrace} from "../formats.js"
import {CE,stylize} from "../util.js"

export class MassCalculatorNode extends Node{
    constructor(title,origin,destinationFlow,position={x:180,y:10}){
        super(title,[],[],origin,destinationFlow,position)
        this.status="floating"
        this.parameters.formula=""
        this.parameters.charge=0
        this.parameters.ratio=0.01
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
        const wrap=CE("div",{style:{display:"grid",gridTemplateColumns:"max-content minmax(0, 1fr)",gap:"8px",height:"100%",minHeight:"0",minWidth:"0",overflow:"auto"}},[])
        const periodicTable=this.buildPeriodicTable()
        const plotArea=this.buildPlotArea()
        stylize(plotArea,{height:"100%",minHeight:"0",minWidth:"0"})
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
        const wrap=CE("div",{style:{display:"block",height:"100%",minHeight:"0",overflow:"visible"}},[])
        const table=CE("div",{style:{
            display:"grid",
            gridTemplateColumns:"repeat(18, 30px)",
            gridAutoRows:"30px",
            gap:"3px",
            alignContent:"start",
            justifyContent:"start",
            width:"max-content"
        }},[])

        const sorted=[...this.elements].sort((a,b)=>a.Z-b.Z)
        for(const el of sorted){
            const pos=this.tablePosition(el.Z)
            if(!pos) continue
            const btn=this.buildElementButton(el)
            btn.style.gridRow=`${pos[0]}`
            btn.style.gridColumn=`${pos[1]}`
            btn.dataset.group=String(pos[1])
            table.appendChild(btn)
        }

        wrap.appendChild(table)
        return wrap
    }

    /* Display position [row, col] in a 9-row grid (7 periods + 2 f-block rows).
       Computed from Z alone (elements.json carries no group/period field),
       so F/Ne land in columns 17/18 — never wrapped to the left. */
    tablePosition(Z){
        if(Z===1) return [1,1]
        if(Z===2) return [1,18]
        if(Z>=3&&Z<=10) return [2,Z<=4?Z-2:Z+8]
        if(Z>=11&&Z<=18) return [3,Z<=12?Z-10:Z]
        if(Z>=19&&Z<=36) return [4,Z-18]
        if(Z>=37&&Z<=54) return [5,Z-36]
        if(Z===55||Z===56) return [6,Z-54]
        if(Z>=57&&Z<=71) return [8,Z-57+3]
        if(Z>=72&&Z<=86) return [6,Z-68]
        if(Z===87||Z===88) return [7,Z-86]
        if(Z>=89&&Z<=103) return [9,Z-89+3]
        if(Z>=104&&Z<=118) return [7,Z-100]
        return null
    }

    categoryFor(Z){
        if(Z===1||(Z>=5&&Z<=8)||Z===14||Z===15||Z===16||Z===33||Z===34||Z===51||Z===52) return "nonmetal"
        if([9,17,35,53,85,117].includes(Z)) return "halogen"
        if([2,10,18,36,54,86,118].includes(Z)) return "noble"
        if([3,11,19,37,55,87].includes(Z)) return "alkali"
        if([4,12,20,38,56,88].includes(Z)) return "alkaline"
        if(Z>=57&&Z<=71) return "lanthanide"
        if(Z>=89&&Z<=103) return "actinide"
        if((Z>=21&&Z<=30)||(Z>=39&&Z<=48)||(Z>=72&&Z<=80)||(Z>=104&&Z<=112)) return "transition"
        return "post-transition"
    }

    categoryColor(cat){
        switch(cat){
            case "alkali": return "rgba(255,120,120,0.12)"
            case "alkaline": return "rgba(255,180,100,0.12)"
            case "transition": return "rgba(255,220,120,0.10)"
            case "post-transition": return "rgba(160,200,255,0.10)"
            case "nonmetal": return "rgba(120,220,150,0.12)"
            case "halogen": return "rgba(150,220,255,0.14)"
            case "noble": return "rgba(190,150,255,0.14)"
            case "lanthanide": return "rgba(255,160,220,0.10)"
            case "actinide": return "rgba(255,140,180,0.12)"
            default: return "var(--surface)"
        }
    }

    categoryAccent(cat){
        switch(cat){
            case "alkali": return "#e74c3c"
            case "alkaline": return "#e67e22"
            case "transition": return "#f1c40f"
            case "post-transition": return "#5dade2"
            case "nonmetal": return "#2ecc71"
            case "halogen": return "#3498db"
            case "noble": return "#9b59b6"
            case "lanthanide": return "#e84393"
            case "actinide": return "#d63031"
            default: return "var(--border)"
        }
    }

    buildElementButton(element){
        const count=this.currentStoich?.counts?.get(element)||0
        const isIon=this.currentStoich?.ionisation?.some(t=>t.group?.has(element))||false
        const cat=this.categoryFor(element.Z)

        const btn=CE("button",{
            type:"button",
            title:`${element.name} (${element.symbol}) - Z=${element.Z}\nLeft click: add\nRight click: remove\nCount: ${count}${isIon?" (in ion group)":""}`,
            style:{
                padding:"0",
                fontSize:"0.95em",
                fontWeight:"700",
                width:"30px",
                height:"30px",
                minWidth:"30px",
                minHeight:"30px",
                maxWidth:"30px",
                maxHeight:"30px",
                boxSizing:"border-box",
                background:count>0?isIon?"rgba(255,100,100,0.3)":"rgba(100,200,100,0.3)":this.categoryColor(cat),
                border:count>0?"1px solid var(--accent)":"1px solid var(--border)",
                borderLeft:`3px solid ${this.categoryAccent(cat)}`,
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
        const wrap=CE("div",{style:{display:"grid",gridTemplateRows:"minmax(0,1fr)",gap:"4px",minHeight:"0"}},[])

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
            const parsed=Formula.parse(this.parameters.formula,table)
            if(parsed){
                this.currentStoich=parsed
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
                limit:200
            })]

            if(isotopologues.length===0){
                this.plotContainer.textContent="No isotopologues in range"
                this.pendingTrace=null
                this.pendingBars=null
                if(this.plot){
                    this.plot.setTraces([])
                    this.plot.drawGraph()
                }
                return
            }

            const masses=isotopologues.map(i=>i.mz)
            const probs=isotopologues.map(i=>Math.exp(i.logProbability))
            const maxProb=Math.max(...probs)
            const normalized=probs.map(p=>p/maxProb)

            const wave=Wave.fromCoordinates(
                new Float64Array(masses),
                new Float64Array(normalized),
                {title:"Isotopic distribution"},
                ["m/z","Relative abundance"]
            )
            const trace=new XYTrace({
                id:"masscalc:isotopic-distribution",
                title:"Isotopic distribution",
                wave,
                options:{
                    color:"#2ecc71",
                    mode:"points",
                    marker:{shape:"circle",size:0},
                    line:{size:0}
                }
            })

            if(!this.plot){
                if(!(this.plotContainer.clientWidth>0&&this.plotContainer.clientHeight>0)){
                    // Container not ready yet, clear and wait for resize
                    this.plotContainer.textContent=""
                    this.pendingTrace=trace
                    this.pendingBars=isotopologues
                    return
                }
                this.plot=new Plot2D([],"Isotopic Distribution",this.origin,this.plotContainer)
                const origDrawGraph=this.plot.drawGraph.bind(this.plot)
                const self=this
                this.plot.drawGraph=function(...args){
                    const out=origDrawGraph(...args)
                    if(self.pendingBars) self.drawPeakBars(self.pendingBars)
                    return out
                }
            }
            this.pendingTrace=trace
            this.pendingBars=isotopologues
            this.plot.setTraces([trace])
            this.plot.syncAxisLabels()

            this.plot.parameters.axis.bottom.autoDomain=true
            this.plot.parameters.axis.left.autoDomain=true
            this.plot.drawGraph()
            this.drawPeakBars(isotopologues)

        }catch(err){
            console.error("Plot update error:",err)
            this.plotContainer.textContent="Error generating plot"
        }
    }

    /* Peak bars: narrow vertical bars drawn inside the .anchor group — same
       coordinates as the points (plotScales are graphzone-local, the anchor
       carries the margin translate). Gradient in objectBoundingBox so each
       bar runs its own ramp: white at the tip, green at 75%, transparent at
       the baseline. Re-painted after every drawGraph via the hook installed
       in updatePlot, so zoom/pan/resize keep them. */
    drawPeakBars(isotopologues){
        const graph=this.plot
        if(!graph?.graphSVG) return
        const zone=graph.graphzone
        if(!(zone.width>0&&zone.height>0)) return
        const {xScale,yScale}=graph.plotScales()
        const anchor=graph.graphSVG.select(".anchor")
        if(anchor.empty()) return
        let barLayer=anchor.select(".masscalc-bars")
        if(barLayer.empty()) barLayer=anchor.append("g").attr("class","masscalc-bars")
        barLayer.selectAll("*").remove()
        // <defs> must be appended (not selected-into-existence): d3's append
        // on an empty selection creates nothing, leaving fill="url(#...)"
        // dangling — SVG then refuses to paint the rect at all.
        let defs=anchor.select("defs")
        if(defs.empty()) defs=anchor.append("defs")
        const gradId=`masscalc-peak-gradient-${graph.graphSVG.attr("id")}`
        let gradient=defs.select(`#${gradId}`)
        if(gradient.empty()){
            gradient=defs.append("linearGradient")
                .attr("id",gradId)
                .attr("x1","0%").attr("x2","0%")
                .attr("y1","0%").attr("y2","100%")
            gradient.append("stop").attr("offset","0%").attr("stop-color","#ffffff")
            gradient.append("stop").attr("offset","75%").attr("stop-color","#2ecc71")
            gradient.append("stop").attr("offset","100%").attr("stop-color","#2ecc71").attr("stop-opacity","0")
        }

        const maxProb=Math.exp(isotopologues[0].logProbability)
        const barWidth=3
        for(const iso of isotopologues){
            if(iso.logProbability<-20) continue
            const rel=Math.exp(iso.logProbability)/maxProb
            const px=xScale(iso.mz)
            const pyTop=yScale(rel)
            const pyBase=yScale(0)
            if(!Number.isFinite(px)||!Number.isFinite(pyTop)||!Number.isFinite(pyBase)) continue
            if(px<0||px>zone.width) continue
            barLayer.append("rect")
                .attr("class","peak-bar")
                .attr("x",px-barWidth/2)
                .attr("y",Math.min(pyTop,pyBase))
                .attr("width",barWidth)
                .attr("height",Math.max(1,Math.abs(pyBase-pyTop)))
                .attr("fill",`url(#${gradId})`)
        }
    }

    serializeState(){
        return {
            formula:this.parameters.formula,
            charge:this.parameters.charge,
            ratio:this.parameters.ratio
        }
    }

    restoreState(state){
        if(!state) return
        this.parameters.formula=state.formula||""
        this.parameters.charge=state.charge||0
        this.parameters.ratio=state.ratio??0.01
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
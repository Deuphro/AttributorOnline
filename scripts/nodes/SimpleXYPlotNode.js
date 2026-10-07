import {NodeWithRightAccordionGraph} from "./NodeWithRightAccordionGraph.js"
import {Wave,XYTrace} from "../formats.js"

export class SimpleXYPlotNode extends NodeWithRightAccordionGraph{
    constructor(title,inputs,outputs,origin,destinationFlow,position={x:180,y:10}){
        super(title,inputs,outputs,origin,destinationFlow,position)
    }
    registered(e){
        if(e.detail.msg.caster !== this || this.logScaleCheckbox){
            return
        }
        super.registered(e)
        this.logScaleCheckbox=true
        this.renderInspector()
    }
    setLogarithmicScale(enabled){
        const scale=enabled?"log":"linear"
        this.graph.parameters.axis.bottom.scale=scale
        this.graph.parameters.axis.left.scale=scale
        this.graph.drawGraph()
    }
    renderInspector(){
        if(!this.accordion) return
        const root=this.accordion.DOMelt.content
        root.style.display="block"
        root.style.minWidth="0"
        root.style.overflow="auto"
        this.graph.ensureAxes?.()
        //the sections are rebuilt on every refresh, so their collapsed state has to survive the wipe
        this.inspectorSections={}
        root.querySelectorAll(":scope > details").forEach(details=>{
            const title=details.querySelector(":scope > summary")?.textContent
            if(title) this.inspectorSections[title]=details.open
        })
        root.replaceChildren()
        const section=(title,open=true)=>{
            const details=document.createElement("details")
            details.open=this.inspectorSections?.[title]??open
            details.style.minWidth="0"
            const summary=document.createElement("summary")
            summary.textContent=title
            details.append(summary)
            root.append(details)
            return details
        }
        const tracesSection=section("Traces")
        const traceList=document.createElement("div")
        traceList.style.display="grid"
        traceList.style.gap="3px"
        tracesSection.append(traceList)
        const selectTrace=trace=>{
            this.selectedTraceId=(this.selectedTraceId===trace.id)?null:trace.id
            this.renderInspector()
        }
        for(const trace of this.graph.traces){
            if(!trace.options.marker||typeof trace.options.marker!=="object"){
                trace.options.marker={shape:"circle",size:4}
            }
            const traceGroup=document.createElement("div")
            traceGroup.className="trace-group"
            const item=document.createElement("div")
            item.className="trace-item"
            item.style.display="grid"
            item.style.gridTemplateColumns="auto minmax(0,1fr) auto"
            item.style.gap="4px"
            item.style.alignItems="center"
            item.draggable=true
            if(trace.id===this.selectedTraceId){
                item.classList.add("selected")
            }
            const swatchWrap=document.createElement("label")
            swatchWrap.title="Trace color"
            swatchWrap.style.width="1.2em"
            swatchWrap.style.height="1.2em"
            swatchWrap.style.borderRadius="4px"
            swatchWrap.style.cursor="pointer"
            swatchWrap.style.border=`2px solid ${trace.options.color}`
            swatchWrap.style.background=trace.options.color
            swatchWrap.style.opacity=trace.options.hidden?"0.35":"1"
            swatchWrap.style.overflow="hidden"
            const swatch=document.createElement("input")
            swatch.type="color"; swatch.value=trace.options.color
            swatch.title="Trace color"
            swatch.style.width="1px"; swatch.style.height="1px"
            swatch.style.opacity="0"; swatch.style.border="none"; swatch.style.padding="0"
            swatch.addEventListener("input",()=>{trace.options.color=swatch.value;this.graph.drawGraph();this.renderInspector()})
            swatchWrap.append(swatch)
            const nameBtn=document.createElement("button")
            nameBtn.type="button"
            nameBtn.title=`${trace.title} (${trace.pointCount} points)`
            nameBtn.style.display="flex"
            nameBtn.style.alignItems="center"
            nameBtn.style.gap="4px"
            //min-width:0 lets the 1fr grid track shrink instead of being widened
            //by a long trace name; the name is truncated with an ellipsis and the
            //full name stays available through the tooltip
            nameBtn.style.minWidth="0"
            nameBtn.style.overflow="hidden"
            nameBtn.style.textAlign="left"
            nameBtn.style.opacity=trace.options.hidden?"0.45":"1"
            const nameSpan=document.createElement("span")
            nameSpan.textContent=trace.title
            nameSpan.title=trace.title
            nameSpan.style.minWidth="0"
            nameSpan.style.overflow="hidden"
            nameSpan.style.textOverflow="ellipsis"
            nameSpan.style.whiteSpace="nowrap"
            const countSpan=document.createElement("span")
            countSpan.textContent=`(${trace.pointCount} points)`
            countSpan.style.flexShrink="0"
            countSpan.style.whiteSpace="nowrap"
            nameBtn.append(nameSpan,countSpan)
            nameBtn.addEventListener("click",()=>selectTrace(trace))
            const eye=document.createElement("button")
            eye.type="button"
            eye.title=trace.options.hidden?"Show trace":"Hide trace"
            eye.textContent=trace.options.hidden?"ðŸš«":"ðŸ‘"
            eye.style.width="1.8em"
            eye.addEventListener("click",(event)=>{
                event.stopPropagation()
                trace.options.hidden=!trace.options.hidden
                this.graph.drawGraph()
                this.renderInspector()
            })
            item.append(swatchWrap,nameBtn,eye)
            item.addEventListener("dragstart",event=>event.dataTransfer.setData("text/plain",trace.id))
            item.addEventListener("dragover",event=>event.preventDefault())
            item.addEventListener("drop",event=>{
                event.preventDefault()
                const from=this.graph.traces.findIndex(candidate=>candidate.id===event.dataTransfer.getData("text/plain"))
                const to=this.graph.traces.indexOf(trace)
                if(from>=0&&to>=0&&from!==to){
                    const [moved]=this.graph.traces.splice(from,1)
                    this.graph.traces.splice(to,0,moved)
                    this.graph.drawGraph()
                    this.renderInspector()
                }
            })
            traceGroup.append(item)
            traceList.append(traceGroup)
        }
        const trace=this.graph.traces.find(candidate=>candidate.id===this.selectedTraceId)
        if(trace){
            if(!trace.options.marker||typeof trace.options.marker!=="object"){
                trace.options.marker={shape:"circle",size:4}
            }
            const editor=document.createElement("div")
            editor.className="trace-editor"
            editor.style.display="grid"
            editor.style.gap="4px"
            editor.style.padding="4px"
            editor.style.border="1px solid rgba(255,255,255,0.35)"
            editor.style.borderRadius="5px"
            const control=(label,element)=>{
                const row=document.createElement("label")
                row.style.display="grid"
                row.style.gridTemplateColumns="1fr 1fr"
                row.style.gap="4px"
                row.style.alignItems="center"
                row.style.fontSize="0.85em"
                row.textContent=label
                row.append(element)
                editor.append(row)
            }
            const colorMini=document.createElement("input")
            colorMini.type="color"; colorMini.value=trace.options.color
            colorMini.style.width="1.2em"; colorMini.style.height="1.2em"
            colorMini.style.padding="0"; colorMini.style.border="none"
            colorMini.style.justifySelf="end"
            colorMini.addEventListener("input",()=>{trace.options.color=colorMini.value;this.graph.drawGraph();this.renderInspector()})
            control("Color",colorMini)
            const mode=document.createElement("select")
            for(const [value,text] of [["lines-between-points","Lines between points"],["lines-and-points","Lines + points"],["points","Points only"],["sticks-to-zero","Sticks to zero"]]){
                const option=new Option(text,value); option.selected=trace.options.mode===value; mode.add(option)
            }
            mode.addEventListener("change",()=>{trace.options.mode=mode.value;this.graph.drawGraph()})
            control("Mode",mode)
            const layer=document.createElement("select")
            for(const [value,text] of [["gl","Canvas (WebGL)"],["svg","SVG (D3)"]]){const option=new Option(text,value);option.selected=(trace.options.layer??"gl")===value;layer.add(option)}
            layer.title="Canvas: massive clouds, SVG: interactive traces"
            layer.addEventListener("change",()=>{trace.options.layer=layer.value;this.graph.drawGraph()})
            control("Layer",layer)
            const markerShape=document.createElement("select")
            for(const [value,text] of [["circle","Circle"],["square","Square"],["diamond","Diamond"],["triangle-up","Triangle up"],["triangle-down","Triangle down"],["cross","Cross"],["plus","Plus"]]){
                const option=new Option(text,value); option.selected=(trace.options.marker.shape??"circle")===value; markerShape.add(option)
            }
            markerShape.addEventListener("change",()=>{trace.options.marker.shape=markerShape.value;this.graph.drawGraph()})
            control("Marker",markerShape)
            const markerSize=document.createElement("input")
            markerSize.type="number"; markerSize.min="1"; markerSize.max="20"; markerSize.step="0.5"; markerSize.value=trace.options.marker.size??4
            markerSize.style.width="100%"
            markerSize.addEventListener("input",()=>{trace.options.marker.size=Number(markerSize.value);this.graph.drawGraph()})
            control("Marker size",markerSize)
            const size=document.createElement("input")
            size.type="number"; size.min="0"; size.step="0.5"; size.value=trace.options.line.size
            size.style.width="100%"
            size.addEventListener("input",()=>{trace.options.line.size=Number(size.value);this.graph.drawGraph()})
            control("Line size",size)
            const selectedGroup=traceList.querySelector(`.trace-group:has(.trace-item.selected)`)
            if(selectedGroup) selectedGroup.append(editor)
        }
        const axesSection=section("Axes",false)
        //one registry per render, so a re-rendered inspector never stacks
        //listeners and always refreshes the blocks it actually owns
        //detach FIRST: it clears axisBlocks, so creating the registry before
        //it would hand back a null Map and silently register nothing
        this.detachAxisSync?.()
        this.axisBlocks=new Map()
        this.onPlotViewChanged=()=>{
            //two guards: a re-entrancy one, and one so that rebuilding the
            //widgets can never fight with a slider the user is dragging
            if(this.syncingAxisBlocks||this.axisInteraction) return
            this.syncingAxisBlocks=true
            try{
                for(const [axisKey,block] of this.axisBlocks??[]){
                    const axis=this.graph.parameters.axis[axisKey]
                    if(!axis||axis.mirror) continue
                    this.refreshAxisBlock(block,axis)
                }
            }finally{
                this.syncingAxisBlocks=false
            }
        }
        this.detachAxisSync=()=>{
            this.graph.onViewChange=null
            this.axisBlocks=null
        }
        this.graph.onViewChange=this.onPlotViewChanged
        for(const [key,axis] of Object.entries(this.graph.parameters.axis)){
            const pretty=this.axisDisplayName(key)
            if(axis.mirror){
                this.renderMirrorAxisInspector(axesSection,key,pretty,axis)
            }else{
                this.renderAxisInspector(axesSection,key,pretty,axis)
            }
        }
    }
    axisDisplayName(key){
        const axisNames={bottom:"X (bottom)",left:"Y (left)",top:"X (top)",right:"Y (right)"}
        return axisNames[key]??key
    }
    axisShowToggle(axis,title,onChange){
        const toggle=document.createElement("input")
        toggle.type="checkbox"
        toggle.checked=axis.enabled??true
        toggle.title=title
        toggle.addEventListener("change",()=>{
            axis.enabled=toggle.checked
            this.graph.drawGraph()
            onChange?.()
        })
        return toggle
    }
    renderAxisInspector(section,key,pretty,axis){
        const block=document.createElement("div")
        block.dataset.axis=key
        section.append(block)
        this.axisBlocks?.set(key,block)
        const row=document.createElement("div")
        row.style.display="grid"; row.style.gridTemplateColumns="auto auto minmax(0,1fr)"; row.style.gap="4px"; row.style.alignItems="center"
        const name=document.createElement("strong"); name.textContent=`${pretty}:`
        name.style.opacity=(axis.enabled??true)?"1":"0.45"
        const label=document.createElement("input"); label.value=axis.label??""
        label.style.width="100%"
        label.addEventListener("input",()=>{axis.label=label.value;axis.autoLabel=false;this.graph.drawGraph()})
        row.append(this.axisShowToggle(axis,"Show this axis",()=>{name.style.opacity=(axis.enabled??true)?"1":"0.45"}),name,label); block.append(row)
        const scaleRow=document.createElement("div")
        scaleRow.style.display="grid"; scaleRow.style.gridTemplateColumns="auto minmax(0,1fr) auto"; scaleRow.style.gap="4px"; scaleRow.style.alignItems="center"
        const scaleLabel=document.createElement("span"); scaleLabel.textContent="Scale"; scaleLabel.style.fontSize="0.85em"
        const scale=document.createElement("select")
        for(const value of ["linear","log"]){const option=new Option(value,value);option.selected=axis.scale===value;scale.add(option)}
        scale.addEventListener("change",()=>{axis.scale=scale.value;axis.autoDomain=true;this.graph.drawGraph();this.refreshAxisBlock(block,axis)})
        const autoBtn=document.createElement("button")
        autoBtn.type="button"; autoBtn.textContent="Auto"; autoBtn.title="Automatic bounds"
        autoBtn.style.opacity=(axis.autoDomain??true)?"1":"0.45"
        autoBtn.addEventListener("click",()=>{axis.autoDomain=true;this.graph.drawGraph();this.refreshAxisBlock(block,axis)})
        scaleRow.append(scaleLabel,scale,autoBtn); block.append(scaleRow)
        this.buildDualSlider(block,axis,autoBtn)
    }
    renderMirrorAxisInspector(section,key,pretty,axis){
        const block=document.createElement("div")
        block.dataset.axis=key
        section.append(block)
        const row=document.createElement("div")
        row.style.display="grid"; row.style.gridTemplateColumns="auto auto minmax(0,1fr)"; row.style.gap="4px"; row.style.alignItems="center"
        const name=document.createElement("strong"); name.textContent=`${pretty}:`
        const body=document.createElement("div")
        const refreshBody=()=>{
            const enabled=axis.enabled??true
            name.style.opacity=enabled?"1":"0.45"
            body.replaceChildren()
            if(!enabled){
                const hidden=document.createElement("div")
                hidden.textContent="Hidden"
                hidden.style.fontSize="0.85em"; hidden.style.opacity="0.6"
                body.append(hidden)
                return
            }
            const source=this.graph.axisMirrorOf(key)
            const labelRow=document.createElement("div")
            labelRow.style.display="grid"; labelRow.style.gridTemplateColumns="auto minmax(0,1fr)"; labelRow.style.gap="4px"; labelRow.style.alignItems="center"; labelRow.style.minWidth="0"
            const labelName=document.createElement("span"); labelName.textContent="Label"; labelName.style.fontSize="0.85em"
            const label=document.createElement("input")
            label.value=axis.label??""
            label.placeholder=source?.label??""
            label.style.width="100%"
            label.addEventListener("input",()=>{axis.label=label.value;this.graph.drawGraph()})
            labelRow.append(labelName,label)
            const note=document.createElement("div")
            note.textContent=`Scale and range follow ${this.axisDisplayName(axis.mirror)}.`
            note.style.fontSize="0.8em"; note.style.opacity="0.7"
            body.append(labelRow,note)
        }
        row.append(this.axisShowToggle(axis,"Show this axis",refreshBody),name)
        block.append(row,body)
        refreshBody()
    }
    axisSliderRange(axis){
        const bounds=this.graph.dataBounds()
        const isX=(axis.orientation==="horizontal")
        const dataMin=isX?bounds?.xMin:bounds?.yMin
        const dataMax=isX?bounds?.xMax:bounds?.yMax
        const currentMin=axis.domain?.[0]
        const currentMax=axis.domain?.[1]
        //The track must always CONTAIN the current view, otherwise a window
        //zoomed past the data extents gets clamped back to it by the input
        //min/max and the thumbs silently lie about the plotted domain. The
        //data extent is the preferred reference, the live domain only widens
        //it (this is the "zoomed before any data" case: bounds are null, so
        //the view itself is the only reference available).
        const candidates=[dataMin,dataMax,currentMin,currentMax]
            .filter(value=>Number.isFinite(value))
        if(candidates.length<2) return {paddedMin:0,paddedMax:1,step:0.005,initMin:0,initMax:1}
        const refMin=Math.min(...candidates)
        const refMax=Math.max(...candidates)
        const span=(refMax-refMin)||1
        //the step keeps following the DATA extent, not the widened track: a
        //track grown by a large zoom-out would otherwise coarsen the slider
        //granularity for the rest of the session
        const dataSpan=(Number.isFinite(dataMin)&&Number.isFinite(dataMax)&&dataMax>dataMin)
            ?(dataMax-dataMin)
            :span
        return {
            paddedMin:refMin-0.1*span,
            paddedMax:refMax+0.1*span,
            step:(dataSpan||1)/200,
            initMin:Number.isFinite(currentMin)?currentMin:(refMin-0.1*span),
            initMax:Number.isFinite(currentMax)?currentMax:(refMax+0.1*span)
        }
    }
    buildDualSlider(block,axis,autoBtn){
        const {paddedMin,paddedMax,step,initMin,initMax}=this.axisSliderRange(axis)
        this.renderDualSlider(block,axis,autoBtn,paddedMin,paddedMax,step,initMin,initMax)
    }
    refreshAxisBlock(block,axis){
        const autoBtn=block.querySelector("button[title='Automatic bounds']")
        if(autoBtn) autoBtn.style.opacity=(axis.autoDomain??true)?"1":"0.45"
        block.querySelectorAll(":scope > div[data-range]").forEach(elt=>elt.remove())
        this.buildDualSlider(block,axis,autoBtn)
    }
    renderDualSlider(block,axis,autoBtn,paddedMin,paddedMax,step,initMin,initMax){
        const rangeRow=document.createElement("div")
        rangeRow.dataset.range="1"
        rangeRow.style.display="grid"; rangeRow.style.gridTemplateColumns="auto minmax(0,1fr)"; rangeRow.style.gap="4px"; rangeRow.style.alignItems="center"
        const rangeLabel=document.createElement("span"); rangeLabel.textContent="Range"; rangeLabel.style.fontSize="0.85em"
        const sliders=document.createElement("div")
        sliders.style.position="relative"; sliders.style.height="1.6em"; sliders.style.minWidth="0"; sliders.style.overflow="hidden"
        const track=document.createElement("div")
        track.style.position="absolute"; track.style.left="0"; track.style.right="0"; track.style.top="50%"
        track.style.height="4px"; track.style.transform="translateY(-50%)"
        track.style.borderRadius="2px"; track.style.background="rgba(255,255,255,0.25)"
        const fill=document.createElement("div")
        fill.style.position="absolute"; fill.style.top="50%"; fill.style.height="4px"; fill.style.transform="translateY(-50%)"
        fill.style.borderRadius="2px"; fill.style.background="#3498db"; fill.style.pointerEvents="none"
        const lo=document.createElement("input")
        lo.type="range"; lo.min=String(paddedMin); lo.max=String(paddedMax); lo.step=String(step); lo.value=String(initMin)
        const hi=document.createElement("input")
        hi.type="range"; hi.min=String(paddedMin); hi.max=String(paddedMax); hi.step=String(step); hi.value=String(initMax)
        lo.classList.add("dual"); hi.classList.add("dual")
        for(const thumb of [lo,hi]){
            thumb.style.position="absolute"; thumb.style.inset="0"; thumb.style.width="100%"
            thumb.style.background="transparent"; thumb.style.pointerEvents="none"
        }
        const paint=()=>{
            const a=Number(lo.value)
            const b=Number(hi.value)
            const loPct=((Math.min(a,b)-paddedMin)/(paddedMax-paddedMin))*100
            const hiPct=((Math.max(a,b)-paddedMin)/(paddedMax-paddedMin))*100
            fill.style.left=`${loPct}%`
            fill.style.width=`${Math.max(0,hiPct-loPct)}%`
            lo.style.zIndex=(a<=b)?"3":"2"
            hi.style.zIndex=(a<=b)?"2":"3"
        }
        const inputsRow=document.createElement("div")
        inputsRow.style.display="grid"; inputsRow.style.gridTemplateColumns="minmax(0,1fr) minmax(0,1fr)"; inputsRow.style.gap="4px"; inputsRow.style.minWidth="0"
        inputsRow.style.gridColumn="1 / -1"
        const loNum=document.createElement("input")
        loNum.type="number"; loNum.step="any"; loNum.value=String(initMin)
        loNum.style.width="100%"; loNum.title="Lower bound"
        const hiNum=document.createElement("input")
        hiNum.type="number"; hiNum.step="any"; hiNum.value=String(initMax)
        hiNum.style.width="100%"; hiNum.title="Upper bound"
        inputsRow.append(loNum,hiNum)
        const parseOk=(value)=>{
            //a number field holds intermediate states while typing ("", "-",
            //"1e"...) which must never be coerced into a bound
            return value!==""&&value!=="-"&&Number.isFinite(Number(value))
        }
        const apply=(a,b,from)=>{
            a=Number(a); b=Number(b)
            if(!Number.isFinite(a)||!Number.isFinite(b)) return
            if(a===b) return
            if(a>b) [a,b]=[b,a]
            if(axis.scale==="log"&&(a<=0||b<=0)) return
            //the rebuild triggered by the redraw must not fight this gesture
            this.axisInteraction=true
            try{
                const loBound=Number(lo.min)
                const hiBound=Number(lo.max)
                a=Math.min(Math.max(a,loBound),hiBound)
                b=Math.min(Math.max(b,loBound),hiBound)
                if(a===b) return
                axis.domain=[a,b]
                axis.autoDomain=false
                this.graph.drawGraph()
                lo.value=String(a); hi.value=String(b)
                if(from!=="numbers"){
                    //the number fields are only rewritten when the change comes from
                    //the sliders: rewriting them from their own typing would clobber
                    //an in-progress value (and made negative numbers impossible)
                    loNum.value=String(a); hiNum.value=String(b)
                }
                paint()
                autoBtn.style.opacity="0.45"
            }finally{
                //a single early return must never leave the guard stuck
                this.axisInteraction=false
            }
        }
        const commitNumbers=()=>{
            if(!parseOk(loNum.value)||!parseOk(hiNum.value)) return
            apply(loNum.value,hiNum.value,"numbers")
            //reflect the clamped domain back into the fields on commit
            loNum.value=String(axis.domain[0]); hiNum.value=String(axis.domain[1])
        }
        lo.addEventListener("input",()=>apply(lo.value,hi.value,"sliders"))
        hi.addEventListener("input",()=>apply(lo.value,hi.value,"sliders"))
        loNum.addEventListener("input",()=>{
            if(!parseOk(loNum.value)||!parseOk(hiNum.value)) return
            apply(loNum.value,hiNum.value,"numbers")
        })
        hiNum.addEventListener("input",()=>{
            if(!parseOk(loNum.value)||!parseOk(hiNum.value)) return
            apply(loNum.value,hiNum.value,"numbers")
        })
        loNum.addEventListener("change",commitNumbers)
        hiNum.addEventListener("change",commitNumbers)
        sliders.append(track,fill,lo,hi)
        rangeRow.append(rangeLabel,sliders,inputsRow); block.append(rangeRow)
        paint()
    }
    collectTraces(){
        const traces=[]
        const colors=["#e74c3c","#3498db","#2ecc71","#f39c12","#9b59b6","#1abc9c"]
        for(const input of this.inputs){
            for(const [parent,values] of input){
                for(const waves of values){
                    if(!Array.isArray(waves)) continue
                    for(const wave of waves){
                        if(wave instanceof Wave){
                            const traceIndex=traces.length
                            const options={color:colors[traceIndex%colors.length]}
                            if(wave.metadata?.traceMode){
                                options.mode=wave.metadata.traceMode
                            }
                            traces.push(new XYTrace({
                                id:`${parent.events?.registrationId??parent.title}:${traceIndex}`,
                                title:wave.metadata.title??parent.title,
                                wave,
                                options
                            }))
                        }
                    }
                }
            }
        }
        return traces
    }
    applyTraceOptions(traces){
        const saved = this.traceOptions?.length
            ? this.traceOptions
            : this.graph?.traces?.map(trace => ({
                id: trace.id,
                title: trace.title,
                options: trace.options
            }))
        if(!Array.isArray(saved)||!saved.length){
            return traces
        }
        const entries=saved.filter(entry=>entry&&typeof entry==="object")
        const positions=entries.map(entry=>entry.id)
        const pending=entries.slice()
        for(const trace of traces){
            if(!trace.options||typeof trace.options!=="object"){
                continue
            }
            let match=pending.find(entry=>entry.id===trace.id)
            if(!match){
                match=pending.find(entry=>entry.title===trace.title)
            }
            if(!match||!match.options||typeof match.options!=="object"){
                continue
            }
            pending.splice(pending.indexOf(match),1)
            //the applied object is shared with its saved entry, so later user
            //edits stay in sync and survive the next re-resolve
            trace.options=Object.assign({},trace.options,match.options)
            match.options=trace.options
            if(!trace.options.marker||typeof trace.options.marker!=="object"){
                trace.options.marker={shape:"circle",size:4}
            }
            if(!trace.options.line||typeof trace.options.line!=="object"){
                trace.options.line={size:1,style:"solid",joinStyle:"round",miterLimit:10,capStyle:"flat"}
            }
        }
        //restore the saved drawing order (drag-reorder in the inspector)
        if(positions.length){
            traces.sort((a,b)=>{
                const ia=positions.indexOf(a.id)
                const ib=positions.indexOf(b.id)
                return (ia===-1?positions.length:ia)-(ib===-1?positions.length:ib)
            })
        }
        return traces
    }
    async startResolve(){
        this.status="pending"
        const traces=this.applyTraceOptions(this.collectTraces())
        this.graph.setTraces(traces)
        this.graph.syncAxisLabels()
        if(this.graph.parameters.axis.bottom.scale==="log"&&this.graph.points.some(([x,y])=>x<=0||y<=0)){
            this.setLogarithmicScale(false)
        }
        this.graph.drawGraph()
        this.renderInspector()
        this.status=traces.length?"resolved":"error"
    }
    restoreAfterImport(){
        super.restoreAfterImport()
        this.status="floating"
        if(this.inputs.some(input=>input instanceof Map&&input.size)){
            //the session import already decoded the inputs: rebuild the traces
            //from them (saved axes and trace options are re-applied)
            this.startResolve()
        }else{
            this.graph?.drawGraph()
        }
    }
    refreshFromLinks(){
        //undo/redo path: the caller triggers this once the links exist again
        this.destination?.syncInputs(this).then(()=>{
            if(this.inputs.some(input=>input instanceof Map&&input.size)){
                //the live parents are already resolved: rebuild the traces from
                //them (saved axes and trace options are re-applied)
                this.startResolve()
            }else{
                this.status="floating"
                this.graph?.drawGraph()
            }
        })
    }
}


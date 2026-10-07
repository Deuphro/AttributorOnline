import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm"
import {CE,stylize,DC} from "../util.js"
import {XYTrace} from "../formats.js"
import {Command} from "../core/index.js"

//mouse zoom: the domain expansion per wheel notch is exp(deltaY Ã— this);
//0.002 â‰ˆ Â±20% for a classic 100px notch, smooth for trackpad deltas
export const WHEEL_ZOOM_SENSITIVITY=0.002
//quiet period after the last wheel event before the gesture is committed
//to the history as a single undoable command
export const ZOOM_GESTURE_DELAY=300
//left-drag must travel further than this (px) before it becomes a pan, so
//plain clicks and double-clicks never move the view
export const PAN_DEAD_ZONE=4
//after an activated pan, the dblclick reset is ignored for this long (ms):
//the click completing a drag must not trigger it by accident
export const PAN_DBLCLICK_GUARD=350
//an axis may be dragged outside the graph zone on purpose: drawing it past
//the fit bounds is how you read a value the data does not reach
export const AXIS_POSITION_LIMIT=3

export class Plot2D{
    //every plot gets a unique SVG id: references such as url(#gradient) are
    //resolved document-wide, so two plots sharing one id would make the first
    //definition win for both
    static instanceCounter=0
    constructor(data,title,origin,destination){
        this.title=title
        this.data=data
        this.traces=[]
        this.origin=origin
        this.destination=destination
        this.container=CE('div',{className:"2dplot container",pilot:this},[]);
        this.parameters={
            graphzone:{
                drawn:false,
                opacity:"0.5"
            },
            baseMargins:{
                top:12,
                bottom:52,
                left:40,
                right:15
            },
            margins:{
                top:12,
                bottom:52,
                left:40,
                right:15
            },
            axis:DC(this.defaultAxes)
        }
        this.updateMargins()
        stylize(this.container,{
            position:"relative",
            width:"100%",
            height:"100%",
        })
        this.destination.appendChild(this.container)
        this.drawGraph()
        this.container.handleResize=(e)=>e.target.pilot.drawGraph()
        //mouse zoom & pan: the wheel rescales the domains under the cursor,
        //left-drag translates them (clamped like the zoom), a double-click
        //gives the automatic (data fitted) view back
        this.zoomDrawFrame=null
        this.zoomGestureBefore=null
        this.zoomGestureTimer=null
        this.zoomedWhileEmpty=false
        this.lastPanEndAt=-Infinity
        this.axisDrag=null
        this.container.addEventListener("wheel",(event)=>this.handleWheelZoom(event),{passive:false})
        this.container.addEventListener("dblclick",(event)=>this.handleZoomReset(event))
        this.container.addEventListener("mousedown",(event)=>this.handlePanStart(event))
    }
    get graphzone(){
        return {
            width:Math.max(0,this.container.clientWidth-this.parameters.margins.left-this.parameters.margins.right),
            height:Math.max(0,this.container.clientHeight-this.parameters.margins.top-this.parameters.margins.bottom)
        }
    }
    get defaultAxes(){
        return {
            bottom:{
                drawn:false,
                enabled:true,
                mirror:null,
                domain:[0,1],
                autoDomain:true,
                range:[0,1],
                position:{left:0,top:1},
                label:"Abscissa",
                autoLabel:true,
                orientation:"horizontal",
                scale:"linear",
                type:"bottom"
            },
            left:{
                drawn:false,
                enabled:true,
                mirror:null,
                domain:[0,1],
                autoDomain:true,
                range:[1,0],
                position:{left:0,top:0},
                label:"Ordinate",
                autoLabel:true,
                orientation:"vertical",
                scale:"linear",
                type:"left"
            },
            top:{
                drawn:false,
                enabled:false,
                mirror:"bottom",
                domain:[0,1],
                autoDomain:true,
                range:[0,1],
                position:{left:0,top:0},
                label:"",
                autoLabel:true,
                orientation:"horizontal",
                scale:"linear",
                type:"top"
            },
            right:{
                drawn:false,
                enabled:false,
                mirror:"left",
                domain:[0,1],
                autoDomain:true,
                range:[1,0],
                position:{left:1,top:0},
                label:"",
                autoLabel:true,
                orientation:"vertical",
                scale:"linear",
                type:"right"
            }
        }
    }
    ensureAxes(){
        for(const [key,fallback] of Object.entries(this.defaultAxes)){
            const axis=this.parameters.axis[key]
            if(!axis){
                this.parameters.axis[key]=DC(fallback)
                continue
            }
            for(const [field,value] of Object.entries(fallback)){
                if(axis[field]===undefined){
                    axis[field]=DC(value)
                }
            }
        }
    }
    updateMargins(){
        if(!this.parameters.baseMargins){
            this.parameters.baseMargins={...this.parameters.margins}
        }
        const margins={...this.parameters.baseMargins}
        if(this.axisShown("top")){
            margins.top=Math.max(margins.top,52)
        }
        if(this.axisShown("right")){
            margins.right=Math.max(margins.right,40)
        }
        this.parameters.margins=margins
        return margins
    }
    axisShown(key){
        const axis=this.parameters.axis[key]
        return Boolean(axis&&(axis.enabled??true))
    }
    axisMirrorOf(key){
        const mirror=this.parameters.axis[key]?.mirror
        return mirror?this.parameters.axis[mirror]??null:null
    }
    //the axis a drawn axis takes its scale and domain from (itself unless it is a mirrored axis)
    axisSource(key){
        return this.axisMirrorOf(key)??this.parameters.axis[key]
    }
    axisLabelText(key){
        const axis=this.parameters.axis[key]
        if(axis?.label) return axis.label
        return this.axisMirrorOf(key)?.label??""
    }
    //coordinates are expressed inside the anchor group, so they only need the graphzone and a free margin
    axisLabelPlacement(key){
        const type=this.parameters.axis[key]?.type??key
        switch(type){
            case "top":
                return {rotate:null,x:this.graphzone.width/2,y:-38}
            case "left":
                return {rotate:-90,x:-this.graphzone.height/2,y:-28}
            case "right":
                return {rotate:90,x:this.graphzone.height/2,y:-28}
            case "bottom":
            default:
                return {rotate:null,x:this.graphzone.width/2,y:38}
        }
    }
    setTraces(traces){
        this.traces=traces.filter(trace=>trace instanceof XYTrace)
        //the flat legacy holder only matters while no trace exists: rebuilding
        //it from the traces would allocate one array per point on every resolve
        this.data=this.traces.length?[]:this.data
    }
    syncAxisLabels(){
        const reference=this.traces[0]?.wave
        if(!reference) return
        if(this.parameters.axis.bottom.autoLabel){
            this.parameters.axis.bottom.label=reference.labels[0]??"X"
        }
        if(this.parameters.axis.left.autoLabel){
            this.parameters.axis.left.label=reference.labels[1]??"Y"
        }
    }
    get points(){
        if(this.traces.length){
            return this.traces.flatMap(trace=>trace.points)
        }
        return this.data
    }
    //allocation free equivalent of the historical
    //filter/slice walk: the same points are visited, but no per point array
    //is ever materialised (mandatory for datasets in the million range)
    dataBounds(){
        const logX=this.parameters?.axis?.bottom?.scale==="log"
        const logY=this.parameters?.axis?.left?.scale==="log"
        const validX=x=>Number.isFinite(x)&&(!logX||x>0)
        const validY=y=>Number.isFinite(y)&&(!logY||y>0)
        let xMin=Infinity
        let xMax=-Infinity
        let yMin=Infinity
        let yMax=-Infinity
        const sources=this.traces.length?this.traces:[{points:this.data}]
        for(const source of sources){
            const wave=source.wave
            if(wave?.core&&wave.degree===2&&wave.dims[1]===2){
                //Wave.core is canonical [x0..xN, y0..yN].
                const core=wave.core
                const count=wave.dims[0]
                for(let i=0;i<count;i++){
                    const x=core[i]
                    const y=core[count+i]
                    if(!validX(x)||!validY(y)) continue
                    if(x<xMin) xMin=x
                    if(x>xMax) xMax=x
                    if(y<yMin) yMin=y
                    if(y>yMax) yMax=y
                }
                continue
            }
            const points=source.points
            if(!points) continue
            if(points instanceof Float32Array||points instanceof Float64Array){
                for(let i=0;i+1<points.length;i+=2){
                    const x=points[i]
                    const y=points[i+1]
                    if(!validX(x)||!validY(y)) continue
                    if(x<xMin) xMin=x
                    if(x>xMax) xMax=x
                    if(y<yMin) yMin=y
                    if(y>yMax) yMax=y
                }
                continue
            }
            for(const pair of points){
                if(!Array.isArray(pair)) continue
                const x=pair[0]
                const y=pair[1]
                if(!validX(x)||!validY(y)) continue
                if(x<xMin) xMin=x
                if(x>xMax) xMax=x
                if(y<yMin) yMin=y
                if(y>yMax) yMax=y
            }
        }
        if(xMin===Infinity||yMin===Infinity) return null
        return {
            xMin,
            xMax,
            yMin,
            yMax
        }
    }
    ensureValidScales(bounds){
        const limits={bottom:[bounds?.xMin,bounds?.xMax],left:[bounds?.yMin,bounds?.yMax]}
        for(const [key,[dataMin,dataMax]] of Object.entries(limits)){
            const axis=this.parameters.axis[key]
            const domain=axis.domain??[]
            const invalidData=!(dataMin>0)||!(dataMax>0)
            const invalidManualDomain=!axis.autoDomain&&(!(domain[0]>0)||!(domain[1]>0))
            if(axis.scale==="log"&&(invalidData||invalidManualDomain)){
                axis.scale="linear"
                axis.autoDomain=true
            }
        }
    }
    //the domain a double-click reset lands on: also the outer bound the
    //wheel zoom-out never crosses (single source of truth for both)
    autoDomainFor(axis,bounds){
        if(!bounds) return null
        if(axis==="bottom"){
            if(this.parameters.axis.bottom.scale==="log"){
                return [bounds.xMin/1.05,bounds.xMax*1.05]
            }
            const xPadding=(bounds.xMax-bounds.xMin)||1
            return [bounds.xMin-0.05*xPadding,bounds.xMax+0.05*xPadding]
        }
        if(axis==="left"){
            if(this.parameters.axis.left.scale==="log"){
                return [bounds.yMin/1.05,bounds.yMax*1.05]
            }
            const yPadding=(bounds.yMax-bounds.yMin)||1
            return [bounds.yMin-0.05*yPadding,bounds.yMax+0.05*yPadding]
        }
        return null
    }
    //Y bounds restricted to the X window currently shown. Used by the
    //single-axis X zoom so points outside that window cannot keep Y too
    //compressed. Keeps the allocation-free typed/Wave traversal of dataBounds.
    dataBoundsInXDomain(){
        const xAxis=this.parameters?.axis?.bottom
        const yAxis=this.parameters?.axis?.left
        const xDomain=xAxis?.domain
        if(!Array.isArray(xDomain)||xDomain.length<2) return null
        if(!Number.isFinite(xDomain[0])||!Number.isFinite(xDomain[1])) return null
        const logX=xAxis.scale==="log"
        const logY=yAxis?.scale==="log"
        if((logX&&!(xDomain[0]>0))||(logY&&!(xDomain[1]>0))) return null
        const validX=x=>Number.isFinite(x)&&x>=xDomain[0]&&x<=xDomain[1]&&(!logX||x>0)
        const validY=y=>Number.isFinite(y)&&(!logY||y>0)
        let yMin=Infinity
        let yMax=-Infinity
        const visit=(x,y)=>{
            if(validX(x)&&validY(y)){
                if(y<yMin) yMin=y
                if(y>yMax) yMax=y
            }
        }
        const sources=this.traces.length?this.traces:[{points:this.data}]
        for(const source of sources){
            const wave=source.wave
            if(wave?.core&&wave.degree===2&&wave.dims[1]===2){
                const core=wave.core
                const count=wave.dims[0]
                for(let i=0;i<count;i++) visit(core[i],core[count+i])
                continue
            }
            const points=source.points
            if(!points) continue
            if(points instanceof Float32Array||points instanceof Float64Array){
                for(let i=0;i+1<points.length;i+=2) visit(points[i],points[i+1])
                continue
            }
            for(const pair of points){
                if(Array.isArray(pair)) visit(pair[0],pair[1])
            }
        }
        return yMin===Infinity?null:{yMin,yMax}
    }
    autoDomain(axis,bounds){
        const domain=this.autoDomainFor(axis,bounds)
        if(domain){
            this.parameters.axis[axis].domain=domain
        }
    }
    /* -----------------------------------------------------------------
       Mouse zoom â€” the wheel rescales both domains around the data point
       under the cursor, computed in the space of each axis scale (identity
       for a linear axis, log10 for a logarithmic one) so the anchored
       point never moves on screen. Zooming out stops at the auto-fit
       bounds a double-click restores. autoDomain is switched off: drawGraph
       then keeps the manual domains, the SVG overlay, the WebGL camera
       (refreshCamera reads these very scales) and the widgets drawn on top
       (the classifier line â€¦) all follow through the regular redraw path.
      ----------------------------------------------------------------- */
    handleWheelZoom(event){
        //a plot can opt out of the wheel zoom (the trimmer frame is a fixed
        //histogram: zooming it would only shrink the bars out of reach)
        if(this.allowZoom===false) return
        //a plain horizontal scroll (deltaY 0) must not freeze autoDomain
        if(!event.deltaY) return
        //the plot owns the wheel gesture: no ancestor may scroll while zooming
        event.preventDefault()
        const zone=this.graphzone
        if(!(zone.width>0&&zone.height>0)) return
        //deltaMode: 0 pixels, 1 lines (Ã—16), 2 pages (Ã—plot height)
        const unit=event.deltaMode===1?16:event.deltaMode===2?zone.height:1
        const factor=Math.exp(event.deltaY*unit*WHEEL_ZOOM_SENSITIVITY)
        if(!Number.isFinite(factor)||factor<=0) return
        //cursor position inside the anchor group (the margins are excluded)
        const rect=this.container.getBoundingClientRect()
        const pixelX=Math.min(Math.max(event.clientX-rect.left-this.parameters.margins.left,0),zone.width)
        const pixelY=Math.min(Math.max(event.clientY-rect.top-this.parameters.margins.top,0),zone.height)
        const {xScale,yScale}=this.plotScales()
        //plain wheel: both axes, shift: Y only, ctrl: X only (alt kept as an alias of ctrl)
        const zoomX=!event.shiftKey
        const zoomY=!event.ctrlKey&&!event.altKey
        let changed=false
        if(zoomX){
            changed=this.zoomAxisDomain("bottom",xScale.invert(pixelX),factor)||changed
            //Ctrl/Alt is the X-only gesture. Refit Y to the points inside
            //the new X window so the vertical signal uses the available
            //height. Plain wheel keeps the existing linked two-axis zoom.
            if(changed&&!zoomY){
                const visibleBounds=this.dataBoundsInXDomain()
                const yFit=this.autoDomainFor("left",visibleBounds)
                if(yFit){
                    this.parameters.axis.left.domain=yFit
                    //This is a fit to the current X window, not the global
                    //data bounds drawGraph would restore in auto mode.
                    this.parameters.axis.left.autoDomain=false
                }
            }
        }
        if(zoomY){
            changed=this.zoomAxisDomain("left",yScale.invert(pixelY),factor)||changed
        }
        if(!changed) return
        //a wheel zoom made before any trace fits no data: remember it so
        //the first drawGraph carrying real bounds discards that manual view
        if(!this.lastDataBounds) this.zoomedWhileEmpty=true
        this.beginZoomGesture()
        this.scheduleZoomDraw()
    }
    //one axis domain scaled around the anchor value, computed in the scale
    //space so a log axis stays strictly positive by construction
    zoomAxisDomain(key,anchor,factor){
        const axis=this.parameters.axis[key]
        const domain=axis?.domain
        if(!Array.isArray(domain)||domain.length<2) return false
        if(!Number.isFinite(anchor)||!Number.isFinite(domain[0])||!Number.isFinite(domain[1])) return false
        const log=axis.scale==="log"
        if(log&&!(anchor>0)) return false
        const to=log?(value=>Math.log10(value)):(value=>value)
        const from=log?(value=>10**value):(value=>value)
        const start=to(domain[0])
        const end=to(domain[1])
        const at=to(anchor)
        let nextStart=at+(start-at)*factor
        let nextEnd=at+(end-at)*factor
        if(!Number.isFinite(nextStart)||!Number.isFinite(nextEnd)) return false
        //set when the clamp snaps a stale view back onto the fit bounds
        let snapped=false
        //zooming out never goes past the auto-fit bounds a double-click
        //restores (the same bounds drawGraph applies through autoDomain)
        if(factor>1){
            const fit=this.fitBoundsFor(key)
            if(fit){
                const low=to(fit[0])
                const high=to(fit[1])
                if(Number.isFinite(low)&&Number.isFinite(high)){
                    nextStart=Math.max(nextStart,low)
                    nextEnd=Math.min(nextEnd,high)
                    //the stale view sits entirely outside the fit bounds:
                    //wheel-out means "show everything", so snap to the fit
                    if(!(nextEnd>nextStart)){
                        nextStart=low
                        nextEnd=high
                        snapped=true
                    }
                }
            }
        }
        //refuse to collapse the domain into (or through) a single float
        const minSpan=Math.max(Math.abs(nextStart),Math.abs(nextEnd),1)*Number.EPSILON*4
        if(Math.abs(nextEnd-nextStart)<minSpan) return false
        const clamped=[from(nextStart),from(nextEnd)]
        //already sitting on the (possibly clamped) target: no state change,
        //so a wheel stuck against the bounds neither redraws nor records
        if(clamped[0]===domain[0]&&clamped[1]===domain[1]) return false
        axis.domain=clamped
        //landing on the fit bounds (snap) IS the auto view: back to auto
        //mode, otherwise the view is manual and drawGraph must keep it
        axis.autoDomain=snapped
        return true
    }
    //The plot view changed programmatically (wheel zoom, pan, reset). The
    //inspector registers a direct callback instead of a DOM event: the slider
    //blocks are rebuilt from axis.domain, which is the single source of truth.
    notifyViewChanged(){
        this.onViewChange?.()
    }

    //wheel bursts and mouse drags both move the domains immediately while
    //the redraw (axes, traces, camera, widgets) runs at most once per frame
    scheduleZoomDraw(){
        if(this.zoomDrawFrame!==null&&this.zoomDrawFrame!==undefined) return
        this.zoomDrawFrame=requestAnimationFrame(()=>{
            this.zoomDrawFrame=null
            this.drawGraph()
            //a pan rebuilds the inspector sliders on every frame otherwise
            if(!this.panInProgress) this.notifyViewChanged()
        })
    }
    //the domains are snapshotted once per gesture (debounced): a whole
    //wheel burst lands in the history as one single undoable command
    beginZoomGesture(){
        if(!this.zoomGestureBefore){
            this.zoomGestureBefore=this.captureZoomState()
        }
        clearTimeout(this.zoomGestureTimer)
        this.zoomGestureTimer=setTimeout(()=>this.commitZoomGesture(),ZOOM_GESTURE_DELAY)
    }
    captureZoomState(){
        return {
            bottom:this.captureAxisZoomState("bottom"),
            left:this.captureAxisZoomState("left")
        }
    }
    captureAxisZoomState(key){
        const axis=this.parameters.axis[key]
        return {
            domain:Array.isArray(axis?.domain)?[...axis.domain]:[0,1],
            autoDomain:Boolean(axis?.autoDomain)
        }
    }
    applyZoomState(state){
        for(const key of ["bottom","left"]){
            const axis=this.parameters.axis[key]
            const saved=state?.[key]
            if(!axis||!saved) continue
            axis.domain=[...saved.domain]
            axis.autoDomain=saved.autoDomain
        }
    }
    zoomStatesEqual(a,b){
        return ["bottom","left"].every(key=>
            a[key].autoDomain===b[key].autoDomain
            &&a[key].domain[0]===b[key].domain[0]
            &&a[key].domain[1]===b[key].domain[1]
        )
    }
    commitZoomGesture(){
        clearTimeout(this.zoomGestureTimer)
        this.zoomGestureTimer=null
        const before=this.zoomGestureBefore
        this.zoomGestureBefore=null
        if(!before) return
        const after=this.captureZoomState()
        if(this.zoomStatesEqual(before,after)) return
        //the command resolves the domains at execution time through the
        //captured snapshots, so a later redraw cannot desync undo/redo
        this.origin?.history?.record?.(new Command({
            label:`Zoom ${this.title??"plot"}`,
            undo:()=>{this.applyZoomState(before);this.drawGraph()},
            redo:()=>{this.applyZoomState(after);this.drawGraph()}
        }))
    }
    //double-click: give the automatic (data fitted) view back
    handleZoomReset(event){
        //the click completing a just-finished pan must not reset the view
        if(performance.now()-this.lastPanEndAt<PAN_DBLCLICK_GUARD) return
        event.preventDefault()
        const before=this.captureZoomState()
        this.parameters.axis.bottom.autoDomain=true
        this.parameters.axis.left.autoDomain=true
        clearTimeout(this.zoomGestureTimer)
        this.zoomGestureTimer=null
        this.zoomGestureBefore=null
        if(this.zoomDrawFrame!==null&&this.zoomDrawFrame!==undefined){
            cancelAnimationFrame(this.zoomDrawFrame)
            this.zoomDrawFrame=null
        }
        const after=this.captureZoomState()
        if(this.zoomStatesEqual(before,after)) return
        this.origin?.history?.record?.(new Command({
            label:`Reset zoom ${this.title??"plot"}`,
            undo:()=>{this.applyZoomState(before);this.drawGraph()},
            redo:()=>{this.applyZoomState(after);this.drawGraph()}
        }))
        this.drawGraph()
        this.notifyViewChanged()
    }
    //the outer bounds both the wheel zoom-out and the pan clamp against:
    //exactly what a double-click reset shows (see autoDomainFor); null
    //while no data has ever been drawn
    fitBoundsFor(key){
        const fit=this.autoDomainFor(key,this.lastDataBounds??this.dataBounds())
        if(!Array.isArray(fit)||!Number.isFinite(fit[0])||!Number.isFinite(fit[1])) return null
        return fit
    }
    //translates one axis domain by a pixel shift (the content follows the
    //cursor), through the very scale drawGraph renders with: a log axis
    //then translates in log space and stays strictly positive. The window
    //is clamped inside the fit bounds â€” it can slide within them but never
    //past them (a window wider than them snaps onto them, the same stale
    //view rule as the wheel zoom-out)
    panAxisDomain(key,scale,shift){
        const axis=this.parameters.axis[key]
        const domain=axis?.domain
        if(!Array.isArray(domain)||domain.length<2) return false
        if(!Number.isFinite(domain[0])||!Number.isFinite(domain[1])) return false
        if(!Number.isFinite(shift)||!shift) return false
        const log=axis.scale==="log"
        const to=log?(value=>Math.log10(value)):(value=>value)
        const from=log?(value=>10**value):(value=>value)
        //each endpoint lives at its own range pixel: translate it there
        const pixels=scale.range()
        const rangePixels=Math.abs(pixels[1]-pixels[0])
        if(!(rangePixels>0)) return false
        let start=to(scale.invert(pixels[0]-shift))
        let end=to(scale.invert(pixels[1]-shift))
        if(!Number.isFinite(start)||!Number.isFinite(end)) return false
        let snapped=false
        const fit=this.fitBoundsFor(key)
        if(fit){
            const low=to(fit[0])
            const high=to(fit[1])
            if(Number.isFinite(low)&&Number.isFinite(high)){
                if(high-low<=end-start){
                    //wider than (or parked on) the bounds: snap onto them
                    start=low
                    end=high
                    snapped=true
                }else{
                    //slide the window back inside, span preserved
                    if(start<low){
                        end+=low-start
                        start=low
                    }
                    if(end>high){
                        start-=end-high
                        end=high
                    }
                }
            }
        }
        //refuse to collapse the domain into (or through) a single float
        const minSpan=Math.max(Math.abs(start),Math.abs(end),1)*Number.EPSILON*4
        if(Math.abs(end-start)<minSpan) return false
        //sub-pixel drift (the clamp held the window against an edge) must
        //neither redraw nor pollute the history
        const movedPx=Math.abs(start-to(domain[0]))/(end-start)*rangePixels
        if(!(movedPx>0.01)) return false
        const clamped=[from(start),from(end)]
        if(!Number.isFinite(clamped[0])||!Number.isFinite(clamped[1])) return false
        if(log&&!(clamped[0]>0&&clamped[1]>0)) return false
        axis.domain=clamped
        //snapping onto the fit bounds IS the auto view; anything else is a
        //manual view drawGraph must keep (same rule as the wheel zoom)
        axis.autoDomain=snapped
        return true
    }
    //left-drag pans both domains (content follows the cursor); the window
    //is clamped inside the same fit bounds as the wheel zoom-out, redraws
    //go through the rAF-coalesced zoom pipeline, and one whole drag lands
    //in the history as a single undoable command
    handlePanStart(event){
        //only the left button pans: the right one keeps its menu
        if(event.button!==0) return
        const zone=this.graphzone
        if(!(zone.width>0&&zone.height>0)) return
        //the plot is dragged as a whole; text selection and native focus
        //moves are blocked for the whole gesture
        event.preventDefault()
        //flush a pending wheel burst so it cannot fold into the pan command
        this.commitZoomGesture()
        const startX=event.clientX
        const startY=event.clientY
        this.panInProgress=true
        let lastX=startX
        let lastY=startY
        let active=false
        let before=null
        const onMove=(moveEvent)=>{
            moveEvent.preventDefault()
            if(!active){
                //dead zone: plain clicks and double-clicks never pan
                if(Math.hypot(moveEvent.clientX-startX,moveEvent.clientY-startY)<PAN_DEAD_ZONE) return
                active=true
                before=this.captureZoomState()
                this.container.style.cursor="grabbing"
                //apply the whole travel from the grab point, not just this step
                lastX=startX
                lastY=startY
            }
            const dx=moveEvent.clientX-lastX
            const dy=moveEvent.clientY-lastY
            lastX=moveEvent.clientX
            lastY=moveEvent.clientY
            if(!dx&&!dy) return
            const {xScale,yScale}=this.plotScales()
            let changed=false
            if(dx) changed=this.panAxisDomain("bottom",xScale,dx)||changed
            if(dy) changed=this.panAxisDomain("left",yScale,dy)||changed
            if(!changed) return
            //same escape hatch as the wheel: a pan before any trace is
            //discarded when the first real bounds arrive
            if(!this.lastDataBounds) this.zoomedWhileEmpty=true
            this.scheduleZoomDraw()
        }
        const onUp=()=>{
            window.removeEventListener("mousemove",onMove)
            window.removeEventListener("mouseup",onUp)
            window.removeEventListener("blur",onUp)
            this.detachPanOnBlur=null
            this.container.style.cursor=""
            this.panInProgress=false
            this.notifyViewChanged()
            if(!active) return
            //the click completing this drag must not finish a double-click
            this.lastPanEndAt=performance.now()
            const after=this.captureZoomState()
            if(this.zoomStatesEqual(before,after)) return
            this.origin?.history?.record?.(new Command({
                label:`Pan ${this.title??"plot"}`,
                undo:()=>{this.applyZoomState(before);this.drawGraph()},
                redo:()=>{this.applyZoomState(after);this.drawGraph()}
            }))
        }
        window.addEventListener("mousemove",onMove)
        window.addEventListener("mouseup",onUp)
        //a drag released outside the window never delivers a mouseup: without
        //this the pan guard would stay stuck and silently kill every later
        //wheel-zoom resync (the inspector would freeze for the whole session)
        window.addEventListener("blur",onUp)
        this.detachPanOnBlur=()=>window.removeEventListener("blur",onUp)
    }
    markerPath(shape,size){
        const s=size??4
        switch(shape){
            case "square": return `M${-s},${-s}H${s}V${s}H${-s}Z`
            case "diamond": return `M0,${-s}L${s},0L0,${s}L${-s},0Z`
            case "triangle-up": return `M0,${-s}L${s},${s}L${-s},${s}Z`
            case "triangle-down": return `M0,${s}L${s},${-s}L${-s},${-s}Z`
            case "cross": return `M${-s},${-s}L${s},${s}M${s},${-s}L${-s},${s}`
            case "plus": return `M${-s},0H${s}M0,${-s}V${s}`
            case "circle":
            default: return null
        }
    }
    drawGraph(){
        if(this.container.clientWidth===0||this.container.clientHeight===0){
            return
        }
        this.ensureAxes()
        this.updateMargins()
        let range=[]
        let scale={}
        let translate=""
        this.axesSVG={}
        let target=""
        const bounds=this.dataBounds()
        //the back layer reuses this very pass as its float precision reference
        this.lastDataBounds=bounds
        this.ensureValidScales(bounds)
        if(bounds){
            //a wheel zoom performed while the plot was empty fits no data:
            //discard that manual view so the first real trace is fitted
            if(this.zoomedWhileEmpty){
                this.zoomedWhileEmpty=false
                this.parameters.axis.bottom.autoDomain=true
                this.parameters.axis.left.autoDomain=true
                //the first real bounds land here: the view jumps back to auto,
                //so the inspector has to be told its widgets are now stale
                this.notifyViewChanged()
            }
            if(this.parameters.axis.bottom.autoDomain??true){
                this.autoDomain("bottom",bounds)
            }
            if(this.parameters.axis.left.autoDomain??true){
                this.autoDomain("left",bounds)
            }
        }
        if(this.parameters.graphzone.drawn){
        } else {
            this.parameters.graphzone.drawn=true
            this.graphSVG=d3.select(this.container)
                .append("svg")
                    .attr("width",this.container.clientWidth)
                    .attr("height",this.container.clientHeight)
                    .attr("class","main")
                    //a real id: SVG references (gradients, clip paths) are
                    //document-wide, so two plots must not answer to the same one
                    .attr("id",`plot2d-${++Plot2D.instanceCounter}`)
            this.graphSVG.append("g")
                    .attr("transform",`translate(${this.parameters.margins.left},${this.parameters.margins.top})`)
                    .attr('class',"anchor")
        }
        this.graphSVG
            .attr("width",this.container.clientWidth)
            .attr("height",this.container.clientHeight)
        this.graphSVG
            .select(".anchor")
                .attr("transform",`translate(${this.parameters.margins.left},${this.parameters.margins.top})`)
        this.graphSVG.attr('opacity',this.parameters.graphzone.opacity)
        for(let axis of Object.keys(this.parameters.axis)){
            if(!this.axisShown(axis)){
                this.graphSVG.select(".anchor").select(`.${axis}`).remove()
                this.parameters.axis[axis].drawn=false
                continue
            }
            if(this.parameters.axis[axis].drawn){
                //MAJ
            }else{
                //INIT (before the traces, so that a re-shown axis does not end up on top of the points)
                this.graphSVG.select(".anchor").insert("g",".trace").attr("class",axis)
            }
            target=`.${axis}`
            translate=`translate(${this.parameters.axis[axis].position.left*this.graphzone.width},${this.parameters.axis[axis].position.top*this.graphzone.height})`
            if(this.parameters.axis[axis].orientation=="horizontal"){
                range=[this.parameters.axis[axis].range[0]*this.graphzone.width,this.parameters.axis[axis].range[1]*this.graphzone.width]
            } else if (this.parameters.axis[axis].orientation=="vertical"){
                range=[this.parameters.axis[axis].range[0]*this.graphzone.height,this.parameters.axis[axis].range[1]*this.graphzone.height]
            }
            const source=this.axisSource(axis)
            scale=(source.scale==="log"?d3.scaleLog():d3.scaleLinear())
                .domain(source.domain)
                .range(range)
            this.axesSVG[axis]=this.graphSVG.select(".anchor").select(target)
            this.axesSVG[axis].attr("transform",translate)
            this.axesSVG[axis].attr("class",`${axis} plot-axis`)
            const axisLength=Math.abs(range[1]-range[0])
            switch (this.parameters.axis[axis].type){
                case "left":
                    this.axesSVG[axis].call(
                        this.applyTickReadability(d3.axisLeft(scale),axis,scale,axisLength)
                    )
                    break
                case "right":
                    this.axesSVG[axis].call(
                        this.applyTickReadability(d3.axisRight(scale),axis,scale,axisLength)
                    )
                    break
                case "top":
                    this.axesSVG[axis].call(
                        this.applyTickReadability(d3.axisTop(scale),axis,scale,axisLength)
                    )
                    break
                case "bottom":
                    this.axesSVG[axis].call(
                        this.applyTickReadability(d3.axisBottom(scale),axis,scale,axisLength)
                    )
                    break
                default:
            }
            const label=this.axisLabelText(axis)
            const placement=this.axisLabelPlacement(axis)
            const axisLabel=this.axesSVG[axis].selectAll("text.axis-label").data([label])
            axisLabel.enter()
                .append("text")
                .attr("class","axis-label")
                .merge(axisLabel)
                .attr("text-anchor","middle")
                .attr("transform",placement.rotate===null?null:`rotate(${placement.rotate})`)
                .attr("x",placement.x)
                .attr("y",placement.y)
                .text(label)
            axisLabel.exit().remove()
            this.parameters.axis[axis].drawn=true
        }
        const {xScale,yScale}=this.plotScales()
        //the axis groups exist only now: the drag behaviour is (re)bound here
        //so a freshly drawn axis is grabbable
        this.attachAxisDrag()
        this.drawTraces(xScale,yScale)
    }
    //the axes and the WebGL back layer share these very scales: deriving the
    //camera bounds from them guarantees a pixel perfect superposition
    plotScales(){
        const xScale=(this.parameters.axis.bottom.scale==="log"?d3.scaleLog():d3.scaleLinear())
            .domain(this.parameters.axis.bottom.domain)
            .range([0,this.graphzone.width])
        const yScale=(this.parameters.axis.left.scale==="log"?d3.scaleLog():d3.scaleLinear())
            .domain(this.parameters.axis.left.domain)
            .range([this.graphzone.height,0])
        return {xScale,yScale}
    }
    //the trace list rendered by both layers: hidden traces are dropped and the
    //legacy plain-array data is wrapped once as a synthetic trace
    resolveRenderTraces(){
        return this.traces.length
            ?this.traces.filter(trace=>!trace.options.hidden)
            :[{
                id:"legacy-data",
                points:this.data,
                options:{color:"tomato",mode:"points",line:{size:1}}
            }]
    }
    //Data-space value the "sticks to zero" segments drop to: 0 on a linear
    //axis, half the smallest positive datum on a log axis (which has no zero).
    stickBaseline(){
        if(this.parameters.axis.left.scale!=="log") return 0
        const bounds=this.lastDataBounds??this.dataBounds()
        const yMin=bounds?.yMin
        return Number.isFinite(yMin)&&yMin>0?yMin/2:NaN
    }

    /* -----------------------------------------------------------------
       Axis dragging â€” grab an axis and it MOVES: only its position (the
       SVG translate) changes, the data domain is left untouched, so the
       plot itself never shifts. A horizontal axis follows the vertical
       pointer, a vertical one the horizontal pointer. The pointer is NOT
       clamped to the zone: an axis is meant to be pulled outside to read a
       value the data does not reach.
       ---------------------------------------------------------------- */
    axisDragPointer(horizontal,event){
        //no clamp: leaving the graphzone is the whole point
        return horizontal?event.y:event.x
    }
    attachAxisDrag(){
        for(const key of Object.keys(this.parameters.axis)){
            if(!this.axisShown(key)) continue
            const group=this.axesSVG[key]
            if(!group||group.empty()) continue
            const axis=this.parameters.axis[key]
            const horizontal=axis.orientation==="horizontal"
            group.style("cursor",horizontal?"ns-resize":"ew-resize")
            group.call(d3.drag()
                .on("start",(event)=>{
                    //flush a pending wheel burst so it cannot fold into this
                    this.commitZoomGesture()
                    this.axisDrag={
                        key,
                        axis,
                        before:{left:axis.position.left,top:axis.position.top},
                        originPointer:this.axisDragPointer(horizontal,event),
                        originPosition:horizontal?axis.position.top:axis.position.left
                    }
                })
                .on("drag",(event)=>{
                    const drag=this.axisDrag
                    if(!drag) return
                    const zoneSize=horizontal?this.graphzone.height:this.graphzone.width
                    if(!(zoneSize>0)) return
                    const pointer=this.axisDragPointer(horizontal,event)
                    //position is a FRACTION of the zone, and it is deliberately
                    //allowed to leave [0,1] so the axis can be read past the fit
                    const raw=drag.originPosition+(pointer-drag.originPointer)/zoneSize
                    const next=Math.min(Math.max(raw,-AXIS_POSITION_LIMIT),AXIS_POSITION_LIMIT)
                    if(horizontal) drag.axis.position.top=next
                    else drag.axis.position.left=next
                    this.scheduleZoomDraw()
                })
                .on("end",()=>{
                    const drag=this.axisDrag
                    this.axisDrag=null
                    if(!drag) return
                    //the click ending this drag must not trigger the dblclick reset
                    this.lastPanEndAt=performance.now()
                    const after={left:drag.axis.position.left,top:drag.axis.position.top}
                    //a pure axis move is its own intention: it gets its own
                    //history entry instead of folding into the zoom command
                    if(drag.before.left===after.left&&drag.before.top===after.top) return
                    this.origin?.history?.record?.(new Command({
                        label:`Move ${drag.key} axis`,
                        undo:()=>{drag.axis.position={...drag.before};this.drawGraph()},
                        redo:()=>{drag.axis.position={...after};this.drawGraph()}
                    }))
                })
            )
        }
    }
    /* -----------------------------------------------------------------
       Tick readability. Two independent causes of unreadable axes:
        â€¢ too many ticks for the room available â†’ the count is derived from
          the ACTUAL pixel length of the axis (~1 tick per 80px);
        â€¢ labels too wide (12,345,678.9) â†’ SI shorthand, and a scientific
          form on log axes where the span is huge.
       Both are applied to the four axis orientations.
       ---------------------------------------------------------------- */
    axisTickConfig(axis,scale,rangePixels){
        const length=Math.abs(rangePixels)
        const count=Math.max(2,Math.floor(length/80))
        const log=this.parameters.axis[axis].scale==="log"
        const formatter=log
            ? (value => {
                if(!Number.isFinite(value)) return ""
                if(value===0) return "0"
                const magnitude=Math.abs(value)
                return (magnitude<1e-3||magnitude>=1e4)
                    ? value.toExponential(0)
                    : String(value)
            })
            : d3.format(".3~s")
        return {count,formatter}
    }
    applyTickReadability(generator,axis,scale,rangePixels){
        const {count,formatter}=this.axisTickConfig(axis,scale,rangePixels)
        return generator.ticks(count).tickFormat(formatter)
    }
    //`traces` is injectable so a subclass can route a subset to the WebGL batch.
    drawTraces(xScale,yScale,traces=this.resolveRenderTraces()){
        const traceGroups=this.graphSVG.select(".anchor")
            .selectAll("g.trace")
            .data(traces,trace=>trace.id)
        const mergedTraceGroups=traceGroups.enter()
            .append("g")
            .attr("class","trace")
            .merge(traceGroups)
        const line=d3.line()
            .x(pair=>xScale(pair[0]))
            .y(pair=>yScale(pair[1]))
        /* LES SEGMENTS, ET ILS SONT UN MODE A PART ENTIERE.

           lines-between-points relie les points DANS L'ORDRE, donc il relie
           aussi le dernier d'un segment au premier du suivant — et un réseau
           de dix mille liens y deviendrait un zigzag qui traverse tout le
           cadre. Ici les points vont deux par deux: a,b,c,d donne DEUX
           segments, a vers b et c vers d, et RIEN entre b et c.

           TOUS LES SEGMENTS TIENNENT DANS UN SEUL path, comme les bâtons. Un
           chemin par lien, ce serait dix mille noeuds DOM et dix mille
           recalculs à chaque déplacement de vue; un chemin unique, c'est une
           chaîne — et c'est ce qui permet de peindre un réseau qui contient
           cent mille pics. */
        const segmentPath=(points,xScale,yScale)=>{
            const parts=[]
            for(let i=0;i+1<points.length;i+=2){
                const from=points[i]
                const to=points[i+1]
                parts.push("M"+xScale(from[0])+","+yScale(from[1])
                    +"L"+xScale(to[0])+","+yScale(to[1]))
            }
            return parts.join("")
        }
        const owner=this
        const stickBaseY=owner.stickBaseline()
        mergedTraceGroups.each(function(trace){
            const group=d3.select(this)
            const tracePoints=trace.points.filter(pair=>Array.isArray(pair)&&Number.isFinite(pair[0])&&Number.isFinite(pair[1]))
            const color=trace.options.color
            const showLine=(trace.options.mode==="lines-between-points"||trace.options.mode==="lines-and-points"||trace.options.mode==="sticks-to-zero"||trace.options.mode==="segments")
            const showMarkers=(trace.options.mode==="points"||trace.options.mode==="lines-and-points")
            const traceLine=group.selectAll("path.trace-line").data(showLine?[tracePoints]:[])
            traceLine.enter()
                .append("path")
                .attr("class","trace-line")
                .merge(traceLine)
                .attr("d",trace.options.mode==="sticks-to-zero"?tracePoints.flatMap(pair=>`M${xScale(pair[0])},${yScale(stickBaseY)}L${xScale(pair[0])},${yScale(pair[1])}`).join(""):trace.options.mode==="segments"?segmentPath(tracePoints,xScale,yScale):line(tracePoints))
                .attr("fill","none")
                .attr("stroke",color)
                /* L'OPACITE, ET ELLE EST UNE PROPRIETE DU TRACE — parce que
                   c'est la seule façon de montrer un lien faible SANS le
                   cacher. Un réseau où les liens à 0.45 Da sont aussi noirs
                   que ceux à 0.02 Da ne dit rien de sa qualité; les effacer
                   dit le contraire de ce qu'on sait. */
                .attr("stroke-opacity",trace.options.opacity??1)
                .attr("stroke-width",trace.options.line.size)
                .attr("stroke-linejoin",trace.options.line.joinStyle)
                .attr("stroke-linecap",trace.options.line.capStyle)
                .attr("stroke-miterlimit",trace.options.line.miterLimit)
            traceLine.exit().remove()
            if(!showMarkers){
                group.selectAll(".point").remove()
                return
            }
            const marker=trace.options.marker??{shape:"circle",size:4}
            const pathD=owner.markerPath(marker.shape,marker.size)
            const circles=group.selectAll("circle.point")
            const paths=group.selectAll("path.point")
            if(pathD){
                circles.remove()
                const markerSelection=paths.data(tracePoints)
                markerSelection.enter()
                    .append("path")
                    .attr("class","point")
                    .merge(markerSelection)
                    .attr("d",pathD)
                    .attr("transform",pair=>`translate(${xScale(pair[0])},${yScale(pair[1])})`)
                    .attr("fill",(marker.shape==="cross"||marker.shape==="plus")?"none":color)
                    .attr("stroke",(marker.shape==="cross"||marker.shape==="plus")?color:"rgb(110, 122, 138)")
                    .attr("stroke-width",Math.max(1,(trace.options.line?.size??1)))
                markerSelection.exit().remove()
            }else{
                paths.remove()
                const tracePointsSelection=circles
                    .data(tracePoints)
                tracePointsSelection.enter()
                    .append("circle")
                    .attr("class","point")
                    .merge(tracePointsSelection)
                    .attr("cx",pair=>xScale(pair[0]))
                    .attr("cy",pair=>yScale(pair[1]))
                    .attr("r",marker.size??4)
                    .attr("fill",color)
                    .attr("stroke","rgb(110, 122, 138)")
                tracePointsSelection.exit().remove()
            }
        })
        traceGroups.exit().remove()
    }
}

/* =====================================================================
    Plot2DWebGL â€” the "sandwich" plot
    ---------------------------------------------------------------------
    Same layout math, same D3/SVG axis pipeline, same ResizeObserver /
    MutationObserver lifecycle as Plot2D; only the trace rendering is
    swapped for the WebGL back layer (scripts/plot2d-gl.js).

        BACK  : persistent <canvas class="trace-layer"> + one Three.js
                renderer/scene/orthographic camera (gl.POINTS + gl.LINES)
        FRONT : the untouched D3/SVG overlay (axes, ticks, labels,
                interaction widgets) drawn on top of the canvas

    The data path is flat Float32Array only, filled in a single traversal
    and re-filled only when the data, the axis transform or the styling
    changed: a resize/pan is strictly a GPU matrix swap.
   ===================================================================== */


import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm"
import {CE,stylize} from "../util.js"
import {Plot2D} from "./Plot2D.js"
import {GLTraceLayer,shapeId,parseCssColor,THREE_CDN} from "../plot2d-gl.js"
import {PAN_DBLCLICK_GUARD,PAN_DEAD_ZONE} from "./Plot2D.js"

const GL_RENDER_DEFAULTS={
    enabled:true,
    opacity:0.7,
    pixelRatioCap:2,
    //subtract the data minimum from every vertex (float32 precision guard)
    referenceOrigin:true,
    //the pick radius, in CSS px. It is the distance at which a point is
    //still grabbed, NOT the size of the marker: the marker is drawn well
    //inside it, or a 10px halo around a 4px dot reads as a bug
    pickRadius:9
}

//the gap between a point and its tooltip, and the distance kept from the
//container edges when the tooltip has to flip to the other side of the point
const GL_PICK_TIP_GAP=14
const GL_PICK_TIP_EDGE=4
//how many pinned points one plot may carry. A hundred is far past any real
//use, and it exists so a runaway dblclick cannot fill the DOM
const GL_PICK_PIN_LIMIT=100

//how many times the post-draw watch may refill the buffers on its own before
//giving up and asking the application for an explicit refresh()
const GL_UPLOAD_CHECK_ATTEMPTS=8

export class Plot2DWebGL extends Plot2D{
    constructor(data,title,origin,destination){
        super(data,title,origin,destination)
        //the base constructor already ran a first drawGraph, whose lazy
        //bootstrap may have created the layer: never clobber it here (each
        //replacement would leak a WebGL context and an orphan canvas)
        this.glLayer=this.glLayer??null
        //instances owned by the class and never recreated in the draw loop
        this.glRenderer=this.glRenderer??null
        this.glScene=this.glScene??null
        this.glCamera=this.glCamera??null
        this.glPoints=this.glPoints??null
        this.glLines=this.glLines??null
        this.glSignature=this.glSignature??null
        this.glDataRevision=this.glDataRevision??0
        this.glRenderOptions=this.glRenderOptions??{...GL_RENDER_DEFAULTS}
        //precision reference of the uploaded vertices
        this.glReference=this.glReference??{x:0,y:0}
        //identity of the arrays currently on the GPU (stale upload detection)
        this.glUploadedSources=this.glUploadedSources??null
        this.glSourceScratch=this.glSourceScratch??[]
        this.glCheckFrame=this.glCheckFrame??null
        this.glCheckAttempts=this.glCheckAttempts??0
        this.lastDataBounds=this.lastDataBounds??null
        this.resizeFrame=this.resizeFrame??null
        /* --- survol / pointage (voir ensurePickOverlay) ---
           Ces champs sont initialisés APRÈS super() parce que le
           constructeur de Plot2D appelle déjà drawGraph(), donc
           drawTraces() et syncPickOverlay() tournent sur une instance
           encore à moitié construite: d'où le test d'entrée de
           syncPickOverlay(). */
        this.pickOverlay=this.pickOverlay??null
        this.pickAnchor=this.pickAnchor??null
        this.pickHoverGroup=this.pickHoverGroup??null
        this.pickHoverVisible=this.pickHoverVisible??false
        this.pickPins=this.pickPins??[]
        this.pickPinSerial=this.pickPinSerial??0
        this.pickHoverFrame=this.pickHoverFrame??null
        this.pickHoverEvent=this.pickHoverEvent??null
        this.pickPointerDown=this.pickPointerDown??null
        this.pickPointerInside=this.pickPointerInside??false
        //les traces routées vers le calque GL lors du DERNIER upload: c'est
        //elles, et elles seules, que l'index de pointage a indexées
        this.pickTraces=this.pickTraces??[]
        //le back layer needs its own stacking context (see styles/main.css)
        this.container.classList.remove("2dplot")
        this.container.classList.add("plot2d")
        stylize(this.container,{position:"relative",zIndex:"0"})
        this.ensureTraceCanvas()
        //same register as the wheel/dblclick/mousedown of Plot2D: the events
        //bubble up from the SVG overlay, which sits on top of the canvas
        this.onPickMove=(event)=>this.handlePickMove(event)
        this.onPickLeave=()=>this.handlePickLeave()
        this.onPickDown=(event)=>{this.pickPointerDown={x:event.clientX,y:event.clientY}}
        this.onPickClick=(event)=>this.handlePickClick(event)
        this.onPickKey=(event)=>this.handlePickKey(event)
        this.container.addEventListener("mousemove",this.onPickMove,{passive:true})
        this.container.addEventListener("mouseleave",this.onPickLeave)
        this.container.addEventListener("mousedown",this.onPickDown)
        this.container.addEventListener("click",this.onPickClick)
        window.addEventListener("keydown",this.onPickKey)
        //the recursive ResizeObserver pipeline now drives the GPU fast path
        this.container.handleResize=(e)=>this.handleResize(e)
        this.drawGraph()
    }

    /* -----------------------------------------------------------------
       Setup phase â€” bootstrap the Three.js subsystem ONCE
      ----------------------------------------------------------------- */
    ensureTraceCanvas(){
        const renderOptions=this.glRenderOptions??GL_RENDER_DEFAULTS
        if(!this.glLayer&&renderOptions.enabled){
            let canvas=null
            try{
                canvas=CE("canvas",{className:"trace-layer"},[])
                stylize(canvas,{
                    position:"absolute",
                    left:"0px",
                    top:"0px",
                    display:"block",
                    pointerEvents:"none",
                    zIndex:"-1"
                })
                this.traceCanvas=canvas
                this.glLayer=new GLTraceLayer(canvas,{
                    opacity:renderOptions.opacity,
                    pixelRatioCap:renderOptions.pixelRatioCap
                })
                this.glLayer.onContextRestored=()=>{
                    //context loss wipes the GPU side buffers: force a re-upload
                    this.glSignature=null
                    this.drawGraph()
                }
                this.glRenderer=this.glLayer.renderer
                this.glScene=this.glLayer.scene
                this.glCamera=this.glLayer.camera
                this.glPoints=this.glLayer.points
                this.glLines=this.glLayer.lines
            }catch(error){
                console.warn(`Plot2DWebGL: WebGL layer unavailable (${THREE_CDN}), falling back to the SVG renderer`,error)
                canvas?.remove?.()
                this.traceCanvas=null
                this.glLayer=null
                this.glRenderOptions={...GL_RENDER_DEFAULTS,enabled:false}
            }
        }
        //the canvas is the first child so that the SVG overlay stays on top
        if(this.traceCanvas&&this.container.firstChild!==this.traceCanvas){
            this.container.insertBefore(this.traceCanvas,this.container.firstChild)
        }
        //defensive: never leave orphan canvases behind (each one owns a context)
        for(const child of [...this.container.children]){
            if(child!==this.traceCanvas&&child.classList?.contains("trace-layer")){
                child.remove()
            }
        }
        return this.glLayer
    }

    /* -----------------------------------------------------------------
       CPU side of the data path: traces â†’ one descriptor per trace.
       Nothing here is per point, so the cost does not depend on the
       number of samples.
      ----------------------------------------------------------------- */
    buildTraceDescriptors(traces){
        const descriptors=[]
        for(const trace of traces){
            const options=trace.options??{}
            const marker=options.marker??{}
            const line=options.line??{}
            const mode=options.mode??"points"
            const markerSize=Number(marker.size??4)
            const lineSize=Number(line.size??1)
            const wave=trace.wave
            let buffer=null
            let yBuffer=null
            let pairs=null
            let count=0
            if(wave?.core&&wave.degree===2&&wave.dims[1]===2){
                //Wave.core is canonical [x0..xN, y0..yN], not interleaved.
                count=wave.dims[0]
                buffer=wave.core.subarray(0,count)
                yBuffer=wave.core.subarray(count,count*2)
            }else{
                const points=trace.points??[]
                if(points instanceof Float32Array||points instanceof Float64Array){
                    buffer=points
                    count=Math.floor(points.length/2)
                }else{
                    pairs=points
                    count=points.length
                }
            }
            descriptors.push({
                buffer,
                yBuffer,
                pairs,
                count,
                //colour resolution is a cached dictionary lookup: no DOM, no layout
                color:parseCssColor(options.color??"#ff0000"),
                //sprite diameter: one unit of the sprite is marker.size (half extent)
                size:markerSize*2,
                shape:shapeId(marker.shape??"circle"),
                markers:(mode==="points"||mode==="lines-and-points")&&markerSize>0,
                lines:(mode==="lines-between-points"||mode==="lines-and-points")&&lineSize>0,
                sticks:mode==="sticks-to-zero"&&lineSize>0,
                /* what the hover is allowed to answer about. NOT `markers`:
                   the default mode is "lines-between-points" (see Trace), and
                   a trace drawn as a line is made of points all the same —
                   refusing to index them would leave the hover dead on every
                   ordinary plot. The polyline passes through every one of
                   them, so the nearest indexed point is on what is drawn. */
                pickable:(mode==="points"||mode==="lines-and-points")&&markerSize>0
                    ||(mode==="lines-between-points"||mode==="lines-and-points"||mode==="sticks-to-zero")&&lineSize>0
            })
        }
        return descriptors
    }

    //cheap O(#traces) fingerprint: the GPU buffers are refilled only when the
    //data, the axis transforms or the trace styling actually changed
    traceSignature(traces){
        const parts=[
            this.glDataRevision??0,
            this.parameters.axis.bottom.scale,
            this.parameters.axis.left.scale,
            traces.length
        ]
        for(const trace of traces){
            const options=trace.options??{}
            const marker=options.marker??{}
            const line=options.line??{}
            const wave=trace.wave
            parts.push(
                trace.id??"",
                options.color??"",
                options.mode??"",
                marker.shape??"",
                marker.size??"",
                line.size??"",
                wave?wave.dims[0]:(trace.points?.length??0)
            )
        }
        return parts.join("|")
    }

    /* -----------------------------------------------------------------
       GPU buffer pre-allocation pipeline (scripts/plot2d-gl.js):
       filtering + filling happen in a single traversal, into persistent
       flat Float32Array buffers bound to one BufferGeometry.

       Guarantees, in this order (all inside drawGraph, hence AFTER
       dataBounds/autoDomain/plotScales have settled):
         â€¢ the axis transforms (log) and the reference origin are known;
         â€¢ the buffers are refilled as soon as the data, the styling, the
           scales OR the identity of the underlying array changed;
         â€¢ a one frame watch re-checks the sources so a producer that
           swaps wave.core right after the draw cannot leave a stale
           partial cloud on screen.
      ----------------------------------------------------------------- */
    uploadTracesToGPU(traces){
        if(!this.glLayer){
            return false
        }
        const renderOptions=this.glRenderOptions??GL_RENDER_DEFAULTS
        const sources=this.glSourceIdentity(traces,this.glSourceScratch)
        const signature=this.traceSignature(traces)
        if(signature===this.glSignature&&!this.sourcesChanged(sources)){
            //same data, same styling, same scales, same source arrays
            return false
        }
        this.glSignature=signature
        const logX=this.parameters.axis.bottom.scale==="log"
        const logY=this.parameters.axis.left.scale==="log"
        const reference=this.glReferenceOrigin(logX,logY)
        this.glReference=reference
        //Stick base, expressed in the SAME translated space as the vertices
        //(every Y has already had referenceY subtracted from it), so a plain 0
        //would place the sticks at the wrong height. A log axis has no zero:
        //the sticks stop halfway below the smallest positive datum instead,
        //which keeps them inside the log space.
        let stickBase
        const stickBounds=this.lastDataBounds??this.dataBounds()
        if(logY){
            const yMin=stickBounds?.yMin
            const floor=Number.isFinite(yMin)&&yMin>0?Math.log10(yMin/2):NaN
            stickBase=Number.isFinite(floor)?floor-reference.y:NaN
        }else{
            stickBase=-reference.y
        }
        this.glLayer.upload(this.buildTraceDescriptors(traces),{
            logX,
            logY,
            stickBase,
            referenceX:reference.x,
            referenceY:reference.y
        })
        //remember what was uploaded (identity of every source array)
        this.glUploadedSources=Array.prototype.slice.call(sources)
        this.glUploadedReference={...reference}
        this.scheduleUploadCheck()
        return true
    }

    //identity of the array behind each trace: a producer that replaces
    //wave.core (see Operation.computeOutputs) must not be able to leave the
    //GPU with the previous buffer. O(#traces), never O(#points).
    glSourceIdentity(traces,target=[]){
        let index=0
        for(const trace of traces){
            const wave=trace.wave
            target[index++]=wave?wave.core:(trace.points??null)
        }
        target.length=index
        return target
    }

    //the origin subtracted from the uploaded vertices: the smallest coordinate
    //of the dataset, in the space the GPU works in. Deriving it from the data
    //bounds (not from the axis domain) keeps it stable while the user pans or
    //zooms, so those gestures still need no re-upload at all.
    glReferenceOrigin(logX,logY){
        const renderOptions=this.glRenderOptions??GL_RENDER_DEFAULTS
        const bounds=this.lastDataBounds??this.dataBounds()
        if(!renderOptions.referenceOrigin||!bounds){
            return {x:0,y:0}
        }
        const xMin=logX?(bounds.xMin>0?bounds.xMin:1):bounds.xMin
        const yMin=logY?(bounds.yMin>0?bounds.yMin:1):bounds.yMin
        return {
            x:Number.isFinite(xMin)?(logX?Math.log10(xMin):xMin):0,
            y:Number.isFinite(yMin)?(logY?Math.log10(yMin):yMin):0
        }
    }

    //cheap O(#traces) fingerprint: the GPU buffers are refilled only when the
    //data, the axis transforms or the trace styling actually changed
    traceSignature(traces){
        const reference=this.glReferenceOrigin(
            this.parameters.axis.bottom.scale==="log",
            this.parameters.axis.left.scale==="log"
        )
        const parts=[
            this.glDataRevision??0,
            this.parameters.axis.bottom.scale,
            this.parameters.axis.left.scale,
            reference.x,
            reference.y,
            traces.length
        ]
        for(const trace of traces){
            const options=trace.options??{}
            const marker=options.marker??{}
            const line=options.line??{}
            const wave=trace.wave
            parts.push(
                trace.id??"",
                options.color??"",
                options.mode??"",
                options.layer??"gl",
                marker.shape??"",
                marker.size??"",
                line.size??"",
                wave?(wave.revision??0):0,
                wave?wave.dims[0]:(trace.points?.length??0)
            )
        }
        return parts.join("|")
    }

    //did a producer swap the array behind one of the traces since the upload?
    sourcesChanged(sources){
        const uploaded=this.glUploadedSources
        if(!uploaded||uploaded.length!==sources.length){
            return true
        }
        for(let index=0;index<sources.length;index++){
            if(uploaded[index]!==sources[index]){
                return true
            }
        }
        return false
    }

    /* -----------------------------------------------------------------
       Safety net for the asynchronous producers: Operation.computeOutputs
       (and any worker kernel) can replace wave.core right AFTER a draw
       has already been served. One frame later the sources are compared
       again and, if they moved, the buffers are refilled and repainted,
       so the first display can never stay partial.
      ----------------------------------------------------------------- */
    scheduleUploadCheck(){
        if(this.glCheckFrame!==null&&this.glCheckFrame!==undefined){
            return
        }
        this.glCheckFrame=requestAnimationFrame(()=>{
            this.glCheckFrame=null
            if(!this.glLayer){
                return
            }
            const traces=this.resolveRenderTraces()
            const sources=this.glSourceIdentity(traces,this.glSourceScratch)
            if(!this.sourcesChanged(sources)){
                return
            }
            if((this.glCheckAttempts??0)>=GL_UPLOAD_CHECK_ATTEMPTS){
                console.warn("Plot2DWebGL: the plotted data is still being rewritten; call plot.refresh() once it is final")
                return
            }
            this.glCheckAttempts=(this.glCheckAttempts??0)+1
            //the arrays changed after the draw: refill and repaint immediately
            this.glSignature=null
            this.uploadTracesToGPU(traces)
            this.glLayer?.render()
        })
    }

    //to be called by an asynchronous producer once its data is really final
    refresh(){
        this.invalidateTraces()
        this.drawGraph()
    }

    //the canvas covers exactly the graphzone: the margins stay owned by the SVG
    syncTraceViewport(){
        if(!this.glLayer&&!this.ensureTraceCanvas()){
            return false
        }
        const zone=this.graphzone
        const style=this.traceCanvas.style
        style.left=`${this.parameters.margins.left}px`
        style.top=`${this.parameters.margins.top}px`
        this.glLayer.setViewport(zone.width,zone.height)
        return true
    }

    /* -----------------------------------------------------------------
       Camera: the bounds are read back from the very scales the axes are
       drawn with, so the WebGL layer and the SVG overlay can never drift
       apart. On a log axis both the data and the bounds go through log10,
       which turns the log mapping into the linear mapping the GPU expects.
      ----------------------------------------------------------------- */
    refreshCamera(xScale,yScale){
        if(!this.glLayer) return false
        const logX=this.parameters.axis.bottom.scale==="log"
        const logY=this.parameters.axis.left.scale==="log"
        //the uploaded vertices live in the precision reference frame (see
        //glReferenceOrigin): the camera has to use that same frame
        const reference=this.glReference??{x:0,y:0}
        const leftSource=xScale.invert(0)
        const rightSource=xScale.invert(this.graphzone.width)
        const topSource=yScale.invert(0)
        const bottomSource=yScale.invert(this.graphzone.height)
        return this.glLayer.setBounds({
            left:(logX?Math.log10(leftSource):leftSource)-reference.x,
            right:(logX?Math.log10(rightSource):rightSource)-reference.x,
            top:(logY?Math.log10(topSource):topSource)-reference.y,
            bottom:(logY?Math.log10(bottomSource):bottomSource)-reference.y
        })
    }

    /* -----------------------------------------------------------------
       Render: replaces Plot2D.drawTraces. The D3/SVG implementation is
       kept as a graceful fallback when WebGL is unavailable.
      ----------------------------------------------------------------- */
    drawTraces(xScale,yScale){
        const renderOptions=this.glRenderOptions??GL_RENDER_DEFAULTS
        if(!renderOptions.enabled||(!this.glLayer&&!this.ensureTraceCanvas())){
            super.drawTraces(xScale,yScale)
            return
        }
        /* per trace routing: massive clouds go to the GPU, the traces that must
           stay interactive (DOM events, hit-testing, per point widgets) stay in
           the SVG layer â€” options.layer = "gl" (default) | "svg" */
        const all=this.resolveRenderTraces()
        const glTraces=[]
        const svgTraces=[]
        for(const trace of all){
            if(trace.options?.layer==="svg"){
                svgTraces.push(trace)
            }else{
                glTraces.push(trace)
            }
        }
        //called even with an empty list, so D3 removes the groups that were
        //just moved over to the canvas
        super.drawTraces(xScale,yScale,svgTraces)
        this.syncTraceViewport()
        //the pick index only ever holds the traces that reached the canvas:
        //this is the list its trace indices address
        this.pickTraces=glTraces
        this.uploadTracesToGPU(glTraces)
        if(this.refreshCamera(xScale,yScale)){
            this.glRenderer.render(this.glScene,this.glCamera)
        }
        //an explicit draw restarts the retry budget of the upload watch
        this.glCheckAttempts=0
    }

    /* -----------------------------------------------------------------
       Instantaneous resize, driven by the App ResizeObserver pipeline.
       No data loop, no reallocation: setSize, one projection matrix
       update, one render â€” the GPU does the rest.
      ----------------------------------------------------------------- */
    handleResize(){
        this.resizeTraceLayer()
        //the SVG overlay (axes, ticks, labels) catches up on the next frame,
        //coalesced so a drag-resize cannot redraw it twice within a frame
        if(this.resizeFrame===null){
            this.resizeFrame=requestAnimationFrame(()=>{
                this.resizeFrame=null
                this.drawGraph()
            })
        }
    }

    resizeTraceLayer(){
        if(!this.glLayer) return false
        const {xScale,yScale}=this.plotScales()
        if(!this.syncTraceViewport()) return false
        const ready=this.refreshCamera(xScale,yScale)
        if(ready) this.glRenderer.render(this.glScene,this.glCamera)
        return ready
    }

    setTraces(traces){
        super.setTraces(traces)
        //the data changed: the next draw has to refill the GPU buffers
        this.glDataRevision++
    }

    //for data mutated in place (e.g. a Wasm buffer written by a worker)
    invalidateTraces(){
        this.glDataRevision++
        this.glSignature=null
    }

    glLayerStats(){
        if(!this.glLayer) return null
        return {...this.glLayer.getStats(),uploaded:this.glSignature!==null}
    }

    /* -----------------------------------------------------------------
       Survol et pointage — « quel point est sous le curseur ? »
       -----------------------------------------------------------------
       Le calque GL ignore tout point individuel : il ne connaît que des
       Float32Array. La réponse vient d'un index CPU à plat
       (scripts/plot2d-hit.js), construit dans l'espace référence du GPU
       — donc toujours valide après un pan, un zoom ou un resize, et
       reconstruit uniquement quand les buffers sont réécrits.

       L'overlay est son PROPRE <svg>, frère de svg.main et non enfant :
       svg.main porte l'opacité du graphzone (0.5 par défaut) et un
       groupe enfant ne peut pas s'en échapper. Un noeud de survol
       réutilisé, jamais un noeud par point ; les points cliqués sont
       ÉPINGLÉS, autant qu'on veut, et repositionnés à chaque drawGraph
       pour suivre la vue.
       ---------------------------------------------------------------- */
    drawGraph(){
        super.drawGraph()
        //after the scales and the buffers settled: the pins read both
        this.syncPickOverlay()
    }

    //returns the D3 SELECTION: syncPickOverlay sizes it on every draw, and
    //the DOM node is kept apart in this.pickOverlay for the isConnected
    //test and for the removal in dispose()
    ensurePickOverlay(){
        if(this.pickOverlay&&this.pickOverlay.isConnected) return d3.select(this.pickOverlay)
        //last child of the container: above the axes, and above the canvas
        const overlay=d3.select(this.container)
            .append("svg")
            .attr("class","pick-overlay")
            .attr("width",this.container.clientWidth)
            .attr("height",this.container.clientHeight)
        const anchor=overlay.append("g").attr("class","anchor")
        /* the ONE hover node, reused for the whole life of the plot.
           `r` is written as an ATTRIBUTE as well as in the stylesheet: the
           CSS geometry property is what animates the pin, but a browser
           that does not know it would fall back to r=0 and draw nothing. */
        const hover=anchor.append("g").attr("class","pick-hover").style("display","none")
        hover.append("circle").attr("class","pick-halo").attr("r",5.5)
        hover.append("circle").attr("class","pick-core").attr("r",2.6)
        this.pickOverlay=overlay.node()
        this.pickAnchor=anchor
        this.pickHoverGroup=hover
        return overlay
    }

    //repositioned by drawGraph(): a pin holds DATA coordinates, never pixels,
    //so it follows a pan or a zoom for free and disappears when its trace
    //does. Runs before the pick fields exist during super() — hence the guard
    syncPickOverlay(){
        if(!this.pickPins) return
        const {xScale,yScale}=this.plotScales()
        const zone=this.graphzone
        const overlay=this.ensurePickOverlay()
        overlay.attr("width",this.container.clientWidth)
            .attr("height",this.container.clientHeight)
        this.pickAnchor.attr("transform",`translate(${this.parameters.margins.left},${this.parameters.margins.top})`)
        //a pin whose trace has been removed can never be honoured again.
        //The COPY matters: removePickPin splices this.pickPins, and a filter
        //iterating the live array would step over the pin it just removed
        const alive=[...this.pickPins].filter(pin=>{
            if(this.traces.some(trace=>trace.id===pin.traceId)) return true
            this.removePickPin(pin)
            return false
        })
        for(const pin of alive){
            const px=xScale(pin.x)
            const py=yScale(pin.y)
            //a log axis has no answer for a non-positive coordinate, and
            //NaN is the honest way of saying so: hide, keep the pin
            const onScreen=Number.isFinite(px)&&Number.isFinite(py)
                &&px>=0&&py>=0&&px<=zone.width&&py<=zone.height
            pin.group.style("display",onScreen?null:"none")
            if(!onScreen){
                pin.tip.style.display="none"
                continue
            }
            pin.group.attr("transform",`translate(${px},${py})`)
            this.positionPickTip(pin,px,py)
        }
    }

    pointerInGraphzone(clientX,clientY){
        const zone=this.graphzone
        if(!(zone.width>0&&zone.height>0)) return null
        //read ONCE, before any DOM write: mixing a layout read with a
        //layout write in one frame is what makes a hover janky
        const box=this.container.getBoundingClientRect()
        const x=clientX-box.left-this.parameters.margins.left
        const y=clientY-box.top-this.parameters.margins.top
        //the margins belong to the axes, not to the plot
        if(x<0||y<0||x>zone.width||y>zone.height) return null
        return {x,y}
    }

    pickRadiusPx(){
        const radius=this.glRenderOptions?.pickRadius
        return Number.isFinite(radius)&&radius>0?radius:GL_RENDER_DEFAULTS.pickRadius
    }

    pickAt(x,y){
        const hit=this.glLayer?.pick(x,y,this.pickRadiusPx())
        if(!hit) return null
        const trace=this.pickTraces?.[hit.traceIndex]
        if(!trace) return null
        const value=this.readPickValue(trace,hit.tracePoint)
        if(!value) return null
        return {...hit,trace,x:value.x,y:value.y}
    }

    /* The values are read from the SOURCE, never from the vertex buffer:
       the buffer is float32 (and pre-transform), while Wave.core is the
       float64 the reader must be given. */
    readPickValue(trace,index){
        const wave=trace.wave
        if(wave?.core&&wave.degree===2&&wave.dims[1]===2){
            const count=wave.dims[0]
            if(!(index>=0&&index<count)) return null
            return {x:wave.core[index],y:wave.core[count+index]}
        }
        const points=trace.points
        if(!points) return null
        if(points instanceof Float32Array||points instanceof Float64Array){
            const offset=index*2
            if(!(index>=0)||!(offset+1<points.length)) return null
            return {x:points[offset],y:points[offset+1]}
        }
        const pair=points[index]
        return Array.isArray(pair)?{x:pair[0],y:pair[1]}:null
    }


    handlePickMove(event){
        this.pickPointerInside=true
        //a pan owns the pointer: the content moves under the cursor, so any
        //hover would name a point the user did not point at
        if(this.panInProgress||!this.glLayer){
            this.hidePickHover()
            return
        }
        this.pickHoverEvent={x:event.clientX,y:event.clientY}
        //coalesced: one pick per frame, whatever the mouse polling rate
        if(this.pickHoverFrame!==null&&this.pickHoverFrame!==undefined) return
        this.pickHoverFrame=requestAnimationFrame(()=>{
            this.pickHoverFrame=null
            this.flushPickHover()
        })
    }

    flushPickHover(){
        const pending=this.pickHoverEvent
        this.pickHoverEvent=null
        const hover=this.pickHoverGroup
        if(!pending||!hover||this.panInProgress||!this.glLayer){
            this.hidePickHover()
            return
        }
        const at=this.pointerInGraphzone(pending.x,pending.y)
        const hit=at?this.pickAt(at.x,at.y):null
        if(!hit){
            this.hidePickHover()
            return
        }
        hover.style("display",null).attr("transform",`translate(${hit.px},${hit.py})`)
        this.pickHoverVisible=true
    }

    hidePickHover(){
        if(!this.pickHoverVisible) return
        this.pickHoverVisible=false
        this.pickHoverGroup?.style("display","none")
    }

    handlePickLeave(){
        this.pickPointerInside=false
        this.pickPointerDown=null
        this.hidePickHover()
    }

    handlePickKey(event){
        if(event.key!=="Escape"||!this.pickPins?.length) return
        if(!this.pickPointerInside) return
        this.clearPickPins()
    }

    handlePickClick(event){
        if(event.button!==0) return
        if(this.panInProgress) return
        //the click that ends a pan, and the second click of a double click,
        //are not picks (see handleZoomReset)
        if(performance.now()-this.lastPanEndAt<PAN_DBLCLICK_GUARD) return
        const down=this.pickPointerDown
        if(down&&Math.hypot(event.clientX-down.x,event.clientY-down.y)>PAN_DEAD_ZONE) return
        const at=this.pointerInGraphzone(event.clientX,event.clientY)
        if(!at) return
        const hit=this.pickAt(at.x,at.y)
        //a click on the background is not a mistake to be corrected: it
        //simply names no point, so the pins stay where they are
        if(!hit) return
        this.togglePickPin(hit)
    }

    //clicking a pinned point again unpins it: which is also what makes a
    //double click leave no trace behind before it resets the view
    togglePickPin(hit){
        const existing=this.pickPins.find(pin=>pin.traceId===hit.trace.id&&pin.tracePoint===hit.tracePoint)
        if(existing){
            this.removePickPin(existing)
            return false
        }
        return this.addPickPin(hit)
    }

    addPickPin(hit){
        if(this.pickPins.length>=GL_PICK_PIN_LIMIT) return false
        const anchor=this.pickAnchor??this.ensurePickOverlay().select(".anchor")
        const group=anchor.append("g").attr("class","pick-pin")
        //the attribute is the resting size; the stylesheet's `settling`
        //class takes it back to the hover size for one frame, and the
        //transition closes it in
        group.append("circle").attr("class","pick-halo").attr("r",3.6)
        group.append("circle").attr("class","pick-core").attr("r",2)
        const pin={
            id:++this.pickPinSerial,
            traceId:hit.trace.id,
            tracePoint:hit.tracePoint,
            x:hit.x,
            y:hit.y,
            group,
            tip:this.buildPickTip(hit)
        }
        this.pickPins.push(pin)
        //the pin is born with the hover radii, then handed over to the
        //tighter ones: that is the "it closes in and stays" gesture, and it
        //needs one laid-out frame before the class is dropped
        group.classed("settling",true)
        requestAnimationFrame(()=>requestAnimationFrame(()=>{
            if(pin.group.node()?.isConnected) group.classed("settling",false)
        }))
        this.syncPickOverlay()
        return true
    }

    buildPickTip(hit){
        const trace=hit.trace
        const labels=trace.wave?.labels??["x","y"]
        const logX=this.parameters.axis.bottom.scale==="log"
        const logY=this.parameters.axis.left.scale==="log"
        const tip=CE("div",{className:"pick-tip"},[])
        //measured before it is shown, so the first placement never jumps
        tip.style.visibility="hidden"
        const head=CE("div",{className:"pick-head"},[])
        const swatch=CE("span",{className:"pick-swatch"},[])
        stylize(swatch,{background:trace.options?.color??"#ff0000"})
        head.appendChild(swatch)
        head.appendChild(CE("span",{className:"pick-title"},[trace.title||"trace"]))
        tip.appendChild(head)
        for(const [key,value] of [
            [labels[0]??"x",this.formatPickValue(hit.x,logX)],
            [labels[1]??"y",this.formatPickValue(hit.y,logY)],
            ["#",String(hit.tracePoint)]
        ]){
            const row=CE("div",{className:"pick-row"},[])
            row.appendChild(CE("span",{className:"pick-key"},[key]))
            row.appendChild(CE("span",{className:"pick-val"},[value]))
            tip.appendChild(row)
        }
        const close=CE("button",{className:"pick-close",type:"button",title:"Retirer ce point"},["×"])
        close.addEventListener("click",(event)=>{
            //the container listens for clicks too: without this, closing a
            //tooltip would immediately re-pin whatever sits underneath
            event.stopPropagation()
            const pin=this.pickPins.find(one=>one.tip===tip)
            if(pin) this.removePickPin(pin)
        })
        tip.addEventListener("click",(event)=>event.stopPropagation())
        tip.appendChild(close)
        this.container.appendChild(tip)
        return tip
    }

    //same rule as axisTickConfig, without the tick count: a tooltip wants
    //the digits, not a rounded tick label
    formatPickValue(value,log){
        if(!Number.isFinite(value)) return "—"
        if(log){
            const magnitude=Math.abs(value)
            if(magnitude===0) return "0"
            return (magnitude<1e-3||magnitude>=1e4)
                ?value.toExponential(4)
                :String(value)
        }
        return d3.format(".6~g")(value)
    }

    positionPickTip(pin,px,py){
        const tip=pin.tip
        const host=this.container
        //measuring the tooltip is a layout read, but there are only a
        //handful of pins and one read per drawGraph
        const width=tip.offsetWidth
        const height=tip.offsetHeight
        const hostWidth=host.clientWidth
        const hostHeight=host.clientHeight
        const anchorX=this.parameters.margins.left+px
        const anchorY=this.parameters.margins.top+py
        //flip on whichever side would overflow, rather than clip
        let left=anchorX+GL_PICK_TIP_GAP
        let top=anchorY+GL_PICK_TIP_GAP
        if(left+width>hostWidth-GL_PICK_TIP_EDGE) left=anchorX-width-GL_PICK_TIP_GAP
        if(top+height>hostHeight-GL_PICK_TIP_EDGE) top=anchorY-height-GL_PICK_TIP_GAP
        tip.style.left=`${Math.max(GL_PICK_TIP_EDGE,left)}px`
        tip.style.top=`${Math.max(GL_PICK_TIP_EDGE,top)}px`
        tip.style.visibility="visible"
    }

    removePickPin(pin){
        const index=this.pickPins.indexOf(pin)
        if(index>=0) this.pickPins.splice(index,1)
        pin.group?.remove()
        pin.tip?.remove()
    }

    clearPickPins(){
        for(const pin of [...this.pickPins]) this.removePickPin(pin)
    }

    dispose(){
        this.container.removeEventListener("mousemove",this.onPickMove)
        this.container.removeEventListener("mouseleave",this.onPickLeave)
        this.container.removeEventListener("mousedown",this.onPickDown)
        this.container.removeEventListener("click",this.onPickClick)
        window.removeEventListener("keydown",this.onPickKey)
        if(this.pickHoverFrame!==null&&this.pickHoverFrame!==undefined){
            cancelAnimationFrame(this.pickHoverFrame)
            this.pickHoverFrame=null
        }
        this.pickHoverEvent=null
        this.clearPickPins()
        this.pickHoverGroup=null
        this.pickAnchor=null
        this.pickOverlay?.remove()
        this.pickOverlay=null
        this.pickTraces=[]
        if(this.resizeFrame!==null){
            cancelAnimationFrame(this.resizeFrame)
            this.resizeFrame=null
        }
        //a disposed plot must not leave a pending zoom redraw or gesture behind
        if(this.zoomDrawFrame!==null&&this.zoomDrawFrame!==undefined){
            cancelAnimationFrame(this.zoomDrawFrame)
            this.zoomDrawFrame=null
        }
        if(this.zoomGestureTimer!==null&&this.zoomGestureTimer!==undefined){
            clearTimeout(this.zoomGestureTimer)
            this.zoomGestureTimer=null
        }
        this.zoomGestureBefore=null
        if(this.glCheckFrame!==null&&this.glCheckFrame!==undefined){
            cancelAnimationFrame(this.glCheckFrame)
            this.glCheckFrame=null
        }
        this.glLayer?.dispose()
        this.glLayer=null
        this.glRenderer=null
        this.glScene=null
        this.glCamera=null
        this.glPoints=null
        this.glLines=null
        this.glSignature=null
        this.traceCanvas?.remove()
        this.traceCanvas=null
        //a disposed plot keeps working, but through the SVG renderer
        this.glRenderOptions={...GL_RENDER_DEFAULTS,enabled:false}
    }
}


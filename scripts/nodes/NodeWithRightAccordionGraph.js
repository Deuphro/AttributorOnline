import {Node} from "../core/index.js"
import {Accordion} from "../ui/Accordion.js"
import {Dialog} from "../ui/Dialog.js"
import {Plot2DWebGL} from "../ui/Plot2DWebGL.js"
import {DC,stylize} from "../util.js"

export class NodeWithRightAccordionGraph extends Node{
    constructor(title,inputs,outputs,origin,destinationFlow,position={x:180,y:10}){
        super(title,inputs,outputs,origin,destinationFlow,position)
    }
    /* THE PLOT A SUBCLASS GETS, AND WHY IT IS A METHOD.

       A WebGL context is a BROWSER-WIDE resource, and browsers cap it — at
       16 in Chrome, after which the OLDEST LIVE context is dropped, not the
       one that asked for the seventeenth. "Oldest live" means a context
       belonging to a node the user is still looking at, so exceeding the cap
       does not degrade the new plot, it destroys an unrelated one. That is
       the `WebGL context was lost` that a session with a dozen plots hits.

       So a subclass that does not want a Plot2DWebGL must be able to say so
       BEFORE the context is created, and there is no constructor hook for
       that: `registered()` runs long after the subclass constructor. Creating
       the plot and disposing it a moment later — which is what a subclass
       used to do, since nothing else was available — burns a context anyway,
       and the browser may not have reclaimed it before the real one is
       requested. Two allocations where the node needs one is exactly how the
       cap is reached early.

       Hence this method: the subclass declares its plot, and the base builds
       exactly one. Override it and no 2D context is ever created here. */
    createGraph(dialog,label){
        return new Plot2DWebGL([],`${label} graph`,this.origin,dialog.DOMelt.content)
    }
    registered(e){
        const {channel, registrationName, label, caster} = e.detail.msg
        if(caster !== this || this.accordion){
            return
        }
        this.accordion=new Accordion(
            label,
            this.origin,
            this.origin.main.querySelector(".vertical.right.content")
        )
        channel.register(`${registrationName}:accordion`,this.accordion,label)
        this.graphDialog=new Dialog(`${label} graph`,this.origin,this.origin.midCentralContent)
        const dismisser=this.graphDialog.DOMelt.dismisser
        delete dismisser.handleClick
        dismisser.classList.add("disabled")
        dismisser.setAttribute("aria-disabled","true")
        stylize(this.graphDialog.DOMelt.window,{
            top:"0px",
            left:"0px",
            width:"100%",
            height:"100%"
        })
        channel.register(`${registrationName}:graph`,this.graphDialog,`${label} graph`)
        //createGraph may return null: a node whose view needs no context of
        //its own is a legitimate case, not a failure to report
        this.graph=this.createGraph(this.graphDialog,label)
    }
    serializeState(){
        if(!this.graph){
            return null
        }
        return {
            axes:DC(this.graph.parameters.axis),
            traces:this.graph.traces.map(trace=>({
                id:trace.id,
                title:trace.title,
                options:DC(trace.options)
            }))
        }
    }
    restoreState(state){
        if(!state||!this.graph){
            return
        }
        if(state.axes&&typeof state.axes==="object"){
            this.graph.parameters.axis=DC(state.axes)
            for(const axis of Object.values(this.graph.parameters.axis)){
                if(axis&&typeof axis==="object"){
                    //drawn is a runtime flag: the fresh Plot2D has to redraw its axes
                    axis.drawn=false
                }
            }
        }
        if(Array.isArray(state.traces)){
            this.traceOptions=state.traces
        }
    }
    restoreAfterImport(){
        super.restoreAfterImport()
        this.graph?.drawGraph()
    }
    suicide(options={}){
        //the WebGL context and the GPU buffers are released with the dialog
        this.graph?.dispose?.()
        this.graphDialog?.suicide()
        this.accordion?.suicide()
        super.suicide(options)
    }
}


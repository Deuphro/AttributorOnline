import {Node} from "../core/index.js"
import {Accordion} from "../ui/Accordion.js"
import {Dialog} from "../ui/Dialog.js"
import {Plot2DWebGL} from "../ui/Plot2DWebGL.js"
import {DC,stylize} from "../util.js"

export class NodeWithRightAccordionGraph extends Node{
    constructor(title,inputs,outputs,origin,destinationFlow,position={x:180,y:10}){
        super(title,inputs,outputs,origin,destinationFlow,position)
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
        this.graph=new Plot2DWebGL([],`${label} graph`,this.origin,this.graphDialog.DOMelt.content)
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


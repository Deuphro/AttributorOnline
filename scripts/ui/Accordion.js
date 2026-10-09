import {CE,stylize} from "../util.js"
import {Dialog} from "./Dialog.js"

let draggedAccordion=null
let reorderMark=null
let reorderMarkEdge=null

export function markReorder(container,edge){
    if(reorderMark===container&&reorderMarkEdge===edge){
        return
    }
    clearReorderMark()
    reorderMark=container
    reorderMarkEdge=edge
    container.classList.add(edge==="above"?"reorder-above":"reorder-below")
    container.style.transition="box-shadow 60ms linear"
}
export function clearReorderMark(){
    if(!reorderMark){
        return
    }
    reorderMark.classList.remove("reorder-above","reorder-below")
    reorderMark.style.transition="300ms"
    reorderMark=null
    reorderMarkEdge=null
}
export function accordionRows(panel){
    return [...(panel?.querySelectorAll?.(":scope > .accordion.container")??[])]
}
export function lastAccordionOf(panel){
    const rows=accordionRows(panel)
    return rows.length?rows[rows.length-1].accordion??null:null
}

export class Accordion{
    constructor(title,origin,destination){
        this.title=title
        this.origin=origin
        this.destination=destination
        this.parameters={
            container:{
                folded:false,
                style:{
                    display:"grid",
                    width:"100%",
                    border:"0px solid black",
                    padding:"1px",
                    "grid-template-rows":"auto minmax(0, 1fr)",
                    transition:"300ms"
                }
            },
            handler:{
                text:title,
                style:{
                    display:"grid",
                    width:"100%",
                    border:"1px solid black",
                    "border-radius":"5px",
                    padding:"0px",
                    "grid-template-columns":"1em 1fr 1em",
                    "margin-bottom":"1px",
                    transition:"none"
                }
            },
            content:{
                style:{
                    width:"100%",
                    border:"1px solid black",
                    padding:"0px",
                    transition:"30ms",
                    overflow:"hidden",
                    transition:"300ms"
                }
            }
        };
this.DOMelt={
            folder:CE('div',{className:"accordion handler folder",pilot:this,handleClick:(e)=>e.target.pilot.toggle()},[]),
            handler:CE('div',{className:"accordion handler",pilot:this,handleDblClick:(e)=>e.target.pilot.toggle()},[
                CE('div',{className:"accordion handler menu grip",pilot:this,draggable:true,tabIndex:0,title:"Glisser pour déplacer ce panneau (flèches haut/bas au clavier) — Double-clic pour détacher",handleDblClick:(e)=>{e.stopPropagation();e.target.pilot.popOut()},handleKeyDown:(e)=>this.handleReorderKey(e)},[]),
                CE('div',{className:"accordion handler label",pilot:this,handleDblClick:(e)=>e.target.pilot.toggle()},[title]),
            ]),
            content:CE('div',{className:"accordion content"},[]),
        }
        this.DOMelt.handler.appendChild(this.DOMelt.folder)
        this.DOMelt.container=CE('div',{className:"accordion container"},[this.DOMelt.handler,this.DOMelt.content]);
        this.DOMelt.container.accordion=this
        stylize(this.DOMelt.container,this.parameters.container.style);
        stylize(this.DOMelt.handler,this.parameters.handler.style);
        stylize(this.DOMelt.content,this.parameters.content.style);
        this.destination.appendChild(this.DOMelt.container)
        this.setSizingMode("content")
        this.setUpReordering()
    }
    setUpReordering(){
        const grip=this.DOMelt.handler.querySelector(".accordion.handler.menu")
        grip.addEventListener("dragstart",(event)=>this.startReorderDrag(event))
        grip.addEventListener("dragend",()=>this.endReorderDrag())
        for(const element of [this.DOMelt.container,this.destination]){
            element.addEventListener("dragover",(event)=>this.handleReorderOver(event))
            element.addEventListener("drop",(event)=>this.handleReorderDrop(event))
        }
    }
    reorderEdge(event){
        const box=this.DOMelt.container.getBoundingClientRect()
        return event.clientY<(box.top+box.height/2)?"above":"below"
    }
    handleReorderOver(event){
        if(!draggedAccordion||draggedAccordion.destination!==this.destination){
            return
        }
        if(event.target!==this.destination&&event.target.closest?.(".accordion.container")!==this.DOMelt.container){
            return
        }
        event.preventDefault()
        event.dataTransfer.dropEffect="move"
        if(event.target===this.destination){
            clearReorderMark()
        }else{
            markReorder(this.DOMelt.container,this.reorderEdge(event))
        }
    }
    handleReorderDrop(event){
        if(!draggedAccordion||draggedAccordion.destination!==this.destination){
            return
        }
        if(event.target!==this.destination&&event.target.closest?.(".accordion.container")!==this.DOMelt.container){
            return
        }
        event.preventDefault()
        clearReorderMark()
        const moved=draggedAccordion
        if(event.target===this.destination){
            moved.moveToEnd()
        }else{
            moved.placeBefore(this,this.reorderEdge(event))
        }
    }
    handleReorderKey(event){
        const delta=event.key==="ArrowUp"?-1:event.key==="ArrowDown"?1:0
        if(!delta){
            return
        }
        event.preventDefault()
        this.moveBy(delta)
        this.DOMelt.handler.querySelector(".accordion.handler.menu").focus()
    }
    moveBy(delta){
        const rows=accordionRows(this.destination)
        const there=rows.indexOf(this.DOMelt.container)+delta
        if(there<0||there>=rows.length){
            return false
        }
        return this.placeBefore(rows[there].accordion,delta<0?"above":"below")
    }
    moveToEnd(){
        const last=lastAccordionOf(this.destination)
        if(!last||last===this){
            return false
        }
        return this.placeBefore(last,"below")
    }
    placeBefore(accordion,edge){
        if(!accordion||accordion===this){
            return false
        }
        const reference=edge==="below"?accordion.DOMelt.container.nextSibling:accordion.DOMelt.container
        if(reference===this.DOMelt.container||this.DOMelt.container.nextSibling===reference){
            return false
        }
        this.destination.insertBefore(this.DOMelt.container,reference)
        this.announce()
        return true
    }
    panelOrder(){
        const index=accordionRows(this.destination).indexOf(this.DOMelt.container)
        return index<0?null:index
    }
    restoredPanelOrder(order){
        this.pendingPanelOrder=Number.isInteger(order)?order:null
    }
    startReorderDrag(event){
        draggedAccordion=this
        event.dataTransfer.effectAllowed="move"
        event.dataTransfer.setData("text/plain",this.title)
        this.DOMelt.container.classList.add("reordering")
    }
    endReorderDrag(){
        draggedAccordion=null
        clearReorderMark()
        this.DOMelt.container.classList.remove("reordering")
    }
    setSizingMode(mode,{height=null}={}){
        if(!["content","viewport"].includes(mode)){
            throw new Error(`Unknown accordion sizing mode: ${mode}`)
        }
        this.parameters.sizing=mode
        this.parameters.viewportHeight=height
        this.DOMelt.container.classList.toggle("sizing-content",mode==="content")
        this.DOMelt.container.classList.toggle("sizing-viewport",mode==="viewport")
        this.DOMelt.content.classList.toggle("sizing-content",mode==="content")
        this.DOMelt.content.classList.toggle("sizing-viewport",mode==="viewport")
        this.DOMelt.container.style.height=mode==="viewport"&&Number.isFinite(height)?`${height}px`:""
        this.DOMelt.content.style.display=mode==="viewport"?"grid":"block"
        this.DOMelt.content.style.height=mode==="viewport"?"100%":"auto"
        this.DOMelt.content.style.overflow=mode==="viewport"?"hidden":"visible"
        if(this.parameters.folded){
            this.DOMelt.container.style.height=""
            this.DOMelt.content.style.display="none"
        }
    }
    fold(){
        this.parameters.folded=true
        this.DOMelt.container.style.height=""
        this.DOMelt.container.style["grid-template-rows"]="auto 0fr"
        this.DOMelt.content.style.display="none"
        this.DOMelt.content.style.border="0px solid black"
        this.DOMelt.handler.style["margin-bottom"]="0px"
        this.DOMelt.folder.style["background-color"]="transparent"
        this.announce()
    }
    unfold(){
        this.parameters.folded=false
        this.DOMelt.container.style["grid-template-rows"]="auto 1fr"
        this.DOMelt.container.style.height=this.parameters.sizing==="viewport"&&Number.isFinite(this.parameters.viewportHeight)?`${this.parameters.viewportHeight}px`:""
        this.DOMelt.content.style.height=this.parameters.sizing==="viewport"?"100%":"auto"
        this.DOMelt.content.style.overflow=this.parameters.sizing==="viewport"?"hidden":"visible"
        this.DOMelt.content.style.display=this.parameters.sizing==="viewport"?"grid":"block"
        this.DOMelt.content.style.border="1px solid black"
        this.DOMelt.handler.style["margin-bottom"]="1px"
        this.DOMelt.folder.style["background-color"]="rgba(172,255,47,0.18)"
        this.announce()
    }
    announce(){
        this.origin?.saveSessionSoon?.()
    }
    toggle(){
        if(this.parameters.folded){
            this.unfold();
        }else{
            this.fold();
        }
    }
    popOut(){
        if(this.dialog){
            this.dialog.focus()
            return
        }
        const panel=this.DOMelt.container.parentElement
        const wasFolded=this.parameters.folded
        if(wasFolded){
            this.unfold()
        }
        this.dialog=new Dialog(this.title,this.origin,this.origin.main)
        this.dialog.DOMelt.window.style.top="100px"
        this.dialog.DOMelt.window.style.left="100px"
        this.dialog.DOMelt.window.style.width="600px"
        this.dialog.DOMelt.window.style.height="400px"
        const dismisser=this.dialog.DOMelt.dismisser
        dismisser.handleClick=(e)=>{
            e.target.pilot.suicide()
            this.dockBack(panel)
        }
        this.dialog.DOMelt.label.handleDblClick=(e)=>{
            e.preventDefault()
            e.stopPropagation()
            this.dockBack(panel)
        }
        this.dialog.DOMelt.label.title="Double-clic pour rattacher au panneau"
        this.dialog.DOMelt.content.appendChild(this.DOMelt.content)
        this.DOMelt.container.remove()
        this.destination=this.dialog.DOMelt.content
        this.parameters.container.style.display="grid"
        this.parameters.container.style.width="100%"
        this.parameters.container.style.height="100%"
        this.parameters.handler.style.display="none"
        this.setSizingMode("viewport",{height:parseInt(this.dialog.DOMelt.content.style.height)||400})
        this.origin.saveSessionSoon?.()
    }
    dockBack(panel){
        if(!this.dialog){
            return
        }
        this.dialog.DOMelt.content.removeChild(this.DOMelt.content)
        this.dialog.suicide()
        this.dialog=null
        this.parameters.handler.style.display="grid"
        this.DOMelt.container=CE('div',{className:"accordion container"},[this.DOMelt.handler,this.DOMelt.content]);
        this.DOMelt.container.accordion=this
        stylize(this.DOMelt.container,this.parameters.container.style);
        panel.appendChild(this.DOMelt.container)
        this.destination=panel
        this.setSizingMode("content")
        this.origin.saveSessionSoon?.()
    }
    suicide(){
        if(reorderMark===this.DOMelt.container){
            clearReorderMark()
        }
        if(draggedAccordion===this){
            draggedAccordion=null
        }
        this.DOMelt.container.remove()
        if(this.events?.broadcast?.killed){
            dispatchEvent(this.events.broadcast.killed)
        }
    }
}
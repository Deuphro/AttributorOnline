import {$,CE,stylize,fakeData,DC,serializeHTML} from "./util.js"
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm"
import {defaultMenu} from "../resources/config.js"
import { Data , Vector, Wave} from "./formats.js"

window.raie=new Wave(5)
window.eiar=new Wave(7)

class Node{
    constructor(title,inputs, outputs,origin,destinationFlow,position={x:10,y:10}){
        this.title=title
        this.inputs=inputs
        this.outputs=outputs
        this.origin=origin
        this.destination=destinationFlow
        this.destination.nodeSet.add(this)
        this.upToDate=true
        this.drawn=false
        this.events={broadcast:{
            nodeMove:new CustomEvent("nodeMove",{detail:{msg:"",emitter:this}}),
            startLinkDrawing(anchor){return new CustomEvent("startLinkDrawing",{detail:{msg:{starter:anchor},emitter:this}})},
            stopLinkDrawing(anchor){return new CustomEvent("stopLinkDrawing",{detail:{msg:{stopper:anchor},emitter:this}})},
            nodeSelected:new CustomEvent("nodeSelected",{detail:{msg:"I'm a node selected",emitter:this}})
        },listen:{
            nodeSelected(e){
                if (e.detail.emitter.events.registrationName==this.events.registrationName) {
                    if(document.activeElement===this.SVGg.select('rect').node()){
                        this.SVGg.select('rect').node().blur()
                    }else{
                        this.SVGg.select('rect').node().focus()
                    }
                } else {
                    this.SVGg.select('rect').attr('class','node')
                }
            }
        }}
        this.parameters={
            heightPerItem:12,
            margin:2.5,
            width:150,
            position:position,
            rounding:5,
            outputs:{
                positions:new Array(this.outputs.length)
            },
            inputs:{
                positions:new Array(this.inputs.length)
            },
            anchorMap:new WeakMap()
        }
        this.SVGg=d3.create("svg:g").attr('class','nodeContainer')
        this.SVGg.append("rect")
            .attr('x',0)
            .attr('y',0)
            .attr("width", this.parameters.width)
            .attr('height',this.nodeHeight)
            .attr("rx", this.parameters.rounding)
            .attr("ry", this.parameters.rounding)
            .attr("tabindex",0)
            .attr("class","node")
        for(let k in inputs){
            this.parameters.inputs.positions[k]={x:0,y:this.parameters.rounding+this.parameters.margin+(Number(k)+0.5)*this.parameters.heightPerItem}
            this.SVGg.append('svg:circle')
                .attr('cx',this.parameters.inputs.positions[k].x)
                .attr('cy',this.parameters.inputs.positions[k].y)
                .attr("r", 5)
                .attr('class','input anchor')
                .attr('id',k)
                .style("z-index", 1)
        }
        for(let k in outputs){
            this.parameters.outputs.positions[k]={x:this.parameters.width,y:this.parameters.rounding+this.parameters.margin+(Number(k)+0.5)*this.parameters.heightPerItem}
            this.SVGg.append('circle')
                .attr('cx',this.parameters.width)
                .attr('cy',this.parameters.outputs.positions[k].y)
                .attr("r", 5)
                .attr('class','output anchor')
                .attr('id',k)
                .style("z-index", 1)
        }
        this.SVGg.append("text")
            .attr("x",10)
            .attr("y",this.nodeHeight/2+2.5)
            .text(title)
            .attr('id','nodeTitle')
        this.SVGg.attr('transform', 'translate('+`${this.parameters.position.x},${this.parameters.position.y}`+')')
        this.DOMelt=this.SVGg.node()
        this.DOMelt.querySelector('rect').pilot=this
        this.DOMelt.querySelector('rect').handleClick=(e)=>globalThis.dispatchEvent(e.target.pilot.events.broadcast.nodeSelected)
        this.DOMelt.querySelector('rect').handleMouseDown=(e)=>e.target.pilot.drag(e)
        this.DOMelt.querySelector('rect').handleKeyDown=(e)=>{
            if(e.key==="Delete"){
                e.target.pilot.suicide()
            }
        }
        for(let anchor of this.DOMelt.querySelectorAll('.anchor')){
            const k=anchor.id
            const anchortype=anchor.classList.contains("output")? "output" : "input"
            this.parameters.anchorMap.set(anchor,{
                type:anchortype,
                positions:this.parameters[anchortype+"s"].positions[k]
            })
            anchor.pilot=this
            anchor.handleMouseDown=(e)=>{
                dispatchEvent(e.target.pilot.events.broadcast.startLinkDrawing.call(e.target.pilot,e.target))
            }
            anchor.handleMouseUp=(e)=>{
                dispatchEvent(e.target.pilot.events.broadcast.stopLinkDrawing.call(e.target.pilot,e.target))
            }
        }
        this.draw()
    }
    draw(){
        if(!this.drawn){
            this.drawn=true
            this.destination.container.querySelector('.field').append(this.DOMelt)
        }
    }
    get nodeHeight(){
        return 2*(this.parameters.rounding+this.parameters.margin)+Math.max(1,Math.max(this.outputs.length,this.inputs.length))*this.parameters.heightPerItem
    }
    drag(e){
        e.preventDefault();
        let dx=e.clientX;
        let dy=e.clientY;
        const pilot=e.target.pilot
        document.onmousemove=(e)=>{
            e.preventDefault();
            dx-=e.clientX;
            dy-=e.clientY;
            pilot.parameters.position.x-=dx
            pilot.parameters.position.y-=dy
            window.dispatchEvent(pilot.events.broadcast.nodeMove)
            pilot.SVGg.attr('transform', 'translate('+`${pilot.parameters.position.x},${pilot.parameters.position.y}`+')')
            dx=e.clientX;
            dy=e.clientY;
        }
        document.onmouseup=(e)=>{
            e.preventDefault();
            document.onmousemove=null;
            document.onmouseup=null;
        }
    }
    suicide(){
        this.SVGg.node().remove()
        this.destination.nodeSet.delete(this)
        dispatchEvent(this.events.broadcast.killed)
    }
}

class Flow{
    constructor(title,origin,destination){
        this.title=title
        this.origin=origin
        this.destination=destination
        this.container=CE('div',{className:`flow container ${title}`},[])
        this.events={broadcast:{},listen:{
            nodeMove(e){
            },
            startLinkDrawing(e){this.startBuildingLink(e)},
            stopLinkDrawing(e){this.stopBuildingLink(e)}
        }}
        this.nodeSet=new Set()
        this.parameters={
            field:{
                drawn:false,
                node:[],
                links:{}
            }
        }
        stylize(this.container,{
            position:"relative",
            width:"100%",
            height:"100%",
        })
        this.destination.appendChild(this.container)
        this.draw()
    }
    draw(){
        if(!this.parameters.field.drawn){
            this.parameters.field.drawn=true
            let container=d3.select(this.container)
            this.field=container.append("svg")
                .attr("width","100%")
                .attr("height","100%")
                .attr("class","flow field")
        }
    }
    startBuildingLink(e){
        const anchorPos=e.detail.emitter.parameters.anchorMap.get(e.detail.msg.starter).positions
        const nodePos=e.detail.emitter.parameters.position
        const startingPos={
            x:anchorPos.x+nodePos.x,
            y:anchorPos.y+nodePos.y
        }
        this.buildingLink=d3.create("svg:g").attr('class','link').append('path').style('pointer-events','none')
            .attr("d", `M ${startingPos.x} ${startingPos.y} L ${startingPos.x} ${startingPos.y}`)
            .attr("class", "link")
        this.buildingLink.startingAnchor=e.detail.msg.starter
        this.buildingLink.startingNode=e.detail.emitter
        this.field.node().appendChild(this.buildingLink.node())
        e.preventDefault()
        document.onmousemove=(e)=>{
            e.preventDefault()
            //console.log(e)
            //console.log("M 0 0 L "+e.clientX+" "+e.clientY)
            this.buildingLink.attr("d", `M ${startingPos.x} ${startingPos.y}
                C ${startingPos.x+50} ${startingPos.y},
                ${e.layerX-50} ${e.layerY},
                ${e.layerX} ${e.layerY}`)
        }
        document.onmouseup=(e)=>{
            e.preventDefault();
            if(!this.buildingLink.endingAnchor){
                this.buildingLink.node().remove()
            }
            document.onmousemove=null;
            document.onmouseup=null;
        }
    }
    stopBuildingLink(e){
        this.buildingLink.endingAnchor=e.detail.msg.stopper
        this.buildingLink.endingNode=e.detail.emitter
    }
}

class MainMenu{
    constructor(configObject,title,origin,destination){
        this.title=title
        this.origin=origin
        this.destination=destination
        this.container=CE('nav',{className:`menu container ${title}`},[])
        this.events={
            broadcast:{
                poppedUp:new CustomEvent("poppedUp",{detail:{msg:"I've just popped up",emitter:this}}),
                killed:new CustomEvent("killed",{detail:{msg:"I've just been killed !!!",emitter:this}}),
            },
            listen:{
            importDelimitedText(e){origin.loadDelimitedText()},
            undo(e){origin.restoreLastState()}
        }}
        this.dfs4objects(configObject,this.container,0)
        this.draw()
    }
    dfs4objects(object,html,c){
        if(!Object.keys(object).length){
            return
        }
        const category=(c==0 ? "menu" :"child")
        html.appendChild(CE('div',{className:category},[]))//ul
        let achteyheymel
        c++
        for (let k of Object.keys(object)){
            if(k=='hr'){
                achteyheymel=CE('hr',{},[])
            } else {
                achteyheymel=
                CE('div',{className:"parent",handleClick:typeof object[k] =="function"? object[k]: null},[
                    k+(Object.keys(object[k]).length==0 || c<2?"":"..."),
                ])
            }
            html.lastChild.append(achteyheymel)
            this.dfs4objects(object[k],achteyheymel,c)
        }
    }
    draw(){
        if (!$(`.${this.title}.menu.container`)){
            this.destination.appendChild(this.container);
        }else{
            this.container.remove()
            this.destination.appendChild(this.container);
        }
    }
}

class Channel{
    constructor(origin){
        this.origin=origin
        this.eventTypes={}
    }
    register(name,caster){
        this[name]=caster
        if (!caster.events){
            caster.events={}
        }
        if (!caster.events.broadcast){
            caster.events.broadcast={}
        }
        caster.events.broadcast['poppedUp']=new CustomEvent("poppedUp",{detail:{msg:"default registration message",emitter:caster}})
        caster.events.broadcast['killed']=new CustomEvent("killed",{detail:{msg:"default killed message",emitter:caster}})
        caster.events.registrationName=name
        const broadcasts=caster.events.broadcast
        Object.values(broadcasts).forEach((e)=>{
            if (!this.eventTypes[e.type]){
                globalThis.addEventListener(e.type,this.defaultListener.bind(this))
                this.eventTypes[e.type]=new Set()
            }
        })
        if(!caster.events.listen){
        } else {
            const listeners=caster.events.listen
            Object.keys(listeners).forEach((e)=>{
                if (!this.eventTypes[e]){
                    globalThis.addEventListener(e,this.defaultListener.bind(this))
                    this.eventTypes[e]=new Set()
                }
                this.eventTypes[e].add(name)
        })
        }
        dispatchEvent(broadcasts.poppedUp)
    }
    setupOnAir(){
        for(let etype of Object.keys(this.eventTypes)){
            globalThis.addEventListener(etype,this.defaultListener.bind(this))
        }
    }
    shutDown(){
        for(let etype of Object.keys(this.eventTypes)){
            globalThis.removeEventListener(etype,this.defaultListener.bind(this))
        }
        this.eventTypes={}
    }
    degister(name){
        delete this[name]
        Object.values(this.eventTypes).forEach((e)=>{e.delete(name)})
    }
    defaultListener(e){
        if(e.detail.stackUndo){
            this.origin.saveAppState()
        }
        const et=e.type
        if(this.eventTypes[e.type]){
            this.eventTypes[e.type].forEach((targetName,i,a)=>{
                this[targetName].events.listen[et].call(this[targetName],e)
                })
        }
        if(et=="killed"){
            this.degister(e.detail.emitter.events.registrationName)
        }
    }
}

class Plot2D{
    constructor(data,title,origin,destination){
        this.title=title
        this.data=data
        this.origin=origin
        this.destination=destination
        this.container=CE('div',{className:"2dplot container",pilot:this},[]);
        this.parameters={
            graphzone:{
                drawn:false,
                opacity:"0.5"
            },
            margins:{
                top:10,
                bottom:30,
                left:30,
                right:15
            },
            axis:{
                bottom:{
                    drawn:false,
                    domain:[0,1],
                    range:[0,1],
                    position:{left:0,top:1},
                    label:"Abscissa",
                    orientation:"horizontal",
                    scale:"linear",
                    type:"bottom"
                },
                left:{
                    drawn:false,
                    domain:[0,1],
                    range:[1,0],
                    position:{left:0,top:0},
                    label:"Ordinate",
                    orientation:"vertical",
                    scale:"linear",
                    type:"left"
                }
            },
        }
        stylize(this.container,{
            position:"relative",
            width:"100%",
            height:"100%",
        })
        this.destination.appendChild(this.container)
        this.drawGraph()
        this.container.handleResize=(e)=>e.target.pilot.drawGraph()
    }
    get graphzone(){
        return {
            width:this.container.clientWidth-this.parameters.margins.left-this.parameters.margins.right,
            height:this.container.clientHeight-this.parameters.margins.top-this.parameters.margins.bottom
        }
    }
    drawGraph(){
        let range=[]
        let scale={}
        let translate=""
        this.axesSVG={}
        let target=""
        if(this.parameters.graphzone.drawn){
        } else {
            this.parameters.graphzone.drawn=true
            this.graphSVG=d3.select(this.container)
                .append("svg")
                    .attr("width",this.container.clientWidth)
                    .attr("height",this.container.clientHeight)
                    .attr("class","main")
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
            if(this.parameters.axis[axis].drawn){
                //MAJ
            }else{
                //INIT
                this.graphSVG.select(".anchor").append("g").attr("class",axis)
            }
            target=`.${axis}`
            translate=`translate(${this.parameters.axis[axis].position.left*this.graphzone.width},${this.parameters.axis[axis].position.top*this.graphzone.height})`
            if(this.parameters.axis[axis].orientation=="horizontal"){
                range=[this.parameters.axis[axis].range[0]*this.graphzone.width,this.parameters.axis[axis].range[1]*this.graphzone.width]
            } else if (this.parameters.axis[axis].orientation=="vertical"){
                range=[this.parameters.axis[axis].range[0]*this.graphzone.height,this.parameters.axis[axis].range[1]*this.graphzone.height]
            }
            if (this.parameters.axis[axis].scale=="linear"){
                scale=d3.scaleLinear()
                    .domain(this.parameters.axis[axis].domain)
                    .range(range)
            }
            this.axesSVG[axis]=this.graphSVG.select(".anchor").select(target)
            this.axesSVG[axis].attr("transform",translate)
            this.axesSVG[axis].attr("fill","blanchedalmond")
            switch (this.parameters.axis[axis].type){
                case "left":
                    this.axesSVG[axis].call(d3.axisLeft(scale))
                    break
                case "right":
                    this.axesSVG[axis].call(d3.axisRight(scale))
                    break
                case "top":
                    this.axesSVG[axis].call(d3.axisTop(scale))
                    break
                case "bottom":
                    this.axesSVG[axis].call(d3.axisBottom(scale))
                    break
                default:
            }
            this.axesSVG[axis].selectAll(".tick text").attr("font-size", "12px").attr("font-family","Times New Roman")
            this.parameters.axis[axis].drawn=true
        }
    }
}

class Table{
    constructor(data,title=null,origin,destination){
        this.drawn=false
        this.origin=origin;
        this.destination=destination;
        this.parameters={
            mutable:{
                hRuler:false,
            },
            virtualIndex:{top:0,left:0},
            styles:{
                tables:{
                    "border-spacing":'1px',
                    width:"max-content",
                    "border-collapse":"separate",
                    "overflow":"hidden",
                    "text-overflow":"ellipsis",
                    outline:"3px solid red"
                },
                cells:{
                    "text-align": "center",
                    width:"50px",
                    height:"20px",
                    "overflow":"hidden",
                    "text-overflow":"ellipsis",
                    outline:"3px solid red"
                },
                lines:{},
                hRuler:{
                    table:{
                        "table-layout":"fixed",
                        "border-spacing":'2px 0px',
                        width:"min-content",
                        "border-collapse":"separate",
                        "overflow":"hidden",
                        "text-overflow":"ellipsis",
                        "border-bottom":"1px solid darkgrey",
                        "background-color":"darkgrey",
                        opacity:"0.5",
                        cursor:"auto"
                    },
                    cells:{
                        "font-size":"12px",
                        "font-weight":"normal",
                        "background-color": "blanchedalmond",
                        "overflow":"hidden",
                        "text-overflow":"ellipsis",
                        "width":"50px",
                        "height":"20px",
                        cursor:"auto",
                        "border-bottom":"1px solid darkgrey"
                    },
                    lines:{
                        "border-bottom":"1px solid black"
                    }
                },
                vRuler:{
                    table:{
                        "table-layout":"fixed",
                        "border-spacing":'1px',
                        width:"max-content",
                        "border-collapse":"separate",
                        "overflow":"hidden",
                        "text-overflow":"ellipsis",
                        "border":"none",
                        cursor:"default",
                        opacity:"0.5"
                    },
                    cells:{
                        "font-size":"12px",
                        "font-weight":"normal",
                        "width":"30px",
                        "height":"20px",
                        "background-color": "blanchedalmond",
                        "overflow":"hidden",
                        "text-overflow":"ellipsis"
                    },
                    lines:{
                    }
                },
                bTable:{
                    table:{
                        "table-layout":"fixed",
                        "border-spacing":'2px 1px',
                        width:"min-content",
                        "border-collapse":"separate",
                        "overflow":"hidden",
                        "text-overflow":"ellipsis",
                        cursor:"cell",
                        "margin-left":"0px"
                    },
                    cells:{
                        "background-color":"rgba(245, 245, 220, 0.5)",
                        "width":"50px",
                        "height":"20px",
                        "opacity": "0.5",
                        "text-align": "center",
                        "overflow":"hidden",
                        "text-overflow":"ellipsis"
                    },
                    lines:{
                    }
                }
            }
        }
        this.setData=data
        this.title=title
        this.container=CE('div',{className:"table container",pilot:this},[]);
        stylize(this.container,{
            position:"relative",
            width:"100%",
            height:"100%",
            overflow:"auto",
            "overflow-anchor":"none",
            "scroll-behavior":"auto",
            "white-space":"nowrap",
        })
        this.destination.appendChild(this.container)
        this.drawVirtual()
        this.container.handleScroll=(e)=>e.target.pilot.onScroll(e);
        this.container.handleResize=(e)=>e.target.pilot.onResize()
    }
    set setData(arg){
        this.data=arg
        this.parameters.dataDimension={rows:Table.rowNum(arg),cols:Table.colNum(arg)}
    }
    onScroll(e){
        this.parameters.virtualIndex.top=Math.floor(
            this.container.scrollTop/
                (parseInt(this.parameters.styles.vRuler.table["border-spacing"]) 
                    + parseInt(this.parameters.styles.vRuler.cells.height)))
        this.parameters.virtualIndex.left=Math.floor(
            (this.container.scrollLeft)/
                (parseInt(this.parameters.styles.hRuler.cells.width) 
                    + 0.5*parseInt(this.parameters.styles.hRuler.table["border-spacing"])))
        const hRulerHeight=this.hRuler.clientHeight
        for(let k=0;k<this.virtualNbCols;k++){this.hRuler.children[0].children[k].textContent=(this.title[this.parameters.virtualIndex.left+k]===undefined ? "" : this.title[this.parameters.virtualIndex.left+k])}
        if(this.hRuler.clientHeight!=hRulerHeight){console.log("SHIFT !!!");this.onHrulerHeightChange()}
        for(let k=0;k<this.virtualNbCols;k++){this.hRuler.children[1].children[k].textContent=`${this.parameters.virtualIndex.left+k}`}
        for(let j=0;j<this.virtualNbRows;j++){this.vRuler.children[j].children[0].textContent=`${this.parameters.virtualIndex.top+j}`}
        for(let j=0;j<this.virtualNbRows;j++){for(let k=0;k<this.virtualNbCols;k++){this.bTable.children[j].children[k].textContent=`${this.data[this.parameters.virtualIndex.top+j][this.parameters.virtualIndex.left+k]}`}}
        if(this.container.scrollLeft){
            this.vRuler.style.opacity=1
        }else{
            this.vRuler.style.opacity=0.5
        }
        if(this.container.scrollTop){
            this.hRuler.style.opacity=1
        }else{
            this.hRuler.style.opacity=0.5
        }
    }
    onHrulerHeightChange(){
        const h=this.hRuler.clientHeight
        this.vScroller.style.top=`${h}px`
        this.bTable.style.top=`${h}px`
        this.vRuler.style.top=`${h}px`
        this.vRuler=this.virtualvRuler()
        this.container.replaceChild(this.vRuler,this.container.children[3])
        this.bTable=this.virtualTable()
        this.container.replaceChild(this.bTable,this.container.children[4])
    }
    onResize(){
        this.hRuler=this.virtualhRuler()
        this.container.replaceChild(this.hRuler,this.container.children[1])
        this.vRuler=this.virtualvRuler()
        this.container.replaceChild(this.vRuler,this.container.children[3])
        this.bTable=this.virtualTable()
        this.container.replaceChild(this.bTable,this.container.children[4])
    }
    drawVirtual(){
        if(!this.drawn){
            this.drawn=true
            this.hScroller=this.horizontalScrollWrapper()
            this.container.appendChild(this.hScroller)
            this.hRuler=this.virtualhRuler()
            this.container.appendChild(this.hRuler)
            this.vScroller=this.verticalScrollWrapper()
            this.container.appendChild(this.vScroller)
            this.vRuler=this.virtualvRuler()
            this.container.appendChild(this.vRuler)
            this.bTable=this.virtualTable()
            this.container.appendChild(this.bTable)
        }else{
            this.drawn=false
            while(this.container.children.length){
                console.log(this.container.lastChild)
                this.container.removeChild(this.container.lastChild)
            }
        }
    }
    horizontalScrollWrapper(){
        const width=parseInt(
            this.parameters.styles.vRuler.cells.width)//la largeur de la colonne d'indice verticaux
            + this.parameters.dataDimension.cols*parseInt(this.parameters.styles.cells.width)//le gros des cellules
            + (this.parameters.dataDimension.cols+2)*parseInt(this.parameters.styles.tables["border-spacing"]//leur empatement
            )
        let res=CE('div',{className:"scrollwrapper horizontal"},[""])
        stylize(res,{
            background:"none",
            position:"absolute",
            width:`${width}px`,
            height:"10px",
            top:"0px",
            left:"0px",
            "z-index":"0",
        })
        return res
    }
    verticalScrollWrapper(){
        const height=this.parameters.dataDimension.rows*parseInt(this.parameters.styles.cells.height) 
        + (this.parameters.dataDimension.rows+1)*parseInt(this.parameters.styles.tables["border-spacing"])
        let res=CE('div',{className:"scrollwrapper vertical"},[""])
        stylize(res,{
            background:"none",
            position:"absolute",
            width:"10px",
            height:`${height}px`,
            top:`${this.hRuler.clientHeight}px`,
            left:"0px",
            "z-index":"1"
        })
        return res
    }
    virtualTable(){
        const Dy=this.container.clientHeight-this.hRuler.clientHeight
        const Dx=this.container.clientWidth-this.vRuler.clientWidth
        const nbRows=this.virtualNbRows
        const nbCols=this.virtualNbCols
        let res=CE('table',{className:"table normal",style:this.parameters.styles.bTable.table},[]);
        let aRow=[]
        this.parameters.virtualIndex.top=Math.min(this.parameters.virtualIndex.top,this.parameters.dataDimension.rows-nbRows)
        this.parameters.virtualIndex.left=Math.min(this.parameters.virtualIndex.left,this.parameters.dataDimension.cols-nbCols)
        for(let k=0;k<nbRows;k++){
            aRow=[]
            for(let j=0;j<nbCols;j++){
                aRow.push(CE('td',{className:"normal cell",style:this.parameters.styles.bTable.cells},
                    [(this.data[this.parameters.virtualIndex.top+k][this.parameters.virtualIndex.left+j]).toString()]))
            }
            res.appendChild(CE('tr',{className:"normal line",style:this.parameters.styles.bTable.lines},[...aRow]));
        }
        stylize(res,{
            position:"sticky",
            display:"inline-table",
            left:`${this.vRuler.clientWidth}px`,
            top:`${this.hRuler.clientHeight}px`,
            overflow:"hidden",
            "z-index":"2",
        })
        return res
    }
    virtualvRuler(){
        const Dy=this.container.clientHeight-this.hRuler.clientHeight
        this.virtualNbRows=Math.min(Math.ceil(Dy/(parseInt(this.parameters.styles.vRuler.table["border-spacing"]) + parseInt(this.parameters.styles.vRuler.cells.height))),this.parameters.dataDimension.rows)
        let res=[];
        this.parameters.virtualIndex.top=Math.min(this.parameters.virtualIndex.top,this.parameters.dataDimension.rows-this.virtualNbRows)
        for(let k=0;k<this.virtualNbRows;k++){res.push(CE('tr',{className:"vertical ruler line",style:this.parameters.styles.vRuler.lines},[CE('th',{className:"vertical ruler cell",style:this.parameters.styles.vRuler.cells},[(this.parameters.virtualIndex.top+k).toString()])]))}
        res=CE('table',{className:"table ruler vertical",style:this.parameters.styles.vRuler.table},res)
        stylize(res,{
            "z-index":"3",
            float:"left",
            position:"sticky",
            left:"0px",
            top:`${this.hRuler.clientHeight}px`,
            "display":"inline-block",
        })
        return res
    }
    columnResizer(e){
        e.preventDefault();
        let dx=e.clientX;
        const pilot=e.target.pilot
        document.onmousemove=(e)=>{
            e.preventDefault();
            dx-=e.clientX
            pilot.parameters.styles.cells.width=`${Math.max(5,parseInt(pilot.parameters.styles.cells.width))-dx}px`
            pilot.parameters.styles.hRuler.cells.width=`${Math.max(5,parseInt(pilot.parameters.styles.cells.width))-dx}px`
            pilot.parameters.styles.bTable.cells.width=`${Math.max(5,parseInt(pilot.parameters.styles.cells.width))-dx}px`
            pilot.hScroller=pilot.horizontalScrollWrapper()
            pilot.container.replaceChild(pilot.hScroller,pilot.container.children[0])
            pilot.onResize()
            dx=e.clientX
        }
        document.onmouseup=(e)=>{
            e.preventDefault();
            document.onmouseup=null;
            document.onmousemove=null;
        }
    }
    virtualhRuler(){
        const Dx=this.container.clientWidth-parseInt(this.parameters.styles.vRuler.cells.width)-2*parseInt(this.parameters.styles.tables["border-spacing"])
        this.virtualNbCols=Math.min(Math.ceil(Dx/(parseInt(this.parameters.styles.hRuler.cells.width)+parseInt(this.parameters.styles.hRuler.table["border-spacing"]))),this.parameters.dataDimension.cols)
        this.parameters.virtualIndex.left=Math.min(this.parameters.virtualIndex.left,this.parameters.dataDimension.cols-this.virtualNbCols)
        let titleLine=[]//[CE('th',{className:"horizontal title cell",style:this.parameters.styles.vRuler.cells},[""])];
        let rulerLine=[]//[CE('th',{className:"horizontal ruler cell",style:this.parameters.styles.vRuler.cells},[""])];
        const leftGap=parseInt(this.parameters.styles.vRuler.cells.width)+2*parseInt(this.parameters.styles.vRuler.table['border-spacing'])
        for(let k=0;k<this.virtualNbCols;k++){
            rulerLine.push(CE('th',{className:"horizontal ruler cell",pilot:this,handleMouseDown:(e)=>{e.target.pilot.columnResizer(e)},style:this.parameters.styles.hRuler.cells},[(this.parameters.virtualIndex.left+k).toString()]));
            titleLine.push(CE('th',{className:"horizontal title cell",style:this.parameters.styles.hRuler.cells},[this.title[this.parameters.virtualIndex.left+k]===undefined ? "" : this.title[this.parameters.virtualIndex.left+k]]));
            rulerLine[k].style["cursor"]="col-resize"
            if(this.parameters.mutable.hRuler){
                titleLine[k].style["cursor"]="auto"
                titleLine[k].style["background-color"]="cornsilk"
                titleLine[k].setAttribute("contenteditable","true")
                titleLine[k].pilot=this
                titleLine[k].handleBlur=(e)=>{
                    e.target.pilot.title[e.target.cellIndex]=e.target.textContent
                }
                titleLine[k].handleKeyDown=(e)=>{
                    if(e.key=="Enter"){
                        e.target.blur()
                    }
                }
            }
        }
        let res=CE('table',{className:"table ruler horizontal",style:this.parameters.styles.hRuler.table},[
            CE('tr',{className:"horizontal title line",style:this.parameters.styles.hRuler.lines},titleLine),
            CE('tr',{className:"horizontal ruler line",style:this.parameters.styles.hRuler.lines},rulerLine)
        ])
        stylize(res,{
            position:"sticky",
            top:"0px",
            left:`${leftGap}px`,
            "z-index":"4",
        })
        res.children[1].style["cursor"]="col-resize"
        return res
    }
    static bareTable(data){
        self=this
        let res=CE('table',{className:"table normal"},[]);
        let line=[];
        for(let k of data){
            line=[];
            k.forEach((v)=>{line.push(CE('td',{className:"normal cell"},[v.toString()]))})
            res.appendChild(CE('tr',{className:"normal line"},[...line]));
        }
        return res
    }
    horizontalRuler(n,title){
        let titleLine=[CE('th',{className:"horizontal title cell",style:{width:this.parameters.cellWidth}},[""])];
        let rulerLine=[CE('th',{className:"horizontal ruler cell",style:{width:this.parameters.cellWidth}},[""])];
        for(let k=0;k<n;k++){
            rulerLine.push(CE('th',{className:"horizontal ruler cell",style:{width:this.parameters.cellWidth}},[k.toString()]));
            titleLine.push(CE('th',{className:"horizontal title cell",style:{width:this.parameters.cellWidth}},[title[k]===undefined ? "" : title[k]]));
        }
        return CE('table',{className:"table ruler horizontal"},[CE('tr',{className:"horizontal title line"},titleLine),CE('tr',{className:"horizontal ruler line"},rulerLine)])
    }
    verticalRuler(n){
        let res=[];
        for(let k=0;k<n;k++){res.push(CE('tr',{className:"vertical ruler line"},[CE('th',{className:"vertical ruler cell",style:{width:this.parameters.cellWidth}},[k.toString()])]))}
        return CE('table',{className:"table ruler vertical"},res)
    }
    fillNormalColumns(vec){
        let res=[];
        if(!vec){return res}
        for(let k of vec){
            res.push(CE('td',{className:"normal cell"},[k.toString()]))
        }
        return res
    }
    static colNum(data){
        let res=0
        data.forEach((v)=>{res=Math.max(res,v.length)})
        return res
    }
    static rowNum(data){
        return data.length
    }
}

class Dialog{
    constructor(title,origin,destination){
        this.title=title
        this.events={
            broadcast:{
                selected:new CustomEvent("selected",{detail:{msg:"I've just been selected !!!",emitter:this}}),
            },
            listen:{
                selected(e){
                    console.log("oupinez "+e.detail.emitter.events.registrationName+" a été selectionné !!")
                    if (e.detail.emitter.events.registrationName==this.events.registrationName) {
                        console.log("hey mais c moi car je suis:",this.events.registrationName)
                        this.DOMelt.window.classList.add('selected')
                        this.DOMelt.window.style["z-index"]="10"
                    } else {
                        console.log("ha oui mais c'est pas moi car je suis:",this.events.registrationName)
                        this.DOMelt.window.classList.remove('selected')
                        this.DOMelt.window.style["z-index"]="2"//1 is for interface
                    }
                },
                killed(e){console.log("quelqu'un s'est fait tué !\n","il s'appelait ",e.detail.emitter.events.registrationName)},
                importDelimitedText(e){console.log(e)}
            }
        }
        this.origin=origin;
        this.destination=destination;
        this.DOMelt={};
        this.DOMelt.dismisser=CE('div',{className:"dismisser",pilot:this},[]);
        this.DOMelt.dismisser.handleClick=(e)=>e.target.pilot.suicide();
        this.DOMelt.label=CE('div',{className:"label",pilot:this},[title.toString()]);
        this.DOMelt.label.handleMouseDown=(e)=>e.target.pilot.drag(e);
        this.DOMelt.label.handleClick=(e)=>{dispatchEvent(e.target.pilot.events.broadcast.selected)}
        this.DOMelt.handler=CE('div',{},[this.DOMelt.label,this.DOMelt.dismisser]);
        this.DOMelt.content=CE('div',{className:"popup content"},[]);
        this.DOMelt.window=CE('div',{className:title+" popup container",pilot:this},[
            this.DOMelt.handler,
            this.DOMelt.content
        ]);
        stylize(this.DOMelt.window,{
            position:"absolute",
            "background-color":"rgba(255, 255, 255, 0.5)",
            "z-index":"1",
            top:"35%",
            left:"35%",
            width:"30%",
            height:"30%",
            "border-radius":"10px",
            display:"grid",
            "grid-template-rows":"auto 1fr",
            padding:"0.2em",
            border:"1px dashed greenyellow",
            overflow:"hidden",
            resize:"both",
            "min-height":"2.2em",
            "min-width":"2.2em"
        });
        stylize(this.DOMelt.handler,{
            display:"grid",
            "grid-template-columns":"1fr 1em",
            "border-radius":"10px",
            padding:"0em"
        })
        stylize(this.DOMelt.content,{
            position:"relative",
            width:"100%",
            height:"100%",
            "border-radius":"10px",
            padding:"0em",
            overflow:"hidden"
        })
        stylize(this.DOMelt.label,{
            cursor:"move",
            //padding:"0em",
            "white-space":"nowrap",
            overflow:"hidden"
        })
        stylize(this.DOMelt.dismisser,{
            height:"1em",
            width:"1em",
            "align-self":"center"
        })
        this.DOMelt.window.handleResize=(e)=>e.target.pilot.resize(e)
        if (!$(`.${title}.popup.container`)){
            destination.appendChild(this.DOMelt.window);
        }else{
            this.DOMelt.window.remove()
            destination.appendChild(this.DOMelt.window);
        }
    }
    suicide(){
        this.DOMelt.window.remove()
        dispatchEvent(this.events.broadcast.killed)
    }
    drag(e){
        const boundary={
            width:this.destination.offsetWidth,
            height:this.destination.offsetHeight
        }
        e.preventDefault();
        let dx=e.clientX;
        let dy=e.clientY;
        const pilot=e.target.pilot
        document.onmousemove=(e)=>{
            e.preventDefault();
            dx-=e.clientX;
            dy-=e.clientY;
            let gap={
                left:pilot.DOMelt.window.offsetLeft-dx,
                right:boundary.width-(pilot.DOMelt.window.offsetLeft-dx+pilot.DOMelt.window.offsetWidth),
                top:pilot.DOMelt.window.offsetTop-dy,
                bottom:boundary.height-(pilot.DOMelt.window.offsetTop-dy+pilot.DOMelt.window.offsetHeight)
            }
            if(gap.left>=0 && gap.right>=0){
                pilot.DOMelt.window.style.left=`${100*gap.left/boundary.width}%`;
                pilot.DOMelt.window.style.right=`${100*gap.right/boundary.width}%`;
            }
            if(gap.top>=0 && gap.bottom>=0){
                pilot.DOMelt.window.style.top=`${100*gap.top/boundary.height}%`;
                pilot.DOMelt.window.style.bottom=`${100*gap.bottom/boundary.height}%`;
            }
            dx=e.clientX;
            dy=e.clientY;
        }
        document.onmouseup=(e)=>{
            e.preventDefault();
            document.onmousemove=null;
            document.onmouseup=null;
        }
    }
    resize(e){
        //console.log(e.target)
        let gap={
            left:e.target.offsetLeft,
            right:e.target.pilot.destination.offsetWidth-(e.target.offsetLeft+e.target.offsetWidth),
            top:e.target.offsetTop,
            bottom:e.target.pilot.destination.offsetHeight-(e.target.offsetTop+e.target.offsetHeight)
        }
        e.target.style.left=`${100*(Math.max(gap.left,0)/e.target.pilot.destination.offsetWidth)}%`;
        e.target.style.right=`${100*(Math.max(gap.right,0)/e.target.pilot.destination.offsetWidth)}%`;
        e.target.style.top=`${100*(Math.max(gap.top,0)/e.target.pilot.destination.offsetHeight)}%`;
        e.target.style.bottom=`${100*(Math.max(gap.bottom,0)/e.target.pilot.destination.offsetHeight)}%`;
        if(gap.bottom<1 || gap.right){
            e.target.style.height="";
            e.target.style.width="";
        }
    }
}

class Accordion{
    constructor(title,origin,destination){
        this.title=title
        this.origin=origin
        this.destination=destination
        this.parameters={
            container:{
                folded:true,
                style:{
                    display:"grid",
                    width:"100%",
                    border:"0px solid black",
                    padding:"1px",
                    "grid-template-rows":"auto 1fr",
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
            handler:CE('div',{className:"accordion handler"},[
                CE('div',{className:"accordion handler menu"},[]),
                CE('div',{className:"accordion handler label"},[title]),
            ]),
            content:CE('div',{className:"accordion content"},[]),
        }
        this.DOMelt.handler.appendChild(this.DOMelt.folder)
        this.DOMelt.container=CE('div',{className:"accordion container"},[this.DOMelt.handler,this.DOMelt.content]);
        stylize(this.DOMelt.container,this.parameters.container.style);
        stylize(this.DOMelt.handler,this.parameters.handler.style);
        stylize(this.DOMelt.content,this.parameters.content.style);
        this.destination.appendChild(this.DOMelt.container)
    }
    fold(){
        this.parameters.folded=true
        this.DOMelt.container.style["grid-template-rows"]="auto 0fr"
        this.DOMelt.content.style.border="0px solid black"
        this.DOMelt.handler.style["margin-bottom"]="0px"
        this.DOMelt.folder.style["background-color"]="rgb(87, 53, 90)"
    }
    unfold(){
        this.parameters.folded=false
        this.DOMelt.container.style["grid-template-rows"]="auto 1fr"
        this.DOMelt.content.style.border="1px solid black"
        this.DOMelt.handler.style["margin-bottom"]="1px"
        this.DOMelt.folder.style["background-color"]="rgb(90, 83, 53)"
    }
    toggle(){
        if(this.parameters.folded){
            this.unfold();
        }else{
            this.fold();
        }
    }
}

class App{
    constructor(){
        this.testMap=new Map()
        this.testMap.set({prout:"zob"},{taille:78})
        this.channel=new Channel(this)
        this.parameters={
            topContent:{
                folded: false,
                height:100,
            },
            botContent:{
                folded: false,
                height:100,
                
            },
            leftContent:{
                folded:false,
                width:250,
            },
            rightContent:{
                folded:false,
                width:250,
            }
        }
        this.topContent=[
            CE('div',{id:"topContent", className:"horizontal content"},[
                "Top content",
                CE('div',{height:"200px",width:"100px",border:"1px solid black",color:'red'},["What is in top content"]),
                CE('button',{pilot:this,handleClick:(e)=>{
                    e.target.pilot.channel.register("choco",new Dialog("choco",e.target.pilot,e.target.pilot.main))
                    e.target.pilot.tata=new Table(fakeData(10),["ttl","an other","a third","anotheronetocheckeverythingis ok","and a last one that is super long !"],e.target.pilot,e.target.pilot.channel["choco"].DOMelt.content)
                }},[" Please click here for a table test"]),
                CE('button',{pilot:this,handleClick:(e)=>{
                    e.target.pilot.channel.register("lata",new Dialog("lata",e.target.pilot,e.target.pilot.midCentralContent))
                    e.target.pilot.yoyo=new Plot2D([],"yoyo",e.target.pilot,e.target.pilot.channel["lata"].DOMelt.content)
                }},[" Please click here for a graph test"]),
                CE('button',{pilot:this,handleClick:(e)=>{console.log(e.target.pilot)}},["Copy stability tests"])
            ])
        ]
        this.midCentralContent=CE('div',{className:"vertical center content"},["center content"])
        this.midContent=[
            CE('div',{id:"left",className:"vertical left panel"},[
                CE('div',{className:"vertical left content"},["left content"])
            ]),
            CE('div',{id:"leftSeptum", className:"left septum vertical"},[
                CE('div',{className:"vertical resizer",pilot:this,handleMouseDown:(e)=>e.target.pilot.resizerHookLeft(e)},[]),
                CE('div',{className:"vertical wrapper",pilot:this,handleClick:(e)=>{e.target.pilot.foldLeft(!e.target.pilot.parameters.leftContent.folded)}},[]),
                CE('div',{className:"vertical resizer",pilot:this,handleMouseDown:(e)=>e.target.pilot.resizerHookLeft(e)},[])
            ]),
            CE('div',{id:"center",className:"vertical center panel"},[
                this.midCentralContent
            ]),
            CE('div',{id:"rightSeptum", className:"right septum vertical"},[
                CE('div',{className:"vertical resizer",pilot:this,handleMouseDown:(e)=>e.target.pilot.resizerHookRight(e)},[]),
                CE('div',{className:"vertical wrapper",pilot:this,handleClick:(e)=>{e.target.pilot.foldRight(!e.target.pilot.parameters.rightContent.folded)}},[]),
                CE('div',{className:"vertical resizer",pilot:this,handleMouseDown:(e)=>e.target.pilot.resizerHookRight(e)},[])
            ]),
            CE('div',{id:"right",className:"vertical right panel"},[
                CE('div',{className:"vertical right content"},["right content"])
            ])
        ]
        this.botContent=[
            CE('div',{id:"botContent", className:"horizontal content"},[
                "Bot content"
            ])
        ]
        this.menu=CE('div',{id:"mainMenu",className:"menu"},[])
        this.top=CE('div',{id:"top",className:"horizontal top panel"},this.topContent)
        this.topSeptum=CE('div',{id:"topSeptum",className:"top horizontal septum"},[
            CE('div',{className:"horizontal resizer",pilot:this,handleMouseDown:(e)=>e.target.pilot.resizerHookTop(e)},[]),
            CE('div',{className:"horizontal wrapper",pilot:this,handleClick:(e)=>{e.target.pilot.foldTop(!e.target.pilot.parameters.topContent.folded)}},[]),
            CE('div',{className:"horizontal resizer",pilot:this,handleMouseDown:(e)=>e.target.pilot.resizerHookTop(e)},[])
        ])
        this.mid=CE('div',{id:"mid",className:"horizontal mid panel"},this.midContent)
        this.botSeptum=CE('div',{id:"botSeptum",className:"bot horizontal septum"},[
            CE('div',{className:"horizontal resizer",pilot:this,handleMouseDown:(e)=>e.target.pilot.resizerHookBot(e)},[]),
            CE('div',{className:"horizontal wrapper",pilot:this,handleClick:(e)=>{e.target.pilot.foldBot(!e.target.pilot.parameters.botContent.folded)}},[]),
            CE('div',{className:"horizontal resizer",pilot:this,handleMouseDown:(e)=>e.target.pilot.resizerHookBot(e)},[])
        ])
        this.bot=CE('div',{id:"bot",className:"horizontal bot panel"},this.botContent)
        this.mainInterface=CE('div',{id:"mainInterface", className:"container"},[
            this.top,
            this.topSeptum,
            this.mid,
            this.botSeptum,
            this.bot
        ])
        this.main=CE('div',{id:"main",className:"app"},[
            this.menu,
            this.mainInterface
        ])

        this.setupOnWindow()
        this.channel.register("Data manager",new Accordion("Data manager",this,$(".vertical.left.content")))
        this.channel['Data manager'].toggle()
        this.channel['Data manager'].DOMelt.content.appendChild(
            CE('div',{},["test",CE('div',{id:"Gloubidi",style:{height:"300px"}},[])])
        )
        this.channel.register("mainMenu",new MainMenu(defaultMenu.mainMenu,"mainMenu",this,this.menu))
        this.channel.register("mainFlow",new Flow("mainFlow",this,this.topContent[0]))
        this.channel.register('teprou',new Node('teprou',[{},{},{}],[{},{},{}],this,this.channel.mainFlow))
        this.channel.register('tefar', new Node('tefar',[{}],[{}],this,this.channel.mainFlow,{x:180,y:10}))
    }
    foldTop(v){
        if(v){
            this.parameters.topContent.folded=true;
            this.mainInterface.style["grid-template-rows"]=`0px 5px 1fr 5px ${this.parameters.botContent.height*(!this.parameters.botContent.folded)}px`
        }else{
            this.parameters.topContent.folded=false;
            this.mainInterface.style["grid-template-rows"]=`${this.parameters.topContent.height}px 5px 1fr 5px ${this.parameters.botContent.height*(!this.parameters.botContent.folded)}px`
        }
    }
    resizeHeightTop(v){
        this.parameters.topContent.height=v
        this.mainInterface.style["grid-template-rows"]=`${v}px 5px 1fr 5px ${this.parameters.botContent.height*(!this.parameters.botContent.folded)}px`
    }
    resizerHookTop(e){
        e.preventDefault();
        let dy=e.clientY;
        const pilot=e.target.pilot
        document.onmousemove=(e)=>{
            pilot.mainInterface.style.transition="0ms";
            pilot.resizeHeightTop(pilot.parameters.topContent.height-dy+e.clientY);
            dy=e.clientY;
        }
        document.onmouseup=(e)=>{
            document.onmousemove=null;
            document.onmouseup=null;
            pilot.mainInterface.style.transition="300ms";
        }
    }
    foldBot(v){
        if(v){
            this.parameters.botContent.folded=true;
            this.mainInterface.style["grid-template-rows"]=`${this.parameters.topContent.height*(!this.parameters.topContent.folded)}px 5px 1fr 5px 0px`
        }else{
            this.parameters.botContent.folded=false;
            this.mainInterface.style["grid-template-rows"]=`${this.parameters.topContent.height*(!this.parameters.topContent.folded)}px 5px 1fr 5px ${this.parameters.botContent.height}px`
        }
    }
    resizeHeightBot(v){
        this.parameters.botContent.height=v;
        this.mainInterface.style["grid-template-rows"]=`${this.parameters.topContent.height*(!this.parameters.topContent.folded)}px 5px 1fr 5px ${v}px`
    }
    resizerHookBot(e){
        e.preventDefault();
        let dy=e.clientY;
        const pilot=e.target.pilot
        document.onmousemove=(e)=>{
            pilot.mainInterface.style.transition="0ms";
            pilot.resizeHeightBot(pilot.parameters.botContent.height+dy-e.clientY)
            dy=e.clientY;
        }
        document.onmouseup=(e)=>{
            document.onmousemove=null;
            document.onmouseup=null;
            pilot.mainInterface.style.transition="300ms";
        }
    }
    foldLeft(v){
        if(v){
            this.parameters.leftContent.folded=true;
            this.mid.style["grid-template-columns"]=`0px 5px 1fr 5px ${this.parameters.rightContent.width*(!this.parameters.rightContent.folded)}px`
        }else{
            this.parameters.leftContent.folded=false;
            this.mid.style["grid-template-columns"]=`${this.parameters.leftContent.width}px 5px 1fr 5px ${this.parameters.rightContent.width*(!this.parameters.rightContent.folded)}px`
        }
    }
    resizeWidthLeft(v){
        this.parameters.leftContent.width=v;
        this.mid.style["grid-template-columns"]=`${v}px 5px 1fr 5px ${this.parameters.rightContent.width*(!this.parameters.rightContent.folded)}px`
    }
    resizerHookLeft(e){
        e.preventDefault();
        let dx=e.clientX;
        const pilot=e.target.pilot
        document.onmousemove=(e)=>{
            pilot.mid.style.transition="0ms";
            pilot.resizeWidthLeft(pilot.parameters.leftContent.width-dx+e.clientX);
            dx=e.clientX;
        }
        document.onmouseup=(e)=>{
            document.onmousemove=null;
            document.onmouseup=null;
            pilot.mid.style.transition="300ms";
        }
    }
    foldRight(v){
        if(v){
            this.parameters.rightContent.folded=true;
            this.mid.style["grid-template-columns"]=`${this.parameters.leftContent.width*(!this.parameters.leftContent.folded)}px 5px 1fr 5px 0px`
        }else{
            this.parameters.rightContent.folded=false;
            this.mid.style["grid-template-columns"]=`${this.parameters.leftContent.width*(!this.parameters.leftContent.folded)}px 5px 1fr 5px ${this.parameters.rightContent.width}px`
        }
    }
    resizeWidthRight(v){
        this.parameters.rightContent.width=v;
        this.mid.style["grid-template-columns"]=`${this.parameters.leftContent.width*(!this.parameters.leftContent.folded)}px 5px 1fr 5px ${v}px`
    }
    resizerHookRight(e){
        e.preventDefault();
        let dx=e.clientX;
        const pilot=e.target.pilot
        document.onmousemove=(e)=>{
            pilot.mid.style.transition="0ms";
            pilot.resizeWidthRight(pilot.parameters.rightContent.width+dx-e.clientX)
            dx=e.clientX;
        }
        document.onmouseup=(e)=>{
            document.onmousemove=null;
            document.onmouseup=null;
            pilot.mid.style.transition="300ms";
        }
    }
    setupOnWindow(destination='body'){
        this.destination=destination;
        $(this.destination).appendChild(this.main);
        this.main.addEventListener('click',(e)=>{
            //console.log(e.target)
            if(e.target.handleClick){e.target.handleClick(e)}
        })
        this.main.addEventListener('mousedown',function(e){
            if(e.target.handleMouseDown){e.target.handleMouseDown(e)}
        })
        this.main.addEventListener('mouseup',function(e){
            if(e.target.handleMouseUp){e.target.handleMouseUp(e)}
        })
        this.main.addEventListener('keydown',(e)=>{
            if(e.target.handleKeyDown){e.target.handleKeyDown(e)}
        })
        this.main.addEventListener('blur',(e)=>{
            if(e.target.handleBlur){e.target.handleBlur(e)}
        },true)
        this.main.addEventListener('input',(e)=>{
            if(e.target.handleInput){e.target.handleInput(e)}
        })
        this.main.addEventListener('scroll',(e)=>{
            if(e.target.handleScroll){e.target.handleScroll(e)}
        },true)
        this.main.addEventListener('change',(e)=>{
            if(e.target.handleChange){e.target.handleChange(e)}
        })
        const deepResize=(e)=>{
            if(e.target.handleResize){
                e.target.handleResize(e)
            }
            for(let child of e.target.children){
                deepResize({target:child})
            }
        }
        const setDeepResizeObs=(elt,obs)=>{
            obs.observe(elt)
            for(let child of elt.children){
                setDeepResizeObs(child,obs)
            }
        }
        this.resizeObserver=new ResizeObserver((entries)=>{entries.forEach((e)=>deepResize(e))})
        this.mutObserver=new MutationObserver((mutationsList, observer)=>{
            mutationsList.forEach((e)=>{
                //console.log(e)
                if(e.target.handleResize){
                    setDeepResizeObs(e.target,this.resizeObserver)
                    /*if(e.oldValue){
                        const oldWidth=e.oldValue.match(/width:\s*([^;]+);/)
                        if(oldWidth!=null){
                            const oldHeight=e.oldValue.match(/height:\s*([^;]+);/)
                            if(oldHeight!=null){
                                if(oldWidth[1]!=e.target.style.width || oldHeight[1]!=e.target.style.height){
                                    deepResize(e)
                                }
                            }
                        }
                    }*/
                }
            }
            )
            }
            )
        setDeepResizeObs(this.main,this.resizeObserver)
        this.mutObserver.observe(this.main,{attributes:true,childList:true,attributeFilter:["style"],attributeOldValue:true,subtree:true})
    }
    loadDelimitedText(){
        let DelimitedTextLoader=new Dialog("Load delimited text file",this,this.main)
        let prevLength=500
        let dataVessel={
            dims:[0,0],
            raw:"",
            processed:[],
            processRaw(){
                if(this.reader){
                    this.raw=this.reader.result
                    delete this.reader
                }
                let lines=this.raw.split(RegExp(lineSeparator.value))
                this.dims[0]=lines.length
                for(let k in lines){
                    lines[k]=lines[k].split(RegExp(colSeparator.value))
                    this.dims[1]=Math.max(this.dims[1],lines[k].length)
                    lines[k].forEach((e,i,a)=>{a[i]=parseFloat(e)})
                }
                this.processed=lines
            }
        }
        const validate=()=>{
            DelimitedTextLoader.DOMelt.dismisser.click()
        }
        const readSingleFile=(e,data)=>{
            let file = e.target.files[0];
            if (!file) {
                return;
            }
            data.reader = new FileReader();
            data.reader.onload = (e)=>{
                updatePreviews(data)
            }
            data.reader.readAsText(file);
        }
        const updatePreviews=(vessel)=>{
            vessel.processRaw()
            rawPreview.textContent=vessel.raw.slice(0,prevLength)
            procPreview.innerHTML=""
            let cropData=vessel.processed.slice(0,15)
            cropData.pop()
            let ellipsisRow=[]
            for(let k in cropData[0]){ellipsisRow.push("...")}
            cropData.push(ellipsisRow)
            let prevTable=new Table(cropData,[],this,procPreview)
            prevTable.parameters.mutable.hRuler=true
        }
        const loaderElement=CE('input',{type:"file",handleChange:(e)=>{readSingleFile(e,dataVessel)}},["Select a text file"])
        let rawPreview=CE('div',{style:{margin:"5px","border-radius":"5px",border:"1px solid white",padding:"5px"}},["Ici la prévisualisation des données brutes"])
        rawPreview.setAttribute("contenteditable","true")
        rawPreview.handleInput=(e)=>{
            dataVessel.raw=e.target.textContent+dataVessel.raw.slice(prevLength)
            updatePreviews(dataVessel)
        }
        let procPreview=CE('div',{style:{margin:"5px","border-radius":"5px",border:"1px solid white",padding:"5px"}},["Ici la prévisualisation des données traitées"])
        const lineSeparator=CE('select',{handleInput:(e)=>{updatePreviews(dataVessel)}},[
            CE('option',{value:"\r|\n|\r\n"},["auto/guess"]),
            CE('option',{value:"\r\n"},["CRLF"]),
            CE('option',{value:"\r"},["CR"]),
            CE('option',{value:"\n"},["LF"]),
        ])
        const colSeparator=CE('select',{handleInput:(e)=>{updatePreviews(dataVessel)}},[
            CE('option',{value:"\t|,|\s"},["auto/guess"]),
            CE('option',{value:"\t"},["tab"]),
            CE('option',{value:","},["comma"]),
            CE('option',{value:"/\s/"},["whitespace"]),
        ])
        const validator=CE('button',{handleClick:(e)=>{validate()}},["Load"])
        const command=CE('div',{width:"100%"},[
            CE('label',{for:"loaderCommands"},["Lines separator"]),
            lineSeparator,
            CE('br',{},[]),
            CE('label',{for:"loaderCommands"},["Columns separator"]),
            colSeparator,
            CE('br',{},[]),
            CE('div',{style:{"text-align":"right"}},[validator])
        ])
        const loaderContainer=CE('div',{
            style:{
                width:"100%",
                height:"100%",
                display:"grid",
                "grid-template-rows":"auto 3fr auto"},
                "justify-items": "stretch",
                "align-items": "stretch"
        },[
            loaderElement,
            CE('div',{style:{
                overflow:"auto",
                display:"grid",
                "grid-template-columns":"1fr 1fr"
            }},[
                rawPreview,
                procPreview
            ]),
            command
        ])
        DelimitedTextLoader.DOMelt.content.appendChild(loaderContainer)
    }
    saveAppState(){
        return globalThis.undoStack.push(DC(this))
    }
    restoreLastState(){
        if(globalThis.undoStack.length){
            document.body.lastChild.remove()
            this.channel.shutDown()
            globalThis.Attributor=globalThis.undoStack.pop()
            globalThis.Attributor.setupOnWindow()
            globalThis.Attributor.channel.setupOnAir()
        }
    }
}


export {App}
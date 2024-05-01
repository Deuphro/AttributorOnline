import {$,CE,stylize,fakeData,DC} from "./util.js"
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm"
import {defaultMenu} from "../resources/config.js"
import { Data , Vector, Wave} from "./formats.js"

window.raie=new Wave(5000,5000)
window.eiar=new Wave(5000,5000)

class Node{
    constructor(title,inputs, outputs,origin,destinationFlow,position={x:10,y:10}){
        const self=this
        this.title=title
        this.inputs=inputs
        this.outputs=outputs
        this.origin=origin
        this.destination=destinationFlow
        this.destination.nodeSet.add(this)
        this.upToDate=true
        this.drawn=false
        this.events={broadcast:{
            nodeMove:(pos)=>new CustomEvent("nodeMove",{detail:{msg:pos,emitter:this}}),
            startLinkDrawing:new CustomEvent("startLinkDrawing",{detail:{msg:"",emitter:this}}),
            nodeSelected:new CustomEvent("nodeSelected",{detail:{msg:"I'm a node selected",emitter:this}})
        },listen:{
            nodeSelected(e){
                if (e.detail.emitter.events.registrationName==self.events.registrationName) {
                    if(document.activeElement===self.SVGg.select('rect').node()){
                        self.SVGg.select('rect').node().blur()
                    }else{
                        self.SVGg.select('rect').node().focus()
                    }
                } else {
                    self.SVGg.select('rect').attr('class','node')
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
            }
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
            .on("mousedown", this.drag.bind(this) )
            .on("click", ()=>window.dispatchEvent(this.events.broadcast.nodeSelected))
            .on("keydown",(e)=>{
                if(e.key==="Delete"){
                    this.suicide()
                }
            })
        for(let k in inputs){
            this.parameters.inputs.positions[k]={x:0,y:this.parameters.rounding+this.parameters.margin+(Number(k)+0.5)*this.parameters.heightPerItem}
            this.SVGg.append('circle')
            .attr('cx',this.parameters.inputs.positions[k].x)
            .attr('cy',this.parameters.inputs.positions[k].y)
            .attr("r", 5)
            .attr('class','input anchor')
            .on("mousedown", (e)=>console.log(e.target) )
        }
        for(let k in outputs){
            this.parameters.outputs.positions[k]={x:this.parameters.width,y:this.parameters.rounding+this.parameters.margin+(Number(k)+0.5)*this.parameters.heightPerItem}
            this.SVGg.append('circle')
            .attr('cx',this.parameters.width)
            .attr('cy',this.parameters.outputs.positions[k].y)
            .attr("r", 5)
            .attr('class','output anchor')
            .on("mousedown", (e)=>console.log(e.target))
        }
        this.SVGg.append("text")
            .attr("x",10)
            .attr("y",this.nodeHeight/2+2.5)
            .text(title)
            .attr('id','testText')
        this.SVGg.attr('transform', 'translate('+`${this.parameters.position.x},${this.parameters.position.y}`+')')
        this.DOMelt=this.SVGg.node()
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
        document.onmousemove=(e)=>{
            e.preventDefault();
            dx-=e.clientX;
            dy-=e.clientY;
            this.parameters.position.x-=dx
            this.parameters.position.y-=dy
            window.dispatchEvent(this.events.broadcast.nodeMove(this.parameters.position))
            this.SVGg.attr('transform', 'translate('+`${this.parameters.position.x},${this.parameters.position.y}`+')')
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
    constructor(title,origin, destination){
        self=this
        this.title=title
        this.origin=origin
        this.destination=destination
        this.container=CE('div',{className:`flow container ${title}`},[])
        this.events={broadcast:{},listen:{
            nodeMove(e){},
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
}

class MainMenu{
    constructor(configObject,title,origin,destination){
        self=this
        this.title=title
        this.origin=origin
        this.destination=destination
        this.container=CE('nav',{className:`menu container ${title}`},[])
        this.events={
            broadcast:{
                poppedUp:new CustomEvent("poppedUp",{detail:{msg:"I've just popped up",emitter:self}}),
                killed:new CustomEvent("killed",{detail:{msg:"I've just been killed !!!",emitter:self}}),
            },
            listen:{
            importDelimitedText(e){origin.loadDelimitedText()},
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
                CE('div',{className:"parent",handleClick:object[k]},[
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
    constructor(){
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
                window.addEventListener(e.type,this.defaultListener.bind(this))
                this.eventTypes[e.type]=new Set()
            }
        })
        if(!caster.events.listen){
        } else {
            const listeners=caster.events.listen
            Object.keys(listeners).forEach((e)=>{
                if (!this.eventTypes[e]){
                    window.addEventListener(e,this.defaultListener.bind(this))
                    this.eventTypes[e]=new Set()
                }
                this.eventTypes[e].add(name)
        })
        }
        dispatchEvent(broadcasts.poppedUp)
    }
    degister(name){
        delete this[name]
        Object.values(this.eventTypes).forEach((e)=>{e.delete(name)})
    }
    defaultListener(e){
        const et=e.type
        this.eventTypes[e.type].forEach((targetName,i,a)=>{
            this[targetName].events.listen[et](e)
            })
        if(et=="killed"){this.degister(e.detail.emitter.events.registrationName)}
    }
}

class Plot2D{
    constructor(data,title,origin,destination){
        self=this
        this.title=title
        this.data=data
        this.origin=origin
        this.destination=destination
        this.container=CE('div',{className:"2dplot container"},[]);
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
        this.resizeObserver=new ResizeObserver((e)=>{this.drawGraph()});
        this.resizeObserver.observe(this.container);
    }
    get graphzone(){
        self=this
        return {
            width:self.container.clientWidth-self.parameters.margins.left-self.parameters.margins.right,
            height:self.container.clientHeight-self.parameters.margins.top-self.parameters.margins.bottom
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
        this.container=CE('div',{className:"table container"},[]);
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
        this.container.addEventListener('scroll',(e)=>{this.onScroll(e)});
        this.resizeObserver=new ResizeObserver(()=>{this.onResize()});
        this.resizeObserver.observe(this.container);
    }
    set setData(arg){
        this.data=arg
        this.parameters.dataDimension={rows:Table.rowNum(arg),cols:Table.colNum(arg)}
    }
    onScroll(e){
        this.parameters.virtualIndex.top=Math.floor(this.container.scrollTop/(parseInt(this.parameters.styles.vRuler.table["border-spacing"]) + parseInt(this.parameters.styles.vRuler.cells.height)))
        this.parameters.virtualIndex.left=Math.floor(this.container.scrollLeft/(parseInt(this.parameters.styles.hRuler.cells.width) + parseInt(this.parameters.styles.hRuler.table["border-spacing"])))
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
        const width=parseInt(this.parameters.styles.vRuler.cells.width) + this.parameters.dataDimension.cols*parseInt(this.parameters.styles.cells.width) + (this.parameters.dataDimension.cols+2)*parseInt(this.parameters.styles.tables["border-spacing"])
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
        const height=this.parameters.dataDimension.rows*parseInt(this.parameters.styles.cells.height) + (this.parameters.dataDimension.rows+1)*parseInt(this.parameters.styles.tables["border-spacing"])
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
    virtualhRuler(){
        const Dx=this.container.clientWidth-parseInt(this.parameters.styles.vRuler.cells.width)-2*parseInt(this.parameters.styles.tables["border-spacing"])
        this.virtualNbCols=Math.min(Math.ceil(Dx/(parseInt(this.parameters.styles.hRuler.cells.width)+parseInt(this.parameters.styles.hRuler.table["border-spacing"]))),this.parameters.dataDimension.cols)
        this.parameters.virtualIndex.left=Math.min(this.parameters.virtualIndex.left,this.parameters.dataDimension.cols-this.virtualNbCols)
        let titleLine=[]//[CE('th',{className:"horizontal title cell",style:this.parameters.styles.vRuler.cells},[""])];
        let rulerLine=[]//[CE('th',{className:"horizontal ruler cell",style:this.parameters.styles.vRuler.cells},[""])];
        const leftGap=parseInt(this.parameters.styles.vRuler.cells.width)+2*parseInt(this.parameters.styles.vRuler.table['border-spacing'])
        for(let k=0;k<this.virtualNbCols;k++){
            rulerLine.push(CE('th',{className:"horizontal ruler cell",style:this.parameters.styles.hRuler.cells},[(this.parameters.virtualIndex.left+k).toString()]));
            titleLine.push(CE('th',{className:"horizontal title cell",style:this.parameters.styles.hRuler.cells},[this.title[this.parameters.virtualIndex.left+k]===undefined ? "" : this.title[this.parameters.virtualIndex.left+k]]));
            rulerLine[k].style["cursor"]="col-resize"
            if(this.parameters.mutable.hRuler){
                titleLine[k].style["cursor"]="auto"
                titleLine[k].style["background-color"]="cornsilk"
                titleLine[k].setAttribute("contenteditable","true")
                titleLine[k].addEventListener("blur",(e)=>{
                    this.title[e.target.cellIndex]=e.target.textContent
                })
                titleLine[k].addEventListener("keydown",(e)=>{
                    if(e.key=="Enter"){
                        e.target.blur()
                    }
                
            })
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
        res.children[1].addEventListener('mousedown',(e)=>{
            e.preventDefault();
            let dx=e.clientX;
            document.onmousemove=(e)=>{
                e.preventDefault();
                dx-=e.clientX
                this.parameters.styles.cells.width=`${Math.max(5,parseInt(this.parameters.styles.cells.width))-dx}px`
                this.parameters.styles.hRuler.cells.width=`${Math.max(5,parseInt(this.parameters.styles.cells.width))-dx}px`
                this.parameters.styles.bTable.cells.width=`${Math.max(5,parseInt(this.parameters.styles.cells.width))-dx}px`
                this.onResize()
                dx=e.clientX
            }
            document.onmouseup=(e)=>{
                e.preventDefault();
                document.onmouseup=null;
                document.onmousemove=null;
            }
        })
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
        const dialog=this;
        this.title=title
        this.events={
            broadcast:{
                
                selected:new CustomEvent("selected",{detail:{msg:"I've just been selected !!!",emitter:dialog}})
            },
            listen:{
                selected(e){
                    console.log("oupinez "+e.detail.emitter.events.registrationName+" a été selectionné !!")
                    if (e.detail.emitter.events.registrationName==dialog.events.registrationName) {
                        console.log("hey mais c moi car je suis:",dialog.events.registrationName)
                        dialog.DOMelt.window.classList.add('selected')
                        dialog.DOMelt.window.style["z-index"]="10"
                    } else {
                        console.log("ha oui mais c'est pas moi car je suis:",dialog.events.registrationName)
                        dialog.DOMelt.window.classList.remove('selected')
                        dialog.DOMelt.window.style["z-index"]="0"
                    }
                },
                killed(e){console.log("quelqu'un s'est fait tué !\n","il s'appelait ",e.detail.emitter.events.registrationName)},
                importDelimitedText(e){console.log(e)}
            }
        }
        this.origin=origin;
        this.destination=destination;
        this.DOMelt={};
        this.DOMelt.dismisser=CE('div',{className:"dismisser"},[]);
        this.DOMelt.dismisser.handleClick=this.suicide.bind(this);
        this.DOMelt.label=CE('div',{className:"label"},[title.toString()]);
        this.DOMelt.label.onmousedown=this.drag.bind(this);
        this.DOMelt.label.handleClick=(e)=>{dispatchEvent(dialog.events.broadcast.selected)}
        this.DOMelt.handler=CE('div',{},[this.DOMelt.label,this.DOMelt.dismisser]);
        this.DOMelt.content=CE('div',{className:"popup content"},[]);
        this.DOMelt.window=CE('div',{className:title+" popup container"},[
            dialog.DOMelt.handler,
            dialog.DOMelt.content
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
        this.resizeObserver=new ResizeObserver((e)=>e.forEach((v)=>{
            this.resize(v);
        }));
        if (!$(`.${title}.popup.container`)){
            destination.appendChild(this.DOMelt.window);
        }else{
            this.DOMelt.window.remove()
            destination.appendChild(this.DOMelt.window);
        }
        this.resizeObserver.observe(this.DOMelt.window);
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
        document.onmousemove=(e)=>{
            e.preventDefault();
            dx-=e.clientX;
            dy-=e.clientY;
            let gap={
                left:this.DOMelt.window.offsetLeft-dx,
                right:boundary.width-(this.DOMelt.window.offsetLeft-dx+this.DOMelt.window.offsetWidth),
                top:this.DOMelt.window.offsetTop-dy,
                bottom:boundary.height-(this.DOMelt.window.offsetTop-dy+this.DOMelt.window.offsetHeight)
            }
            if(gap.left>=0 && gap.right>=0){
                this.DOMelt.window.style.left=`${100*gap.left/boundary.width}%`;
                this.DOMelt.window.style.right=`${100*gap.right/boundary.width}%`;
            }
            if(gap.top>=0 && gap.bottom>=0){
                this.DOMelt.window.style.top=`${100*gap.top/boundary.height}%`;
                this.DOMelt.window.style.bottom=`${100*gap.bottom/boundary.height}%`;
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
        self=this;
        let gap={
            left:e.target.offsetLeft,
            right:self.destination.offsetWidth-(e.target.offsetLeft+e.target.offsetWidth),
            top:e.target.offsetTop,
            bottom:self.destination.offsetHeight-(e.target.offsetTop+e.target.offsetHeight)
        }
        e.target.style.left=`${100*(Math.max(gap.left,0)/this.destination.offsetWidth)}%`;
        e.target.style.right=`${100*(Math.max(gap.right,0)/this.destination.offsetWidth)}%`;
        e.target.style.top=`${100*(Math.max(gap.top,0)/this.destination.offsetHeight)}%`;
        e.target.style.bottom=`${100*(Math.max(gap.bottom,0)/this.destination.offsetHeight)}%`;
        if(gap.bottom<1 || gap.right){
            e.target.style.height="";
            e.target.style.width="";
        }
    }
}

class Accordion{
    constructor(title,origin,destination){
        const accordion=this;
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
            folder:CE('div',{className:"accordion handler folder",
                handleClick:(e)=>{accordion.toggle()}},[]),
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
        const app=this
        this.channel=new Channel()
        this.parameters={
            topContent:{
                folded: false,
                set fold(v){
                    if(v){
                        app.parameters.topContent.folded=true;
                        $("#mainInterface").style["grid-template-rows"]=`0px 5px 1fr 5px ${app.parameters.botContent.height*(!app.parameters.botContent.folded)}px`
                    }else{
                        app.parameters.topContent.folded=false;
                        $("#mainInterface").style["grid-template-rows"]=`${app.parameters.topContent.height}px 5px 1fr 5px ${app.parameters.botContent.height*(!app.parameters.botContent.folded)}px`
                    }
                },
                height:100,
                set resizeHeight(v){
                    app.parameters.topContent.height=v
                    $("#mainInterface").style["grid-template-rows"]=`${v}px 5px 1fr 5px ${app.parameters.botContent.height*(!app.parameters.botContent.folded)}px`
                },
                resizerHook:(e)=>{
                    e.preventDefault();
                    let dy=e.clientY;
                    document.onmousemove=(e)=>{
                        $("#mainInterface").style.transition="0ms";
                        app.parameters.topContent.resizeHeight=app.parameters.topContent.height-dy+e.clientY;
                        dy=e.clientY;
                    }
                    document.onmouseup=(e)=>{
                        document.onmousemove=null;
                        document.onmouseup=null;
                        $("#mainInterface").style.transition="300ms";
                    }
                }
            },
            botContent:{
                folded: false,
                set fold(v){
                    if(v){
                        app.parameters.botContent.folded=true;
                        $("#mainInterface").style["grid-template-rows"]=`${app.parameters.topContent.height*(!app.parameters.topContent.folded)}px 5px 1fr 5px 0px`
                    }else{
                        app.parameters.botContent.folded=false;
                        $("#mainInterface").style["grid-template-rows"]=`${app.parameters.topContent.height*(!app.parameters.topContent.folded)}px 5px 1fr 5px ${app.parameters.botContent.height}px`
                    }
                },
                height:100,
                set resizeHeight(v){
                    app.parameters.botContent.height=v;
                    $("#mainInterface").style["grid-template-rows"]=`${app.parameters.topContent.height*(!app.parameters.topContent.folded)}px 5px 1fr 5px ${v}px`
                },
                resizerHook:(e)=>{
                    e.preventDefault();
                    let dy=e.clientY;
                    document.onmousemove=(e)=>{
                        $("#mainInterface").style.transition="0ms";
                        app.parameters.botContent.resizeHeight=app.parameters.botContent.height+dy-e.clientY;
                        dy=e.clientY;
                    }
                    document.onmouseup=(e)=>{
                        document.onmousemove=null;
                        document.onmouseup=null;
                        $("#mainInterface").style.transition="300ms";
                    }
                }
            },
            leftContent:{
                folded:false,
                width:250,
                set fold(v){
                    if(v){
                        app.parameters.leftContent.folded=true;
                        app.mid.style["grid-template-columns"]=`0px 5px 1fr 5px ${app.parameters.rightContent.width*(!app.parameters.rightContent.folded)}px`
                    }else{
                        app.parameters.leftContent.folded=false;
                        app.mid.style["grid-template-columns"]=`${app.parameters.leftContent.width}px 5px 1fr 5px ${app.parameters.rightContent.width*(!app.parameters.rightContent.folded)}px`
                    }
                },
                set resizeWidth(v){
                    app.parameters.leftContent.width=v;
                    app.mid.style["grid-template-columns"]=`${v}px 5px 1fr 5px ${app.parameters.rightContent.width*(!app.parameters.rightContent.folded)}px`
                },
                resizerHook:(e)=>{
                    e.preventDefault();
                    let dx=e.clientX;
                    document.onmousemove=(e)=>{
                        app.mid.style.transition="0ms";
                        app.parameters.leftContent.resizeWidth=app.parameters.leftContent.width-dx+e.clientX;
                        dx=e.clientX;
                    }
                    document.onmouseup=(e)=>{
                        document.onmousemove=null;
                        document.onmouseup=null;
                        app.mid.style.transition="300ms";
                    }
                }
            },
            rightContent:{
                folded:false,
                width:250,
                set fold(v){
                    if(v){
                        app.parameters.rightContent.folded=true;
                        app.mid.style["grid-template-columns"]=`${app.parameters.leftContent.width*(!app.parameters.leftContent.folded)}px 5px 1fr 5px 0px`
                    }else{
                        app.parameters.rightContent.folded=false;
                        app.mid.style["grid-template-columns"]=`${app.parameters.leftContent.width*(!app.parameters.leftContent.folded)}px 5px 1fr 5px ${app.parameters.rightContent.width}px`
                    }
                },
                set resizeWidth(v){
                    app.parameters.rightContent.width=v;
                    app.mid.style["grid-template-columns"]=`${app.parameters.leftContent.width*(!app.parameters.leftContent.folded)}px 5px 1fr 5px ${v}px`
                },
                resizerHook:(e)=>{
                    e.preventDefault();
                    let dx=e.clientX;
                    document.onmousemove=(e)=>{
                        app.mid.style.transition="0ms";
                        app.parameters.rightContent.resizeWidth=app.parameters.rightContent.width+dx-e.clientX;
                        dx=e.clientX;
                    }
                    document.onmouseup=(e)=>{
                        document.onmousemove=null;
                        document.onmouseup=null;
                        app.mid.style.transition="300ms";
                    }
                }
            }
        }
        this.topContent=[
            CE('div',{id:"topContent", className:"horizontal content"},[
                "Top content",
                CE('div',{height:"200px",width:"100px",border:"1px solid black",color:'red'},["What is in top content"]),
                CE('button',{handleClick:(e)=>{
                    app.channel.register("choco",new Dialog("choco",app,app.main))
                    app.tata=new Table(fakeData(10),["ttl","an other","a third","anotheronetocheckeverythingis ok","and a last one that is super long !"],app,app.channel["choco"].DOMelt.content)
                }},[" Please click here for a table test"]),
                CE('button',{handleClick:(e)=>{
                    app.channel.register("lata",new Dialog("lata",app,app.midCentralContent))
                    app.yoyo=new Plot2D([],"yoyo",app,app.channel["lata"].DOMelt.content)
                }},[" Please click here for a graph test"])
            ])
        ]
        this.midCentralContent=CE('div',{className:"vertical center content"},["center content"])
        this.midContent=[
            CE('div',{id:"left",className:"vertical left panel"},[
                CE('div',{className:"vertical left content"},["left content"])
            ]),
            CE('div',{id:"leftSeptum", className:"left septum vertical"},[
                CE('div',{className:"vertical resizer",onmousedown:this.parameters.leftContent.resizerHook},[]),
                CE('div',{className:"vertical wrapper",handleClick:()=>{this.parameters.leftContent.fold=!this.parameters.leftContent.folded;}},[]),
                CE('div',{className:"vertical resizer",onmousedown:this.parameters.leftContent.resizerHook},[])
            ]),
            CE('div',{id:"center",className:"vertical center panel"},[
                this.midCentralContent
            ]),
            CE('div',{id:"rightSeptum", className:"right septum vertical"},[
                CE('div',{className:"vertical resizer",onmousedown:this.parameters.rightContent.resizerHook},[]),
                CE('div',{className:"vertical wrapper",handleClick:()=>{this.parameters.rightContent.fold=!this.parameters.rightContent.folded;}},[]),
                CE('div',{className:"vertical resizer",onmousedown:this.parameters.rightContent.resizerHook},[])
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
        //this.menu.onload
        this.top=CE('div',{id:"top",className:"horizontal top panel"},this.topContent)
        this.topSeptum=CE('div',{id:"topSeptum",className:"top horizontal septum"},[
            CE('div',{className:"horizontal resizer",onmousedown:this.parameters.topContent.resizerHook},[]),
            CE('div',{className:"horizontal wrapper",handleClick:()=>{this.parameters.topContent.fold=!this.parameters.topContent.folded;}},[]),
            CE('div',{className:"horizontal resizer",onmousedown:this.parameters.topContent.resizerHook},[])
        ])
        this.mid=CE('div',{id:"mid",className:"horizontal mid panel"},this.midContent)
        this.botSeptum=CE('div',{id:"botSeptum",className:"bot horizontal septum"},[
            CE('div',{className:"horizontal resizer",onmousedown:this.parameters.botContent.resizerHook},[]),
            CE('div',{className:"horizontal wrapper",handleClick:()=>{this.parameters.botContent.fold=!this.parameters.botContent.folded;}},[]),
            CE('div',{className:"horizontal resizer",onmousedown:this.parameters.botContent.resizerHook},[])
        ])
        this.bot=CE('div',{id:"bot",className:"horizontal bot panel"},this.botContent)

        this.main=CE('div',{id:"main",className:"app"},[
            this.menu,
            CE('div',{id:"mainInterface", className:"container"},[
                this.top,
                this.topSeptum,
                this.mid,
                this.botSeptum,
                this.bot
            ])
        ])

        this.setupOnWindow()
        this.channel.register("Data manager",new Accordion("Data manager",this,$(".vertical.left.content")))
        this.channel['Data manager'].toggle()
        this.channel['Data manager'].DOMelt.content.appendChild(
            CE('div',{},["test",CE('div',{id:"Gloubidi",style:{height:"300px"}},[])])
        )
        this.channel.register("mainMenu",new MainMenu(defaultMenu.mainMenu,"mainMenu",app,app.menu))
        this.channel.register("mainFlow",new Flow("mainFlow",app,app.topContent[0]))
        this.channel.register('teprou',new Node('teprou',[1,2,3],[6,4,2],app,this.channel.mainFlow))
        this.channel.register('tefar', new Node('tefar',[1],[],app,this.channel.mainFlow,{x:180,y:10}))
    }
    setupOnWindow(destination='body'){
        this.destination=destination;
        $(this.destination).appendChild(this.main);
        this.main.addEventListener('click',(e)=>{
            console.log(e.target,e.target.parentNode)
            if(e.target.handleClick){e.target.handleClick(e)}
        })
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
        const loaderElement=CE('input',{type:"file",onchange:(e)=>{readSingleFile(e,dataVessel)}},["Select a text file"])
        let rawPreview=CE('div',{style:{margin:"5px","border-radius":"5px",border:"1px solid white",padding:"5px"}},["Ici la prévisualisation des données brutes"])
        rawPreview.setAttribute("contenteditable","true")
        rawPreview.addEventListener('input',(e)=>{
            dataVessel.raw=e.target.textContent+dataVessel.raw.slice(prevLength)
            updatePreviews(dataVessel)
        })
        let procPreview=CE('div',{style:{margin:"5px","border-radius":"5px",border:"1px solid white",padding:"5px"}},["Ici la prévisualisation des données traitées"])
        const lineSeparator=CE('select',{oninput:(e)=>{updatePreviews(dataVessel)}},[
            CE('option',{value:"\r|\n|\r\n"},["auto/guess"]),
            CE('option',{value:"\r\n"},["CRLF"]),
            CE('option',{value:"\r"},["CR"]),
            CE('option',{value:"\n"},["LF"]),
        ])
        const colSeparator=CE('select',{oninput:(e)=>{updatePreviews(dataVessel)}},[
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
        window.visited=new Map()
        let appState=DC(this,window.visited)
        return window.savedState=appState
    }
    restoreAppState(savedState){
        document.body.lastChild.remove()
        savedState.setupOnWindow()
        window.Attributor=savedState
    }
}


export {App}
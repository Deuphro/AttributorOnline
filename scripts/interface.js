import {$,CE,stylize,fakeData} from "./util.js"
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm"
import defaultMenu from "./../resources/config.js"

console.log(defaultMenu)

class Channel{
    constructor(){
        this.eventTypes={}
    }
    register(name,caster){
        this[name]=caster
        if (!caster.events){
            if (!caster.events.broadcast){
                caster.events.broadcast={
                poppedUp:new CustomEvent("poppedUp",{detail:{msg:"I've just popped up",emitter:caster}}),
                killed:new CustomEvent("killed",{detail:{msg:"I've just been killed !!!",emitter:caster}})
                }
            }
        }
        caster.events.channelNickname=name
        const broadcasts=caster.events.broadcast
        Object.values(broadcasts).forEach((e)=>{
            window.addEventListener(e.type,this.defaultListener.bind(this))
            if (!this.eventTypes[e.type]){
                this.eventTypes[e.type]=[]
            }
        })
        if(!caster.events.listen){
        } else {
            const listeners=caster.events.listen
            Object.keys(listeners).forEach((e)=>{
                if (!this.eventTypes[e]){
                    this.eventTypes[e]=[]
                }
                this.eventTypes[e].push(name)
        })
        }
        dispatchEvent(broadcasts.poppedUp)
    }
    degister(caster){
    }
    defaultListener(e){
        const event=e
        const et=e.type
        this.eventTypes[e.type].forEach((targetName)=>{
            this[targetName].events.listen[et](e)
            })
    }
}



class Plot2D{
    constructor(traces,origin,destination){
        self=this
        this.traces=traces
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
            virtualIndex:{top:0,left:0},
            styles:{
                tables:{
                    "border-spacing":'1px',
                    width:"max-content",
                    "border-collapse":"separate",
                    "text-overflow":"clip",
                },
                cells:{
                    "text-align": "center",
                    width:"50px",
                    height:"20px",
                },
                lines:{},
                hRuler:{
                    table:{
                        "border-spacing":'1px',
                        width:"max-content",
                        "border-collapse":"separate",
                        "text-overflow":"clip",
                        "border-bottom":"1px solid darkgrey",
                        "background-color":"darkgrey",
                        opacity:"0.5"
                    },
                    cells:{
                        "font-size":"12px",
                        "font-weight":"normal",
                        "background-color": "blanchedalmond",
                        "text-overflow":"clip",
                        "width":"50px",
                        "height":"20px",
                        cursor:"default",
                    },
                    lines:{
                        "border-bottom":"1px solid black"
                    }
                },
                vRuler:{
                    table:{
                        "border-spacing":'1px',
                        width:"max-content",
                        "border-collapse":"separate",
                        "text-overflow":"clip",
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
                        "text-overflow":"clip",
                    },
                    lines:{
                    }
                },
                bTable:{
                    table:{
                        "border-spacing":'1px',
                        width:"max-content",
                        "border-collapse":"separate",
                        "text-overflow":"clip",
                        cursor:"cell",
                        "margin-left":"-10px"
                    },
                    cells:{
                        "background-color":"rgba(245, 245, 220, 0.5)",
                        "width":"50px",
                        "height":"20px",
                        "opacity": "0.5",
                        "text-align": "center",
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
        this.hRuler.addEventListener('mousedown',(e)=>{
            e.preventDefault();
            let dx=e.clientX;
            document.onmousemove=(e)=>{
                e.preventDefault();
                dx-=e.clientX
                this.parameters.cellWidth=`${Math.max(5,parseInt(this.parameters.cellWidth))-dx}px`
                Object.values(this.DOMelt.getElementsByClassName("cell")).forEach((v)=>{v.style.width=this.parameters.cellWidth})
                this.DOMelt.getElementsByClassName("normal table")[0].style.left=this.parameters.cellWidth
                dx=e.clientX
            }
            document.onmouseup=(e)=>{
                e.preventDefault();
                document.onmouseup=null;
                document.onmousemove=null;
            }
        })
        this.container.addEventListener('scroll',()=>{this.onScroll()});
        this.resizeObserver=new ResizeObserver(()=>{this.onResize()});
        this.resizeObserver.observe(this.container);
    }
    set setData(arg){
        this.data=arg
        this.parameters.dataDimension={rows:Table.rowNum(arg),cols:Table.colNum(arg)}
    }
    onScroll(){//FIXER les effets de bord au post resize !!!
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
            display:"inline-block",
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
            "white-space":"nowrap",
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
        }
        let res=CE('table',{className:"table ruler horizontal",style:this.parameters.styles.hRuler.table},[CE('tr',{className:"horizontal title line",style:this.parameters.styles.hRuler.lines},titleLine),CE('tr',{className:"horizontal ruler line",style:this.parameters.styles.hRuler.lines},rulerLine)])
        stylize(res,{
            position:"sticky",
            top:"0px",
            left:`${leftGap}px`,
            "z-index":"4",
            "white-space":"normal",
            "word-wrap":"clip",
        })
        return res
    }
    bareTable(data){
        self=this
        let res=CE('table',{className:"table normal"},[]);
        let line=[];
        for(let k of data){
            line=[];
            k.forEach((v)=>{line.push(CE('td',{className:"normal cell",style:{width:this.parameters.cellWidth}},[v.toString()]))})
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
        this.events={
            broadcast:{
                poppedUp:new CustomEvent("poppedUp",{detail:{msg:"I've just popped up",emitter:dialog}}),
                killed:new CustomEvent("killed",{detail:{msg:"I've just been killed !!!",emitter:dialog}}),
                selected:new CustomEvent("selected",{detail:{msg:"I've just been selected !!!",emitter:dialog}})
            },
            listen:{
                selected(e){console.log("oupinez quelqu'un a été selectionné !!",e.detail.emitter==dialog)},
                killed(e){console.log("quelqu'un s'est fait tué !\n",e)}
            }
        }
        this.origin=origin;
        this.destination=destination;
        this.DOMelt={};
        this.DOMelt.dismisser=CE('div',{className:"dismisser"},[]);
        this.DOMelt.dismisser.onclick=this.suicide.bind(this);
        this.DOMelt.label=CE('div',{className:"label"},[title.toString()]);
        this.DOMelt.label.onmousedown=this.drag.bind(this);
        this.DOMelt.label.onclick=(e)=>{dispatchEvent(dialog.events.broadcast.selected)}
        this.DOMelt.handler=CE('div',{},[this.DOMelt.label,this.DOMelt.dismisser]);
        this.DOMelt.content=CE('div',{className:"popup content"},[]);
        this.DOMelt.window=CE('div',{className:"popup container"},[
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
            "border-radius":"10px",
            padding:"0em",
            overflow:"hidden"
        })
        stylize(this.DOMelt.label,{
            cursor:"move",
            padding:"0em",
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
        destination.appendChild(this.DOMelt.window);
        this.resizeObserver.observe(this.DOMelt.window);
    }
    suicide(){
        this.destination.removeChild(this.DOMelt.window)
        delete this.DOMelt
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
                    padding:"0px",
                    "grid-template-columns":"1em 1fr 1em",
                    "margin-bottom":"1px",
                }
            },
            content:{
                style:{
                    width:"100%",
                    border:"1px solid black",
                    padding:"0px",
                    transition:"30ms",
                    overflow:"hidden",
                    transition:"200ms"
                }
            }
        };
        this.DOMelt={
            folder:CE('div',{className:"accordion handler folder",
                onclick:(e)=>{accordion.toggle()}},[]),
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
                        $("#mainInterface").style["grid-template-rows"]=`0px 5px 3fr 5px ${app.parameters.botContent.height*(!app.parameters.botContent.folded)}px`
                    }else{
                        app.parameters.topContent.folded=false;
                        $("#mainInterface").style["grid-template-rows"]=`${app.parameters.topContent.height}px 5px 3fr 5px ${app.parameters.botContent.height*(!app.parameters.botContent.folded)}px`
                    }
                },
                height:100,
                set resizeHeight(v){
                    app.parameters.topContent.height=v
                    $("#mainInterface").style["grid-template-rows"]=`${v}px 5px 3fr 5px ${app.parameters.botContent.height*(!app.parameters.botContent.folded)}px`
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
                height:200,
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
                CE('button',{onclick:(e)=>{
                    app.channel.register("choco",new Dialog("A table test",app,app.main))
                    app.tata=new Table(fakeData(10),["A title","an other","a third"],app,app.channel["choco"].DOMelt.content)
                }},[" Please click here for a table test"]),
                CE('button',{onclick:(e)=>{
                    app.lat=new Dialog("A graph test",app,app.midCentralContent);
                    app.yoyo=new Plot2D([],app,app.lat.DOMelt.content)
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
                CE('div',{className:"vertical wrapper",onclick:()=>{this.parameters.leftContent.fold=(!this.parameters.leftContent.folded)}},[]),
                CE('div',{className:"vertical resizer",onmousedown:this.parameters.leftContent.resizerHook},[])
            ]),
            CE('div',{id:"center",className:"vertical center panel"},[
                this.midCentralContent
            ]),
            CE('div',{id:"rightSeptum", className:"right septum vertical"},[
                CE('div',{className:"vertical resizer",onmousedown:this.parameters.rightContent.resizerHook},[]),
                CE('div',{className:"vertical wrapper",onclick:()=>{this.parameters.rightContent.fold=(!this.parameters.rightContent.folded)}},[]),
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
        this.menu=CE('div',{id:"mainMenu",className:"menu"},["Main menu"])
        this.top=CE('div',{id:"top",className:"horizontal top panel"},this.topContent)
        this.topSeptum=CE('div',{id:"topSeptum",className:"top horizontal septum"},[
            CE('div',{className:"horizontal resizer",onmousedown:this.parameters.topContent.resizerHook},[]),
            CE('div',{className:"horizontal wrapper",onclick:()=>{this.parameters.topContent.fold=!this.parameters.topContent.folded;}},[]),
            CE('div',{className:"horizontal resizer",onmousedown:this.parameters.topContent.resizerHook},[])
        ])
        this.mid=CE('div',{id:"mid",className:"horizontal mid panel"},this.midContent)
        this.botSeptum=CE('div',{id:"botSeptum",className:"bot horizontal septum"},[
            CE('div',{className:"horizontal resizer",onmousedown:this.parameters.botContent.resizerHook},[]),
            CE('div',{className:"horizontal wrapper",onclick:()=>{this.parameters.botContent.fold=!this.parameters.botContent.folded;}},[]),
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

        this.target="body";
        $(this.target).appendChild(this.main);
        let dataManager= new Accordion("Data manager",this,$(".vertical.left.content"));
        let dataManager2= new Accordion("Data manager 2",this,$(".vertical.left.content"));
        dataManager.DOMelt.content.appendChild(
            CE('div',{},["test",CE('div',{id:"Gloubidi",style:{height:"300px"}},[])])
            
        )
        let grrrr=new Plot2D([],this,$("#Gloubidi"))
    }
}

export {App}
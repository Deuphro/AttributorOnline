import {$,CE,stylize} from "../util.js"

export class Table{
    constructor(data,title=null,origin,destination,options={}){
        this.drawn=false
        this.origin=origin;
        this.destination=destination;
        this.onTitleChange=(typeof options?.onTitleChange==="function")?options.onTitleChange:null
        this.parameters={
            mutable:{
                hRuler:options?.mutable?.hRuler??options?.mutable===true??false,
            },
            virtualIndex:{top:0,left:0},
            styles:{
                tables:{
                    "border-spacing":'1px',
                    width:"max-content",
                    "border-collapse":"separate"
                },
                cells:{
                    "text-align": "center",
                    width:"50px",
                    height:"20px"
                },
                lines:{},
                hRuler:{
                    table:{
                        "table-layout":"fixed",
                        "border-spacing":'2px 0px',
                        width:"min-content",
                        "border-collapse":"separate"
                    },
                    cells:{
                        "font-size":"12px",
                        "font-weight":"normal",
                        "width":"50px",
                        "height":"20px",
                        cursor:"auto"
                    },
                    lines:{}
                },
                vRuler:{
                    table:{
                        "table-layout":"fixed",
                        "border-spacing":'1px',
                        width:"max-content",
                        "border-collapse":"separate",
                        cursor:"default"
                    },
                    cells:{
                        "font-size":"12px",
                        "font-weight":"normal",
                        "width":"30px",
                        "height":"20px"
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
                        cursor:"cell",
                        "margin-left":"0px"
                    },
                    cells:{
                        "width":"50px",
                        "height":"20px",
                        "text-align": "center"
                    },
                    lines:{
                    }
                }
            }
        }
        this.setData=data
        this.title=Array.isArray(title)?[...title]:title
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
        this.resizeObserver=new ResizeObserver(()=>this.scheduleVirtualDraw())
        this.resizeObserver.observe(this.container)
    }
    set setData(arg){
        this.data=arg
        this.parameters.dataDimension={rows:Table.rowNum(arg),cols:Table.colNum(arg)}
    }
    setColumnLabel(columnIndex,value){
        if(!Number.isInteger(columnIndex)||columnIndex<0){
            return
        }
        if(!Array.isArray(this.title)){
            this.title=[]
        }
        while(this.title.length<=columnIndex){
            this.title.push("")
        }
        this.title[columnIndex]=value
        if(typeof this.onTitleChange==="function"){
            this.onTitleChange([...this.title],columnIndex,value)
        }
    }
    columnLabel(columnIndex){
        if(!Array.isArray(this.title)){
            return ""
        }
        return this.title[columnIndex]??""
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
        for(let k=0;k<this.virtualNbCols;k++){this.hRuler.children[0].children[k].textContent=(this.columnLabel(this.parameters.virtualIndex.left+k))}
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
    scheduleVirtualDraw(){
        if(this.virtualDrawScheduled){
            return
        }
        this.virtualDrawScheduled=true
        requestAnimationFrame(()=>{
            this.virtualDrawScheduled=false
            this.onResize()
        })
    }
    onResize(){
        if(!this.drawn||!this.container.isConnected){
            return
        }
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
            titleLine.push(CE('th',{className:"horizontal title cell",style:this.parameters.styles.hRuler.cells},[this.columnLabel(this.parameters.virtualIndex.left+k)]));
            rulerLine[k].style["cursor"]="col-resize"
            if(this.parameters.mutable.hRuler){
                titleLine[k].style["cursor"]="auto"
                titleLine[k].setAttribute("contenteditable","true")
                titleLine[k].pilot=this
                titleLine[k].handleInput=(e)=>{
                    const columnIndex=e.target.cellIndex+Number(e.target.pilot.parameters.virtualIndex.left||0)
                    e.target.pilot.setColumnLabel(columnIndex,e.target.textContent)
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
    dispose(){
        this.resizeObserver?.disconnect()
        this.container.remove()
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
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm"
import {CE} from "../util.js"

export class OrbiSpinner{
    constructor(width=30,height=15){
        let t=10000*Math.random()
        const r=Math.min(width,height)/5
        let container=CE('div',{style:{
            "background-color":"rgba(164, 173, 185, 0.3)",
            margin:"0px",
            display:"inline-block",
            border:"1px solid lightblue",
            "border-radius":`5px`,
            width:`${width}px`,
            height:`${height}px`,
            position:"relative"}},[])
        let svg=d3.select(container).append("svg")
            .attr("width","100%")
            .attr("height","100%")
        let c1=svg.append("circle")
            .attr("cx",10)
            .attr("cy",10)
            .attr("r",r)
            .attr('fill','tomato')
            .attr('stroke','rgb(110, 122, 138)')
        let c2=svg.append("circle")
            .attr("cx",10)
            .attr("cy",10)
            .attr("r",r)
            .attr('fill','#aef22e')
            .attr('stroke','DarkCyan')
        let c3=svg.append("circle")
            .attr("cx",10)
            .attr("cy",10)
            .attr("r",r)
            .attr('fill','purple')
            .attr('stroke','rgb(110, 122, 138)')
        const animLoop=()=>{
            c1
            .attr("cx",0.5*width+0.5*(width-r)*Math.cos(t/200))
            .attr("cy",0.5*height+(height/2-1.5*r)*Math.sin(t/10))
            .attr("r",1+r*Math.abs(Math.sin(t/20)))
            c2
            .attr("cx",0.5*width+0.5*(width-r)*Math.cos((t-10)/30))
            .attr("cy",0.5*height+(height/2-1.5*r)*Math.sin((t-10)/10))
            .attr("r",1+r*Math.abs(Math.sin(t/20)))
            c3
            .attr("cx",0.5*width+0.5*(width-r)*Math.cos((t-30)/60))
            .attr("cy",0.5*height+(height/2-1.5*r)*Math.sin((t-30)/10))
            .attr("r",1+r*Math.abs(Math.sin(t/20)))
            t++
            requestAnimationFrame(animLoop)
        }
        animLoop()
        return container
    }
}

export class CycloSpinner{
    constructor(size=20){
        let width=size
        let height=size
        let t=10000*Math.random()
        const r=Math.min(size/5,4)
        let c=0
        let container=CE('div',{style:{
            background:"radial-gradient(circle, rgba(164, 173, 185, 0.28) 0%, rgba(164, 173, 185, 0.12) 58%, transparent 100%)",
            margin:"0px",
            display:"inline-block",
            border:"none",
            "border-radius":"50%",
            width:`${width}px`,
            height:`${height}px`,
            position:"relative",
            overflow:"hidden"}},[])
        let svg=d3.select(container).append("svg")
            .attr("width","100%")
            .attr("height","100%")
        let c0=svg.append("circle")
            .attr("cx",width/2)
            .attr("cy",height/2)
            .attr("r",width/2-1)
            .attr('fill','rgba(164, 173, 185, 0.3)')
            .attr('stroke','lightblue')
        let c1=svg.append("circle")
            .attr("cx",10)
            .attr("cy",10)
            .attr("r",r)
            .attr('fill','tomato')
            .attr('stroke','rgb(110, 122, 138)')
        let c2=svg.append("circle")
            .attr("cx",10)
            .attr("cy",10)
            .attr("r",r)
            .attr('fill','#aef22e')
            .attr('stroke','DarkCyan')
        let c3=svg.append("circle")
            .attr("cx",10)
            .attr("cy",10)
            .attr("r",r)
            .attr('fill','purple')
            .attr('stroke','rgb(110, 122, 138)')
        const animLoop=()=>{
            const c=(phi)=>0.9*Math.abs(Math.sin((t+phi)/200))**1.5
            c1
            .attr("cx",0.5*width+0.5*c(-50)*(width-r)*Math.cos(t/20))
            .attr("cy",0.5*height+0.5*c(-50)*(height-r)*Math.sin(t/20))
            //.attr("r",1+r*Math.abs(Math.sin(t/100)))
            c2
            .attr("cx",0.5*width+0.5*c(-100)*(width-r)*Math.cos((1.5*t)/20))
            .attr("cy",0.5*height+0.5*c(-100)*(height-r)*Math.sin((1.5*t)/20))
            //.attr("r",1+r*Math.abs(Math.sin(t/100)))
            c3
            .attr("cx",0.5*width+0.5*c(-150)*(width-r)*Math.cos((1.25*t)/20))
            .attr("cy",0.5*height+0.5*c(-150)*(height-r)*Math.sin((1.25*t)/20))
            //.attr("r",1+r*Math.abs(Math.sin(t/100)))
            t++
            requestAnimationFrame(animLoop)
        }
        animLoop()
        return container
    }
}


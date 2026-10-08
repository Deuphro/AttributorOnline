/* =====================================================================
    "Sandwich" plotting architecture — BACK layer
    ---------------------------------------------------------------------
    This module is the pure WebGL half of the sandwich. It owns a single
    Three.js renderer/scene/camera and renders every trace with two draw
    calls (one gl.POINTS batch + one gl.LINES batch).

    Contract with the CPU:
      • the CPU only builds layout metadata (flat Float32Array, camera
        bounds, viewport size) once per data change;
      • the GPU does the pixel mapping, so a resize is only a matrix
        transform (no buffer reallocation, no per-point loop);
      • every array is a flat typed array, ready to be produced by an
        upstream Rust/Wasm worker without a JS detour.

    It deliberately has no dependency on interface.js / d3, so importing
    three.js here can never create a module cycle.
   ===================================================================== */

import * as THREE from "https://unpkg.com/three@0.160.1/build/three.module.js"
//the CPU hit-testing index. Pure, no d3 and no DOM either (see the header
//of the file): plot2d-gl.js stays importable from a worker, and the pick
//arithmetic is unit tested without a GL context.
import {
    PointGrid,
    affineFromBounds,
    scanNearest,
    PICK_SCAN_THRESHOLD
} from "./plot2d-hit.js"

//the single CDN endpoint used for the whole engine (import-map friendly)
export const THREE_CDN="https://unpkg.com/three@0.160.1/build/three.module.js"

//shape ids are shared verbatim with the fragment shader switch
export const MARKER_SHAPES={
    circle:0,
    square:1,
    diamond:2,
    "triangle-up":3,
    "triangle-down":4,
    cross:5,
    plus:6
}

export function shapeId(shape){
    const id=MARKER_SHAPES[shape]
    return id===undefined?MARKER_SHAPES.circle:id
}

/* ---------------------------------------------------------------------
    CSS colour dictionary
    A plain JS lookup table + a memo cache: no DOM injection, no
    getComputedStyle, no layout computation inside the upload loop.
   --------------------------------------------------------------------- */

const COLOR_FALLBACK="#ff0000"
const COLOR_CACHE=new Map()

const NAMED_COLORS={
    transparent:"#00000000",
    black:"#000000",silver:"#c0c0c0",gray:"#808080",grey:"#808080",white:"#ffffff",
    maroon:"#800000",red:"#ff0000",purple:"#800080",fuchsia:"#ff00ff",magenta:"#ff00ff",
    green:"#008000",lime:"#00ff00",olive:"#808000",yellow:"#ffff00",navy:"#000080",
    blue:"#0000ff",teal:"#008080",aqua:"#00ffff",cyan:"#00ffff",orange:"#ffa500",
    tomato:"#ff6347",orangered:"#ff4500",crimson:"#dc143c",firebrick:"#b22222",
    darkred:"#8b0000",salmon:"#fa8072",lightsalmon:"#ffa07a",darksalmon:"#e9967a",
    hotpink:"#ff69b4",pink:"#ffc0cb",plum:"#dda0dd",orchid:"#da70d6",violet:"#ee82ee",
    indigo:"#4b0082",blueviolet:"#8a2be2",darkviolet:"#9400d3",darkorchid:"#9932cc",
    mediumorchid:"#ba55d3",mediumpurple:"#9370db",slateblue:"#6a5acd",darkslateblue:"#483d8b",
    steelblue:"#4682b4",skyblue:"#87ceeb",lightblue:"#add8e6",lightskyblue:"#87cefa",
    royalblue:"#4169e1",dodgerblue:"#1e90ff",cornflowerblue:"#6495ed",deepskyblue:"#00bfff",
    midnightblue:"#191970",darkblue:"#00008b",cadetblue:"#5f9ea0",darkcyan:"#008b8b",
    darkturquoise:"#00ced1",turquoise:"#40e0d0",aquamarine:"#7fffd4",powderblue:"#b0e0e6",
    darkslategray:"#2f4f4f",darkslategrey:"#2f4f4f",dimgray:"#696969",dimgrey:"#696969",
    slategray:"#708090",slategrey:"#708090",lightslategray:"#778899",lightgray:"#d3d3d3",
    lightgrey:"#d3d3d3",whitesmoke:"#f5f5f5",ghostwhite:"#f8f8ff",lavender:"#e6e6fa",
    sienna:"#a0522d",saddlebrown:"#8b4513",brown:"#a52a2a",chocolate:"#d2691e",
    peru:"#cd853f",tan:"#d2b48c",khaki:"#f0e68c",beige:"#f5f5dc",ivory:"#fffff0",
    gold:"#ffd700",goldenrod:"#daa520",darkgoldenrod:"#b8860b",darkorange:"#ff8c00",
    forestgreen:"#228b22",darkgreen:"#006400",seagreen:"#2e8b57",mediumseagreen:"#3cb371",
    limegreen:"#32cd32",olivedrab:"#6b8e23",yellowgreen:"#9acd32",springgreen:"#00ff7f",
    mediumspringgreen:"#00fa9a",chartreuse:"#7fff00",lawngreen:"#7cfc00",mediumaquamarine:"#66cdaa",
    coral:"#ff7f50",wheat:"#f5deb3",navajowhite:"#ffdead",lightsteelblue:"#b0c4de",
    lightcyan:"#e0ffff",papayawhip:"#ffefd5",mistyrose:"#ffe4e1"
}

function clamp01(value){
    if(!(value>=0)) return 0
    return value>1?1:value
}

function hexToColor(hex){
    const text=hex.startsWith("#")?hex.slice(1):hex
    let r=0,g=0,b=0,a=1
    if(text.length===3||text.length===4){
        r=parseInt(text[0]+text[0],16)
        g=parseInt(text[1]+text[1],16)
        b=parseInt(text[2]+text[2],16)
        if(text.length===4) a=parseInt(text[3]+text[3],16)/255
    }else if(text.length===6||text.length===8){
        r=parseInt(text.slice(0,2),16)
        g=parseInt(text.slice(2,4),16)
        b=parseInt(text.slice(4,6),16)
        if(text.length===8) a=parseInt(text.slice(6,8),16)/255
    }else{
        return null
    }
    if(!Number.isFinite(r)||!Number.isFinite(g)||!Number.isFinite(b)) return null
    return [r/255,g/255,b/255,Number.isFinite(a)?a:1]
}

function functionalToColor(text){
    const match=text.match(/^rgba?\(([^)]*)\)$/)
    if(!match) return null
    const parts=match[1].split(/[,/\s]+/).filter(part=>part.length>0)
    if(parts.length<3) return null
    const channel=(part)=>{
        if(part.endsWith("%")) return clamp01(parseFloat(part)/100)
        return clamp01(parseFloat(part)/255)
    }
    const r=channel(parts[0])
    const g=channel(parts[1])
    const b=channel(parts[2])
    if(!Number.isFinite(r)||!Number.isFinite(g)||!Number.isFinite(b)) return null
    if(parts[3]===undefined) return [r,g,b,1]
    const a=parts[3].endsWith("%")?clamp01(parseFloat(parts[3])/100):clamp01(parseFloat(parts[3]))
    return [r,g,b,Number.isFinite(a)?a:1]
}

//cache lookup first, parsing only on the first encounter of a colour
export function parseCssColor(value){
    const key=(value===undefined||value===null||value==="")?COLOR_FALLBACK:String(value).trim().toLowerCase()
    const cached=COLOR_CACHE.get(key)
    if(cached) return cached
    let color=null
    if(key.startsWith("#")) color=hexToColor(key)
    if(!color&&key.startsWith("rgb")) color=functionalToColor(key)
    if(!color&&NAMED_COLORS[key]) color=hexToColor(NAMED_COLORS[key])
    if(!color){
        console.warn(`Plot2DWebGL: unsupported colour "${key}", falling back to ${COLOR_FALLBACK}`)
        color=hexToColor(COLOR_FALLBACK)
    }
    COLOR_CACHE.set(key,color)
    return color
}

/* ---------------------------------------------------------------------
    Shaders
    Markers are point sprites: the sprite is a square of gl_PointSize
    device pixels and gl_PointCoord spans it in [0,1]², so c=gl_PointCoord*2-1
    addresses the marker inside a -1..1 box (1 unit => a marker of half
    extent `marker.size`, i.e. exactly the SVG marker extents).
    Every shape is an analytic mask (pixels outside are discarded) with a
    one device pixel feather derived from the sprite size: no derivative
    extension required, so it compiles on WebGL1 and WebGL2 alike.
   --------------------------------------------------------------------- */

const MARKER_VERTEX_SHADER=`
uniform float uPixelRatio;

attribute vec4 aColor;
attribute float aSize;
attribute float aShape;

varying vec4 vColor;
varying float vShape;
varying float vSize;

void main(){
    vColor=aColor;
    vShape=aShape;
    vSize=max(aSize*uPixelRatio,1.0);
    gl_PointSize=vSize;
    gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
}
`

const MARKER_FRAGMENT_SHADER=`
uniform float uOpacity;

varying vec4 vColor;
varying float vShape;
varying float vSize;

//signed area of the triangle (a,b,p): positive inside for the vertex
//order used below (the same winding as the SVG marker paths)
float halfPlane(vec2 p,vec2 a,vec2 b){
    return (b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x);
}

float triangleMask(vec2 c){
    float e0=halfPlane(c,vec2(-1.0,1.0),vec2(0.0,-1.0))/2.2360679;
    float e1=halfPlane(c,vec2(0.0,-1.0),vec2(1.0,1.0))/2.2360679;
    float e2=halfPlane(c,vec2(1.0,1.0),vec2(-1.0,1.0))/2.0;
    return min(min(e0,e1),e2);
}

float plusMask(vec2 c){
    vec2 a=abs(c);
    float bar=0.28;
    float horizontal=min(1.0-a.x,bar-a.y);
    float vertical=min(bar-a.x,1.0-a.y);
    return max(horizontal,vertical);
}

void main(){
    vec2 c=gl_PointCoord*2.0-1.0;
    float mask;
    if(vShape<0.5){
        mask=1.0-length(c);                                    //circle
    }else if(vShape<1.5){
        mask=min(1.0-abs(c.x),1.0-abs(c.y));                   //square
    }else if(vShape<2.5){
        mask=1.0-(abs(c.x)+abs(c.y));                          //diamond
    }else if(vShape<3.5){
        mask=triangleMask(c);                                  //triangle-up
    }else if(vShape<4.5){
        mask=triangleMask(vec2(c.x,-c.y));                     //triangle-down
    }else if(vShape<5.5){
        mask=plusMask(vec2(c.x+c.y,c.y-c.x)*0.70710678);       //cross
    }else{
        mask=plusMask(c);                                      //plus
    }
    if(mask<0.0) discard;
    //one device pixel of feather, expressed in sprite space
    float feather=2.0/max(vSize,2.0);
    float alpha=mask/feather;
    if(alpha<=0.0) discard;
    if(alpha>1.0) alpha=1.0;
    gl_FragColor=vec4(vColor.rgb,uOpacity*vColor.a*alpha);
}
`

/* ---------------------------------------------------------------------
    GLTraceLayer — persistent singleton WebGL subsystem
   --------------------------------------------------------------------- */

export class GLTraceLayer{
    constructor(canvas,{opacity=0.7,pixelRatioCap=2,depth=2000}={}){
        this.canvas=canvas
        this.pixelRatioCap=Math.max(1,pixelRatioCap)
        this.pixelRatio=1
        this.width=0
        this.height=0
        this.renderer=new THREE.WebGLRenderer({
            canvas,
            antialias:true,
            alpha:true,
            powerPreference:"high-performance"
        })
        this.renderer.setClearColor(0x000000,0)
        this.renderer.autoClear=true
        //trace colours are CSS (sRGB) values: they must reach the framebuffer
        //verbatim, exactly like the SVG layer, instead of being re-encoded
        //from linear space by the built-in materials
        this.renderer.outputColorSpace=THREE.LinearSRGBColorSpace
        this.scene=new THREE.Scene()
        //3D ready: the orthographic box is deep enough to host future Z data
        this.camera=new THREE.OrthographicCamera(-1,1,1,-1,depth/2,depth*2)
        this.camera.position.set(0,0,depth)
        this.camera.updateProjectionMatrix()
        //marker material: per vertex colour/size/shape, shape is resolved in GLSL
        this.markerMaterial=new THREE.ShaderMaterial({
            uniforms:{
                uOpacity:{value:opacity},
                uPixelRatio:{value:1}
            },
            vertexShader:MARKER_VERTEX_SHADER,
            fragmentShader:MARKER_FRAGMENT_SHADER,
            transparent:true,
            opacity:opacity,
            depthTest:false,
            depthWrite:false
        })
        //line material: RGBA vertex colours, one shared batch for every trace
        this.lineMaterial=new THREE.LineBasicMaterial({
            vertexColors:true,
            transparent:true,
            opacity:opacity,
            depthTest:false,
            depthWrite:false
        })
        this.pointGeometry=new THREE.BufferGeometry()
        this.lineGeometry=new THREE.BufferGeometry()
        this.buffers={
            positions:new Float32Array(0),
            colors:new Float32Array(0),
            sizes:new Float32Array(0),
            shapes:new Float32Array(0),
            linePositions:new Float32Array(0),
            lineColors:new Float32Array(0)
        }
        this.capacity={points:0,segments:0}
        this.pointCount=0
        this.segmentCount=0
        //origin subtracted from the uploaded vertices (see upload)
        this.reference={x:0,y:0}
        this.points=new THREE.Points(this.pointGeometry,this.markerMaterial)
        //buffers are grown and partially drawn: rely on the draw range only
        this.points.frustumCulled=false
        this.points.renderOrder=1
        this.lines=new THREE.LineSegments(this.lineGeometry,this.lineMaterial)
        this.lines.frustumCulled=false
        this.lines.renderOrder=0
        this.scene.add(this.lines,this.points)
        this.onContextRestored=null
        //hover/pick state: built on demand, dropped by every upload (the
        //point indices it holds are the indices of the CURRENT buffers)
        this.pickMode="off"
        this.pickGrid=null
        this.pickTraceStarts=null
        this.pickTraceRefs=null
        this.pickCoordsU=null
        this.pickCoordsV=null
        this.lastUpload=null
        canvas.addEventListener("webglcontextlost",(event)=>event.preventDefault(),false)
        canvas.addEventListener("webglcontextrestored",()=>this.onContextRestored?.(),false)
    }

    get opacity(){
        return this.markerMaterial.uniforms.uOpacity.value
    }

    setOpacity(value){
        const alpha=Number.isFinite(value)?value:0.7
        this.markerMaterial.uniforms.uOpacity.value=alpha
        this.markerMaterial.opacity=alpha
        this.lineMaterial.opacity=alpha
    }

    //viewport changes never touch the buffers: only the GL size and the
    //device pixel ratio are refreshed
    setViewport(width,height){
        const w=Math.max(1,Math.round(width))
        const h=Math.max(1,Math.round(height))
        this.width=w
        this.height=h
        const ratio=Math.min(window.devicePixelRatio||1,this.pixelRatioCap)
        if(ratio!==this.pixelRatio){
            this.pixelRatio=ratio
            this.renderer.setPixelRatio(ratio)
            this.markerMaterial.uniforms.uPixelRatio.value=ratio
        }
        this.renderer.setSize(w,h,false)
        //the CSS box is owned by the caller (it must match the graphzone)
        this.canvas.style.width=`${w}px`
        this.canvas.style.height=`${h}px`
    }

    //camera bounds are expressed in the uploaded (axis-transformed) space
    setBounds({left,right,top,bottom}){
        if(!Number.isFinite(left)||!Number.isFinite(right)||!Number.isFinite(top)||!Number.isFinite(bottom)) return false
        if(!(right>left)||!(top>bottom)) return false
        const camera=this.camera
        if(camera.left===left&&camera.right===right&&camera.top===top&&camera.bottom===bottom) return true
        camera.left=left
        camera.right=right
        camera.top=top
        camera.bottom=bottom
        camera.updateProjectionMatrix()
        return true
    }

    render(){
        this.renderer.render(this.scene,this.camera)
    }

    getStats(){
        return {
            points:this.pointCount,
            segments:this.segmentCount,
            pointCapacity:this.capacity.points,
            segmentCapacity:this.capacity.segments,
            pixelRatio:this.pixelRatio,
            pick:this.pickMode,
            pickPoints:this.pickGrid?this.pickGrid.count:(this.pickCoordsU?this.pickCoordsU.length:0),
            pickBytes:this.pickGrid
                ?this.pickGrid.memoryBytes()
                :(this.pickCoordsU?(this.pickCoordsU.byteLength+this.pickCoordsV.byteLength):0)
        }
    }

    /* ---------------------------------------------------------------
       Hit testing. The index is LAZY on purpose: it is built on the
       first hover, not on every upload. A dataset can be re-uploaded
       many times while a worker fills it, and a plot nobody hovers must
       never pay for an index it will not read.

       The grid is expressed in the uploaded frame, so a pan or a zoom
       only changes the projection below — the index itself survives,
       which is the whole point of indexing data space and not the
       visible window (see the header of plot2d-hit.js).
       ---------------------------------------------------------------- */

    //the point indices the index holds are the indices of the CURRENT
    //vertex buffer: any upload invalidates them, and only an upload does
    invalidatePickIndex(){
        this.pickMode="off"
        this.pickGrid=null
        this.pickTraceStarts=null
        this.pickTraceRefs=null
        this.pickCoordsU=null
        this.pickCoordsV=null
    }

    /* Walks the pickable points of the last upload exactly like _collect
       does — same filter, same log transform, same reference origin, same
       numbering — and hands them to the grid, which buckets them itself.
       ONE walk over the flat arrays, on BOTH paths: no per point object,
       no comparison sort, no allocation beyond the typed arrays.

       The walk also checks the invariant the whole hover rests on: the
       index the grid stores must be the index the VERTEX BUFFER has at
       the same place, because pick() reads the coordinates back out of
       positions[pointIndex*3]. A trace drawn as a line has as many pickable
       points as vertices, but a trace with markers=False and a broken
       polyline could shift the numbering, and a hover that silently names
       the wrong point is worse than no hover at all. */
    buildPickIndex(){
        const upload=this.lastUpload
        if(!upload) return null
        const descriptors=upload.descriptors
        const config=upload.config
        const starts=[]
        //ordinal (among the pickable traces) -> position in `descriptors`.
        //The caller owns `descriptors`, so it is the only one that can turn a
        //pickable ordinal back into a trace: it must be handed this mapping
        const refs=[]
        let total=0
        for(let t=0;t<descriptors.length;t++){
            if(!descriptors[t].pickable) continue
            refs.push(t)
            starts.push(total)
            total+=descriptors[t].count
        }
        starts.push(total)
        if(!(total>0)) return null
        this.pickTraceStarts=Uint32Array.from(starts)
        this.pickTraceRefs=Uint32Array.from(refs)
        /* The two coordinate planes of the PICKABLE points, filled by the
           single walk below. They are the measure of truth for BOTH paths:
           the grid adopts them, the scan reads them. Reading them back from
           the vertex buffer would be wrong — that buffer only holds the
           MARKER points, while a line's vertices live in linePositions. */
        const coordsU=new Float64Array(total)
        const coordsV=new Float64Array(total)
        let parked=0
        this._visitPickable(descriptors,config,(u,v)=>{
            coordsU[parked]=u
            coordsV[parked]=v
            parked++
        })
        //the walk and _collect must have agreed on how many points there
        //are; if they did not, every index past this point would be wrong
        if(parked!==total){
            console.warn(`Plot2DWebGL: the pick walk saw ${parked} points where ${total} were expected; hover is disabled`)
            this.invalidatePickIndex()
            return null
        }
        if(total<=PICK_SCAN_THRESHOLD){
            //too few points to fragment: a plain scan over the same two
            //planes answers exactly what the grid would
            this.pickCoordsU=coordsU
            this.pickCoordsV=coordsV
            this.pickMode="scan"
            return null
        }
        //the grid ADOPTS the two planes instead of copying them: the scan
        //path keeps them alive, the grid path hands them over, and in both
        //cases there is exactly one copy of the coordinates in the process
        const grid=new PointGrid()
        grid.seal(total,starts,coordsU,coordsV)
        this.pickGrid=grid
        this.pickMode="grid"
        return grid
    }

    //one callback per PICKABLE point (a marker, or any vertex of a drawn
    //line/stick), in the very order _collect numbers them
    _visitPickable(descriptors,config,visit){
        const logX=config.logX
        const logY=config.logY
        const referenceX=config.referenceX
        const referenceY=config.referenceY
        for(let t=0;t<descriptors.length;t++){
            const trace=descriptors[t]
            if(!trace.pickable) continue
            const buffer=trace.buffer
            const yBuffer=trace.yBuffer
            const pairs=trace.pairs
            const count=trace.count|0
            for(let i=0;i<count;i++){
                let x
                let y
                if(buffer!==null&&buffer!==undefined&&yBuffer!==null&&yBuffer!==undefined){
                    x=buffer[i]
                    y=yBuffer[i]
                }else{
                    const pair=pairs?pairs[i]:null
                    if(!pair) continue
                    x=pair[0]
                    y=pair[1]
                }
                //the very filter of _collect: an indexed point must be a
                //drawn point, or the hover would answer about a vertex
                //that never reached the framebuffer
                if(!Number.isFinite(x)||!Number.isFinite(y)) continue
                if(logX&&!(x>0)) continue
                if(logY&&!(y>0)) continue
                visit(
                    (logX?Math.log10(x):x)-referenceX,
                    (logY?Math.log10(y):y)-referenceY
                )
            }
        }
    }

    /* Returns {traceIndex, tracePoint, distance, px, py} or null.
       `traceIndex` is the position in the descriptor list passed to
       upload() — which is what the caller indexed its traces by — and
       `tracePoint` is the index INSIDE that trace, the number a reader
       expects to see. `px`/`py` is where the point landed on screen: the
       marker belongs ON the point, not under a cursor a few pixels off. */
    pick(px,py,radiusPx){
        if(!this.lastUpload) return null
        const projection=affineFromBounds(this.camera,this.width,this.height)
        if(!projection.sx||!projection.sy) return null
        if(this.pickMode==="off") this.buildPickIndex()
        let hit=null
        if(this.pickMode==="grid"&&this.pickGrid){
            hit=this.pickGrid.nearest(px,py,projection,radiusPx)
        }else if(this.pickMode==="scan"&&this.pickCoordsU){
            const index=scanNearest(
                this.pickCoordsU,this.pickCoordsV,this.pickCoordsU.length,
                px,py,projection,radiusPx
            )
            if(index>=0) hit={pointIndex:index,distance:null}
        }
        if(!hit) return null
        const ordinal=this.pickTraceIndexOf(hit.pointIndex)
        if(ordinal<0) return null
        const descriptorIndex=this.pickTraceRefs?this.pickTraceRefs[ordinal]:ordinal
        //the point's own pixel position, from whichever plane holds it
        const u=this.pickMode==="grid"&&this.pickGrid?hit.u:this.pickCoordsU[hit.pointIndex]
        const v=this.pickMode==="grid"&&this.pickGrid?hit.v:this.pickCoordsV[hit.pointIndex]
        return {
            traceIndex:descriptorIndex,
            tracePoint:hit.pointIndex-this.pickTraceStarts[ordinal],
            distance:hit.distance??null,
            px:projection.u0+u*projection.sx,
            py:projection.v0+v*projection.sy
        }
    }

    //the pickable ordinal a global point index belongs to
    pickTraceIndexOf(pointIndex){
        const starts=this.pickTraceStarts
        if(!starts||!(starts.length>1)) return -1
        let low=0
        let high=starts.length-2
        let found=-1
        while(low<=high){
            const middle=(low+high)>>1
            if(starts[middle]<=pointIndex){
                found=middle
                low=middle+1
            }else{
                high=middle-1
            }
        }
        return found
    }

    /* ---------------------------------------------------------------
       GPU buffer pipeline
       descriptors: one entry per visible trace (metadata only)
       config: {logX, logY, stickBase}
       Pass 1 measures the finite vertices, pass 2 fills the flat
       arrays. The buffers are persistent and only ever grow (1.5x), so
       re-uploading the same dataset allocates nothing at all.
      ---------------------------------------------------------------- */
    upload(descriptors,{logX=false,logY=false,stickBase=0,referenceX=0,referenceY=0}={}){
        //the reference origin is subtracted from every vertex, and from the
        //camera bounds (see Plot2DWebGL.refreshCamera): the magnitudes that
        //reach the float32 pipeline stay small (the span of the data instead
        //of its absolute position), which is what preserves the precision of a
        //float64 source (timestamps, large abscissas, deep zooms). It is a
        //pure translation: the pixel mapping is strictly identical.
        const config={
            logX,
            logY,
            stickBase,
            referenceX:Number.isFinite(referenceX)?referenceX:0,
            referenceY:Number.isFinite(referenceY)?referenceY:0
        }
        this.reference={x:config.referenceX,y:config.referenceY}
        //the vertex buffer is about to be rewritten: every point index the
        //hover index holds becomes meaningless, so it is dropped HERE and
        //only here. A pan, a zoom or a resize go through setBounds and
        // leave it alone.
        this.invalidatePickIndex()
        this.lastUpload={descriptors,config}
        //measurement pass: counts vertices/segments without touching the buffers.
        //It does not need the Float32 cast, but it uses the same (now 4-arg)
        //signature for consistency: pass descriptors as both sources and meta.
        const measured=this._collect(descriptors,descriptors,config,false)
        const grew=this._ensureCapacity(measured.pointCount,measured.segmentCount)
        //one explicit cast per source buffer, not per vertex. The inner loop
        //reads from the typed result[] so it never pays Float64->Float32 per
        //element AND it never allocates a temporary array per trace.
        const sources=this._castBuffers(descriptors)
        const written=this._collect(sources,descriptors,config,true)
        if(grew) this._bindAttributes()
        else this._flagAttributes()
        this.pointCount=written.pointCount
        this.segmentCount=written.segmentCount
        //only the used range is submitted to the GPU
        this.pointGeometry.setDrawRange(0,this.pointCount)
        this.lineGeometry.setDrawRange(0,this.segmentCount*2)
        return written
    }

    //pre-allocation: grow in one shot instead of reallocating per frame
    _ensureCapacity(pointCount,segmentCount){
        const points=Math.max(pointCount,this.capacity.points)
        const segments=Math.max(segmentCount,this.capacity.segments)
        if(points===this.capacity.points&&segments===this.capacity.segments&&this.capacity.points>0){
            return false
        }
        this.capacity.points=Math.max(1024,Math.ceil(points*1.5))
        this.capacity.segments=Math.max(1024,Math.ceil(segments*1.5))
        const buffers=this.buffers
        buffers.positions=new Float32Array(this.capacity.points*3)
        buffers.colors=new Float32Array(this.capacity.points*4)
        buffers.sizes=new Float32Array(this.capacity.points)
        buffers.shapes=new Float32Array(this.capacity.points)
        buffers.linePositions=new Float32Array(this.capacity.segments*6)
        buffers.lineColors=new Float32Array(this.capacity.segments*8)
        return true
    }

    _bindAttributes(){
        const buffers=this.buffers
        this.pointGeometry.setAttribute("position",new THREE.BufferAttribute(buffers.positions,3))
        this.pointGeometry.setAttribute("aColor",new THREE.BufferAttribute(buffers.colors,4))
        this.pointGeometry.setAttribute("aSize",new THREE.BufferAttribute(buffers.sizes,1))
        this.pointGeometry.setAttribute("aShape",new THREE.BufferAttribute(buffers.shapes,1))
        this.lineGeometry.setAttribute("position",new THREE.BufferAttribute(buffers.linePositions,3))
        //an RGBA "color" attribute is required by vertexColors (itemSize 4 => USE_COLOR_ALPHA)
        this.lineGeometry.setAttribute("color",new THREE.BufferAttribute(buffers.lineColors,4))
    }

    _flagAttributes(){
        const pointAttributes=this.pointGeometry.attributes
        for(const name in pointAttributes) pointAttributes[name].needsUpdate=true
        const lineAttributes=this.lineGeometry.attributes
        for(const name in lineAttributes) lineAttributes[name].needsUpdate=true
    }

    /* ---------------------------------------------------------------\n       Float64 (wave.core) -> Float32 pipeline\n\n       wave.core is Float64Array; the GPU buffers are Float32Array. Writing\n       each vertex through Number(value) inside the inner loop would pay the\n       cast AND potentially allocate per trace. This method does one cast per\n       source buffer (Trace.buffer and Trace.pairs) and returns a new array of\n       descriptors whose buffers/pairs live in Float32Array. The rest of the\n       pipeline is untouched.\n\n       Precision notes:\n         - the significant digits of a Float32 are ~7; a float64 value like\n           1234567.89 becomes 1234568 in float32. For plotting this is never\n           visible (it is < 1 pixel at any reasonable zoom and the raster is\n           already point-sampled), and the float32 space is exactly the space\n           the GPU operates in, so no re-conversion happens.\n         - large coordinates are kept small by the reference origin (pure\n           translation), so the cast is on the SPAN, not on the absolute value;\n           that is what makes float64 timestamps / deep zooms safe.\n       --------------------------------------------------------------- */
    _castBuffers(descriptors){
        const out=descriptors.map(trace=>{
            const buffer=trace.buffer
            const yBuffer=trace.yBuffer
            const pairs=trace.pairs
            if(buffer && yBuffer){
                if(!(buffer instanceof Float32Array)){
                    //explicit Float64 -> Float32 (trace.buffer must be a typed
                    //array: Float32Array or Float64Array; anything else is left
                    //to the inner loop's Number())
                    if(!(buffer instanceof Float64Array)){
                        return trace
                    }
                    const c=new Float32Array(buffer.length)
                    const cy=new Float32Array(yBuffer.length)
                    //one native copy per source buffer, no per-element JS calls
                    for(let i=0;i<buffer.length;i++) c[i]=buffer[i]
                    for(let i=0;i<yBuffer.length;i++) cy[i]=yBuffer[i]
                    return {...trace,buffer:c,yBuffer:cy}
                }
                return trace
            }
            if(pairs&&pairs.length){
                //pairs are [x,y] number pairs: cast them into a Float32Array
                //interleaved [x0,y0,x1,y1,...] so the inner loop can read from
                //a typed array again (and avoid per-vertex Number()).
                const c=new Float32Array(pairs.length*2)
                for(let i=0;i<pairs.length;i++){
                    const p=pairs[i]
                    if(p&&typeof p[0]==="number"&&typeof p[1]==="number"){
                        c[i*2]=p[0]
                        c[i*2+1]=p[1]
                    }
                }
                return {...trace,buffer:c,pairs:null}
            }
            return trace
        })
        return out
    }

    /* ---------------------------------------------------------------
       The only per-point loop of the whole engine: it is executed only
       when the data (or the axis transform) actually changed. `write`
       false measures the sizes, `write` true fills the flat arrays.

       `sources` is the cast version of `descriptors` returned by
       _castBuffers(): every trace.buffer / trace.pairs inside `sources` is a
       Float32Array (or null), so the inner loop reads typed values with no
       per-vertex Number() and no per-trace allocation.
       ---------------------------------------------------------------- */
    _collect(sources,descriptors,config,write){
        const buffers=this.buffers
        const positions=buffers.positions
        const colors=buffers.colors
        const sizes=buffers.sizes
        const shapes=buffers.shapes
        const linePositions=buffers.linePositions
        const lineColors=buffers.lineColors
        const logX=config.logX
        const logY=config.logY
        const referenceX=config.referenceX
        const referenceY=config.referenceY
        let pointIndex=0
        let segmentIndex=0
        for(let t=0;t<sources.length;t++){
            //sources carries the Float32-cast buffers/pairs; metadata (color,
            //mode, markers, lines, sticks) is identical between sources and
            //descriptors, so reading from sources is safe for both.
            const trace=sources[t]
            const buffer=trace.buffer
            const yBuffer=trace.yBuffer
            const pairs=trace.pairs
            const count=trace.count|0
            const withMarkers=trace.markers
            const withLines=trace.lines&&count>1
            /* Mode "segments": DISJOINT pairs — a,b,c,d draw a–b and c–d,
               never b–c, exactly like the SVG segmentPath. The partner is read
               straight from the source at i-1, so the polyline state of the
               lines mode can never leak in, and a dropped vertex drops its
               whole pair instead of shifting every pair after it. */
            const withSegments=trace.segments&&count>1
            //stickBase arrives already expressed in the uploaded (translated)
            //space, exactly like the vertices: see uploadTracesToGPU.
            const withSticks=trace.sticks&&Number.isFinite(config.stickBase)
            const color=trace.color
            const r=color[0]
            const g=color[1]
            const b=color[2]
            const a=color[3]
            const size=trace.size
            const shape=trace.shape
            let previousValid=false
            let previousX=0
            let previousY=0
            for(let i=0;i<count;i++){
                let x
                let y
                if(buffer!==null && yBuffer!==null && yBuffer!==undefined){
                    x=buffer[i]
                    y=yBuffer[i]
                }else{
                    const pair=pairs[i]
                    if(!pair){
                        previousValid=false
                        continue
                    }
                    x=pair[0]
                    y=pair[1]
                }
                //non finite pairs are dropped (the SVG version filters them out)
                if(!Number.isFinite(x)||!Number.isFinite(y)) continue
                //a coordinate that cannot be transformed breaks the polyline
                if(logX&&!(x>0)){ previousValid=false; continue }
                if(logY&&!(y>0)){ previousValid=false; continue }
                const px=(logX?Math.log10(x):x)-referenceX
                const py=(logY?Math.log10(y):y)-referenceY
                if(withLines&&previousValid){
                    if(write){
                        const lineOffset=segmentIndex*6
                        linePositions[lineOffset]=previousX
                        linePositions[lineOffset+1]=previousY
                        linePositions[lineOffset+2]=0
                        linePositions[lineOffset+3]=px
                        linePositions[lineOffset+4]=py
                        linePositions[lineOffset+5]=0
                        const lineColorOffset=segmentIndex*8
                        lineColors[lineColorOffset]=r
                        lineColors[lineColorOffset+1]=g
                        lineColors[lineColorOffset+2]=b
                        lineColors[lineColorOffset+3]=a
                        lineColors[lineColorOffset+4]=r
                        lineColors[lineColorOffset+5]=g
                        lineColors[lineColorOffset+6]=b
                        lineColors[lineColorOffset+7]=a
                    }
                    segmentIndex++
                }
                if(withSegments&&(i&1)===1){
                    //the partner of an odd vertex is the PREVIOUS source point
                    let x0
                    let y0
                    if(buffer!==null&&yBuffer!==null&&yBuffer!==undefined){
                        x0=buffer[i-1]
                        y0=yBuffer[i-1]
                    }else if(pairs){
                        const partner=pairs[i-1]
                        x0=partner?partner[0]:NaN
                        y0=partner?partner[1]:NaN
                    }
                    const valid=Number.isFinite(x0)&&Number.isFinite(y0)
                        &&(!logX||x0>0)&&(!logY||y0>0)
                    if(valid){
                        if(write){
                            const lineOffset=segmentIndex*6
                            linePositions[lineOffset]=(logX?Math.log10(x0):x0)-referenceX
                            linePositions[lineOffset+1]=(logY?Math.log10(y0):y0)-referenceY
                            linePositions[lineOffset+2]=0
                            linePositions[lineOffset+3]=px
                            linePositions[lineOffset+4]=py
                            linePositions[lineOffset+5]=0
                            const lineColorOffset=segmentIndex*8
                            lineColors[lineColorOffset]=r
                            lineColors[lineColorOffset+1]=g
                            lineColors[lineColorOffset+2]=b
                            lineColors[lineColorOffset+3]=a
                            lineColors[lineColorOffset+4]=r
                            lineColors[lineColorOffset+5]=g
                            lineColors[lineColorOffset+6]=b
                            lineColors[lineColorOffset+7]=a
                        }
                        segmentIndex++
                    }
                }
                if(withSticks){
                    if(write){
                        const lineOffset=segmentIndex*6
                        linePositions[lineOffset]=px
                        linePositions[lineOffset+1]=config.stickBase
                        linePositions[lineOffset+2]=0
                        linePositions[lineOffset+3]=px
                        linePositions[lineOffset+4]=py
                        linePositions[lineOffset+5]=0
                        const lineColorOffset=segmentIndex*8
                        lineColors[lineColorOffset]=r
                        lineColors[lineColorOffset+1]=g
                        lineColors[lineColorOffset+2]=b
                        lineColors[lineColorOffset+3]=a
                        lineColors[lineColorOffset+4]=r
                        lineColors[lineColorOffset+5]=g
                        lineColors[lineColorOffset+6]=b
                        lineColors[lineColorOffset+7]=a
                    }
                    segmentIndex++
                }
                if(withMarkers){
                    if(write){
                        const pointOffset=pointIndex*3
                        positions[pointOffset]=px
                        positions[pointOffset+1]=py
                        positions[pointOffset+2]=0
                        const pointColorOffset=pointIndex*4
                        colors[pointColorOffset]=r
                        colors[pointColorOffset+1]=g
                        colors[pointColorOffset+2]=b
                        colors[pointColorOffset+3]=a
                        sizes[pointIndex]=size
                        shapes[pointIndex]=shape
                    }
                    pointIndex++
                }
                previousX=px
                previousY=py
                previousValid=true
            }
        }
        return {pointCount:pointIndex,segmentCount:segmentIndex}
    }

    dispose(){
        try{
            this.scene.remove(this.points,this.lines)
            this.pointGeometry.dispose()
            this.lineGeometry.dispose()
            this.markerMaterial.dispose()
            this.lineMaterial.dispose()
            this.renderer.dispose()
            this.renderer.forceContextLoss()
        }catch(error){
            console.warn("Plot2DWebGL: error while releasing the WebGL layer",error)
        }
        this.invalidatePickIndex()
        this.lastUpload=null
        this.capacity={points:0,segments:0}
        this.pointCount=0
        this.segmentCount=0
        this.buffers.positions=new Float32Array(0)
        this.buffers.colors=new Float32Array(0)
        this.buffers.sizes=new Float32Array(0)
        this.buffers.shapes=new Float32Array(0)
        this.buffers.linePositions=new Float32Array(0)
        this.buffers.lineColors=new Float32Array(0)
    }
}

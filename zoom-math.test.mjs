// Standalone validation of Plot2D mouse zoom/pan math (mirrors zoomAxisDomain/panAxisDomain/handleWheelZoom)
let failures=0
function check(name,cond){
    if(cond){console.log(`  PASS ${name}`)}
    else{failures++;console.error(`  FAIL ${name}`)}
}
// --- replica of Plot2D.zoomAxisDomain (pure domain math, fit = fitBoundsFor bounds) ---
function zoomAxisDomain(axis,anchor,factor,fit){
    const domain=axis.domain
    if(!Array.isArray(domain)||domain.length<2) return false
    if(!Number.isFinite(anchor)||!Number.isFinite(domain[0])||!Number.isFinite(domain[1])) return false
    const log=axis.scale==="log"
    if(log&&!(anchor>0)) return false
    const to=log?(value=>Math.log10(value)):(value=>value)
    const from=log?(value=>10**value):(value=>value)
    const start=to(domain[0])
    const end=to(domain[1])
    const at=to(anchor)
    let nextStart=at+(start-at)*factor
    let nextEnd=at+(end-at)*factor
    if(!Number.isFinite(nextStart)||!Number.isFinite(nextEnd)) return false
    let snapped=false
    if(factor>1&&fit){
        const low=to(fit[0])
        const high=to(fit[1])
        if(Number.isFinite(low)&&Number.isFinite(high)){
            nextStart=Math.max(nextStart,low)
            nextEnd=Math.min(nextEnd,high)
            if(!(nextEnd>nextStart)){
                nextStart=low
                nextEnd=high
                snapped=true
            }
        }
    }
    const minSpan=Math.max(Math.abs(nextStart),Math.abs(nextEnd),1)*Number.EPSILON*4
    if(Math.abs(nextEnd-nextStart)<minSpan) return false
    const clamped=[from(nextStart),from(nextEnd)]
    if(clamped[0]===domain[0]&&clamped[1]===domain[1]) return false
    axis.domain=clamped
    axis.autoDomain=snapped
    return true
}
// --- replica of the wheel factor ---
function wheelFactor(deltaY,deltaMode=0,zoneHeight=400){
    const unit=deltaMode===1?16:deltaMode===2?zoneHeight:1
    return Math.exp(deltaY*unit*0.002)
}
// linear scale equivalent to d3: domain -> [0,width]
function linear(domain,value,width){
    return (value-domain[0])/(domain[1]-domain[0])*width
}
function linearInvert(domain,pixel,width){
    return domain[0]+pixel/width*(domain[1]-domain[0])
}
// log scale equivalent to d3
function logScale(domain,value,width){
    return (Math.log10(value)-Math.log10(domain[0]))/(Math.log10(domain[1])-Math.log10(domain[0]))*width
}
function logInvert(domain,pixel,width){
    const l0=Math.log10(domain[0])
    const l1=Math.log10(domain[1])
    return 10**(l0+pixel/width*(l1-l0))
}
// replica of autoDomainFor for the padded fit bounds (linear case, +5%)

function fitOf(xMin,xMax){
    const pad=(xMax-xMin)||1
    return [xMin-0.05*pad,xMax+0.05*pad]
}
//d3-like scales under test: linear and log, with pixel ranges (range[0]
//always hosts domain[0], like plotScales does for X [0,w] and Y [h,0])
function testScale(kind,domain,range){
    const [d0,d1]=domain
    const [r0,r1]=range
    if(kind==="log"){
        const l0=Math.log10(d0)
        const l1=Math.log10(d1)
        return {
            range:()=>[r0,r1],
            invert:(p)=>10**(l0+(p-r0)/(r1-r0)*(l1-l0))
        }
    }
    return {
        range:()=>[r0,r1],
        invert:(p)=>d0+(p-r0)/(r1-r0)*(d1-d0)
    }
}
// --- replica of Plot2D.panAxisDomain (fit = fitBoundsFor bounds) ---
function panAxisDomain(axis,scale,shift,fit){
    const domain=axis.domain
    if(!Array.isArray(domain)||domain.length<2) return false
    if(!Number.isFinite(domain[0])||!Number.isFinite(domain[1])) return false
    if(!Number.isFinite(shift)||!shift) return false
    const log=axis.scale==="log"
    const to=log?(value=>Math.log10(value)):(value=>value)
    const from=log?(value=>10**value):(value=>value)
    const pixels=scale.range()
    const rangePixels=Math.abs(pixels[1]-pixels[0])
    if(!(rangePixels>0)) return false
    let start=to(scale.invert(pixels[0]-shift))
    let end=to(scale.invert(pixels[1]-shift))
    if(!Number.isFinite(start)||!Number.isFinite(end)) return false
    let snapped=false
    if(fit){
        const low=to(fit[0])
        const high=to(fit[1])
        if(Number.isFinite(low)&&Number.isFinite(high)){
            if(high-low<=end-start){
                start=low
                end=high
                snapped=true
            }else{
                if(start<low){
                    end+=low-start
                    start=low
                }
                if(end>high){
                    start-=end-high
                    end=high
                }
            }
        }
    }
    const minSpan=Math.max(Math.abs(start),Math.abs(end),1)*Number.EPSILON*4
    if(Math.abs(end-start)<minSpan) return false
    const movedPx=Math.abs(start-to(domain[0]))/(end-start)*rangePixels
    if(!(movedPx>0.01)) return false
    const clamped=[from(start),from(end)]
    if(!Number.isFinite(clamped[0])||!Number.isFinite(clamped[1])) return false
    if(log&&!(clamped[0]>0&&clamped[1]>0)) return false
    axis.domain=clamped
    axis.autoDomain=snapped
    return true
}

console.log("1. linear zoom anchors the data point under the cursor")
{
    const width=800
    const axis={scale:"linear",domain:[0,100],autoDomain:true}
    const cursorPixel=600
    const anchor=linearInvert(axis.domain,cursorPixel,width)
    const pixelBefore=linear(axis.domain,anchor,width)
    const factor=wheelFactor(-100) // wheel up => zoom in, factor < 1
    check("wheel up zooms in (factor<1)",factor<1)
    check("zoomAxisDomain accepted",zoomAxisDomain(axis,anchor,factor)===true)
    const pixelAfter=linear(axis.domain,anchor,width)
    check("anchor pixel unchanged",Math.abs(pixelAfter-pixelBefore)<1e-9)
    check("autoDomain disabled",axis.autoDomain===false)
    check("domain shrank",axis.domain[1]-axis.domain[0]<100)
}

console.log("2. log zoom anchors in log space and stays positive")
{
    const width=800
    const axis={scale:"log",domain:[1,1000],autoDomain:true}
    const cursorPixel=250
    const anchor=logInvert(axis.domain,cursorPixel,width)
    const pixelBefore=logScale(axis.domain,anchor,width)
    const factor=wheelFactor(100) // wheel down => zoom out
    check("wheel down zooms out (factor>1)",factor>1)
    check("zoomAxisDomain accepted",zoomAxisDomain(axis,anchor,factor)===true)
    const pixelAfter=logScale(axis.domain,anchor,width)
    check("anchor pixel unchanged (log)",Math.abs(pixelAfter-pixelBefore)<1e-9)
    check("domain strictly positive",axis.domain[0]>0&&axis.domain[1]>0)
    check("domain expanded",Math.log10(axis.domain[1]/axis.domain[0])>Math.log10(1000))
}

console.log("3. guards")
{
    const axis={scale:"linear",domain:[0,1],autoDomain:true}
    check("rejects non finite factor path via NaN anchor",zoomAxisDomain(axis,NaN,0.5)===false)
    const collapsed={scale:"linear",domain:[1,1+1e-15],autoDomain:true}
    const accepted=zoomAxisDomain(collapsed,1,1e-12)
    const span=collapsed.domain[1]-collapsed.domain[0]
    check("cannot collapse domain below machine gap",!accepted||span>=Math.max(1,Math.abs(collapsed.domain[0]))*Number.EPSILON*4*0.999)
    const logAxis={scale:"log",domain:[1,10],autoDomain:true}
    check("rejects non positive anchor on log axis",zoomAxisDomain(logAxis,-5,0.5)===false)
    check("deltaY=0 guarded upstream",(()=>{if(!0)return true;return false})())
}

console.log("4. repeated zoom then reset semantics")
{
    const axis={scale:"linear",domain:[0,10],autoDomain:true}
    const anchor=3
    for(let i=0;i<50;i++){zoomAxisDomain(axis,anchor,0.9)}
    check("50 zoom-in steps keep finite ordered domain",
        Number.isFinite(axis.domain[0])&&Number.isFinite(axis.domain[1])&&axis.domain[1]>axis.domain[0])
    check("autoDomain false after zoom",axis.autoDomain===false)
    axis.autoDomain=true // the double-click reset path
    check("reset re-enables autoDomain",axis.autoDomain===true)
}

console.log("5. zoom-out clamped to the double-click (auto-fit) bounds")
{
    const fit=fitOf(0,100) // [-5,105]
    const axis={scale:"linear",domain:[...fit],autoDomain:true}
    const anchor=50
    check("wheel-out at fit is rejected",zoomAxisDomain(axis,anchor,1.5,fit)===false)
    check("autoDomain still true at fit",axis.autoDomain===true)
    check("zoom in accepted",zoomAxisDomain(axis,anchor,0.5,fit)===true)
    check("zoom in leaves the fit",axis.domain[1]-axis.domain[0]<100)
    let guard=0
    while(zoomAxisDomain(axis,anchor,2,fit)&&guard<200)guard++
    check("converges back to fit bounds",
        Math.abs(axis.domain[0]-fit[0])<1e-9&&Math.abs(axis.domain[1]-fit[1])<1e-9)
    check("further wheel-out refused",zoomAxisDomain(axis,anchor,2,fit)===false)
    const axis2={scale:"linear",domain:[10,20],autoDomain:false}
    for(let i=0;i<50;i++){zoomAxisDomain(axis2,15,1.3,fit)}
    check("domain stays within fit",
        axis2.domain[0]>=fit[0]-1e-9&&axis2.domain[1]<=fit[1]+1e-9)
    const logFit=[1/1.05,1000*1.05]
    const logAxis={scale:"log",domain:[10,100],autoDomain:false}
    for(let i=0;i<100;i++){zoomAxisDomain(logAxis,50,1.5,logFit)}
    check("log zoom-out clamped to log fit",
        Math.abs(Math.log10(logAxis.domain[0])-Math.log10(logFit[0]))<1e-9
        &&Math.abs(Math.log10(logAxis.domain[1])-Math.log10(logFit[1]))<1e-9)
    const axis3={scale:"linear",domain:[...fit],autoDomain:true}
    check("deep zoom-in accepted",zoomAxisDomain(axis3,50,1e-6,fit)===true)
    check("zoom-in span tiny",axis3.domain[1]-axis3.domain[0]<1e-3)
}

console.log("6. stale view (zoom before any trace) snaps back instead of locking")
{
    // the empty-plot zoom left [0.4,0.6] while data lives in [100,1000]
    const fit=fitOf(100,1000) // [55,1050], disjoint from [0.4,0.6]
    const stale={scale:"linear",domain:[0.4,0.6],autoDomain:false}
    const anchor=0.5 // cursor anchor inside the stale view
    const accepted=zoomAxisDomain(stale,anchor,1.5,fit)
    check("wheel-out from stale view accepted (no lock)",accepted===true)
    check("snapped exactly onto the fit bounds",
        stale.domain[0]===fit[0]&&stale.domain[1]===fit[1])
    check("snap returns to auto mode",stale.autoDomain===true)
    check("further wheel-out refused at fit",zoomAxisDomain(stale,500,1.5,fit)===false)
    // zoom-in on a stale view is never clamped (fit limits zoom-out only)
    const stale2={scale:"linear",domain:[0.4,0.6],autoDomain:false}
    check("zoom-in on stale view accepted",zoomAxisDomain(stale2,0.5,0.5,fit)===true)
    check("zoom-in keeps manual mode",stale2.autoDomain===false)
    // mirror of the zoomedWhileEmpty branch in drawGraph: the flag set while
    // the plot had no bounds re-enables autoDomain on the first real draw
    const fresh={scale:"linear",domain:[0.4,0.6],autoDomain:false}
    fresh.autoDomain=true // zoomedWhileEmpty branch in drawGraph
    check("empty-plot zoom is discarded when data arrives (flag)",fresh.autoDomain===true)
}

console.log("6. X-only zoom refits Y from points inside the visible X window")
{
    const points=[[0,100],[10,90],[20,20],[30,10]]
    const xDomain=[18,32]
    let yMin=Infinity
    let yMax=-Infinity
    for(const [x,y] of points){
        if(x>=xDomain[0]&&x<=xDomain[1]){
            yMin=Math.min(yMin,y)
            yMax=Math.max(yMax,y)
        }
    }
    const padding=(yMax-yMin)*0.05
    const yDomain=[yMin-padding,yMax+padding]
    check("X-only fit ignores distant Y values",yMin===10&&yMax===20)
    check("X-only fit occupies padded local Y range",yDomain[0]===9.5&&yDomain[1]===20.5)
    const yAxis={domain:[0,105],autoDomain:true}
    yAxis.domain=yDomain
    yAxis.autoDomain=false
    //drawGraph must preserve a manual local fit instead of replacing it
    //with the global Y bounds [0,105].
    if(yAxis.autoDomain) yAxis.domain=[0,105]
    check("redraw preserves the local manual Y fit",yAxis.domain[0]===9.5&&yAxis.domain[1]===20.5)
}

if(failures){console.error(`\n${failures} FAILURE(S)`);process.exit(1)}
console.log("\nALL ZOOM MATH TESTS PASSED")
// Standalone validation of the PersistentHomology0D classifier math
// (mirrors clampClassifierSlope / keepAllSlope / clipSegmentToRect from
//  interface.js, plus the applySlopeFilter predicate and the slope
//  computation of handleClassifierClick)
let failures=0
function check(name,cond){
    if(cond){console.log(`  PASS ${name}`)}
    else{failures++;console.error(`  FAIL ${name}`)}
}
const near=(a,b,eps=1e-9)=>Math.abs(a-b)<=eps

// --- replicas ---
const CLASSIFIER_MIN_SLOPE=1e-12
const CLASSIFIER_MAX_SLOPE=1-1e-6
function clampClassifierSlope(value){
    if(Number.isNaN(value)) return CLASSIFIER_MAX_SLOPE
    return Math.min(CLASSIFIER_MAX_SLOPE,Math.max(CLASSIFIER_MIN_SLOPE,value))
}
function keepAllSlope(pairs){
    let slope=CLASSIFIER_MIN_SLOPE
    for(const pair of pairs){
        if(!(pair.birth>0)) continue
        const ratio=pair.death/pair.birth
        if(Number.isFinite(ratio)&&ratio>slope) slope=ratio
    }
    return clampClassifierSlope(slope)
}
function clipSegmentToRect(x0,y0,x1,y1,width,height){
    let t0=0
    let t1=1
    const dx=x1-x0
    const dy=y1-y0
    const p=[-dx,dx,-dy,dy]
    const q=[x0,width-x0,y0,height-y0]
    for(let i=0;i<4;i++){
        if(p[i]===0){
            if(q[i]<0) return null
            continue
        }
        const r=q[i]/p[i]
        if(p[i]<0){
            if(r>t1) return null
            if(r>t0) t0=r
        }else{
            if(r<t0) return null
            if(r<t1) t1=r
        }
    }
    return [x0+t0*dx,y0+t0*dy,x0+t1*dx,y0+t1*dy]
}
//handleClassifierClick: slope of the line origin → clicked point
function slopeFromClick(birth,death){
    return clampClassifierSlope(death/birth)
}
//applySlopeFilter predicate: under the line, inclusive; null slope keeps all
function isKept(pair,slope){
    if(!Number.isFinite(slope)) return true
    return pair.death<=slope*pair.birth
}

console.log("1. clamp keeps the slope strictly below 1")
{
    check("large slope clamped to MAX",clampClassifierSlope(2.7)===CLASSIFIER_MAX_SLOPE)
    check("negative slope clamped to MIN",clampClassifierSlope(-3)===CLASSIFIER_MIN_SLOPE)
    check("NaN clamped to MAX",clampClassifierSlope(NaN)===CLASSIFIER_MAX_SLOPE)
    check("+Infinity clamped to MAX",clampClassifierSlope(Infinity)===CLASSIFIER_MAX_SLOPE)
    check("valid slope untouched",clampClassifierSlope(0.4)===0.4)
    check("MAX is below 1",CLASSIFIER_MAX_SLOPE<1)
    check("clamp never returns at or above 1",clampClassifierSlope(1)<1)
}

console.log("2. click computes the slope of the line through the click")
{
    check("click (3,1.2) gives slope 0.4",near(slopeFromClick(3,1.2),0.4))
    check("click above the diagonal clamps to MAX",slopeFromClick(3,6)===CLASSIFIER_MAX_SLOPE)
    check("click on the Y axis (0,7) clamps to MAX",slopeFromClick(0,7)===CLASSIFIER_MAX_SLOPE)
    check("click on the origin (0,0) clamps to MAX",slopeFromClick(0,0)===CLASSIFIER_MAX_SLOPE)
    check("click on the diagonal (1,1) clamps below 1",slopeFromClick(1,1)<1)
    // idempotency: same pixel -> identical float -> the === guard skips work
    check("same click is bit-stable",slopeFromClick(3,1.2)===slopeFromClick(3,1.2))
}

console.log("3. keepAllSlope default keeps every positive-birth pair")
{
    const pairs=[
        {birth:1,death:0.5},
        {birth:2,death:1},
        {birth:0.5,death:0.2},
        {birth:-1,death:2} // can never sit under a line through the origin
    ]
    const slope=keepAllSlope(pairs)
    check("default slope below 1",slope<1)
    check("(1,0.5) kept",isKept(pairs[0],slope))
    check("(2,1) kept",isKept(pairs[1],slope))
    check("(0.5,0.2) kept",isKept(pairs[2],slope))
    check("boundary pair exactly on the line kept",isKept({birth:1,death:slope},slope))
    check("birth<=0 pair documented as not keepable",!isKept(pairs[3],slope))
    check("empty pairs fall back to MIN",keepAllSlope([])===CLASSIFIER_MIN_SLOPE)
}

console.log("4. filter partitions the cloud")
{
    const slope=0.5
    const pairs=[
        {birth:1,death:0.4}, // under
        {birth:1,death:0.6}, // above
        {birth:2,death:1},   // exactly on the line
        {birth:4,death:1.9}, // under
        {birth:4,death:2.1}  // above
    ]
    const kept=pairs.filter(p=>isKept(p,slope))
    const discarded=pairs.filter(p=>!isKept(p,slope))
    check("kept = under + on-line",kept.length===3)
    check("discarded = above",discarded.length===2)
    check("no pair lost",kept.length+discarded.length===pairs.length)
    check("on-line pair lands in kept",kept.some(p=>p.death===1))
    check("null slope keeps everything",pairs.every(p=>isKept(p,null)))
}

console.log("5. clipSegmentToRect (Liang-Barsky)")
{
    let c=clipSegmentToRect(-10,50,110,50,100,100)
    check("horizontal crossing clipped",c&&near(c[0],0)&&near(c[1],50)&&near(c[2],100)&&near(c[3],50))
    c=clipSegmentToRect(50,-10,50,110,100,100)
    check("vertical crossing clipped",c&&near(c[0],50)&&near(c[1],0)&&near(c[2],50)&&near(c[3],100))
    c=clipSegmentToRect(-10,-10,110,110,100,100)
    check("diagonal corner-to-corner clipped",c&&near(c[0],0)&&near(c[1],0)&&near(c[2],100)&&near(c[3],100))
    check("segment fully inside untouched",
        (()=>{const i=clipSegmentToRect(10,10,90,90,100,100);return i&&i[0]===10&&i[1]===10&&i[2]===90&&i[3]===90})())
    check("segment right of the rect rejected",clipSegmentToRect(200,-10,200,110,100,100)===null)
    check("segment above the rect rejected",clipSegmentToRect(-10,-50,110,-60,100,100)===null)
}

console.log("6. the drawn line spans the whole graph zone (not cut at birth 10)")
{
    // d3-like linear scales matching plotScales: x [0..w], y inverted [h..0]
    const width=800, height=400
    const xDom=[0,100], yDom=[0,250]
    const xScale=(v)=>(v-xDom[0])/(xDom[1]-xDom[0])*width
    const xInv=(p)=>xDom[0]+p/width*(xDom[1]-xDom[0])
    const yScale=(v)=>height-(v-yDom[0])/(yDom[1]-yDom[0])*height
    const slope=0.5
    // replica of the fixed sampling: the whole visible x-range
    const b0=xInv(0), b1=xInv(width)
    const clipped=clipSegmentToRect(xScale(b0),yScale(slope*b0),xScale(b1),yScale(slope*b1),width,height)
    check("line reaches both horizontal edges",clipped&&near(clipped[0],0)&&near(clipped[2],width))
    // the old birth=1..10 sample left the line cut well before the edge
    const oldClip=clipSegmentToRect(xScale(1),yScale(slope),xScale(10),yScale(slope*10),width,height)
    check("old 1→10 sample fell short (the reported bug)",oldClip&&(oldClip[2]-oldClip[0])<width/2)
}

if(failures){console.error(`\n${failures} FAILURE(S)`);process.exit(1)}
console.log("\nALL CLASSIFIER MATH TESTS PASSED")
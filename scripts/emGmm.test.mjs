/* -------------------------------------------------------------------------
   Test — node scripts/emGmm.test.mjs

   L'EM/GMM du funnel doit répondre à une seule question utile : où est le
   nuage sain, celui qui reste collé à (0,0) quand l'abscisse est une erreur
   en ppm et l'ordonnée un δ. Les affirmations testées sont donc :

     1. deux gaussiennes nettement séparées sont retrouvées, avec leurs
        moyennes, et BIC choisit bien deux composantes ;
     2. quand un nuage dense entoure l'origine et qu'un second est loin, la
        composante la plus proche de l'origine est celle du nuage dense, et
        elle le contient réellement (majorité des points retrouvés) ;
     3. le résultat est déterministe : mêmes points, mêmes paramètres ;
     4. l'ellipse dessinée est bien à `radius` écarts-types (Mahalanobis).
   ------------------------------------------------------------------------- */
import {fitGmm2d,gaussianEllipse} from "./emGmm.js"

let passed=0
const failures=[]
const test=(name,fn)=>{
    try{ fn(); passed++; console.log(`  ok   ${name}`) }
    catch(e){ failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const ok=(value,msg)=>{ if(!value) throw new Error(msg??`expected a truthy value, got ${value}`) }
const close=(a,b,tolerance,msg)=>{
    if(!(Math.abs(a-b)<=tolerance)) throw new Error(`${msg??"values differ"}: ${a} vs ${b}`)
}

/* Générateur gaussien déterministe (Box-Muller), pour que le test ne
   dépende pas du hasard de la machine. */
function mulberry32(seed){
    let a=seed>>>0
    return function(){
        a=(a+0x6D2B79F5)>>>0
        let t=a
        t=Math.imul(t^(t>>>15),t|1)
        t^=t+Math.imul(t^(t>>>7),t|61)
        return ((t^(t>>>14))>>>0)/4294967296
    }
}
function gaussianPair(rng){
    const u=Math.max(rng(),1e-12)
    const v=rng()
    const radius=Math.sqrt(-2*Math.log(u))
    return [radius*Math.cos(2*Math.PI*v),radius*Math.sin(2*Math.PI*v)]
}
function blob({center,sx,sy,count,rng,correlation=0}){
    const points=[]
    for(let index=0;index<count;index++){
        const [z1,z2]=gaussianPair(rng)
        points.push([
            center[0]+z1*sx,
            center[1]+correlation*z1*sy+z2*sy*Math.sqrt(1-correlation*correlation)
        ])
    }
    return points
}
function nearestComponent(result,point){
    let best=0
    let bestDistance=Infinity
    result.means.forEach((mean,component)=>{
        const distance=Math.hypot(mean[0]-point[0],mean[1]-point[1])
        if(distance<bestDistance){ bestDistance=distance; best=component }
    })
    return best
}

test("two well-separated blobs are recovered as two components",()=>{
    const rng=mulberry32(12345)
    const points=[
        ...blob({center:[0.5,0.2],sx:0.25,sy:0.18,count:120,rng}),
        ...blob({center:[4,3],sx:0.3,sy:0.3,count:120,rng})
    ]
    const result=fitGmm2d(points)
    ok(result,"no fit")
    ok(result.k===2,`expected k=2, got ${result.k}`)
    const nearOrigin=nearestComponent(result,[0.5,0.2])
    const far=nearestComponent(result,[4,3])
    ok(nearOrigin!==far,"the two blobs share a component")
    close(result.means[nearOrigin][0],0.5,0.12,"origin blob mean x")
    close(result.means[nearOrigin][1],0.2,0.12,"origin blob mean y")
    close(result.means[far][0],4,0.15,"far blob mean x")
    close(result.means[far][1],3,0.15,"far blob mean y")
})

test("origin cluster is the dense blob near (0,0), not a distant one",()=>{
    const rng=mulberry32(999)
    const originBlob=blob({center:[0,0],sx:1.4,sy:0.08,count:150,rng})
    const distantBlob=blob({center:[45,-0.9],sx:2.5,sy:0.05,count:90,rng})
    const result=fitGmm2d([...originBlob,...distantBlob],{k:2})
    ok(result,"no fit")
    ok(result.k===2,`expected k=2, got ${result.k}`)
    const originComponent=result.originComponent
    close(result.means[originComponent][0],0,3,"origin mean x")
    close(result.means[originComponent][1],0,0.1,"origin mean y")
    // Recall: most of the dense blob must actually carry the origin label.
    const originTrueIndexes=new Set(originBlob.map((_,index)=>index))
    let recovered=0
    result.labels.forEach((label,index)=>{
        if(originTrueIndexes.has(index)&&label===originComponent) recovered++
    })
    ok(recovered/originBlob.length>=0.85,
        `origin recall too low: ${recovered}/${originBlob.length}`)
    // And the distant blob must almost never be labelled origin.
    let polluted=0
    for(let index=originBlob.length;index<originBlob.length+distantBlob.length;index++){
        if(result.labels[index]===originComponent) polluted++
    }
    ok(polluted/distantBlob.length<=0.1,
        `distant blob polluted origin component: ${polluted}`)
})

test("same points give the same fit",()=>{
    const rng=mulberry32(7)
    const points=[
        ...blob({center:[0,0],sx:1,sy:0.2,count:80,rng}),
        ...blob({center:[8,1],sx:1.5,sy:0.3,count:80,rng})
    ]
    const first=fitGmm2d(points,{k:2})
    const second=fitGmm2d(points,{k:2})
    ok(JSON.stringify(first.means)===JSON.stringify(second.means),
        "means differ between runs")
    ok(JSON.stringify(first.labels)===JSON.stringify(second.labels),
        "labels differ between runs")
    ok(first.converged,"EM did not converge")
})

test("ellipse respects the Mahalanobis radius",()=>{
    const mean=[1.5,-2]
    const covariance=[[4,1.2],[1.2,0.9]]
    const a=covariance[0][0]
    const b=covariance[0][1]
    const d=covariance[1][1]
    const det=a*d-b*b
    const inverse=[[d/det,-b/det],[-b/det,a/det]]
    for(const radius of [1,2]){
        const ellipse=gaussianEllipse(mean,covariance,{radius,samples:32})
        ok(ellipse.length===33,"ellipse is not closed")
        for(const [x,y] of ellipse){
            const dx=x-mean[0]
            const dy=y-mean[1]
            const distance=Math.sqrt(
                inverse[0][0]*dx*dx+2*inverse[0][1]*dx*dy+inverse[1][1]*dy*dy)
            close(distance,radius,1e-6,"ellipse radius")
        }
    }
})

test("too few or degenerate points do not throw",()=>{
    ok(fitGmm2d([])===null,"empty input should return null")
    const single=fitGmm2d([[3,4]])
    ok(single&&single.k===1,"single point should give one component")
    close(single.originDistance,5,1e-9,"single point origin distance")
    const flat=fitGmm2d([[0,0],[1,0],[2,0],[3,0]])
    ok(flat,"flat input should still fit")
    ok(Number.isFinite(flat.means[0][0]),"flat fit produced a non-finite mean")
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length) process.exitCode=1

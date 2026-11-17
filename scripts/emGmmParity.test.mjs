/* -------------------------------------------------------------------------
   Test — node scripts/emGmmParity.test.mjs

   Le noyau Rust et le JS doivent répondre la MÊME chose sur les mêmes
   points. Ce n'est pas une question de goût : le funnel affiche le résultat
   du noyau et le JS sert de repli, donc une divergence signifierait que le
   repli n'est pas le même calcul — exactement le piège que le test de
   clustering évite déjà pour k-means.

   On compare :
     1. le nombre de composantes ;
     2. les moyennes, appariées par proximité (l'ordre des composantes n'a
        pas de sens intrinsèque) ;
     3. les effectifs ;
     4. la composante la plus proche de l'origine.

   Le RNG est le même (mulberry32), l'initialisation aussi (k-means++ et 12
   passes de Lloyd) ; les écarts attendus sont ceux de l'arithmétique f64.
   ------------------------------------------------------------------------- */
import {fitGmm2d,unpackGmm2dFlat} from "./emGmm.js"
import {gmm2d_em} from "../XOP/rust-extension/pkg-node/attribrustor.js"

let passed=0
const failures=[]
const test=(name,fn)=>{
    try{ fn(); passed++; console.log(`  ok   ${name}`) }
    catch(e){ failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const ok=(value,msg)=>{ if(!value) throw new Error(msg??`expected a truthy value, got ${value}`) }
const close=(a,b,tolerance,msg)=>{
    const scale=Math.max(1,Math.abs(a),Math.abs(b))
    if(!(Math.abs(a-b)<=tolerance*scale)) throw new Error(`${msg??"values differ"}: ${a} vs ${b}`)
}

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
function blob({center,sx,sy,count,rng}){
    const points=[]
    for(let index=0;index<count;index++){
        const [z1,z2]=gaussianPair(rng)
        points.push([center[0]+z1*sx,center[1]+z2*sy])
    }
    return points
}

/* Le test lit la sortie avec le MÊME décodeur que le worker: si le contrat
   plat change d'un côté sans l'autre, c'est ici que ça tombe. */
function runRust(points,{k=0,maxComponents=6,maxIter=400,tolerance=1e-7,seed=0x9e3779b9}={}){
    const data=new Float64Array(points.length*2)
    points.forEach(([x,y],index)=>{ data[2*index]=x; data[2*index+1]=y })
    const flat=gmm2d_em(
        data,points.length,maxComponents,k,maxIter,tolerance,BigInt(seed))
    const result=unpackGmm2dFlat(flat,points.length)
    ok(result,"the shared unpacker rejected the Rust output")
    return result
}
function matchMeans(reference,other){
    const used=new Set()
    return reference.means.map(mean=>{
        let best=-1
        let bestDistance=Infinity
        other.means.forEach((candidate,index)=>{
            if(used.has(index)) return
            const distance=Math.hypot(candidate[0]-mean[0],candidate[1]-mean[1])
            if(distance<bestDistance){ bestDistance=distance; best=index }
        })
        used.add(best)
        return best
    })
}

function dataset(seed=12345){
    const rng=mulberry32(seed)
    return [
        ...blob({center:[0.5,0.1],sx:0.25,sy:0.12,count:140,rng}),
        ...blob({center:[6,2],sx:0.6,sy:0.3,count:110,rng}),
        ...blob({center:[20,-1],sx:2,sy:0.5,count:50,rng})
    ]
}

test("fixed k: Rust and JS recover the same components",()=>{
    const points=dataset()
    const js=fitGmm2d(points,{k:3})
    const rust=runRust(points,{k:3})
    ok(js.k===rust.k,`k differs: js=${js.k} rust=${rust.k}`)
    const order=matchMeans(js,rust)
    js.means.forEach((mean,index)=>{
        const other=rust.means[order[index]]
        close(other[0],mean[0],1e-6,"mean x")
        close(other[1],mean[1],1e-6,"mean y")
        close(rust.covariances[order[index]][0][0],js.covariances[index][0][0],
            1e-5,"covariance xx")
    })
    close(rust.logLikelihood,js.logLikelihood,1e-8,"log-likelihood")
})

test("labels agree up to the component permutation",()=>{
    const points=dataset(777)
    const js=fitGmm2d(points,{k:3})
    const rust=runRust(points,{k:3})
    const order=matchMeans(js,rust)
    let agreeing=0
    for(let index=0;index<points.length;index++){
        if(order[js.labels[index]]===rust.labels[index]) agreeing++
    }
    ok(agreeing/points.length>=0.99,
        `label agreement too low: ${agreeing}/${points.length}`)
})

test("auto BIC picks the same number of components",()=>{
    const points=dataset(321)
    const js=fitGmm2d(points)
    const rust=runRust(points,{k:0,maxComponents:6})
    ok(js.k===rust.k,`auto k differs: js=${js.k} rust=${rust.k}`)
    close(rust.bic,js.bic,1e-6,"BIC")
    const order=matchMeans(js,rust)
    const jsOrigin=js.originComponent
    ok(order[jsOrigin]===rust.originComponent,
        `origin component differs: js=${jsOrigin} rust=${rust.originComponent}`)
    close(rust.counts[rust.originComponent],js.counts[jsOrigin],1e-9,
        "origin count")
})

test("single point and invalid input keep the same contract",()=>{
    const one=runRust([[3,4]])
    ok(one.k===1,"single point should give one component")
    close(one.means[0][0],3,1e-12,"single mean x")
    close(one.means[0][1],4,1e-12,"single mean y")
    ok(gmm2d_em(new Float64Array([1,2,3]),1,6,0,400,1e-7,1n).length===0,
        "mismatched length should return nothing")
    ok(gmm2d_em(new Float64Array([1,Number.NaN]),1,6,0,400,1e-7,1n).length===0,
        "non-finite input should return nothing")
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length) process.exitCode=1

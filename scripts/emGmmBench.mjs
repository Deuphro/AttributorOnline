/* -------------------------------------------------------------------------
   emGmmBench.mjs — le clustering EM du funnel mérite-t-il un kernel Rust ?

       node scripts/emGmmBench.mjs [reps]

   On chronomètre le calcul PUR de `fitGmm2d` sur des nuages de la forme que
   le funnel produit réellement : un cœur dense près de (0,0), une population
   plus large, et une queue lointaine. Deux modes sont mesurés séparément
   parce qu'ils n'ont pas le même coût :

     - `auto`  : BIC sur k=1..6, donc jusqu'à six EM complets ;
     - `k=3`   : un seul EM, le cas du sélecteur manuel.

   La question n'est pas « combien de points au total » mais « combien de
   marqueurs le funnel affiche ». Un spectre chargé en donne quelques milliers.
   La règle de décision est écrite en bas de sortie.
   ------------------------------------------------------------------------- */
import {fitGmm2d} from "./emGmm.js"

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

/* Un nuage du funnel en mode |Δppm| / Δppm : x en ppm, y en δ.
   70 % collés à l'origine, 22 % dans une population plus large, 8 % de queue:
   c'est la forme pour laquelle la composante d'origine doit être retrouvée. */
function makeFunnel(n,seed=12345){
    const rng=mulberry32(seed)
    const points=new Array(n)
    for(let index=0;index<n;index++){
        const [z1,z2]=gaussianPair(rng)
        const draw=rng()
        if(draw<0.70){
            points[index]=[Math.abs(z1)*3.0+0.2,z2*0.03]
        }else if(draw<0.92){
            points[index]=[Math.abs(z1)*18+8,z2*0.12+0.02]
        }else{
            points[index]=[Math.abs(z1)*70+40,z2*0.6-0.1]
        }
    }
    return points
}

function quantile(sorted,share){
    if(!sorted.length) return NaN
    const position=(sorted.length-1)*share
    const low=Math.floor(position)
    const high=Math.ceil(position)
    if(low===high) return sorted[low]
    return sorted[low]+(sorted[high]-sorted[low])*(position-low)
}

function bench(label,points,options,reps){
    const warmups=points.length>=50000?1:2
    for(let warmup=0;warmup<warmups;warmup++) fitGmm2d(points,options)
    const times=[]
    let last=null
    for(let rep=0;rep<reps;rep++){
        const start=performance.now()
        last=fitGmm2d(points,options)
        times.push(performance.now()-start)
    }
    times.sort((a,b)=>a-b)
    const median=quantile(times,0.5)
    const p95=quantile(times,0.95)
    const mean=times.reduce((sum,value)=>sum+value,0)/times.length
    console.log(
        `  ${String(points.length).padStart(6)}  ${label.padEnd(10)}`
        +`${String(last?.k??"-").padStart(2)}`
        +`${median.toFixed(1).padStart(9)}`
        +`${mean.toFixed(1).padStart(9)}`
        +`${p95.toFixed(1).padStart(9)}`
        +`${times[times.length-1].toFixed(1).padStart(9)}`
        +`${String(last?.counts?.[last.originComponent]??0).padStart(8)}`)
}

const repsArgument=Number(process.argv[2])
const sizes=[200,2000,10000,50000]
console.log("\n  Pure fitGmm2d — no drawing, no DOM.\n")
console.log(
    "   points  mode        k   median     mean      p95      max  originN"
)
console.log("  "+"-".repeat(70))
for(const size of sizes){
    const points=makeFunnel(size)
    const automatic=size<=2000?11:size<=10000?5:1
    const reps=Number.isInteger(repsArgument)&&repsArgument>0?repsArgument:automatic
    bench("auto BIC",points,{},reps)
    bench("k=3",points,{k:3},reps)
}

/* CE QUE LE BENCH A APPRIS, y compris contre l'intuition :

   Le noyau Rust `gmm2d_em` (même algorithme, test de parité 4/4) a été
   mesuré sur ces mêmes nuages : il ne bat PAS le JS, et peut être un peu plus
   lent. Le coût est dominé par les exp/ln de l'étape E ; sur wasm ces
   transcendantes sont logicielles, alors que Math.exp de V8 est natif.

   Donc la décision n'est pas « JS ou Rust », mais :
     - le calcul tourne déjà dans kernelWorker : le thread principal est libre,
       quel que soit le temps mural ;
     - le vrai levier sur le temps mural est le nombre d'EM (auto BIC jusqu'à
       k=6 en lance six) : plafonner l'auto ou warm-starter les k supérieurs. */
console.log(`
  Lecture: n est le nombre de marqueurs du funnel, pas de points du spectre.
  Un EM 2D doit rester interactif au clic, pas à chaque frame.
`)

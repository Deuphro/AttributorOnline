/* -------------------------------------------------------------------------
   cost2.mjs — LE VRAI CHEMIN, ET LA MESURE QUI MANQUAIT.

   Hier j'ai mesuré `cribleMixedRadix` APPELÉ DIRECTEMENT, sans `emit`. C'est le
   chemin qui MATERIALISE tous les états — donc j'ai mesuré une sortie que le
   nœud ne produit jamais, et j'ai conclu à une mort par mémoire qui ne dit rien
   du nœud.

   La sélection passe par `emit`: chaque état est classé à la volée, rangé dans
   le seau de son pic, et seul le contenu des seaux est gardé. C'est exactement
   l'architecture décrite: un seau par pic, taille `bestMatches`, remplacement du
   pire. Il n'y a AUCUN tableau de tous les états.

   Donc on mesure ici `attributeSpectrum` — ce que le nœud appelle vraiment.
   ------------------------------------------------------------------------- */
import {readFileSync} from "fs"
import {Element} from "../scripts/chemistry.js"
import {buildPlan,attributeSpectrum,SortedPoints} from "../scripts/attribution.js"

const TABLE=Element.load(JSON.parse(
    readFileSync(new URL("../data/elements.json",import.meta.url),"utf8")))
const log=(...parts)=>console.log(...parts)

const build=(ratio)=>buildPlan({
    table:TABLE,
    combining:["CH2","NH","O","C"].map(g=>({group:g,ratio,max:20})),
    ionising:[{group:"[H+]",min:1,max:1,ratio:1}],
    ratio,chargeMax:1,chargeAuto:true
})

/* 7 executions, minimum. La machine varie de 20 a 60 ms sur la meme course:
   une valeur isolee ne prouverait rien. */
const REPEATS=7
const timed=(fn)=>{
    const runs=[]
    let out=null
    for(let i=0;i<REPEATS;i++){
        const t0=performance.now()
        out=fn()
        runs.push(performance.now()-t0)
    }
    return {min:Math.min(...runs),runs,out}
}

log("LE CHEMIN DU NOEUD: attributeSpectrum, avec emit et les seaux par pic.")
log("minimum sur 7 executions.\n")
log("plafond  ratio   briques   lectures     min temps")

for(const high of [386,700,1000,1400]){
    for(const ratio of [0.1,0.02,0.01]){
        const plan=build(ratio)
        const points=[]
        for(let i=0;i<95;i++) points.push(175+i*((high-175)/94))
        const spectrum=new SortedPoints(points,points.map(()=>1000))
        const result=timed(()=>attributeSpectrum(plan,spectrum,
            {limit:Infinity,bestMatches:3,ppm:10}))
        log(`${String(high).padStart(6)}  ${String(ratio).padEnd(7)}`+
            `${String(plan.itemCount).padStart(6)}   `+
            `${String(result.out.entries.length).padStart(8)}   `+
            `${result.min.toFixed(0).padStart(9)} ms`)
    }
}

log("")
log("La difference avec hier: hier on mesurait le crible SANS emit, qui")
log("materialise 27531 puis 332758 puis 4580411 etats. Le noeud ne fait")
log("jamais cela - il classe a la volee et ne garde que les seaux.")
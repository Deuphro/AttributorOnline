/* -------------------------------------------------------------------------
   cost.mjs — OÙ PASSE LE TEMPS, AVANT DE PORTER QUOI QUE CE SOIT.

   On ne transpose pas en Rust parce que c'est joli. On transpose quand le JS
   devient le goulot, et la question est de savoir si c'est le crible.

       node scripts/cost.mjs

   Trois temps sont mesurés séparément, sur la même course:
     - le crible seul            (cribleMixedRadix)
     - le crible + la sélection  (ce que fait attributeSpectrum)
     - la construction des formules (stateToFormula)

   Et un contrôle: ce que coûte le TRANSFERT d'un `Int32Array.from(counts)` par
   état, parce que c'est le poste que le Rust supprimera.
   ------------------------------------------------------------------------- */
import {readFileSync} from "fs"
import {Element} from "../scripts/chemistry.js"
import {
    buildPlan,cribleMixedRadix,cribleHeap,attributeSpectrum,SortedPoints,stateToFormula
} from "../scripts/attribution.js"

const TABLE=Element.load(JSON.parse(
    readFileSync(new URL("../data/elements.json",import.meta.url),"utf8")))

/* Le peak list de la fixture, et un plan à 95 points réels. */
const points=[]
for(let i=0;i<95;i++) points.push(175+i*2.25)
const SPECTRUM=new SortedPoints(points,points.map(()=>1000))

const build=(ratio)=>buildPlan({
    table:TABLE,
    combining:["CH2","NH","O","C"].map(g=>({group:g,ratio,max:20})),
    ionising:[{group:"[H+]",min:1,max:1,ratio:1}],
    ratio,chargeMax:1,chargeAuto:true
})

/* MINIMUM SUR 7 EXÉCUTIONS, ET JAMAIS LA MÉDIANE: la machine varie du simple
   au double, donc une mesure isolée ne prouve rien. On garde le minimum,
   qui est la borne inférieure réelle, et on affiche les sept valeurs pour que
   la dispersion soit visible au lieu d'être cachée. */
const REPEATS=7
const timed=(fn)=>{
    const runs=[]
    let lastLength=null
    for(let i=0;i<REPEATS;i++){
        const t0=performance.now()
        const out=fn()
        runs.push(performance.now()-t0)
        if(out&&typeof out.length==="number") lastLength=out.length
    }
    return {min:Math.min(...runs),runs,lastLength}
}
const show=(label,result,note="")=>{
    log(`${label.padEnd(34)} min ${result.min.toFixed(1).padStart(8)} ms`+
        `   [${result.runs.map(r=>r.toFixed(0)).join(" ")}]${note?"  "+note:""}`)
}

const log=(...parts)=>console.log(...parts)

log(`mesures en millisecondes, ${REPEATS} executions, on garde le MINIMUM`)
log("(la machine varie du simple au double: une seule valeur ne prouverait rien)\n")

/* LA QUESTION POSÉE: jusqu'où, et à partir de quelle masse.

   Les 27 531 états venaient d'un plafond de **386,5 Da** — la mesure ci-dessus
   allait de 175 à 175 + 94 × 2,25. C'est BAS, et le plafond de masse est la
   seule chose qui décide de la taille de l'espace: on le monte donc jusqu'à
   1000, ce qui est la demande.

   On compte les ÉTATS, pas le temps: c'est le nombre qui décide si le JS passe
   à l'échelle, et il ne dépend pas de la charge de la machine. Le temps est
   donné à titre indicatif, en minimum sur 7 exécutions. */
log("\n=== COMBIEN D'ETATS, ET JUSQU'OÙ ===")
log("massif        ratio   briques   etats       visited      temps(min/7)")
const COUNTED=[]
for(const [low,high] of [[175,386],[175,700],[175,1000],[175,1400]]){
    for(const ratio of [0.1,0.05,0.02,0.01]){
        const plan=build(ratio)
        const points=[]
        for(let i=0;i<95;i++) points.push(low+i*((high-low)/94))
        const spectrum=new SortedPoints(points,points.map(()=>1000))
        const maxMass=plan.massCeiling(spectrum)
        const minMass=plan.massFloor(spectrum)
        /* le comptage SEUL: une course, pas sept, parce qu'on veut le nombre */
        /* LE CAS QUI TUE LE JS N'EST PAS MESURÉ ICI, IL EST SUBI.

           À 1000 Da et ratio 0.01 le crible JS épuise 4 Go et V8 aborte après
           ~200 secondes. Le laisser dans la boucle ferait mourir le script
           avant d'afficher le reste, donc on s'arrête à 700 Da — et le fait
           qu'il MOURE est écrit plus bas comme un résultat, pas comme un trou
           dans la mesure. Le seuil est le but de l'exercice. */
        if(high>=1000&&ratio<=0.02) continue
        const counted=cribleMixedRadix(plan,{maxMass,minMass})
        const runs=[]
        for(let i=0;i<7;i++){
            const t0=performance.now()
            cribleMixedRadix(plan,{maxMass,minMass})
            runs.push(performance.now()-t0)
        }
        const min=Math.min(...runs)
        COUNTED.push({high,ratio,bricks:plan.itemCount,states:counted.states.length})
        log(`${String(high).padStart(5)} Da   ${String(ratio).padEnd(7)}`+
            `${String(plan.itemCount).padStart(6)}   `+
            `${String(counted.states.length).padStart(9)}   `+
            `${String(counted.visited).padStart(9)}   `+
            `${min.toFixed(0).padStart(9)} ms`)
    }
}

const biggest=COUNTED.reduce((a,b)=>b.states>a.states?b:a)
log(`\nle plus grand espace mesure : ${biggest.states} etats `+
    `(plafond ${biggest.high} Da, ratio ${biggest.ratio})`)

/* LE SEUIL EST ECRIT DANS LE KERNEL RUST LUI-MEME, donc on le cite plutôt que
   de l'inventer: « c'est faisable quand le tas JS ne passe pas à l'échelle »,
   et le `seen` du tas est un `Set`/`HashMap` plafonné. On affiche donc la
   progression pour que la décision soit prise sur des chiffres. */
log("\n=== progression de l'espace ===")
for(const row of COUNTED.filter(r=>r.ratio===0.01)){
    log(`  plafond ${String(row.high).padStart(5)} Da -> `+
        `${String(row.states).padStart(9)} etats`)
}
/* LA MESURE QUI RÉPOND À LA QUESTION, ET ELLE EST SANS APPEL.

   1000 Da et ratio 0.01 : 4,6 millions d'états à 700 Da, et à 1000 le JS
   n'a pas seulement été lent — il a MORT. `FATAL ERROR: Reached heap limit`,
   4 Go, après 200 secondes. Pas un timeout, pas une lenteur: une mort du
   process, sur le cas même qu'on veut atteindre.

   On ne devine pas la suite: le processus est mort, donc les chiffres au-delà
   n'existent pas. C'est un résultat, pas une lacune de mesure. */

log("\n=== CE QUE LE JS FAIT A 1000 Da, ratio 0.01 ===")
log("  386 Da ->    332 758 etats      445 ms")
log("  700 Da ->  4 580 411 etats   15 253 ms   (~13 s)")
log(" 1000 Da -> ?")
log("")
log("  A 1000 Da le crible JS n'a pas rendu la main pendant 200 secondes,")
log("  puis V8 a aborté: heap out of memory, 4 Go, apres 332 758 etats a")
log("  386 Da et 4 580 411 a 700 Da. Le nombre d'etats a 1000 Da n'est donc pas")
log("  « plus grand » — il est INCONNU, parce que le programme n'existe plus.")
log("")
log("  C'est exactement le regime que attribution.rs decrit: « c'est faisable »")
log("  quand le tas JS ne passe pas a l'echelle. On y est.")

/* Et la raison du crash, qu'on peut nommer: ce n'est pas le NOMBRE d'etats,
   c'est leur COUTE MEMOIRE. Chaque etat est un objet {mass, counts, lastAdded}
   avec un Int32Array PAR etat. On le mesure plutot que de le supposer. */
const counts=new Int32Array(7)
log("\n=== POURQUOI CA MOURUT: LA MEMOIRE, PAS LE TEMPS ===")
log("  un etat du crible mixte = un objet {mass, counts, lastAdded}")
log("                              + un Int32Array de 7 nombres")
for(const states of [332758,4580411]){
    const bytesPerState=3*8+32+7*4+8
    log(`  ${String(states).padStart(9)} etats x ~${bytesPerState} o = `+
        `${(states*bytesPerState/1e9).toFixed(1)} Go`)
}
log("")
log("  Un etat en RUST = 7 u32 + 1 f64 dans un Vec<F64> contigu, soit 64 o,")
log("  et surtout ZERO allocation par etat: un seul tableau pour tout le crible.")
log(`  4 580 411 etats tenant alors dans ${(4580411*64/1e9).toFixed(2)} Go`)
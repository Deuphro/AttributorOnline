/* -------------------------------------------------------------------------
   Test — node scripts/isotopeMatch.test.mjs

   Vérifie l'enveloppe isotopique prédite et le score de comparaison au
   spectre. L'oracle physique, ici, est simple et vérifiable à la main:

     - le germe d'une formule non enrichie est le pic le plus probable;
     - pour C6H12O6, M+1 vaut environ 6 x 1,07 % ≈ 6,4 % du germe, dominé
       par le 13C (le deutérium et le 17O sont bien plus rares);
     - un spectre synthétisé à partir de l'enveloppe doit scorer 1;
     - retirer un satellite doit faire baisser la couverture ET le score.
   ------------------------------------------------------------------------- */
import {readFileSync} from "fs"
import {Element,Formula} from "./chemistry.js"
import {isotopologueEnvelope,scoreIsotopePattern} from "./isotopeMatch.js"

const TABLE=Element.load(JSON.parse(
    readFileSync(new URL("../data/elements.json",import.meta.url),"utf8")))

let passed=0
const failures=[]
const test=(name,fn)=>{
    try{ fn(); passed++; console.log(`  ok   ${name}`) }
    catch(e){ failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const ok=(value,msg)=>{ if(!value) throw new Error(msg??`expected a truthy value, got ${value}`) }
const close=(a,b,tol,msg)=>{
    if(!(Math.abs(a-b)<=tol)) throw new Error(`${msg??"values differ"}: ${a} vs ${b}`)
}
const nearestIn=(peaks,ppm=10)=>(mz)=>{
    let best=null
    let bestDistance=Infinity
    for(const peak of peaks){
        const distance=Math.abs(peak.mz-mz)
        if(distance<bestDistance){ bestDistance=distance; best=peak }
    }
    if(!best) return null
    const errorPpm=(best.mz-mz)/mz*1e6
    if(Math.abs(errorPpm)>ppm) return null
    return {mz:best.mz,intensity:best.intensity,errorPpm}
}

const glucose=Formula.parse("C6H12O6 [H+]",TABLE)

test("l'enveloppe a un germe à probabilité 1 et un M+1 d'environ 6 %",()=>{
    const envelope=isotopologueEnvelope(glucose,{spanDa:3})
    ok(envelope.centre===glucose.mz,`centre should be the ion m/z, got ${envelope.centre}`)
    const germ=envelope.peaks.reduce((a,b)=>a.probability>=b.probability?a:b)
    close(germ.probability,1,1e-12,"the most probable state must normalise to 1")
    close(germ.mz,glucose.mz,1e-9,"the germ must sit at the formula m/z")
    /* M+1 est à +1,00335 (13C). On cherche le satellite le plus probable
       au-dessus du germe: pour le glucose c'est bien celui-là. */
    const satellite=envelope.peaks
        .filter(peak=>peak.mz>germ.mz+0.5&&peak.mz<germ.mz+1.5)
        .reduce((a,b)=>a.probability>=b.probability?a:b)
    ok(Math.abs(satellite.mz-germ.mz-1.00335)<0.01,
        `M+1 should be the 13C shift, got +${satellite.mz-germ.mz}`)
    ok(satellite.probability>0.04&&satellite.probability<0.10,
        `C6 M+1 should be about 6 %, got ${satellite.probability}`)
})

test("un spectre synthétisé depuis l'enveloppe score 1",()=>{
    const envelope=isotopologueEnvelope(glucose,{spanDa:3})
    const measured=envelope.peaks.map(peak=>({mz:peak.mz,intensity:peak.probability*1000}))
    const score=scoreIsotopePattern(envelope,nearestIn(measured))
    close(score.score,1,1e-9,"a perfect envelope must score 1")
    close(score.coverage,1,1e-9,"every predicted satellite is present")
    ok(score.matched===score.usable,`all ${score.usable} usable peaks matched`)
    ok(score.residual!==null&&score.residual<1e-6,"no intensity residual")
})

test("retirer un satellite baisse la couverture et le score",()=>{
    const envelope=isotopologueEnvelope(glucose,{spanDa:3})
    const germ=envelope.peaks.reduce((a,b)=>a.probability>=b.probability?a:b)
    const satellite=envelope.peaks
        .filter(peak=>peak!==germ)
        .reduce((a,b)=>a.probability>=b.probability?a:b)
    /* On retire le CLUSTER mesuré, pas seulement l'état prédit: la fusion de
       l'enveloppe a déjà réuni 13C, 17O et 2H en un seul pic, et un voisin à
       quelques ppm tiendrait lieu de satellite. */
    const measured=envelope.peaks
        .filter(peak=>Math.abs(peak.mz-satellite.mz)>0.01)
        .map(peak=>({mz:peak.mz,intensity:peak.probability*1000}))
    const score=scoreIsotopePattern(envelope,nearestIn(measured))
    ok(score.matched<score.usable,"the removed satellite must not be matched")
    ok(score.coverage<1,`coverage should drop, got ${score.coverage}`)
    ok(score.score<0.98,`score should drop, got ${score.score}`)
    ok(score.residual!==null&&Number.isFinite(score.residual),"residual stays finite")
})

test("un satellite hors fenêtre ppm n'est pas apparié",()=>{
    const envelope=isotopologueEnvelope(glucose,{spanDa:3})
    const shifted=envelope.peaks.map(peak=>({
        mz:peak.mz+0.05,
        intensity:peak.probability*1000
    }))
    const score=scoreIsotopePattern(envelope,nearestIn(shifted,10))
    ok(score.matched===0,`nothing should match at 10 ppm, got ${score.matched}`)
    close(score.score,0,1e-12,"no match means no score")
})

test("un spectre vide rend un score nul, jamais NaN",()=>{
    const envelope=isotopologueEnvelope(glucose,{spanDa:3})
    const score=scoreIsotopePattern(envelope,nearestIn([]))
    ok(score.score===0,"score must be 0")
    ok(score.coverage===0,"coverage must be 0")
    ok(score.residual===null,"no residual without a match")
    ok(score.bins.every(bin=>Number.isFinite(bin.predicted)),"no NaN in bins")
})

test("une formule dont l'enveloppe est décalée score moins bien",()=>{
    const envelope=isotopologueEnvelope(glucose,{spanDa:3})
    const measured=envelope.peaks.map(peak=>({mz:peak.mz,intensity:peak.probability*1000}))
    const other=Formula.parse("C5H8O7 [H+]",TABLE)
    const otherEnvelope=isotopologueEnvelope(other,{mz:glucose.mz,spanDa:3})
    const otherScore=scoreIsotopePattern(otherEnvelope,nearestIn(measured))
    const ownScore=scoreIsotopePattern(envelope,nearestIn(measured))
    ok(ownScore.score>otherScore.score,
        `the measured envelope must favour its own formula: ${ownScore.score} vs ${otherScore.score}`)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length){
    console.log(failures.join("\n"))
    process.exit(1)
}

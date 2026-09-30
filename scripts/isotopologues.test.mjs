/* -------------------------------------------------------------------------
   Test — node scripts/isotopologues.test.mjs

   Ce qui est vérifié ici, c'est l'ÉNUMÉRATION: combien de formules on peut
   produire, dans quel ordre, et ce qu'on ne doit PAS perdre au passage.

   L'ORACLE, c'est le code Igor de la thèse — generesimu et crible1..10 dans
   resources/ProcAttributorLegacy/MainProc.ipf. Les chiffres ci-dessous en sont
   tirés, recalculés depuis data/elements.json, pas recopiés d'une exécution:
   ils disent ce que la PHYSIQUE doit donner, pas ce que le code fait.

   chemistry.test.mjs vérifie la grammaire. stoichiometry.test.mjs vérifie le
   graphe. Ici c'est la recherche: le tri, l'élagage, et les trois pièges que
   seule l'énumération peut rencontrer.
   ------------------------------------------------------------------------- */
import {readFileSync} from "fs"
import {Element,Formula,Stoichiometry} from "./chemistry.js"
const TABLE=Element.load(JSON.parse(
    readFileSync(new URL("../data/elements.json",import.meta.url),"utf8")))

let passed=0
const failures=[]
const test=(name,fn)=>{
    try{ fn(); passed++; console.log(`  ok   ${name}`) }
    catch(e){ failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const ok=(value,msg)=>{ if(!value) throw new Error(msg??`expected a truthy value, got ${value}`) }
const close=(a,b,tol,msg)=>{ if(!(Math.abs(a-b)<=tol)) throw new Error(`${msg??`${a} vs ${b}`}`) }
const root=(text,charge=0)=>new Stoichiometry({
    composition:Formula.parseComposition(text,TABLE),
    charge,table:TABLE
})
/* La somme des P vaut 1 sur l'espace entier. C'est la propriété qui dit que la
   formule est une PROBABILITÉ et pas un score: si elle ne tient plus, le
   classement n'a plus de sens, et rien d'autre ne le montrera. */
const logSumExp=(values)=>{
    const max=Math.max(...values)
    return max+Math.log(values.reduce((a,v)=>a+Math.exp(v-max),0))
}

console.log("l'oracle: les chiffres d'Igor, recalculés depuis la table")
test("C6H12O6 a 2548 isotopologues (7 x 13 x 28)",()=>{
    const all=[...root("C6H12O6").isotopologues({ratio:0,limit:Infinity})]
    ok(all.length===2548,`expected 2548, got ${all.length}`)
})
test("les probabilités somment à 1",()=>{
    const all=[...root("C6H12O6").isotopologues({ratio:0,limit:Infinity})]
    close(logSumExp(all.map(s=>s.logProbability)),0,1e-9,"ΣP must be 1")
})
test("le top 10 couvre 99,99 % de la probabilité",()=>{
    const all=[...root("C6H12O6").isotopologues({ratio:0,limit:Infinity})]
    const covered=logSumExp(all.slice(0,10).map(s=>s.logProbability))
    const total=logSumExp(all.map(s=>s.logProbability))
    close(Math.exp(covered-total)*100,99.99,0.01,"the top 10 must carry ~99.99 %")
})
test("la plus rare vaut 2,4e-80",()=>{
    const all=[...root("C6H12O6").isotopologues({ratio:0,limit:Infinity})]
    const min=Math.min(...all.map(s=>s.logProbability))
    close(Math.exp(min),2.418e-80,1e-82,"the rarest glucose isotopologue")
})
test("l'étendue vaut 79,6 ordres de grandeur",()=>{
    const all=[...root("C6H12O6").isotopologues({ratio:0,limit:Infinity})]
    const logs=all.map(s=>s.logProbability)
    close((Math.max(...logs)-Math.min(...logs))/Math.LN10,79.6,0.1,"the dynamic range")
})
test("le 13C est au rang 2, relatif 0,0649",()=>{
    const all=[...root("C6H12O6").isotopologues({ratio:0,limit:3})]
    const second=all[1]
    close(Math.exp(second.logProbability-all[0].logProbability),0.0649,1e-4,"one 13C in glucose")
    ok(second.notation.includes("13C"),`expected a 13C, got "${second.notation}"`)
})
test("18O au rang 2 de l'O, mais 2x13C avant 2x18O",()=>{
    /* Le piège de rang: dans le C, 2 x 13C est au rang 3; dans l'O, 2 x 18O est
       au rang 4. Deux sources du M+2, à des rangs différents, parce que la
       probabilité totale est un PRODUIT entre éléments. C'est pourquoi on ne
       peut pas dire "les k premiers par élément" pour obtenir les k globaux. */
    const one18O=[...root("O6").isotopologues({ratio:0,limit:2})]
    close(Math.exp(one18O[1].logProbability-one18O[0].logProbability),0.0123,1e-4,"one 18O in O6")
    const two13C=[...root("C6").isotopologues({ratio:0,limit:3})][2]
    const two18O=[...root("O6").isotopologues({ratio:0,limit:4})][3]
    ok(two13C.logProbability>two18O.logProbability,
        "2 x 13C must be more probable than 2 x 18O, so it is reached earlier")
})

console.log("le seuil relatif, par élément — la sémantique du kriter d'Igor")
test("ratio=0 prend tout, ratio=1 prend le seul plus probable",()=>{
    const all=[...root("C6H12O6").isotopologues({ratio:0,limit:Infinity})]
    ok(all.length===2548,`ratio:0 must take everything, got ${all.length}`)
    const mono=[...root("C6H12O6").isotopologues({ratio:1,limit:Infinity})]
    ok(mono.length===1,`ratio:1 must keep one per element, got ${mono.length}`)
    close(Math.exp(mono[0].logProbability-all[0].logProbability),1,1e-12,
        "ratio:1 keeps the most probable, and it is also the global one")
})
test("ratio=0.001 donne 3 x 2 x 3 = 18 combinaisons",()=>{
    /* Le seuil est RELATIF au max de chaque élément: c'est ce qui l'adapte à
       chaque élément au lieu d'appliquer la même barre partout. Mesuré sur les
       deux listes, pas supposé. */
    const all=[...root("C6H12O6").isotopologues({ratio:0.001,limit:Infinity})]
    ok(all.length===18,`expected 18, got ${all.length}`)
})
test("17O est atteint à ratio:0 et exclu à ratio:0.01",()=>{
    const all=[...root("C6H12O6").isotopologues({ratio:0,limit:Infinity})]
    ok(all.some(s=>s.notation.includes("17O")),"17O is in the table, so ratio:0 reaches it")
    const tight=[...root("C6H12O6").isotopologues({ratio:0.01,limit:Infinity})]
    ok(!tight.some(s=>s.notation.includes("17O")),"17O is 3.8e-4, so ratio:0.01 excludes it")
})

console.log("le piège de la sous-flottement")
test("un lipide ne tombe pas à zéro : tout est en log",()=>{
    /* C54H104O6, 161 700 combinaisons. La plus rare est à -536 ordres de
       grandeur: en probabilité ordinaire elle SOUS-FLOTTE à 0, et le cas
       disparaît sans erreur. C'est la régression la plus utile du fichier.
       On NE MATÉRIALISE PAS les 161 700: on les parcourt, sinon c'est le
       test qui explose la pile, pas le code. */
    let count=0,min=Infinity,previous=Infinity
    for(const state of root("C54H104O6").isotopologues({ratio:0,limit:Infinity})){
        count++
        if(!Number.isFinite(state.logProbability)){
            throw new Error(`rank ${state.rank} has a non-finite logP`)
        }
        if(state.logProbability>previous){
            throw new Error(`not sorted at rank ${state.rank}`)
        }
        previous=state.logProbability
        if(state.logProbability<min) min=state.logProbability
    }
    ok(count===161700,`expected 161700, got ${count}`)
    ok(Number.isFinite(min),`the rarest logP must be finite, got ${min}`)
    ok(min< -500,`expected about -536 orders of magnitude, got ${min}`)
    ok(Math.exp(min)===0,`this molecule is SUPPOSED to underflow: that is the point`)
})
test("le classement reste correct quand la queue vaut zéro",()=>{
    /* Le tas compare des logP, jamais des P: deux états dont la P sous-flotte
       restent distinguables par leur logP. Si on comparait des P, ils
       tomberaient à égalité et l'ordre deviendrait arbitraire. */
    const all=[...root("C54H104O6").isotopologues({ratio:0,limit:Infinity})]
    const logs=all.map(s=>s.logProbability)
    for(let i=1;i<logs.length;i++){
        if(logs[i]>logs[i-1]) throw new Error(`not sorted at ${i}: ${logs[i]} > ${logs[i-1]}`)
    }
})

console.log("la fenêtre de masse: la couverture, pas le classement")
test("autour du monoisotopique, une seule formule",()=>{
    const mono=[...root("C6H12O6").isotopologues({ratio:0,limit:1})]
    const hits=[...root("C6H12O6").isotopologues({within:{mz:mono[0].mz,ppm:5},limit:Infinity})]
    ok(hits.length===1,`expected 1, got ${hits.length}`)
    close(hits[0].mass,mono[0].mass,1e-9,"it must be the monoisotopic one")
})
test("autour du 13C1, deux formules isobares",()=>{
    /* 12C5 13C et 16O5 17O sont à 4,8 ppm l'un de l'autre: à 5 ppm les DEUX
       sortent. Un générateur qui n'en renverrait qu'un se trompe — la fenêtre
       est plus large que l'écart isobarique. */
    const first=[...root("C6H12O6").isotopologues({ratio:0,limit:2})]
    const target=first[1].mz
    const hits=[...root("C6H12O6").isotopologues({within:{mz:target,ppm:5},limit:Infinity})]
    const offset=(state)=>(state.mz-target)/target*1e6
    const report=hits.map(h=>`${h.notation} @ ${offset(h).toFixed(2)} ppm`)
    ok(hits.length===2,`expected the 2 isobares, got ${hits.length}: ${report.join(" | ")}`)
    ok(hits.some(s=>s.notation.includes("13C")),`the 13C isotopologue: ${hits.map(h=>h.notation)}`)
    ok(hits.some(s=>s.notation.includes("17O")),`the 17O isotopologue: ${hits.map(h=>h.notation)}`)
    for(const hit of hits) close(hit.mz,target,target*5e-6,"each must sit in the window")
})
test("la fenêtre se resserre d'un facteur |z|",()=>{
    /* Un 1+ de glucose a son m/z décalé d'un électron. Si la fenêtre ne se
       resserrait pas de |z|, on chercherait au mauvais endroit de l'axe. */
    const at1=[...root("C6H12O6",1).isotopologues({ratio:0,limit:1})]
    const mono=[...root("C6H12O6").isotopologues({ratio:0,limit:1})]
    const hits=[...root("C6H12O6",1).isotopologues(
        {within:{mz:at1[0].mz,ppm:5},limit:Infinity})]
    ok(hits.length===1,`expected 1, got ${hits.length}`)
    close(hits[0].mz,at1[0].mz,1e-9,"it must be the ionised one")
    close(hits[0].mass,mono[0].mass,1e-9,"and the mass is the neutral one")
})
test("la charge change le m/z, pas l'espace",()=>{
    /* Un ion 1+ a son m/z décalé d'exactement un électron, et son ESPACE
       d'isotopologues est le même: la charge ne fait pas varier d'isotope,
       elle ne fait que corriger la masse finale. Le vérifier ensemble, c'est
       dire que l'axe 2 est indépendant de l'axe 1 — donc qu'une molécule
       se retrouve à toutes ses charges sans qu'on la recalcule. */
    const neutral=[...root("C6H12O6").isotopologues({ratio:0,limit:1})]
    const cation=[...root("C6H12O6",1).isotopologues({ratio:0,limit:1})]
    close(neutral[0].mz,180.063388,1e-5,"the neutral m/z")
    close(cation[0].mz,180.062839,1e-5,"the 1+ m/z, one electron lighter")
    close(cation[0].mass,neutral[0].mass,1e-12,
        "the MASS is the neutral one: only ionMass is corrected")
    close(cation[0].ionMass,neutral[0].mz-TABLE.electronMass.value,1e-12,
        "a positive ion is lighter by exactly one electron per charge")
    const anion=[...root("C6H12O6",-1).isotopologues({ratio:0,limit:1})]
    close(anion[0].ionMass,neutral[0].mz+TABLE.electronMass.value,1e-12,
        "a negative ion GAINS an electron, and the sign carries it")
})
test("un 2+ a bien son m/z divisé par deux",()=>{
    /* ATTENTION, ce n'est PAS la moitié du m/z du 1+, et l'écart n'est pas
       un détail: mz = (masse - z·mₑ)/|z|, donc le 2+ vaut masse/2 - mₑ
       quand le 1+ vaut masse - mₑ. Les deux diffèrent donc de mₑ/2. Un test
       qui les comparerait directement échouerait, et il aurait raison —
       c'est ce que la correction de l'électron veut dire. */
    const z1=[...root("C6H12O6",1).isotopologues({ratio:0,limit:1})]
    const z2=[...root("C6H12O6",2).isotopologues({ratio:0,limit:1})]
    close(z2[0].mz,z1[0].mz/2-TABLE.electronMass.value/2,1e-12,
        "the 2+ is half the 1+, less half an electron")
    close(z2[0].mass,z1[0].mass,1e-12,"but the MASS is not divided at all")
})

console.log("le moteur: le tas vaut la force brute")
test("le top 100 par tas == la force brute, sur 2548",()=>{
    const tas=[...root("C6H12O6").isotopologues({ratio:0,limit:100})]
    /* La force brute: chaque liste d'élément triée en logP décroissant, puis
       le produit cartésien complet, puis un tri. C'est O(total log total) —
       exactement ce que le tas évite — donc c'est un oracle, pas une solution. */
    const brute=cartesian("C6H12O6",0)
        .sort((a,b)=>b.logProbability-a.logProbability)
        .slice(0,100)
    ok(tas.length===100,`expected 100, got ${tas.length}`)
    for(let i=0;i<100;i++){
        close(tas[i].logProbability,brute[i].logProbability,1e-9,`rank ${i+1} disagrees`)
    }
})
test("aucun état n'est rendu deux fois",()=>{
    const all=[...root("C6H12O6").isotopologues({ratio:0,limit:Infinity})]
    const keys=new Set(all.map(s=>s.key))
    ok(keys.size===all.length,`${all.length} states but ${keys.size} distinct keys`)
})
test("chaque état a une masse, une probabilité et un rang",()=>{
    const all=[...root("C6H12O6").isotopologues({ratio:0,limit:5})]
    all.forEach((s,i)=>{
        ok(Number.isFinite(s.mass),`rank ${i+1} has no mass`)
        ok(Number.isFinite(s.logProbability),`rank ${i+1} has no logP`)
        ok(s.rank===i+1,`rank ${i+1} says it is ${s.rank}`)
    })
})

console.log("les refus")
test("une racine sans table le dit",()=>{
    const orphan=new Stoichiometry({composition:Formula.parseComposition("C6H12O6",TABLE)})
    let raised=null
    try{ [...orphan.isotopologues({ratio:0})] }catch(e){ raised=e }
    ok(raised,"without a table there are no masses to enumerate")
    ok(/table/i.test(raised.message),`the error must explain why: ${raised.message}`)
})

/* L'oracle brut, construit ici plutôt qu'importé: il doit rester lisible et
   indépendant de l'implémentation qu'il juge. */
function compositionsOf(element,n,ratio){
    const isotopes=element.isotopes
    const out=[]
    const counts=new Array(isotopes.length).fill(0)
    const rec=(index,remaining)=>{
        if(index===isotopes.length-1){
            counts[index]=remaining
            let logProbability=logFactorial(n),mass=0
            for(let i=0;i<counts.length;i++){
                logProbability-=logFactorial(counts[i])
                if(counts[i]>0){
                    const abundance=isotopes[i].abundance??1
                    if(abundance>0) logProbability+=counts[i]*Math.log(abundance)
                    mass+=counts[i]*isotopes[i].mass
                }
            }
            out.push({logProbability,mass})
            return
        }
        for(let k=0;k<=remaining;k++){ counts[index]=k; rec(index+1,remaining-k) }
    }
    rec(0,n)
    out.sort((a,b)=>b.logProbability-a.logProbability)
    /* Le seuil d'Igor: un ratio RELATIF au max de la liste. La soustraction est
       le logarithme du quotient, donc la sémantique est identique — et elle
       survit à 536 ordres de grandeur là où une probabilité littérale meurt. */
    return ratio>0?out.filter(c=>c.logProbability-out[0].logProbability>=Math.log(ratio)):out
}
function cartesian(text,ratio){
    const spec=[...text.matchAll(/([A-Z][a-z]?)(\d*)/g)]
        .map(m=>[m[1],Number(m[2]||1)])
    return spec.map(([symbol,n])=>compositionsOf(TABLE.find(symbol),n,ratio))
        .reduce((acc,list)=>acc.flatMap(prefix=>
            list.map(c=>({
                logProbability:prefix.logProbability+c.logProbability,
                mass:prefix.mass+c.mass
            }))),[{logProbability:0,mass:0}])
}
function logFactorial(n){
    let s=0
    for(let i=2;i<=n;i++) s+=Math.log(i)
    return s
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length) process.exitCode=1


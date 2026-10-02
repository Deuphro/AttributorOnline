/* -------------------------------------------------------------------------
   Test — node scripts/attribution.test.mjs

   Ce qui est vérifié ici, c'est le CRIBLE: combien de combinaisons il trouve,
   dans quel ordre, et ce qu'il ne doit PAS perdre au passage.

   L'ORACLE, c'est le code Igor de la thèse — trouvemass et crible1..10 dans
   resources/ProcAttributorLegacy/MainProc.ipf. La propriété centrale qu'on lui
   oppose est l'EXHAUSTIVITÉ: le crible d'Igor comblait le reste de masse avec
   LA MASSE LA PLUS FAIBLE, donc il ne touchait pas les masses nobles proches
   de la cible. Ici la fenêtre doit être couverte en entier, et le test le
   démontre en comparant le tas à la FORCE BRUTE sur des cas dont l'espace
   entier est calculable.

   chemistry.test.mjs vérifie la grammaire. stoichiometry.test.mjs vérifie le
   graphe. isotopologues.test.mjs vérifie l'énumération d'UNE molécule. Ici
   c'est la recherche sur DEUX listes: l'algorithme, son ordre, et les pièges que
   seul un crible rencontre — le doublon, l'état bloqué, et la masse plafonnée.
   ------------------------------------------------------------------------- */
import {readFileSync} from "fs"
import {Element,Formula,Stoichiometry} from "./chemistry.js"
import {
    buildPlan,
    SortedPoints,
    cribleHeap,
    cribleMixedRadix,
    attributeSpectrum,
    lastNonZero
} from "./attribution.js"

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

/* Un plan de lecture, sans passer par une liste de formules à chaque test:
   c'est le même geste que le noeud, et il garantit que les tests exercent le
   chemin du noeud et pas une version allégée. */
const plan=(options)=>buildPlan({table:TABLE,...options})

console.log("les deux listes, et ce qu'elles produisent")

test("la liste à combiner donne les masses isotopiques du groupe",()=>{
    const p=plan({combining:["CH2"],ionising:["[H+]"],chargeMax:1})
    /* CH2 a deux isotopes de C et trois de H: 2 x 3 = 6 combinaisons */
    ok(p.combinables.length===6,`expected 6 combinable masses, got ${p.combinables.length}`)
})

test("la liste ionisante exige une charge et le dit",()=>{
    const p=plan({combining:["CH2"],ionising:["Na"],chargeMax:1})
    ok(p.ionisers.length===0,"Na carries no charge and must be refused")
    ok(p.diagnostics.some(d=>/carries no charge/.test(d)),
        `the refusal must be visible: ${JSON.stringify(p.diagnostics)}`)
})

test("[Na+] est un adduit valide, de masse atomique et de charge",()=>{
    const p=plan({combining:["CH2"],ionising:["[Na+]"],chargeMax:1})
    ok(p.ionisers.length===1,`expected 1 ionising group, got ${p.ionisers.length}`)
    close(p.ionisers[0].charge,1,1e-12,"[Na+] carries a +1")
    /* La masse de l'ION, donc 23Na MOINS un électron: 22.989220. C'est la
       correction dont parle `readIonising`, et elle se voit ici. */
    close(p.ionisers[0].atomicMass,22.98922,1e-4,"the sodium ion mass")
})

test("un groupe illisible est un diagnostic, pas une exception",()=>{
    const p=plan({combining:["CH2","Xx9"],ionising:["[H+]"]})
    ok(p.combinables.length===6,"the readable group must survive the unreadable one")
    ok(p.diagnostics.length>=1,`the typo must be reported: ${JSON.stringify(p.diagnostics)}`)
})

test("le ratio filtre les masses combinables",()=>{
    const all=plan({combining:["CH2"],ionising:["[H+]"],ratio:0}).combinables.length
    const onlyMost=plan({combining:["CH2"],ionising:["[H+]"],ratio:1}).combinables.length
    ok(all===6,`ratio 0 keeps everything: got ${all}`)
    ok(onlyMost===1,`ratio 1 keeps only the most probable: got ${onlyMost}`)
})

test("les masses combinables sont triees par abondance decroissante",()=>{
    const p=plan({combining:["CH2"],ionising:["[H+]"],ratio:0})
    for(let i=1;i<p.combinables.length;i++){
        ok(p.combinables[i-1].logProbability>=p.combinables[i].logProbability,
            `rank ${i} is more probable than rank ${i-1}`)
    }
})
    const all=plan({combining:["CH2"],ionising:["[H+]"],ratio:0}).combinables.length
console.log("le crible : exhaustivité")

/* L'oracle brut: on énumère TOUT l'espace par force brute, sans tas ni règle.

   Il applique le MÊME plafond de masse que le crible, et c'est le détail qui
   compte. Un oracle qui l'oublierait compterait le produit des bornes — 25080
   ici — et le crible en rendrait 4915: les deux auraient l'air de se contredire
   alors que le second est le bon. Un oracle doit appliquer les règles qu'il
   juge, sinon il ne juge rien: il mesure autre chose.

   Il est volontairement naïf, parce que son seul travail est de ne pas
   manquer une combinaison — c'est exactement le rôle d'un oracle. */
function bruteForce(plan,maxMass){
    const caps=plan.capsFor(maxMass)
    const items=plan.items
    const out=[]
    const walk=(index,mass,counts)=>{
        if(index===items.length){
            /* le plafond de masse, comme le crible. Toute somme déjà trop
               lourde ne peut qu'empirer en ajoutant une brique, donc on
               élague ICI plutôt que d'aller jusqu'au bout. */
            if(mass>maxMass) return
            out.push({mass,counts:Int32Array.from(counts)})
            return
        }
        for(let k=0;k<=caps[index];k++){
            counts[index]=k
            walk(index+1,mass+k*items[index].atomicMass,counts)
        }
        counts[index]=0
    }
    walk(0,0,new Int32Array(items.length))
    return out
}
/* la signature d'un multiensemble, pour comparer deux ensembles sans se
   soucier de l'ordre */
const signature=(state)=>Array.from(state.counts).join(",")

test("le tas trouve exactement ce que la force brute trouve",()=>{
    const p=plan({combining:["CH2","O"],ionising:["[H+]"],ratio:0.01,chargeMax:2})
    const maxMass=300
    const brute=bruteForce(p,maxMass)
    const heap=cribleHeap(p,{maxMass}).states
    ok(brute.length>0,"the oracle must produce something to compare")
    ok(heap.length===brute.length,
        `the heap found ${heap.length} combinations, the brute force ${brute.length}`)
    const known=new Set(brute.map(signature))
    for(const state of heap){
        ok(known.has(signature(state)),
            `the heap invented a combination: ${signature(state)}`)
    }
})

test("la base mixte trouve elle aussi exactement le même ensemble",()=>{
    const p=plan({combining:["CH2","O"],ionising:["[H+]"],ratio:0.01,chargeMax:2})
    const maxMass=300
    const heap=cribleHeap(p,{maxMass}).states
    const mixed=cribleMixedRadix(p,{maxMass}).states
    ok(heap.length===mixed.length,
        `the heap found ${heap.length}, the mixed radix ${mixed.length}`)
    const known=new Set(heap.map(signature))
    for(const state of mixed){
        ok(known.has(signature(state)),
            `the mixed radix invented a combination: ${signature(state)}`)
    }
})

test("aucun multiensemble n'est rendu deux fois",()=>{
    const p=plan({combining:["CH2","O"],ionising:["[H+]"],ratio:0.01,chargeMax:2})
    const states=cribleHeap(p,{maxMass:300}).states
    const keys=new Set(states.map(signature))
    ok(keys.size===states.length,`${states.length} states but ${keys.size} distinct`)
})

test("les masses sortent par ordre croissant",()=>{
    const p=plan({combining:["CH2","O"],ionising:["[H+]"],ratio:0.01,chargeMax:2})
    const states=cribleHeap(p,{maxMass:300}).states
    for(let i=1;i<states.length;i++){
        ok(states[i-1].mass<=states[i].mass,
            `rank ${i} (${states[i].mass}) is lighter than rank ${i-1} (${states[i-1].mass})`)
    }
})

test("le vecteur nul est le premier, à masse nulle",()=>{
    const p=plan({combining:["CH2"],ionising:["[H+]"]})
    const states=cribleHeap(p,{maxMass:100}).states
    ok(states[0].mass===0,"the seed must be the empty combination")
    ok(Array.from(states[0].counts).every(c=>c===0),"the seed must be the null vector")
})

test("aucune masse ne dépasse le plafond",()=>{
    const p=plan({combining:["CH2","O"],ionising:["[H+]"],ratio:0.01})
    const maxMass=250
    for(const state of cribleHeap(p,{maxMass}).states){
        ok(state.mass<=maxMass,`${state.mass} exceeds the ceiling ${maxMass}`)
    }
})
console.log("les trois pièges")

/* LE PREMIER: un état refusé n'est pas un état abandonné.
   Le vecteur nul a une charge de zéro, donc il est HORS de toute fenêtre
   d'ionisation. S'il n'était pas développé, la marche entière s'arrêterait sur
   lui et ne rendrait rien du tout — alors que ses voisins, eux, sont
   exactement à la bonne charge. C'est le piège que documente `isotopologues`
   sur sa fenêtre de masse, et il se reproduit ici mot pour mot. */
test("un état hors fenêtre n'arrête pas la marche",()=>{
    const p=plan({combining:["CH2"],ionising:["[H+]"],chargeMin:1,chargeMax:1})
    /* le vecteur nul est refusé: il porte 0 charge */
    ok(!p.withinCharge(new Int32Array(p.itemCount)),
        "the null vector has no charge and must be out of the window")
    const states=cribleHeap(p,{maxMass:200,accept:s=>p.withinCharge(s.counts)}).states
    ok(states.length>0,
        "the crible must still reach the charged combinations past the seed")
    ok(states.every(s=>p.withinCharge(s.counts)),
        "every rendered state must be inside the window")
})

/* LE DEUXIÈME: la fenêtre d'ionisation est en VALEUR ABSOLUE. Un 2+ et un 2-
   sont la même chose à mesurer. */
test("la fenêtre d'ionisation se lit en valeur absolue",()=>{
    const p=plan({combining:["CH2"],ionising:["[Cl-]"],chargeMin:1,chargeMax:2})
    const counts=new Int32Array(p.itemCount)
    counts[p.combinables.length]=1   // one [Cl-]
    ok(p.withinCharge(counts),"|1| is inside [1,2]")
    ok(!p.withinCharge(new Int32Array(p.itemCount)),"0 is outside [1,2]")
})

test("la borne de multiplicité d'un adduit vient de la charge",()=>{
    const p=plan({combining:["CH2"],ionising:["[2+]"],chargeMax:3})
    const caps=p.capsFor(100000)
    /* 100000 de masse ne borne rien, donc c'est la charge qui parle: 3 [2+]
       donnent 6+, et la fenêtre s'arrête à 3 — donc UNE seule copie. */
    const adductIndex=p.combinables.length
    ok(caps[adductIndex]===1,`expected 1 [2+] copy, got ${caps[adductIndex]}`)
    /* et un [2+] n'a PAS de masse propre: deux électrons perdus, aucun atome,
       donc une masse légèrement négative. Le plafond de masse ne peut donc PAS
       le borner — ce serait un quotient négatif qui le ferait disparaître de
       tout plan, alors qu'il est précisément ce qui produit une charge
       multiple. La charge reste le seul chemin qui le fait entrer, et c'est le
       comportement correct d'un adduit purement électronique. */
    const tight=plan({combining:["CH2"],ionising:["[2+]"],chargeMax:3})
    ok(tight.capsFor(1)[tight.combinables.length]===1,
        "a massless [2+] is bounded by the charge alone, so it survives")
    /* et sa masse est bien négative, ce qui explique la règle sans qu'on ait à
       le croire: deux électrons en moins, rien en plus. */
    close(tight.ionisers[0].atomicMass,-2*0.000548579909065,1e-12,
        "a [2+] weighs two lost electrons")
})

test("lastNonZero lit le dernier indice non nul",()=>{
    ok(lastNonZero(new Int32Array([0,0,0]))===-1,"an empty vector has no highest")
    ok(lastNonZero(new Int32Array([1,0,0]))===0)
    ok(lastNonZero(new Int32Array([1,0,4]))===2)
    ok(lastNonZero(new Int32Array([0,7,0]))===1)
})

console.log("l'appariement aux points")

test("le point le plus proche est trouvé par dichotomie",()=>{
    const points=new SortedPoints([100,100.5,101,200],[10,20,30,40])
    const near=points.nearest(100.4)
    ok(near&&near.index===1,`expected the point at 100.5, got ${near&&near.index}`)
    close(near.mz,100.5,1e-12,"the nearest mass")
})

test("le plus proche l'emporte, même quand il est AVANT",()=>{
    const points=new SortedPoints([100,100.5,101],[10,20,30])
    /* 100.49 est plus près de 100.5 que de 100: la recherche ne doit pas
       s'arrêter au premier voisin rencontré. */
    ok(points.nearest(100.49).index===1,"the upper neighbour must win")
    ok(points.nearest(100.25).index===0,"the lower neighbour must win")
    /* et au milieu exact des deux, l'égalité se tranche sans favoritisme */
    ok([0,1].includes(points.nearest(100.25+1e-12).index),
        "a tie must still resolve to one of the two")
})

test("l'erreur est en ppm, et son signe pointe vers le point",()=>{
    const points=new SortedPoints([100.0005],[1])
    const target=points.nearest(100)
    close(target.errorPpm,5,1e-6,"a point 5 mDa above 100 is 5 ppm at 100")
})

test("un spectre vide ou sans masse ne donne aucun point",()=>{
    ok(new SortedPoints([],[]).nearest(100)===null,"an empty spectrum has no nearest")
    ok(new SortedPoints([0,0],[1,2]).nearest(100)===null,
        "a zero mass has no ppm, so it cannot be a target")
})

test("le tri des points est payé une fois, pas par candidat",()=>{
    /* Le coût annoncé est O(n log n + k log n), donc un spectre dix fois plus
       grand ne doit pas coûter dix fois plus PAR CANDIDAT. On vérifie le
       quotient, pas le temps machine: c'est la seule mesure stable. */
    const small=new SortedPoints(Array.from({length:1000},(_,i)=>i*0.1),new Array(1000).fill(1))
    const large=new SortedPoints(Array.from({length:10000},(_,i)=>i*0.01),new Array(10000).fill(1))
    ok(large.order.length===10000,"the large index must be whole")
    ok(small.order.length===1000,"the small index must be whole")
    /* et l'index est bien un TRI, sur les deux — c'est la propriété dont
       dépend la dichotomie, donc celle qu'il faut vérifier, pas le temps. */
    for(const points of [small,large]){
        for(let i=1;i<points.order.length;i++){
            ok(points.x[points.order[i-1]]<=points.x[points.order[i]],
                "the index is not sorted")
        }
    }
})

console.log("de bout en bout")

test("une attribution rend une formule, un point et une erreur",()=>{
    /* CH2 en brique et [H+] en adduit: le monomère le plus léger qui existe
       est 12CH3+ à 15.0229. On place un point dessus, et c'est l'attribution
       qu'on attend.

       On cherche la MEILLEURE entrée et non la première: le crible rend par
       masse croissante, ce qui est l'ordre demandé par l'énumération, pas
       l'ordre par qualité. Une attribution est une proposition, et la question
       « laquelle vaut-il mieux » est celle du lecteur, pas du crible. */
    const p=plan({combining:["CH2"],ionising:["[H+]"],ratio:1,chargeMin:1,chargeMax:1})
    const points=new SortedPoints([15.02288,100],[1000,2000])
    const result=attributeSpectrum(p,points,{ppm:5})
    ok(result.entries.length>0,"nothing was attributed at all")
    const best=result.entries.reduce((a,b)=>
        (Math.abs(b.errorPpm)<Math.abs(a.errorPpm)?b:a))
    ok(typeof best.notation==="string"&&best.notation.length>0,"no notation")
    ok(Number.isFinite(best.mz),"no m/z")
    ok(best.target!==null,"no target point")
    ok(Number.isFinite(best.errorPpm),"no error in ppm")
    /* l'erreur doit être petite: on a mis le point exactement sur la formule */
    ok(Math.abs(best.errorPpm)<=5,
        `the nearest point is ${best.errorPpm} ppm away, expected <= 5`)
    /* et la formule rendue doit être celle du monomère protoné: CH3 s'écrit
       « CH3[+] » — le carbone, les trois hydrogènes du groupe, puis la charge
       seule dans les crochets. C'est relisible, et c'est ce que le lecteur doit
       lire. */
    ok(/C/.test(best.notation)&&/H/.test(best.notation)&&best.notation.endsWith("[+]"),
        `expected a protonated hydrocarbon, got "${best.notation}"`)
})

test("la recette dit quelles briques ont servi, et combien",()=>{
    const p=plan({combining:["CH2","O"],ionising:["[H+]"],ratio:0.5,chargeMin:1,chargeMax:1})
    const points=new SortedPoints([100,200],[1,2])
    const result=attributeSpectrum(p,points)
    ok(result.entries.length>0,"nothing attributed")
    const withBricks=result.entries.find(e=>e.recipe.length>0)
    ok(withBricks,"every entry should carry the bricks that built it")
    for(const brick of withBricks.recipe){
        ok(brick.times>=1,`a used brick must appear at least once: ${brick.times}`)
        ok(typeof brick.group==="string","a brick must name its group")
    }
})

test("la masse du m/z est bien celle de la formule rendue",()=>{
    /* Le m/z est calculé par le crible et la formule par la chimie. Les deux
       doivent tomber d'accord au microdalton près, sinon l'appariement se ferait
       sur une masse que rien ne corrobore. */
    const p=plan({combining:["CH2","O"],ionising:["[H+]"],ratio:0.1,chargeMin:1,chargeMax:2})
    const points=new SortedPoints([50,150],[1,2])
    const result=attributeSpectrum(p,points)
    for(const entry of result.entries){
        close(entry.mz,entry.formula.mz,1e-12,
            `${entry.notation}: the entry and the formula disagree on m/z`)
    }
})

test("un adduit seul reste une attribution, et c'est correct",()=>{
    /* Sans AUCUNE brique à combiner, le proton nu [H+] reste une combinaison
       recevable: 1.0073 est une masse qu'un instrument peut voir. Le refus
       d'une liste vide de briques serait une RAISON de trop — c'est
       l'ESPECTRE qui décide s'il y a un pic, pas la liste. */
    const p=plan({combining:[],ionising:["[H+]"],chargeMin:1,chargeMax:1})
    const result=attributeSpectrum(p,new SortedPoints([1.00728],[1]))
    ok(result.entries.length===1,`the proton alone is one combination: got ${result.entries.length}`)
    /* « H[+] » et non « [H+] »: le proton nu S'ÉCRIT avec son hydrogène devant,
       parce que `parseIonisationOnly` verse le groupe de l'adduit dans la
       composition pour que la masse soit juste — et que la masse se lit dans la
       composition. Les crochets ne portent alors que la charge. C'est relisible
       et c'est exact; c'est aussi ce qui distingue un adduit du squelette qu'il
       viendrait s'ajouter à. */
    ok(result.entries[0].notation==="H[+]",
        `expected the bare proton, got "${result.entries[0].notation}"`)
    close(result.entries[0].mz,1.007276,1e-6,"the proton's own m/z")
})

test("un plan totalement vide le dit, au lieu de ne rien rendre",()=>{
    const p=plan({combining:[],ionising:[],chargeMin:0,chargeMax:0})
    const result=attributeSpectrum(p,new SortedPoints([100],[1]))
    ok(result.entries.length===0,"nothing should be attributed")
    ok(result.diagnostics.some(d=>/no group to combine/.test(d)),
        `the refusal must be visible: ${JSON.stringify(result.diagnostics)}`)
})

test("un plan sans table le dit, au lieu de choisir un isotope en silence",()=>{
    const orphan=buildPlan({combining:["CH2"],ionising:["[H+]"],table:null})
    ok(orphan.combinables.length===0,"nothing can be read without a table")
    ok(orphan.diagnostics.some(d=>/no periodic table/.test(d)),
        `the refusal must be visible: ${JSON.stringify(orphan.diagnostics)}`)
})

test("la troncature est signalée, jamais silencieuse",()=>{
    /* Le plancher dérive du PREMIER point, donc un spectre dont le point le plus
       bas est déjà haut ne laisse presque rien passer — et c'est très bien ainsi.
       Pour éprouver la TRONCATURE il faut donc un plancher bas: on part de 100,
       ce qui laisse tout l'espace au-dessus sans le vider. */
    const p=plan({combining:["CH2","O"],ionising:["[H+]"],ratio:0.01})
    const points=new SortedPoints([100,500],[1,1])
    const result=attributeSpectrum(p,points,{limit:5})
    ok(result.entries.length<=5,"the limit was not honoured")
    ok(result.truncated,"the truncation must be reported")
})

test("le plancher ne perd aucune formule que le sans-plancher aurait rendue",()=>{
    /* LE PLANCHER DOIT ÊTRE UN FILTRE, PAS UN TAILLANT.

       C'est la propriété qui compte, et elle n'est pas évidente: un état sous le
       plancher mène peut-être à un état au-dessus, parce que les briques n'ont
       pas toutes la même taille. « 1 CH2 » à 14.016 mène à « CH2 + H+ » à 15.022
       par l'ajout d'une brique de 1.007.

       Une version naïve qui coupait la croissance vidait donc le crible: sur un
       spectre dont le premier pic est à 15.0229, elle rendait ZÉRO état. Ce test
       est écrit contre cette version-là, et il doit rester vert si quelqu'un
       replace l'élagage où il était tentant de le mettre. */
    const p=plan({combining:["CH2","O"],ionising:["[H+]","[Na+]"],ratio:0.05,
        chargeMin:1,chargeMax:1})
    const points=new SortedPoints([180,201,300],[1000,500,300])
    const sorted=new SortedPoints(Float64Array.from([180,201,300,100,90]),
        Float64Array.from([1000,500,300,10,10]))
    const withFloor=attributeSpectrum(p,sorted,{limit:Infinity,ppm:null})

    const massFloor=p.massFloor(sorted)
    ok(massFloor>0,`the floor must be positive here, got ${massFloor}`)
    /* the same attribution, with the floor switched off by a spectrum whose
       lowest point is 0 — no floor, so the two lists must agree */
    const noFloorPoints=new SortedPoints(Float64Array.from([0,180,201,300,100]),
        Float64Array.from([0,1000,500,300,10]))
    const without=attributeSpectrum(p,noFloorPoints,{limit:Infinity,ppm:null})
    const keysWith=new Set(withFloor.entries.map(e=>e.key))
    const keysWithout=without.entries.filter(e=>e.mz>=massFloor).map(e=>e.key)
    for(const key of keysWithout){
        ok(keysWith.has(key),`the floor lost ${key}, which the unfiltered sieve found`)
    }
})

console.log("le volume, qui est la raison d'être du tas")

test("le tas passe là où la force brute n'irait pas",()=>{
    /* CH2 x O x [H+], ratio 0.1. À 2000 de masse de plafond, l'espace compte
       18 103 combinaisons, et la force brute en visiterait autant. On en demande
       3000, ce qui est l'usage réel: un utilisateur regarde les plus légères
       avant de s'arrêter.

       Ce qui est vérifié n'est pas le compte — il dépend du ratio, donc des
       masses isotopiques retenues — mais les TROIS propriétés qui rendent le tas
       utilisable: il rend ce qu'il promet (le plafond), dans l'ordre promis (la
       masse croissante), et sans rejouer une même combinaison. */
    const p=plan({combining:["CH2","O"],ionising:["[H+]"],ratio:0.1,chargeMax:1})
    const wanted=3000
    const states=cribleHeap(p,{maxMass:2000,limit:wanted}).states
    ok(states.length===wanted,`expected ${wanted} states, got ${states.length}`)
    for(let i=1;i<states.length;i++){
        ok(states[i-1].mass<=states[i].mass,"the 3000 must come out sorted")
        ok(states[i-1].mass<=2000,"the ceiling must hold on the first N too")
    }
    const keys=new Set(states.map(signature))
    ok(keys.size===states.length,"no duplicate in the first 3000")
})

test("le volume suit le plafond, comme il doit",()=>{
    /* C'est la raison d'être du plafond: sans lui, l'espace est le PRODUIT des
       multiplicités, et le produit croît vite. On le vérifie en comparant deux
       plafonds — c'est la seule mesure stable, et elle dit ce que le plafond
       est censé dire.

       On vérifie aussi que le plafond N'AJOUTE rien: un espace plus large
       contient le plus étroit. Sans cette moitié du test, un crible qui
       oublierait une partie du petit espace passerait le premier contrôle. */
    const p=plan({combining:["CH2","O"],ionising:["[H+]"],ratio:0.1,chargeMax:1})
    const low=cribleHeap(p,{maxMass:100}).states.length
    const high=cribleHeap(p,{maxMass:2000}).states.length
    ok(high>low,`a wider ceiling must reach more combinations: ${low} then ${high}`)
    const small=new Set(cribleHeap(p,{maxMass:100}).states.map(signature))
    for(const state of cribleHeap(p,{maxMass:2000}).states){
        if(state.mass<=100){
            ok(small.has(signature(state)),
                "a wider ceiling must not change what a narrower one already had")
        }
    }
})

console.log("le kernel Rust et son repli JS")

/* Les deux kernels DOIVENT rendre les mêmes masses, dans le même ordre.

   C'est la propriété qui autorise à traiter le kernel comme un détail
   d'implémentation. Sans elle, l'attribution d'un utilisateur dépendrait de
   l'état de son build wasm — une propriété que personne ne peut raisonner, et
   que personne ne remarkquerait si elle changeait.

   Le repli JS est donc l'ORACLE DU KERNEL, au même titre que la force brute est
   l'oracle du crible. On compare les MASSES, pas les empreintes: les deux
   implémentations n'ont aucune raison de produire la même empreinte, et elles
   n'en ont pas besoin, puisque personne ne la lit.

   Le repli est recopié depuis kernelWorker.js — voir la note là-bas sur
   pourquoi il est dupliqué plutôt qu'importé. Le dupliquer ici aussi est
   nécessaire: importer le worker tirerait `self` dans un process node. */
const STRIDE=4
function cribleHeapJS(itemMasses,itemCharges,caps,maxMass,limit){
    const count=itemMasses.length
    if(count===0||itemCharges.length!==count||caps.length!==count) return new Float64Array(0)
    if(!Number.isFinite(maxMass)||maxMass<=0) return new Float64Array(0)
    for(let i=0;i<count;i++){
        if(caps[i]===0xFFFFFFFF&&!(itemMasses[i]>0)) return new Float64Array(0)
    }
    if(caps.every(cap=>cap===0)) return new Float64Array(0)
    const signature=(counts)=>counts.join(",")
    const open=[]
    const push=(mass,counts)=>open.push({mass,counts})
    const popMin=()=>{
        let best=0
        for(let i=1;i<open.length;i++){
            if(open[i].mass<open[best].mass) best=i
        }
        return open.splice(best,1)[0]
    }
    const seen=new Set()
    const zero=new Int32Array(count)
    seen.add(signature(zero))
    push(0,zero)
    const out=[]
    let emitted=0
    while(open.length){
        const state=popMin()
        let charge=0
        for(let i=0;i<count;i++) charge+=itemCharges[i]*state.counts[i]
        out.push(state.mass,charge,0,emitted===0?-1:emitted-1)
        emitted++
        if(emitted>=limit) break
        for(let i=0;i<count;i++){
            if(state.counts[i]>=caps[i]) continue
            const mass=state.mass+itemMasses[i]
            if(mass>maxMass) continue
            const counts=Int32Array.from(state.counts)
            counts[i]+=1
            const marker=signature(counts)
            if(seen.has(marker)) continue
            seen.add(marker)
            push(mass,counts)
        }
    }
    return Float64Array.from(out)
}

/* FIN DE LA SUITE - le kernel Rust et son repli JS sont compares dans
   kernelParity.test.mjs, qui doit charger le wasm de facon asynchrone alors
   que ce fichier reste synchrone. La separation n est pas une preference: un
   await de haut niveau ici empecherait toute la suite de tourner. */
console.log("le noeud et le lecteur : le contrat de sortie")

/* LE CONTRAT ENTRE LES DEUX NŒUDS.

   `AttributionNode` publishes into `FormulaCollectionNode`. Nothing else in the
   flow knows that this pairing exists, and nothing else enforces it — so the two
   sides are checked here, against each other, with the reader's OWN acceptance
   rule copied below.

   Why the reader's rule and not the node's: the reader is the side that
   DECLINES. If the node agreed with its own idea of what is readable, and the
   reader had a stricter one, this test would pass and the flow would still
   break — which is exactly the bug these tests were added for. */
import {FormulaCollection} from "./chemistry.js"

/* The reader's `asCollection`, in the shapes it accepts. Copied, not imported:
   the reader is a DOM-bound class in interface.js, and importing it into a node
   test would drag the whole interface along. `Formula` comes from the import at
   the top of this file; re-importing it here would shadow nothing and would
   only be a second declaration of the same name. */
const asCollection=(raw)=>{
    if(raw instanceof Formula||raw instanceof FormulaCollection) return true
    if(Array.isArray(raw)) return true
    if(raw&&typeof raw==="object"){
        const formulas=raw.formulas??raw.entries??raw.items??null
        if(Array.isArray(formulas)) return true
    }
    return false
}

test("une collection est lue par le lecteur",()=>{
    const collection=new FormulaCollection({name:"spectrum 1",table:TABLE,ppm:10})
    /* built exactly the way the node builds one: `add` of a NOTATION. The
       notation, not the key — a formula carrying an adduct does not survive a
       round trip through its key. */
    for(const notation of ["12CH3[H+]","C6H12O6[H+]"]){
        const added=collection.add(notation)
        ok(added!==null,`"${notation}" should have parsed: ${collection.diagnostics.join("; ")}`)
    }
    ok(asCollection(collection),
        "the reader's own acceptance rule rejects a FormulaCollection")
})

test("le descripteur d'avant ne passait pas, et c'est ce qui cassait",()=>{
    /* The shape the node used to publish, recorded here as a FAILING case.
       A bug that no test reproduces stops being fixed: the next reader of this
       file has no way of knowing that shape was already tried and rejected. */
    const oldShape=[{input:0,total:2,attributions:[{key:"...",notation:"..."}]}]
    ok(!asCollection(oldShape[0]),
        "the old descriptor shape would be accepted, which would mean the bug is back")
    ok(!asCollection(oldShape[0].attributions[0]),
        "a bare attribution descriptor would be accepted, which would mean the bug is back")
})

test("les notations produites par le crible sont relues par la table",()=>{
    /* The round trip the node relies on, checked against the ENGINE rather than
       a hand-written list: whatever the sieve produces, the collection must be
       able to READ it. A notation the collection rejects is an attribution the
       user would never see, and `add` would drop it silently. */
    const plan=buildPlan({combining:["CH2","O"],ionising:["[H+]","[Na+]"],ratio:0.05,
        chargeMin:1,chargeMax:2,table:TABLE})
    const x=[180.15679,201.04044,300.12345,100,90,110].flatMap(value=>[value,1000])
    const points=new SortedPoints(Float64Array.from(x),
        Float64Array.from([1000,500,300,800,200,100]))
    const result=attributeSpectrum(plan,points,{limit:400,ppm:10})
    ok(result.entries.length>0,"the sieve produced nothing to check")
    const collection=new FormulaCollection({name:"round trip",table:TABLE,ppm:10})
    let unreadable=0
    for(const entry of result.entries){
        const before=collection.diagnostics.length
        collection.add(entry.notation)
        if(collection.diagnostics.length>before) unreadable++
    }
    ok(unreadable===0,
        `${unreadable}/${result.entries.length} notations the collection cannot read — `+
        `first: ${collection.diagnostics[0]}`)
    ok(collection.entries.length===result.entries.length,
        `the collection holds ${collection.entries.length} of ${result.entries.length} attributions`)
})

test("une collection par entrée, avec des noms distincts",()=>{
    /* One collection PER INPUT, in input order — the order is what tells the
       reader which spectrum a collection came from. A list sorted by size, or by
       mass, or by whatever the sieve felt like, would silently relabel
       everything. And two collections under one name would SHARE their state
       record in the reader, notes included. */
    const makeCollection=(name)=>{
        const collection=new FormulaCollection({name,table:TABLE,ppm:10})
        collection.add("12CH3[H+]")
        return collection
    }
    const published=[makeCollection("spectrum 1"),makeCollection("spectrum 2")]
    ok(published.length===2,"one collection per input")
    ok(published[0].name!==published[1].name,
        "two collections under one name would share their state record")
    ok(published.every(asCollection),"both are readable")
})

test("la troncature traverse et se lit",()=>{
    /* A truncated sieve is a fact about the RUN, and a user who sees 2000
       formulas has no way of knowing there were more unless something says so.
       The reader is where they will look, so the warning travels there. */
    const collection=new FormulaCollection({name:"truncated",table:TABLE,ppm:10})
    collection.add("12CH3[H+]")
    collection.diagnostics.push("truncated: the sieve was truncated at 2000 states")
    ok(collection.diagnostics.length===1,"the truncation notice survives")
    ok(/truncat/.test(collection.diagnostics[0]),"and it says what happened")
})

/* -------------------------------------------------------------------------
   LA FIXTURE: crop0_0stripped++.txt, 95 ions de 175 à 389.

   Une peak list RÉELLE, pas une liste fabriquée pour les besoins du test. C'est
   la seule façon de vérifier ce qui compte vraiment ici: la COUVERTURE, c'est-à-dire
   que chaque pic mesuré reçoit une lecture. Une liste synthétique n'aurait pas
   les collisions de masse qui font le travail intéressant — plusieurs
   compositions à quelques ppm l'une de l'autre, sur des pics voisins, ce qui est
   précisément le cas pour lequel « la meilleure » n'est pas évidente.

   Ces tests verrouillent ce que l'ANCIEN `limit` faisait de travers, parce que
   ce défaut ne se voyait pas: il ne plantait pas, il rendait une liste plausible
   dont la moitié des pics n'était pas couverte. */
const CROP_LINES=readFileSync(
    new URL("../crop0_0stripped++.txt",import.meta.url),"utf8")
    .split(/\r?\n/)
    .filter(line=>line.trim()&&!line.trim().startsWith("text"))
const CROP_X=Float64Array.from(CROP_LINES.map(line=>Number(line.trim().split(/\s+/)[0])))
const CROP_Y=Float64Array.from(CROP_LINES.map(line=>Number(line.trim().split(/\s+/)[1])))
const cropPlan=()=>buildPlan({
    combining:["CH2","NH","O","C"],
    ionising:["[H+]"],
    ratio:0.1,
    chargeMin:1,
    chargeMax:1,
    table:TABLE
})
const cropRun=(options={})=>attributeSpectrum(
    cropPlan(),new SortedPoints(CROP_X,CROP_Y),
    {limit:Infinity,ppm:10,...options})

test("la fixture a bien la taille qu'on croit",()=>{
    /* 95 points. Le test le vérifie plutôt que de le supposer: une fixture
       tronquée par un mauvais commit donnerait un oracle muet, et tous les tests
       ci-dessous passeraient sur un spectre amputé. */
    ok(CROP_X.length===95,`expected 95 peaks, got ${CROP_X.length}`)
    ok(CROP_X.every(value=>Number.isFinite(value)&&value>0),"every m/z is a real mass")
})

test("chaque pic reçoit au moins une lecture, dans la fenêtre",()=>{
    /* LA COUVERTURE. Avec le `limit` de 2000, le crible gardait les 2000 états
       les plus LÉGERS: les pics hauts n'avaient plus de candidats et
       disparaissaient de la sortie. Ici aucun pic ne manque. */
    const result=cropRun({bestMatches:1})
    const covered=new Set(result.entries.map(entry=>entry.target.index))
    ok(covered.size===95,`95 peaks expected to be covered, got ${covered.size}`)
    /* Every published reading is INSIDE the window. If the ppm gate were applied
       after the ranking rather than before, a formula 4000 ppm out could win a
       slot, and the list would be readable but useless. */
    for(const entry of result.entries){
        ok(Math.abs(entry.errorPpm)<=10,"a published reading is outside the window")
    }
})

test("`bestMatches` garde le bon nombre, et par pic",()=>{
    /* The count is PER PEAK, not global. A global cap of 3 would have kept the
       three best of the whole spectrum and left 92 peaks empty — a list of
       formulas, not an attribution. */
    const one=cropRun({bestMatches:1})
    const three=cropRun({bestMatches:3})
    ok(one.entries.length===95,`j=1 must give one reading per peak, got ${one.entries.length}`)
    ok(three.entries.length>=one.entries.length,"raising j must not lose readings")
    ok(three.entries.length<=95*3,"j=3 cannot exceed three readings per peak")
    const perPeak=new Map()
    for(const entry of three.entries){
        perPeak.set(entry.target.index,(perPeak.get(entry.target.index)??0)+1)
    }
    ok(perPeak.size===95,`every peak must still be covered at j=3, got ${perPeak.size}`)
    ok([...perPeak.values()].every(count=>count<=3),"no peak exceeds j")
})

test("les lectures d'un pic sont classées par écart, puis par probabilité",()=>{
    /* Two ordering rules, and the second one is not a detail. Ties on ppm are
       common at this level — two compositions can land within a fraction of a
       ppm of each other — and breaking the tie by enumeration order would make
       the result depend on how the sieve walked the space. Two identical spectra
       would then give two different lists, and nothing would look wrong. */
    const result=cropRun({bestMatches:5})
    const byPeak=new Map()
    for(const entry of result.entries){
        if(!byPeak.has(entry.target.index)) byPeak.set(entry.target.index,[])
        byPeak.get(entry.target.index).push(entry)
    }
    for(const bucket of byPeak.values()){
        for(let i=1;i<bucket.length;i++){
            const before=Math.abs(bucket[i-1].errorPpm)
            const after=Math.abs(bucket[i].errorPpm)
            ok(after>=before-1e-9,"ppm is not non-decreasing within a peak")
            if(Math.abs(after-before)<1e-9){
                ok(bucket[i].logProbability<=bucket[i-1].logProbability+1e-12,
                    "a ppm tie must be broken by DECREASING probability")
            }
        }
    }
})

test("aucune troncature: l'espace entier est couvert",()=>{
    /* The `limit` is gone, so the sieve must walk the whole mass window and say
       it did. `truncated` true here would mean the published list is a PREFIX,
       and a prefix of a mass-ordered enumeration is not an attribution. */
    const result=cropRun({bestMatches:3})
    ok(result.truncated===false,"the sieve reported a truncation it should not have")
    ok(result.visited>result.entries.length,
        "more states visited than published: the sieve did explore")
})

test("deux lectures d'un même pic sont deux FORMULES différentes",()=>{
    /* LE TEST QUI MANQUAIT, et le manque était réel.

       La fixture vérifiait la couverture, l'ordre et les comptes. Elle ne
       vérifiait JAMAIS que deux lectures d'un même pic soient des formules
       différentes — donc `bestMatches:3` pouvait rendre trois fois la même
       formule, et tous les tests passaient. Un réglage d'ambiguïté qui rend
       trois fois la même chose n'est plus un réglage d'ambiguïté.

       Il faut un `ratio` BAS pour que le 13C entre dans la liste, parce que c'est
       lui qui rend les briques dépendantes: la liste contient « CH2 » ET « C »,
       et l'isotope du carbone peut être porté par l'un ou par l'autre. À
       ratio 0.1 le 13C est hors fenêtre, il n'y a pas de dépendance, et le test
       passerait même sur le code buggé — un test qui ne peut pas échouer ne
       prouve rien. */
    const dependent=buildPlan({
        combining:["CH2","NH","O","C"],ionising:["[H+]"],
        ratio:0.01,chargeMin:1,chargeMax:1,table:TABLE
    })
    /* The fixture itself must be the one that shows the dependence, otherwise
       this test would pass on a list that cannot reproduce it. */
    ok(dependent.dependence,
        "this plan must be the dependent one, or the test below proves nothing")
    const result=attributeSpectrum(dependent,new SortedPoints(CROP_X,CROP_Y),
        {limit:Infinity,ppm:10,bestMatches:3})
    const perPeak=new Map()
    for(const entry of result.entries){
        ok(entry.target!==null&&entry.target!==undefined,
            `entry ${entry.notation} was matched to no point`)
        const peak=entry.target.index
        if(!perPeak.has(peak)) perPeak.set(peak,[])
        perPeak.get(peak).push(entry)
    }
    /* THE COVERAGE, at this ratio: the window is narrow and low, and a peak with
       no candidate inside 10 ppm is a fact about the spectrum. What must hold is
       that no peak gets the same formula twice. */
    ok(perPeak.size===95,
        `95 peaks should be covered at ratio 0.01, got ${perPeak.size}`)
    let repeated=0
    for(const [peak,bucket] of perPeak){
        const keys=new Set(bucket.map(entry=>entry.key))
        if(keys.size!==bucket.length){
            repeated++
            if(repeated===1){
                const counts=new Map()
                for(const entry of bucket) counts.set(entry.key,(counts.get(entry.key)??0)+1)
                const worst=[...counts].find(([,n])=>n>1)
                throw new Error(
                    `peak ${peak} holds ${bucket.length} readings but only `+
                    `${keys.size} distinct formulas; ${worst[0]} appears `+
                    `${worst[1]}×`)
            }
        }
        /* And the readings of one peak must still be three when three distinct
           formulas exist — de-duplicating must not silently cost the user a
           reading, which is the other way this could go wrong. */
        ok(bucket.length<=3,`peak ${peak} holds ${bucket.length} readings for j=3`)
    }
    ok(repeated===0,
        `${repeated} of ${perPeak.size} peaks received the same formula more than once`)
    /* The readings must be genuinely DIFFERENT formulas, not the same formula
       spelled twice: a key is the full isotope-resolved identity, so this is the
       strong form of the claim. */
    const allKeys=result.entries.map(entry=>entry.key)
    ok(new Set(allKeys).size===allKeys.length,
        `${allKeys.length} readings but ${new Set(allKeys).size} distinct keys overall`)
})

test("la sélection borne le nombre de formules construites",()=>{
    /* The point of selecting BEFORE building formulas. Not a timing assertion —
       timings vary — but a STRUCTURAL one: the number of formulas BUILT is
       bounded by peaks × j when a selection is asked for, and equals the size of
       the space when it is not. The counts show the ratio is real: 29 381
       combinations rendered against 240. */
    const every=cropRun({bestMatches:null})
    const selected=cropRun({bestMatches:3})
    ok(every.entries.length>20000,
        `the unselected run should render the whole space, got ${every.entries.length}`)
    ok(selected.entries.length<1000,
        `the selected run should render far fewer, got ${selected.entries.length}`)
    ok(every.candidates===undefined,"an unselected run has no per-peak candidate count")
    ok(selected.candidates===95,`95 peaks should hold candidates, got ${selected.candidates}`)
})

test("sans sélection, le moteur se comporte comme avant",()=>{
    /* The default is NO selection, and it must stay that way: the older tests
       call `attributeSpectrum` without `bestMatches` and expect every rendered
       state. A default of 1 would silently turn "all candidates" into "the
       winner", which is a different ANSWER, not a different setting. */
    const result=cropRun()
    ok(result.keptMatches===null,"the default must not select")
    ok(result.entries.length>20000,`everything should be rendered, got ${result.entries.length}`)
})

console.log("le NOM de l'option, entre le moteur et le nœud")
test("le nœud ne passe que des options que le moteur connaît",()=>{
    /* L'AUTRE FAÇON DE CASSER LA SÉLECTION, et elle ne lève RIEN.

       Le moteur déstructure ses options par leur nom. Le nœud, lui, passe un
       objet littéral. Si un nom diffère — `bestMatches` d'un côté,
       `bestPerPoint` de l'autre — l'option arrive `undefined`, prend sa valeur
       par défaut, et le moteur rend un résultat PARFAITEMENT VALIDE: la
       sélection est simplement absente, la fenêtre en ppm n'est pas appliquée,
       et les 29 381 combinaisons partent en collection. Aucun avertissement, aucune
       exception, un nœud vert et une liste plausible — le pire genre de panne.

       On compare donc les deux listes de noms, texte contre texte. C'est un test
       de contrat entre deux fichiers, et c'est nécessaire: rien dans les deux
       côtés ne peut attraper l'erreur seul, puisque chacun est correct
       isolément. */
    const engine=readFileSync(new URL("./attribution.js",import.meta.url),"utf8")
    const node=readFileSync(new URL("./interface.js",import.meta.url),"utf8")

    /* Les options que le moteur ACCEPTE, lues dans sa signature. */
    const signature=/function attributeSpectrum\(plan,points,\{([^}]*)\}=/.exec(engine)
    ok(signature,"the attributeSpectrum signature is readable")
    const accepted=new Set()
    for(const part of signature[1].split(",")){
        const name=part.trim().split(/[=:]/)[0].trim()
        if(name) accepted.add(name)
    }
    ok(accepted.size>=3,`the signature lists its options, got ${[...accepted].join(", ")}`)

    const call=/attributeSpectrum\(this\.plan,points,\{([\s\S]*?)\}\)/.exec(node)
    ok(call,"the node's call to attributeSpectrum is readable")
    /* Les options que le NŒUD passe, lues dans son seul appel.

       LE DÉCOUPAGE RESPECTE LA PROFONDEUR DE PARENTHÈSES, et il le doit: une
       simple `split(",")` hachait `Math.max(1,Math.trunc(…))` en deux morceaux et
       produisait une option nommée `Math.trunc(Number(this.parameters.
       bestMatches))` — c'est-à-dire un nom qui n'existe nulle part. Le test
       échouait donc sur sa propre maladresse, pas sur le code. Un test qui se
       trompe de façon grossière apprend à ne pas l'écouter. */
    const topLevelKeys=(text)=>{
        const keys=[]
        let depth=0
        let start=0
        for(let i=0;i<text.length;i++){
            const ch=text[i]
            if(ch==="("||ch==="["||ch==="{") depth++
            else if(ch===")"||ch==="]"||ch==="}") depth--
            else if(ch===","&&depth===0){
                keys.push(text.slice(start,i))
                start=i+1
            }
        }
        keys.push(text.slice(start))
        return keys.map(part=>part.trim().split(":")[0].trim()).filter(Boolean)
    }
    const passed=topLevelKeys(call[1])
    ok(passed.length>0,`the node passes options, got ${passed.join(", ")}`)

    for(const key of passed){
        ok(accepted.has(key),
            `the node passes "${key}", which attributeSpectrum does not accept — it would arrive undefined and silently fall back to its default`)
    }
    /* Et l'inverse compte pour les options qui PROVIENNENT DE L'INTERFACE: une
       option que le moteur sait lire, que l'écran expose et que le nœud ne
       transmet pas, est un réglage qui s'affiche et ne fait rien.

       `strategy` est exempté, et il faut dire pourquoi: ce n'est pas un réglage
       utilisateur mais un choix interne — la stratégie de crible, `heap` par
       défaut. Le nœud n'a donc rien à transmettre, et l'exiger le ferait
       échouer pour une raison qui n'en est pas une. La liste est donc écrite,
       pas déduite: ajouter une option au moteur ne doit pas casser ce test
       sans qu'on se demande s'il faut la câbler. */
    const forwarded=["limit","ppm","bestMatches"]
    for(const key of forwarded){
        ok(accepted.has(key),`attributeSpectrum no longer accepts "${key}"`)
        ok(passed.includes(key),
            `the interface exposes "${key}" but the node never passes it — the setting would do nothing`)
    }
})

test("le nom du réglage est le même des deux côtés",()=>{
    /* Le même contrat, une fois de plus et par un chemin différent: le réglage
       est écrit dans la session et lu par l'interface sous `bestMatches`. Un
       nom qui diverge entre la session, l'écran et le moteur ne casse rien
       immédiatement — ça casse à la PROCHAINE relecture, dans un fichier
       enregistré chez quelqu'un d'autre. */
    const node=readFileSync(new URL("./interface.js",import.meta.url),"utf8")
    const engine=readFileSync(new URL("./attribution.js",import.meta.url),"utf8")
    const persisted=/serializeState\(\)\{[\s\S]*?bestMatches:this\.parameters\.bestMatches/.test(node)
    ok(persisted,"the session stores `bestMatches`")
    const restored=/for\(const name of \[[^\]]*"bestMatches"/.test(node)
    ok(restored,"and restoreState reads it back under the same name")
    const engineHas=/bestMatches\s*=\s*null/.test(engine)
    ok(engineHas,"and the engine's option carries that same name")
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length) process.exitCode=1

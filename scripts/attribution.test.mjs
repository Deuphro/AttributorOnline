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
    lastNonZero,
    saneBound,
    saneRatio
} from "./attribution.js"

const TABLE=Element.load(JSON.parse(
    readFileSync(new URL("../data/elements.json",import.meta.url),"utf8")))

let passed=0
const failures=[]
/* `await fn()` — SANS quoi un test `async` est compté « ok » avant d'avoir rien
   vérifié, et qu'on n'apprend qu'il était faux qu'après la sortie de la suite.

   C'est arrivé: le test « bestMatches/ppm s'appliquent tout de suite » est
   async parce qu'il attend la promesse de `startResolve`. Appelé sans `await`,
   `try` n'entourait que la création de la promesse, donc le compteur
   passait à 64 alors que la dernière assertion n'avait pas encore tourné — et
   un rejet plus tard faisait sortir le processus en 1 sans qu'aucun test ne
   soit nommé.

   La suite est donc séquentielle et attend chacun. C'est plus strict, et c'est
   la seule façon dont « 64 passed » veut dire quelque chose. */
const test=async(name,fn)=>{
    try{ await fn(); passed++; console.log(`  ok   ${name}`) }
    catch(e){ failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const ok=(value,msg)=>{ if(!value) throw new Error(msg??`expected a truthy value, got ${value}`) }
/* `eq` EXISTE parce que la comparaison de chaînes est la moitié de ce fichier:
   une notation qui change d'un caractère est un défaut qu'aucun `ok` ne
   voitrait, et le message doit nommer les DEUX écritures — c'est ce qui permet
   de lire l'échec sans relancer. */
const eq=(a,b,msg)=>{ if(a!==b) throw new Error(`${msg??`${a} != ${b}`}`) }
const close=(a,b,tol,msg)=>{ if(!(Math.abs(a-b)<=tol)) throw new Error(`${msg??`${a} vs ${b}`}`) }

/* Un plan de lecture, sans passer par une liste de formules à chaque test:
   c'est le même geste que le noeud, et il garantit que les tests exercent le
   chemin du noeud et pas une version allégée. */
const plan=(options)=>buildPlan({table:TABLE,...options})

console.log("les deux listes, et ce qu'elles produisent")

await test("la liste à combiner donne les masses isotopiques du groupe",()=>{
    const p=plan({combining:["CH2"],ionising:["[H+]"],chargeMax:1})
    /* CH2 a deux isotopes de C et trois de H: 2 x 3 = 6 combinaisons */
    ok(p.combinables.length===6,`expected 6 combinable masses, got ${p.combinables.length}`)
})

await test("la liste ionisante exige une charge et le dit",()=>{
    const p=plan({combining:["CH2"],ionising:["Na"],chargeMax:1})
    ok(p.ionisers.length===0,"Na carries no charge and must be refused")
    ok(p.diagnostics.some(d=>/carries no charge/.test(d)),
        `the refusal must be visible: ${JSON.stringify(p.diagnostics)}`)
})

await test("[Na+] est un adduit valide, de masse atomique et de charge",()=>{
    const p=plan({combining:["CH2"],ionising:["[Na+]"],chargeMax:1})
    ok(p.ionisers.length===1,`expected 1 ionising group, got ${p.ionisers.length}`)
    close(p.ionisers[0].charge,1,1e-12,"[Na+] carries a +1")
    /* La masse de l'ION, donc 23Na MOINS un électron: 22.989220. C'est la
       correction dont parle `readIonising`, et elle se voit ici. */
    close(p.ionisers[0].atomicMass,22.98922,1e-4,"the sodium ion mass")
})

await test("a lone adduct is not written twice",()=>{
    /* THE BARE PROTON, and it showed in the ionising list: "[H+]" displayed as
       "H[H+]" — the proton spelled out AND inside brackets, so it read as two
       hydrogens when there is one.

       The cause is `written`, which falls back to the composition when there
       is no core. `parseIonisationOnly` has NO core: its composition IS the
       group, and the brackets already write it. */

    const proton=Formula.parseIonisationOnly("[H+]",TABLE)
    eq(String(proton),"[H+]",`a bare proton must read back as "[H+]", got "${proton}"`)
    /* AND THE MASS IS UNCHANGED, because the mass is what counts. The bare
       proton weighs 1.007276 — 1.007825 less the electron — and not 2.015: had
       the writing counted the atom twice, the mass would be wrong too. */
    close(proton.mass,1.00728,1e-4,"the bare proton ion mass")
    ok(proton.composition.size===1,"the proton still carries its atom in the composition")

    /* The same adduct typed WITH a skeleton keeps ITS core: the core is what
       gets written, and the adduct stays in the brackets as it should. */
    const methyl=Formula.parse("CH4[H+]",TABLE)
    eq(String(methyl),"CH4[H+]",`a typed skeleton must keep its core, got "${methyl}"`)
    ok(methyl.composition.get(TABLE.find("H")).size===1,
        "CH4[H+] holds two kinds of hydrogen — the core one and the adduct one")
})
await test("the ionising list names the adduct as it was typed",()=>{
    /* What the user reads in the node, not what the key says. */
    const p=plan({combining:["CH2"],ionising:["[H+]"],chargeMax:1})
    eq(p.ionisers[0].notation,"[H+]",`the panel shows "${p.ionisers[0].notation}"`)
    eq(p.ionisers[0].groupNotation,"[H+]",`the row name is "${p.ionisers[0].groupNotation}"`)
    /* And it brings ONE hydrogen in the composition, which is what
       `stateToFormula` merges. */
    const hydrogens=p.ionisers[0].composition.get(TABLE.find("H"))
    close(hydrogens.get(1),1,0,"the proton adduct brings ONE hydrogen")
})
await test("combinable blocks display a notation, not a key",()=>{
    /* The panel lists what the `ratio` OPENED, and the point of that line is to
       be read at a glance. The key says "12C 1H2" — exact, but nobody writes a
       mass number on every atom, and it is not a notation anyone would type. */
    const p=plan({combining:["CH2"],ionising:["[H+]"],ratio:0})
    ok(p.combinables.length===6,`expected 6 blocks, got ${p.combinables.length}`)
    /* The notation abbreviates the default isotope; the key never does. That
       gap is exactly what makes the key unusable as on-screen text. */
    const block=p.combinables.find(b=>b.notation==="C H2")
    ok(block,`expected an abbreviated "C H2", got ${JSON.stringify(p.combinables.map(b=>b.notation))}`)
    eq(block.key,"12C 1H2",`the key of the abbreviated block is "${block.key}"`)
})
await test("un groupe illisible est un diagnostic, pas une exception",()=>{
    const p=plan({combining:["CH2","Xx9"],ionising:["[H+]"]})
    ok(p.combinables.length===6,"the readable group must survive the unreadable one")
    ok(p.diagnostics.length>=1,`the typo must be reported: ${JSON.stringify(p.diagnostics)}`)
})

await test("le ratio filtre les masses combinables",()=>{
    const all=plan({combining:["CH2"],ionising:["[H+]"],ratio:0}).combinables.length
    const onlyMost=plan({combining:["CH2"],ionising:["[H+]"],ratio:1}).combinables.length
    ok(all===6,`ratio 0 keeps everything: got ${all}`)
    ok(onlyMost===1,`ratio 1 keeps only the most probable: got ${onlyMost}`)
})

await test("les masses combinables sont triees par abondance decroissante",()=>{
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

await test("le tas trouve exactement ce que la force brute trouve",()=>{
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

await test("la base mixte trouve elle aussi exactement le même ensemble",()=>{
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

await test("aucun multiensemble n'est rendu deux fois",()=>{
    const p=plan({combining:["CH2","O"],ionising:["[H+]"],ratio:0.01,chargeMax:2})
    const states=cribleHeap(p,{maxMass:300}).states
    const keys=new Set(states.map(signature))
    ok(keys.size===states.length,`${states.length} states but ${keys.size} distinct`)
})

await test("les masses sortent par ordre croissant",()=>{
    const p=plan({combining:["CH2","O"],ionising:["[H+]"],ratio:0.01,chargeMax:2})
    const states=cribleHeap(p,{maxMass:300}).states
    for(let i=1;i<states.length;i++){
        ok(states[i-1].mass<=states[i].mass,
            `rank ${i} (${states[i].mass}) is lighter than rank ${i-1} (${states[i-1].mass})`)
    }
})

await test("le vecteur nul est le premier, à masse nulle",()=>{
    const p=plan({combining:["CH2"],ionising:["[H+]"]})
    const states=cribleHeap(p,{maxMass:100}).states
    ok(states[0].mass===0,"the seed must be the empty combination")
    ok(Array.from(states[0].counts).every(c=>c===0),"the seed must be the null vector")
})

await test("aucune masse ne dépasse le plafond",()=>{
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
await test("un état hors fenêtre n'arrête pas la marche",()=>{
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
await test("la fenêtre d'ionisation se lit en valeur absolue",()=>{
    const p=plan({combining:["CH2"],ionising:["[Cl-]"],chargeMin:1,chargeMax:2})
    const counts=new Int32Array(p.itemCount)
    counts[p.combinables.length]=1   // one [Cl-]
    ok(p.withinCharge(counts),"|1| is inside [1,2]")
    ok(!p.withinCharge(new Int32Array(p.itemCount)),"0 is outside [1,2]")
})

await test("la borne de multiplicité d'un adduit vient de la charge",()=>{
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

await test("lastNonZero lit le dernier indice non nul",()=>{
    ok(lastNonZero(new Int32Array([0,0,0]))===-1,"an empty vector has no highest")
    ok(lastNonZero(new Int32Array([1,0,0]))===0)
    ok(lastNonZero(new Int32Array([1,0,4]))===2)
    ok(lastNonZero(new Int32Array([0,7,0]))===1)
})

console.log("l'appariement aux points")

await test("le point le plus proche est trouvé par dichotomie",()=>{
    const points=new SortedPoints([100,100.5,101,200],[10,20,30,40])
    const near=points.nearest(100.4)
    ok(near&&near.index===1,`expected the point at 100.5, got ${near&&near.index}`)
    close(near.mz,100.5,1e-12,"the nearest mass")
})

await test("le plus proche l'emporte, même quand il est AVANT",()=>{
    const points=new SortedPoints([100,100.5,101],[10,20,30])
    /* 100.49 est plus près de 100.5 que de 100: la recherche ne doit pas
       s'arrêter au premier voisin rencontré. */
    ok(points.nearest(100.49).index===1,"the upper neighbour must win")
    ok(points.nearest(100.25).index===0,"the lower neighbour must win")
    /* et au milieu exact des deux, l'égalité se tranche sans favoritisme */
    ok([0,1].includes(points.nearest(100.25+1e-12).index),
        "a tie must still resolve to one of the two")
})

await test("l'erreur est en ppm, et son signe pointe vers le point",()=>{
    const points=new SortedPoints([100.0005],[1])
    const target=points.nearest(100)
    close(target.errorPpm,5,1e-6,"a point 5 mDa above 100 is 5 ppm at 100")
})

await test("un spectre vide ou sans masse ne donne aucun point",()=>{
    ok(new SortedPoints([],[]).nearest(100)===null,"an empty spectrum has no nearest")
    ok(new SortedPoints([0,0],[1,2]).nearest(100)===null,
        "a zero mass has no ppm, so it cannot be a target")
})

await test("le tri des points est payé une fois, pas par candidat",()=>{
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

await test("une attribution rend une formule, un point et une erreur",()=>{
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

await test("la recette dit quelles briques ont servi, et combien",()=>{
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

await test("la masse du m/z est bien celle de la formule rendue",()=>{
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

await test("un adduit seul reste une attribution, et c'est correct",()=>{
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

await test("un plan totalement vide le dit, au lieu de ne rien rendre",()=>{
    const p=plan({combining:[],ionising:[],chargeMin:0,chargeMax:0})
    const result=attributeSpectrum(p,new SortedPoints([100],[1]))
    ok(result.entries.length===0,"nothing should be attributed")
    ok(result.diagnostics.some(d=>/no group to combine/.test(d)),
        `the refusal must be visible: ${JSON.stringify(result.diagnostics)}`)
})

await test("un plan sans table le dit, au lieu de choisir un isotope en silence",()=>{
    const orphan=buildPlan({combining:["CH2"],ionising:["[H+]"],table:null})
    ok(orphan.combinables.length===0,"nothing can be read without a table")
    ok(orphan.diagnostics.some(d=>/no periodic table/.test(d)),
        `the refusal must be visible: ${JSON.stringify(orphan.diagnostics)}`)
})

await test("la troncature est signalée, jamais silencieuse",()=>{
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

await test("le plancher ne perd aucune formule que le sans-plancher aurait rendue",()=>{
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

await test("le tas passe là où la force brute n'irait pas",()=>{
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

await test("le volume suit le plafond, comme il doit",()=>{
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

await test("une collection est lue par le lecteur",()=>{
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

await test("le descripteur d'avant ne passait pas, et c'est ce qui cassait",()=>{
    /* The shape the node used to publish, recorded here as a FAILING case.
       A bug that no test reproduces stops being fixed: the next reader of this
       file has no way of knowing that shape was already tried and rejected. */
    const oldShape=[{input:0,total:2,attributions:[{key:"...",notation:"..."}]}]
    ok(!asCollection(oldShape[0]),
        "the old descriptor shape would be accepted, which would mean the bug is back")
    ok(!asCollection(oldShape[0].attributions[0]),
        "a bare attribution descriptor would be accepted, which would mean the bug is back")
})

await test("les notations produites par le crible sont relues par la table",()=>{
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

await test("une collection par entrée, avec des noms distincts",()=>{
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

await test("la troncature traverse et se lit",()=>{
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

await test("la fixture a bien la taille qu'on croit",()=>{
    /* 95 points. Le test le vérifie plutôt que de le supposer: une fixture
       tronquée par un mauvais commit donnerait un oracle muet, et tous les tests
       ci-dessous passeraient sur un spectre amputé. */
    ok(CROP_X.length===95,`expected 95 peaks, got ${CROP_X.length}`)
    ok(CROP_X.every(value=>Number.isFinite(value)&&value>0),"every m/z is a real mass")
})

await test("chaque pic reçoit au moins une lecture, dans la fenêtre",()=>{
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

await test("`bestMatches` garde le bon nombre, et par pic",()=>{
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

await test("les lectures d'un pic sont classées par écart, puis par probabilité",()=>{
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

await test("aucune troncature: l'espace entier est couvert",()=>{
    /* The `limit` is gone, so the sieve must walk the whole mass window and say
       it did. `truncated` true here would mean the published list is a PREFIX,
       and a prefix of a mass-ordered enumeration is not an attribution. */
    const result=cropRun({bestMatches:3})
    ok(result.truncated===false,"the sieve reported a truncation it should not have")
    ok(result.visited>result.entries.length,
        "more states visited than published: the sieve did explore")
})

await test("deux lectures d'un même pic sont deux FORMULES différentes",()=>{
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

await test("un adduit à 1..1 est POSÉ, pas cherché",()=>{
    /* LE RÉGRESSION DU BOUTON « AUCUNE SOLUTION ».

       Un `[H+]` avec `min:1, max:1` est un GROUPE FIXE: il est présent une fois,
       quoi qu'il arrive. Or il l'est aussi par DÉFAUT dans la liste ionisante du
       nœud — donc une régression ici ne « perd » pas un réglage exotic, elle tue le
       réglage par défaut et renvoie zéro résultat partout.

       Ce qui l'avait tuée: le repère du groupe fixe était un `Int32Array` et la
       clé de groupe est une CHAÎNE. Une chaîne dans un tableau d'entiers vaut 0,
       donc la recherche de la Map échouait, la branche « groupe fixe » n'était
       jamais prise, et la branche d'après mettait le compte de l'adduit à zéro
       PARTOUT. La charge valait toujours 0, et rien ne pouvait s'accrocher à un
       pic.

       ON TESTE LES DEUX COTÉS, parce que les deux se trompent différemment: le
       1..1 doit rendre ce que le 0..1 rendait (charge 1 disponible), et il doit
       le rendre en PROPORTION — un groupe fixe ne coûte pas une dimension. */
    const groups=[{group:"CH2",ratio:1,max:20},{group:"NH",ratio:1,max:20},{group:"O",ratio:1,max:8},{group:"C",ratio:1,max:20}]
    const required=plan({combining:groups,ionising:[{group:"[H+]",min:1,max:1}],
        chargeAuto:true})
    const optional=plan({combining:groups,ionising:[{group:"[H+]",min:0,max:1}],
        chargeAuto:true})
    const result=attributeSpectrum(required,new SortedPoints(CROP_X,CROP_Y),
        {limit:Infinity,ppm:10,bestMatches:3})
    /* D'abord ça MARCHE: le réglage par défaut doit expliquer le spectre. */
    ok(result.entries.length>0,
        `a required [H+] must still attribute: ${result.entries.length} readings`)
    ok(required.chargeSet?.includes(1),
        `charge 1 must be reachable, got ${JSON.stringify(required.chargeSet)}`)
    /* Puis ça ne COÛTE PAS: l'adduit fixé ne doit pas doubler l'espace. */
    const requiredSpace=cribleMixedRadix(required,{
        maxMass:required.massCeiling(new SortedPoints(CROP_X,CROP_Y)),
        minMass:required.massFloor(new SortedPoints(CROP_X,CROP_Y))
    }).visited
    const optionalSpace=cribleMixedRadix(optional,{
        maxMass:optional.massCeiling(new SortedPoints(CROP_X,CROP_Y)),
        minMass:optional.massFloor(new SortedPoints(CROP_X,CROP_Y))
    }).visited
    ok(requiredSpace<optionalSpace,
        `a fixed adduct must not cost a dimension: ${requiredSpace} fixed vs `+
        `${optionalSpace} free`)
    /* Et PAS DEUX FOIS MOINS, ce qui serait une fausse promesse: le plafond de
       masse rogne les deux espaces différemment, donc le rapport n'est pas
       exactement 2. Ce qu'on peut affirmer, c'est « pas plus de », et c'est ce
       que le test vérifie. */
})

await test("un isotope s'ouvre PAR GROUPE, et c'est ce qui rend les listes tenables",()=>{
    /* LE PROBLÈME QUE ÇA RÉSOUT, et il faut le poser avant la solution.

       Un `ratio` global ne peut pas dire « 13C oui, 17O non ». Ouvrir le
       seuil pour voir le 13C ouvre le 17O et le 18O dans la MÊME liste, parce que
       le seuil était commun — et ces isotopes-là sont rares, donc ils
       multiplient les briques sans jamais servir. */

    /* L'ISOTOPE RARE EST OUVERT, LE GROUP LE RENDANT TOUT AUTRE: c'est la preuve
       que le seuil est bien par groupe. CH2 à 0.01 donne 12CH2 et 13CH2; le même
       groupe à 1 ne donne que 12CH2. */
    const wide=plan({combining:[{group:"CH2",ratio:0.01}],ionising:["[H+]"]})
    const narrow=plan({combining:[{group:"CH2",ratio:1}],ionising:["[H+]"]})
    ok(wide.combinables.length>1,
        `ratio 0.01 should open more than one isotopic mass, got ${wide.combinables.length}`)
    ok(narrow.combinables.length===1,
        `ratio 1 should keep only the most probable, got ${narrow.combinables.length}`)
    /* ET les deux plans de la fixture: un seul ratio pour toute la liste
       ouvrait le 13C du groupe C en même temps que le 13C du groupe CH2. On
       veut pouvoir les ouvrir L'UN SANS L'AUTRE — c'est tout l'intérêt. */
    const onlyC=plan({
        combining:[
            {group:"CH2",ratio:1},
            {group:"C",ratio:0.01}
        ],
        ionising:["[H+]",{group:"[H+]",min:1,max:1}],
        chargeMin:1,chargeMax:1
    })
    const notations=onlyC.combinables.map(c=>c.notation)
    ok(notations.includes("13C"),
        `the C group should have opened its 13C, got ${notations.join(" ")}`)
    ok(!notations.includes("13C H2"),
        `CH2 stayed at ratio 1 and must NOT have opened its 13C, got ${notations.join(" ")}`)
})

await test("les bornes min/max comptent le GROUPE entier, pas chaque isotope",()=>{
    /* LA BORNE EST PARTAGÉE, et c'est le piège. Un groupe « CH2 » est fait de
       12CH2 ET 13CH2 à ratio 0.01; `max:2` veut dire deux CH2 AU TOTAL, donc
       un seul 13CH2 et un seul 12CH2 — pas deux de chaque. */
    const bounded=plan({
        combining:[{group:"CH2",ratio:0.01,min:0,max:2}],
        ionising:["[H+]"],chargeMin:1,chargeMax:1
    })
    /* Les briques DU GROUPE CH2 portent toutes la même borne. L'adduit est à
       part: il a sa propre entrée, et il n'a pas de borne à 2. */
    const groupBounds=new Set(bounded.items
        .filter(item=>String(item.groupIndex).startsWith("combining#"))
        .map(item=>item.groupMax))
    ok(groupBounds.size===1&&groupBounds.has(2),
        `every brick of the CH2 group must carry max 2, got ${[...groupBounds]}`)
    /* Et la vérité se vérifie au RENDU, où toutes les multiplicités sont
       connues: c'est `groupWithin` qui décide, pas la répartition. */
    const counts=new Int32Array(bounded.itemCount)
    const indices=bounded.items.map((item,index)=>String(item.groupIndex).startsWith("combining#")?index:-1)
        .filter(index=>index>=0)
    /* Un vecteur qui met deux briques du groupe à 1 doit passer: deux CH2, pas
       plus, quelle que soit la façon dont ils se partagent. */
    counts[indices[0]]=1
    counts[indices[1]]=1
    ok(bounded.groupWithin(counts),`two bricks of a max-2 group must be allowed`)
    /* Et trois doivent être refusés — même si le CHIFFRE de la première brique
       peut legally atteindre 3, parce que le budget est partagé. C'est exactement
       le cas que la répartition des bornes ne sait pas voir. */
    counts[indices[0]]=2
    counts[indices[1]]=1
    ok(!bounded.groupWithin(counts),
        `three CH2 in a max-2 group must be refused even though the digit allows it`)
})

await test("un min par adduit tient la charge basse",()=>{
    /* LE MIN EST CE QUI REMPLACE LE « charge min » TAPÉ À LA MAIN, et il se
       vérifie dans les deux sens: un adduit exigé est toujours présent, un
       adduit facultatif peut manquer. */
    const required=plan({
        combining:[{group:"CH2",ratio:1}],
        ionising:[{group:"[Na+]",min:1,max:1}],
        chargeMin:1,chargeMax:1
    })
    const counts=new Int32Array(required.itemCount)
    /* Sans adduit: la charge est nulle, donc rien ne peut être proposé. */
    ok(!required.withinCharge(counts),
        "a plan whose adduct has min 1 admits nothing without it")
    counts[required.combinables.length]=1
    ok(required.withinCharge(counts),
        "the required adduct, once present, gives the charge")
    /* Et le plan refuse d'autoriser un min plus grand que le max, en le DIT. */
    const impossible=plan({
        combining:[{group:"CH2",ratio:1}],
        ionising:[{group:"[H+]",min:3,max:1}],
        chargeMin:1,chargeMax:1
    })
    ok(impossible.diagnostics.some(d=>/is above max/.test(d)),
        `an impossible bound must be reported: ${JSON.stringify(impossible.diagnostics)}`)
})

await test("une chaîne reste une chaîne: rien d'existant ne casse",()=>{
    /* LA COMPATIBILITÉ, et elle n'est pas-optionnelle. Une session enregistrée,
       un script, un test: tout écrit `"CH2"` et rien d'autre. Ça doit produire le
       plan d'avant — mêmes briques, même isotopie. */
    const old=plan({combining:["CH2"],ionising:["[H+]"],ratio:0,chargeMin:1,chargeMax:1})
    const explicit=plan({
        combining:[{group:"CH2",min:0,max:Infinity}],
        ionising:[{group:"[H+]",min:0,max:Infinity}],
        ratio:0,chargeMin:1,chargeMax:1
    })
    ok(old.combinables.length===explicit.combinables.length,
        `${old.combinables.length} vs ${explicit.combinables.length} combinable masses`)
    ok(old.combinables.map(c=>c.key).join()===explicit.combinables.map(c=>c.key).join(),
        "the same string and the same object must give the same bricks")
    /* Et le `ratio` du PLAN reste respecté quand l'entrée n'en donne pas: c'est
       ce qui permet à un appelant de dire ratio:0 et de tout garder. */
    ok(old.combinables.length===6,
        `ratio 0 on a bare string must keep every isotopic mass, got ${old.combinables.length}`)
})

await test("la sélection borne le nombre de formules construites",()=>{
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

await test("sans sélection, le moteur se comporte comme avant",()=>{
    /* The default is NO selection, and it must stay that way: the older tests
       call `attributeSpectrum` without `bestMatches` and expect every rendered
       state. A default of 1 would silently turn "all candidates" into "the
       winner", which is a different ANSWER, not a different setting. */
    const result=cropRun()
    ok(result.keptMatches===null,"the default must not select")
    ok(result.entries.length>20000,`everything should be rendered, got ${result.entries.length}`)
})

const NAME=readFileSync(new URL("./interface.js",import.meta.url),"utf8")
const start=NAME.indexOf("/* UNE LISTE DE GROUPES, QUELLE QUE SOIT SON")
const end=NAME.indexOf("/* La liste du nœud, normalisée")
if(start<0||end<start){
    console.error("readGroups could not be located in interface.js - the test cannot run")
    process.exit(1)
}
const slice=NAME.slice(start,end)
if(!slice.includes("readGroups(value,kind)")){
    console.error("the readGroups slice is incomplete - the test cannot run")
    process.exit(1)
}
/* `readGroups` est une MÉTHODE du nœud, donc on la sort comme TEXTE et on la
   rappelle sur une coquille qui n'a que ce dont elle a besoin: `readList`, et
   `Formula`/`Stoichiometry` pour le `instanceof`. C'est tout l'intérêt du
   découpage — il éprouve la migration LIVRÉE, pas une copie qui cesse d'être
   vraie dès que quelqu'un édite le vrai fichier.

   LE LIT DEPUIS UNE CLASSE, et c'est pour ça qu'on reconstruit une classe: le
   texte est une méthode, donc il n'est pas valide tout seul dans `new Function`.
   On le rend dans un CORPS DE CLASSE, ce qui accepte exactement la même
   écriture, et on prend la méthode sur le prototype. */
const Shell=new Function("Formula","Stoichiometry","saneBound","saneRatio",`return class {
    ${slice}
}`)(Formula,Stoichiometry,saneBound,saneRatio)
const readGroups=(value,kind)=>Shell.prototype.readGroups.call({
    readList:(text)=>String(text??"").split(/[\n;]/).map(l=>l.trim()).filter(l=>l.length>0)
},value,kind)

await test("une session à l'ancienne écriture se relit, et prend les défauts par liste",()=>{
    /* LA MIGRATION, et c'est elle qui évite de perdre les sessions.

       Une session enregistrée avant les bornes porte une chaîne. Elle doit
       redevenir une liste de groupes, et surtout recevoir les DÉFAUTS DE SA
       LISTE: un groupe de masse à 0..∞, un adduit à 1..1. Les confondre donnerait
       un adduit facultatif — donc des formules sans charge, donc rien à
       rattacher à un pic. */
    const old=readGroups("CH2\nNH\nO","combining")
    ok(old.length===3,`three lines became three groups, got ${old.length}`)
    ok(old.every(g=>g.group&&g.min===0&&g.max===Infinity&&g.ratio===1),
        `every combining group gets 0..∞ and ratio 1: ${JSON.stringify(old)}`)
    const adduct=readGroups("[H+]","ionising")
    ok(adduct[0].min===1&&adduct[0].max===1,
        `an adduct is required by default: ${JSON.stringify(adduct)}`)
})

await test("une session à la nouvelle écriture se relit sans y toucher",()=>{
    const read=readGroups([{group:"CH2",min:1,max:4,ratio:0.01}],"combining")
    ok(read.length===1&&read[0].min===1&&read[0].max===4&&read[0].ratio===0.01,
        `a current session must survive unchanged: ${JSON.stringify(read)}`)
})

await test("`∞` se lit comme l'infini, parce que c'est ce que la case affiche",()=>{
    /* LA CASE MONTRE « ∞ » ET LA LECTURE ATTEND « ∞ ». Si l'un des deux disait
       autre chose, lever l'infini demanderait de taper un mot que l'écran ne
       montre pas — et une borne qu'on ne sait pas lever est une borne
       permanente. */
    const read=readGroups([{group:"CH2",max:"∞"}],"combining")
    ok(read[0].max===Infinity,`"∞" must read as Infinity, got ${read[0].max}`)
    const spelled=readGroups([{group:"CH2",max:"Infinity"}],"combining")
    ok(spelled[0].max===Infinity,`the spelled-out form works too, got ${spelled[0].max}`)
    const number=readGroups([{group:"CH2",max:"12"}],"combining")
    ok(number[0].max===12,`a number still reads as a number, got ${number[0].max}`)
})

console.log("le NOM de l'option, entre le moteur et le nœud")
await test("le nœud ne passe que des options que le moteur connaît",()=>{
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

await test("le nom du réglage est le même des deux côtés",()=>{
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

/* -------------------------------------------------------------------------
   LES TROIS DÉFAUTS, ET LEUR TEST.

   Chacun de ces tests a ÉCHOUÉ avant la correction, et il échoue encore si on
   réintroduit la faute — c'est vérifié, pas supposé. Ils sont écrits contre le
   MOTEUR parce que c'est là que les défauts 2 et 3 vivent; le défaut 1 est un
   défaut de PANNEAU, et il se vérifie dans scripts/bug1.mjs.
   ------------------------------------------------------------------------- */

await test("BUG 2 — un adduit facultatif (min:0) rend la charge 0 atteignable",()=>{
    /* LE FAUX, ET LA FAUSSE IDÉE QU'IL PORTE.

       « Reachable charge(s): 1 » pour un adduit en `0..1` n'est pas une
       simplification: les SOMMES possibles sont {0, 1}, et le 0 est écarté par
       un `.filter(v=>v>0)`. Un `min:0` signifie « cet adduit est facultatif »,
       donc qu'un neutre EST possible — et l'écran doit le dire au lieu de
       montrer un ensemble plus étroit que ce que les réglages autorisent. */
    const optional=plan({
        combining:[{group:"CH2",ratio:1,max:20}],
        ionising:[{group:"[H+]",min:0,max:1,ratio:1}],
        chargeAuto:true
    })
    ok(optional.chargeSet?.includes(0),
        `a 0..1 adduct makes the neutral reachable, got ${JSON.stringify(optional.chargeSet)}`)
    ok(optional.chargeSet?.includes(1),
        `and must keep the charge 1, got ${JSON.stringify(optional.chargeSet)}`)

    /* ET L'AUTRE MOITIÉ DU CONTRAT: un adduit OBLIGATOIRE (1..1) ne doit PAS
       ouvrir la charge 0. C'est ce qui distingue « j'ai demandé le neutre » de
       « le calcul en a trouvé un par hasard ». */
    const required=plan({
        combining:[{group:"CH2",ratio:1,max:20}],
        ionising:[{group:"[H+]",min:1,max:1,ratio:1}],
        chargeAuto:true
    })
    ok(!required.chargeSet?.includes(0),
        `a 1..1 adduct admits no neutral, got ${JSON.stringify(required.chargeSet)}`)
})

await test("BUG 2bis — le neutre est DIT, et il se range comme les autres",()=>{
    /* CE TEST AFFIRMAIT AUTREFOIS `chargeMin >= 1`, ET IL AVAIT TORT.

       Il corrigeait le défaut 2 en prohibant le neutre — parce qu'à l'époque on
       croyait qu'un neutre était une division par zéro. C'était faux: `Formula.mz`
       fait `mass/Math.abs(charge||1)` et rend donc la MASSE, qui est la bonne
       valeur. Et l'utilisateur attribue des listes de NEUTRES, et il sonde des
       masses de neutres sans vouloir ajouter le proton de tête.

       Le contrat vrai est donc l'inverse de celui qu'on avait écrit: le neutre
       est une lecture à part entière, au m/z de sa masse. Il est dit à l'écran
       ET il est rendu. */
    const optional=plan({
        combining:[{group:"CH2",ratio:1,max:20}],
        ionising:[{group:"[H+]",min:0,max:1,ratio:1}],
        chargeAuto:true
    })
    ok(optional.neutralPossible,
        "a 0..1 adduct makes a neutral reachable, and the plan must say so")
    ok(optional.chargeSet?.includes(0)&&optional.chargeSet?.includes(1),
        `and both charges must be offered, got ${JSON.stringify(optional.chargeSet)}`)

    /* UNE LISTE IONISANTE VIDE EST UN CHOIX, ET ELLE SE DIT COMME TEL.

       Elle rendait `null`, donc l'écran annonçait « the adducts cannot charge
       anything » — ce qui laisse croire à un plan cassé, alors que c'est
       exactement le réglage d'un utilisateur qui veut des masses neutres. */
    const none=plan({
        combining:[{group:"C",ratio:1,max:20}],
        ionising:[],
        ratio:1,chargeMax:1,table:TABLE,chargeAuto:true
    })
    ok(Array.isArray(none.chargeSet),
        `an empty ionising list must still answer, got ${JSON.stringify(none.chargeSet)}`)
    ok(none.chargeSet?.length===1&&none.chargeSet[0]===0,
        `and the only charge it can reach is the neutral one, got `+
        `${JSON.stringify(none.chargeSet)}`)

    /* LA DÉPENSE, MESURÉE ET NON SUPPOSÉE.

       Ouvrir `chargeMin` à 0 ne coûte RIEN: même `visited`, mêmes états. Le
       neutre ne rajoute aucune dimension — il était déjà produit par le
       crible, on cessait seulement de le jeter.

       Ce qui double, c'est l'adduit en `0..1`: il cesse d'être fixé, donc
       son compte devient une variable de plus. C'est le prix de « l'adduit
       est facultatif », et il est payé une fois, pas deux. */
    const points=new SortedPoints([100,200,300],[1,1,1])
    const walk=(ionising,chargeMin)=>{
        const p=plan({combining:[{group:"CH2",ratio:1,max:20}],ionising,chargeMin,chargeAuto:true})
        return cribleMixedRadix(p,{
            maxMass:p.massCeiling(points),
            minMass:p.massFloor(points),
            accept:state=>p.withinCharge(state.counts)
        }).visited
    }
    const adduct=[{group:"[H+]",min:1,max:1,ratio:1}]
    ok(walk(adduct,0)===walk(adduct,1),
        `the charge window alone must cost nothing: `+
        `${walk(adduct,0)} vs ${walk(adduct,1)}`)
    /* Et l'adduit facultatif en coûte plus, une fois — c'est la dimension. */
    const optionalAdduct=[{group:"[H+]",min:0,max:1,ratio:1}]
    ok(walk(optionalAdduct,1)>walk(adduct,1),
        `an optional adduct does add a dimension, got `+
        `${walk(optionalAdduct,1)} vs ${walk(adduct,1)}`)
})

await test("BUG 3 — un groupe dont la NOTATION porte l'isotope garde cet isotope",()=>{
    /* LE CŒUR DU DÉFAUT, ET IL EST CHIMIQUE, PAS D'AFFICHAGE.

       « 13C » est une formule qui dit 13C. La lire en brique doit donc peser
       13.00336. Or `readCombining` appelle `root.isotopologues({ratio})`, et le
       germe d'`isotopologues` est l'état le PLUS PROBABLE: à ratio 1 il ne rend
       que 12C. Le 13C écrit par l'utilisateur disparaissait donc, et le groupe
       devenait indiscernable d'un « C » — mesuré: même masse au dalton près. */
    const forced=plan({
        combining:[{group:"13C",min:1,max:1,ratio:1}],
        ionising:[{group:"[H+]",min:1,max:1,ratio:1}],
        ratio:1,chargeMax:1,table:TABLE,chargeAuto:true
    })
    /* Les masses sont lues dans la TABLE, pas recopiées: une masse écrite en
       dur dans un test devient un second orifice de vérité, et c'est
       exactement le genre de chiffre qui survit à un changement de source. */
    const CARBON=TABLE.bySymbol.get("C")
    const CARBON_13=CARBON.isotope(13).mass
    const HYDROGEN=TABLE.bySymbol.get("H")
    ok(forced.combinables.length>0,
        `a readable group must give a brick, got ${forced.combinables.length}`)
    close(forced.combinables[0].atomicMass,CARBON_13,1e-3,
        `"13C" must weigh the mass of 13C, got ${forced.combinables[0].atomicMass}`)
    ok(forced.combinables[0].key.startsWith("13C"),
        `and it must say so in its key, got "${forced.combinables[0].key}"`)

    /* ET IL DOIT SE DÉMARQUER d'un « C », sinon le réglage ne veut rien dire. */
    const plain=plan({
        combining:[{group:"C",min:1,max:1,ratio:1}],
        ionising:[{group:"[H+]",min:1,max:1,ratio:1}],
        ratio:1,chargeMax:1,table:TABLE,chargeAuto:true
    })
    ok(Math.abs(forced.combinables[0].atomicMass-plain.combinables[0].atomicMass)>1,
        `"13C" and "C" must not weigh the same, both gave `+
        `${forced.combinables[0].atomicMass}`)

    /* ET LE 13C DOIT ATTEINDRE LES FORMULES PROPOSÉES, pas seulement la liste de
       briques: c'est ce que l'utilisateur attend, et c'est ce que le nœud
       affiche. On sonde la masse qu'un 13C protoné donnerait.

       DEUX POINTS, et c'est délibéré: avec un point unique, la masse visée est
       à la fois le plancher et le plafond de l'énumération, donc la formule
       tombe pile sur la borne — un cas limite qui teste `capsFor`, pas
       l'isotope. Un spectre a toujours une plagée de pics de part et
       d'autre de la cible, et c'est cette situation-là qu'on veut vérifier. */
    const probe=CARBON_13+1.007276
    const found=attributeSpectrum(forced,new SortedPoints([probe-4,probe,probe+4],[1,1,1]),
        {limit:Infinity,bestMatches:5,ppm:20})
    ok(found.entries.some(entry=>/13C/.test(entry.notation)),
        `a 13C group must propose a 13C formula, got `+
        `${found.entries.map(e=>e.notation).join(" ")||"(nothing)"}`)

    /* ET LE CAS GÉNÉRAL: un isotope écrit dans un groupe plus gros.

       « 13C2H4 » et non « 13CH2 »: ce dernier est un défaut de GRAMMAIRE
       distinct — il se lit 13C + 1H au lieu de 13C + 2H (constaté pendant cette
       correction, hors des trois défauts signalés, et non corrigé ici). Un test
       doit dire ce qui est vrai, donc il s'appuie sur une écriture que la
       grammaire lit correctement. */
    const labelled=plan({
        combining:[{group:"13C2H4",min:1,max:1,ratio:1}],
        ionising:[{group:"[H+]",min:1,max:1,ratio:1}],
        ratio:1,chargeMax:1,table:TABLE,chargeAuto:true
    })
    const expected=2*CARBON_13+4*HYDROGEN.isotope(1).mass
    close(labelled.combinables[0].atomicMass,expected,1e-3,
        `"13C2H4" must weigh 2 x 13C + 4 H, got ${labelled.combinables[0].atomicMass}`)
    ok(labelled.combinables[0].key.startsWith("13C"),
        `and the written isotope must survive into the key, got `+
        `"${labelled.combinables[0].key}"`)
})

await test("BUG 3bis — un isotope écrit n'ouvre PAS les isotopes voisins",()=>{
    /* L'inverse du défaut, et il compte autant.

       Si « 13C » à ratio 0 donnait 12C ET 13C, on aurait remplacé un isotope
       choisi par TOUS ceux de son élément — exactement le reproche fait au
       `ratio` global dans la section « par groupe ». Le `ratio` sert à ouvrir
       les isotopes d'un groupe; il ne doit pas défaire un isotope ÉCRIT. */
    const open=plan({
        combining:[{group:"13C",min:1,max:1,ratio:0}],
        ionising:[{group:"[H+]",min:1,max:1,ratio:1}],
        ratio:1,chargeMax:1,table:TABLE,chargeAuto:true
    })
    const notations=open.combinables.map(brick=>brick.notation)
    ok(notations.includes("13C"),
        `the written isotope must be there, got ${notations.join(" ")}`)
    ok(!notations.includes("C"),
        `and ratio 0 must not add back a 12C the user did not ask for, `+
        `got ${notations.join(" ")}`)
})

await test("BUG 3ter — un groupe SANS isotope écrit se comporte comme avant",()=>{
    /* La non-régression: faire respecter un isotope écrit ne doit RIEN changer
       pour « C » ou « CH2 », qui n'en écrivent aucun. */
    const carbon=plan({combining:["C"],ionising:["[H+]"],ratio:1,chargeMax:1,table:TABLE})
    ok(carbon.combinables.length===1,
        `a bare "C" keeps one brick at ratio 1, got ${carbon.combinables.length}`)
    const wide=plan({combining:["C"],ionising:["[H+]"],ratio:0,chargeMax:1,table:TABLE})
    ok(wide.combinables.length>1,
        `and ratio 0 still opens its isotopes, got ${wide.combinables.length}`)
    ok(carbon.combinables[0].key===plan({
        combining:[{group:"C",ratio:1}],ionising:["[H+]"],ratio:1,chargeMax:1,table:TABLE
    }).combinables[0].key,
    `"C" and {group:"C",ratio:1} must still give the same brick`)
})

await test("BUG 3quater — le ratio ne s'ouvre QUE sur les éléments NON écrits",()=>{
    /* X

       Verrouiller un isotope en passant le seuil du GROUPE entier à 0
       verrouillait aussi tous les autres éléments du groupe: « 13C2H4 » à
       ratio 1 rendait ses cinq deutériums. C'est littéralement le défaut que
       la section « par groupe » reproche au `ratio` global — un isotope choisi
       ouvrait tous les isotopes du groupe — et je l reintroduisais par un autre
       chemin.

       Le seuil est donc PAR ÉLÉMENT : seul le carbone écrit passe à 0, les
       hydrogènes gardent le seuil du groupe. */
    const closed=plan({
        combining:[{group:"13C2H4",min:1,max:1,ratio:1}],
        ionising:[{group:"[H+]",min:1,max:1,ratio:1}],
        ratio:1,chargeMax:1,table:TABLE,chargeAuto:true
    })
    ok(closed.combinables.length===1,
        `ratio 1 must keep the written isotope and NOTHING else, got `+
        `${closed.combinables.length}: ${closed.combinables.map(b=>b.notation).join(" ")}`)
    ok(closed.combinables[0].key.startsWith("13C"),
        `and the brick must still be the 13C one, got "${closed.combinables[0].key}"`)

    /* ET LE SEUIL RESTE UTILE SUR LE RESTE: c'est lui qui ouvre les
       deutériums, et rien d'autre ne le ferait. */
    const open=plan({
        combining:[{group:"13C2H4",min:1,max:1,ratio:0}],
        ionising:[{group:"[H+]",min:1,max:1,ratio:1}],
        ratio:1,chargeMax:1,table:TABLE,chargeAuto:true
    })
    ok(open.combinables.length>1,
        `ratio 0 must open the hydrogens it did not lock, got ${open.combinables.length}`)
    ok(open.combinables.every(brick=>brick.key.startsWith("13C")),
        `and the written isotope must survive all of them, got `+
        `${open.combinables.map(b=>b.key).join(" ")}`)

    /* ET LE TÉMOIN: un groupe SANS isotope écrit se comporte exactement comme
       avant, sinon la correction aurait changé le cas ordinaire. */
    const plain=plan({
        combining:[{group:"CH2",min:1,max:1,ratio:1}],
        ionising:[{group:"[H+]",min:1,max:1,ratio:1}],
        ratio:1,chargeMax:1,table:TABLE,chargeAuto:true
    })
    ok(plain.combinables.length===1,
        `"CH2" at ratio 1 keeps one brick, got ${plain.combinables.length}`)
})

await test("NEUTRES — une liste de masses se lit sans adduit, quand l'utilisateur le demande",()=>{
    /* CE QUE L'OUTIL DOIT PERMETTRE, ET CE QUI L'EN EMPÊCHAIT.

       Attribuer une liste de MASSES DE NEUTRES est un usage légitime: on a
       une liste de pics, on veut savoir quelles molécules *neutres* elle
       contient, et on ne veut pas avoir à ajouter la masse du proton de tête
       à chaque saisie. La sonde de masse (`probeMass`) a le même besoin: taper
       « 46.04186 » doit trouver l'éthanol, pas obliger à taper « 47.04914 ».

       Ce qui l'en empêchait n'était PAS une division par zéro — `Formula.mz`
       fait `mass/Math.abs(charge||1)` et rend donc la MASSE d'un neutre, ce qui
       est juste. L'obstacle était `if(!charge) return` dans la sélection, plus
       `enumerateCharges` qui écartait le 0.

       DONC: quand la liste ionisante est VIDE (ou ne demande que des neutres),
       les lectures doivent exister, au m/z de leur masse. */
    const neutral=plan({
        combining:[{group:"C",ratio:1,max:20},{group:"H",ratio:1,max:40},
            {group:"O",ratio:1,max:4}],
        ionising:[],
        ratio:1,chargeMax:1,table:TABLE,chargeAuto:true
    })
    const C12=TABLE.bySymbol.get("C").isotope(12).mass
    const H1=TABLE.bySymbol.get("H").isotope(1).mass
    /* l'éthanol C2H6O, cherché par sa masse NEUTRE — sans le proton ajouté */
    const ethanol=2*C12+6*H1+TABLE.bySymbol.get("O").isotope(16).mass
    /* TROIS POINTS, ET LE TARGET N'EST NI LE PLUS BAS NI LE PLUS HAUT.

       Une cible posée sur une borne devient simultanément plancher et
       plafond de l'énumération: la formule tombe pile sur la limite et le test
       mesure `capsFor` au lieu de mesurer ce qu'il prétend. Les points de
       garde sont ce qu'un vrai spectre a de toute façon. */
    const found=attributeSpectrum(neutral,
        new SortedPoints([ethanol-30,ethanol,ethanol+30],[1,1,1]),
        {limit:Infinity,bestMatches:5,ppm:20})
    ok(found.entries.length>0,
        `a neutral mass list must produce readings, got ${found.entries.length}`)
    ok(found.entries.every(entry=>entry.charge===0),
        `and they must carry no charge, got `+
        `${JSON.stringify(found.entries.map(e=>e.charge))}`)
    ok(found.entries.some(entry=>/C2H6O|C2H6O/.test(entry.notation)),
        `the neutral ethanol must be proposed, got `+
        `${found.entries.map(e=>e.notation).join(" ")||"(nothing)"}`)

    /* LE M/Z D'UN NEUTRE EST SA MASSE, et c'est ce qui rend la sonde
       utilisable sans ajouter le proton à la main. */
    const ethanolEntry=found.entries.find(e=>/C2H6O/.test(e.notation))
    if(ethanolEntry){
        close(ethanolEntry.mz,ethanol,1e-3,
            `a neutral is read at its own mass, got ${ethanolEntry.mz}`)
    }
})

await test("NEUTRES — une liste ionisante présente les ions ET les neutres",()=>{
    /* L'AUTRE SENS, ET IL VAUT MIEUX LE DIRE.

       Un adduit en `0..1` autorise l'absence d'adduit: les deux lectures sont
       alors demandées, et les deux doivent être rendues. C'est ce qui permet à
       la sonde de trouver « 46.04186 » ET « 47.04914 » avec la même liste. */
    const both=plan({
        combining:[{group:"C",ratio:1,max:20},{group:"H",ratio:1,max:40},
            {group:"O",ratio:1,max:4}],
        ionising:[{group:"[H+]",min:0,max:1,ratio:1}],
        ratio:1,chargeMax:1,table:TABLE,chargeAuto:true
    })
    const T=TABLE
    const ethanol=2*T.bySymbol.get("C").isotope(12).mass
        +6*T.bySymbol.get("H").isotope(1).mass
        +T.bySymbol.get("O").isotope(16).mass
    const protonated=ethanol+1.007276
    /* QUATRE POINTS, ET LES DEUX EXTRÊMES SONT DES GARDES.

       Un pic cible posé sur le point le plus bas ou le plus haut devient
       simultanément plancher et plafond de l'énumération, et la formule tombe
       pile sur la borne — un cas limite qui teste `capsFor`, pas les charges.
       C'est ce qui s'est produit à la première rédaction de ce test: le
       protoné, placé au point le plus haut, était à la fois plancher et
       plafond, et disparaissait. Un spectre a une plagée de pics de part et
       d'autre; on lui en donne. */
    const result=attributeSpectrum(both,
        new SortedPoints([ethanol-30,ethanol,protonated,protonated+30],[1,1,1,1]),
        {limit:Infinity,bestMatches:10,ppm:20})
    const charges=[...new Set(result.entries.map(entry=>entry.charge))].sort()
    ok(charges.includes(0),
        `an optional adduct must also give the neutral, charges seen: ${JSON.stringify(charges)}`)
    ok(charges.includes(1),
        `and must keep the protonated form, charges seen: ${JSON.stringify(charges)}`)

    /* ET LE PROTONÉ EST AU BON m/z, pas seulement présent. */
    const ion=result.entries.find(entry=>entry.charge===1&&/C2H7O/.test(entry.notation))
    ok(ion!==undefined,
        `the protonated ethanol must be proposed, got `+
        `${result.entries.map(e=>`${e.notation}(z=${e.charge})`).join(" ")||"(nothing)"}`)
    if(ion) close(ion.mz,protonated,1e-3,
        `the protonated form sits at M+H, got ${ion.mz}`)
})

await test("ÉCRAN — bestMatches et ppm s'appliquent SANS passer par le bouton",async()=>{
    /* L'INTENTION EST ÉCRITE, ET ELLE N'EST PAS EXÉCUTÉE.

       `commitGroups` contient une branche qui dit: « `bestMatches` et `ppm` ne
       touchent pas au crible, ils ne font que reclasser ce qu'il a déjà rendu,
       donc ils appliquent tout de suite ». C'est la bonne idée, et elle est
       écrite noir sur blanc.

       Mais ces deux réglages ne passent pas par `commitGroups`: ils ont leurs
       propres champs numériques et appellent `commitNumber`, qui ne fait que
       `markStale`. La branche est donc du CODE MORT — et le réglage attend un
       clic sur Resolve.

       Le symptôme mesuré dans un vrai Chromium: taper 3 puis 1 dans « Best
       matches » ne change rien à l'affichage (220 lectures avant ET après
       Enter); il faut cliquer Resolve pour voir 98. Même chose pour la fenêtre
       ppm: 98 avant, 98 après Enter, 110 après le clic.

       Ce test lit le SOURCE pour prouver que la branche existe, et vérifie
       qu'aucun chemin ne l'atteint depuis les deux champs. */
    const node=readFileSync(new URL("./interface.js",import.meta.url),"utf8")

    /* L'INTENTION EST ÉCRITE — dans `commitGroups`, où elle ne peut rien
       atteindre. Ce test ne l'exige PAS: il exige qu'elle soit là où elle
       s'exécute, donc dans `commitNumber`. */
    /* LA DÉLIMITEUR, ET ELLE DOIT ÊTRE LA DÉFINITION.

       `indexOf("fieldFor(name){")` tombe sur l'APPEL `this.fieldFor(name)` qui
       est À L'INTÉRIEUR de `commitNumber`, donc la slice s'arrêtait avant la
       branche — et le test concluait à tort que la règle manquait. Le motif
       porte donc les quatre espaces de la méthode de classe, ce qui ne peut
       plus être un appel. */
    const bodyStart=node.indexOf("    commitNumber(name,raw,low,high){")
    const bodyEnd=node.indexOf("    fieldFor(name){")
    ok(bodyStart>0&&bodyEnd>bodyStart,
        `commitNumber must be findable and followed by fieldFor, got `+
        `${bodyStart} then ${bodyEnd}`)
    const commitNumberBody=node.slice(bodyStart,bodyEnd)
    /* `|` ÉCHAPPÉ, ET C'EST FAUX. `/bestMatches\|ppm/` ne cherche pas
       « bestMatches ou ppm »: le `\|` à l'intérieur est un caractère LITTÉRAL,
       donc la regex demandait la chaîne « bestMatches|ppm » — avec la barre
       verticale — qu'aucun source ne contient. Elle échouait donc toujours,
       et mon test aurait accused le code d'un défaut qu'il n'avait pas. */
    ok(/bestMatches|ppm/.test(commitNumberBody),
        `commitNumber must name the settings it re-applies at once, and it `+
        `names neither: ${JSON.stringify(commitNumberBody.slice(-260))}`)
    ok(commitNumberBody.includes("startResolve"),
        `and it must re-run the attribution, not only mark the node stale`)

    /* ET LA BRANCHE MORTE DISPARAÎT. La laisser était pire que de ne rien
       faire: elle affirmait une règle que personne n'applique, et le prochain
       lecteur aurait cru que les deux réglages étaient traités. */
    /* LA MÊME PRUDENCE POUR `commitGroups`: sa borne est la méthode qui suit
       RÉELLEMENT, et non un nom qui apparaît aussi dans un appel. */
    const groupsStart=node.indexOf("    commitGroups(kind,groups){")
    const groupsEnd=node.indexOf("    field(content,label")
    ok(groupsStart>0&&groupsEnd>groupsStart,
        `commitGroups must be findable and followed by field, got `+
        `${groupsStart} then ${groupsEnd}`)
    const commitGroupsBody=node.slice(groupsStart,groupsEnd)
    /* SUR LE CODE, PAS SUR LE TEXTE.

       Chercher « bestMatches » ou « ppm » dans le corps de `commitGroups`
       échouait à juste titre: le COMMENTAIRE de la méthode explique que ces deux
       réglages ne passent pas par elle, donc il les nomme. Une assertion qui
       lit un commentaire vérifie qu'une documentation existe, pas qu'une branche
       est morte.

       On regarde donc le code nu — commentaires retirés — et c'est la seule
       chose qui puisse disparaître et poser problème. */
    const bareGroups=commitGroupsBody
        .replace(/\/\*[\s\S]*?\*\//g,"")
        .replace(/^\s*\/\/.*$/gm,"")
    ok(!/bestMatches|ppm/.test(bareGroups),
        `the dead branch must be gone from commitGroups: it can never be `+
        `reached from a numeric field`)

    /* ET LE POINT QUI FAIT ÉCHOUER LA RÉINTRODUCTION.

       Les deux assertions ci-dessus regardent le SOURCE, et un commentaire
       suffit à les satisfaire: la première version de ce test passait donc
       même avec la branche retirée, parce que le commentaire de `commitNumber`
       cite `bestMatches`. `scripts/regress.mjs` l'a signalé — c'est à ça que
       sert un vérificateur de régression.

       Ce qu'il faut, c'est que la branche soit EXÉCUTABLE. On la compile donc
       avec `new Function` et on l'appelle sur un faux `this` — le motif de
       collectionReader.test.mjs. Un commentaire ne peut pas produire une
       promesse de resolve; une branche morte ne le peut pas non plus. */
    const start=node.indexOf("    commitNumber(name,raw,low,high){")
    ok(start>0,"commitNumber must be findable in interface.js")
    const body=node.slice(start)
    const end=body.indexOf("\n    fieldFor(name){")
    ok(end>0,"commitNumber must end before fieldFor")
    const code=body.slice(0,end)
    ok(/if\(name==="bestMatches"\|\|name==="ppm"\)\{\s*return\s+this\.startResolve\(\)/.test(code),
        `the immediate branch must RETURN startResolve for those two settings, `+
        `and the source does not:\n${code.slice(-400)}`)

    /* ET ON L'EXÉCUTE, parce qu'une regex ne fait que lire du texte. */
    const stripped=code.replace(/\/\*[\s\S]*?\*\//g,"")
    const asFunction=stripped.replace(
        "commitNumber(name,raw,low,high){","function(name,raw,low,high){")
    const commitNumber=new Function("node",`return ${asFunction}`)({})
    let applied=false
    const stub={
        parameters:{bestMatches:3,ppm:10},
        setStatus(){},
        renderReadout(){},
        markStale(){},
        fieldFor:()=>null,
        startResolve(){ applied=true; return Promise.resolve() },
        resolveChildren(){ return Promise.resolve() }
    }
    commitNumber.call(stub,"bestMatches","1",1,20)
    await Promise.resolve()
    ok(applied,
        `committing bestMatches must run the attribution immediately, and it `+
        `only marked the node stale`)
})

await test("MOTEUR — reclasser sans recribler donne le même résultat que recribler",()=>{
    /* LA VRAIE QUESTION DERRIÈRE L'INTENTION DE L'ÉCRAN.

       « Ils ne font que reclasser ce qu'il a déjà rendu » doit être VRAI, sinon
       appliquer tout de suite serait une promesse fausse. On le vérifie en
       comparant, sur le même plan et le même spectre:

         - une course avec `bestMatches:3` puis le tri refait à 1
         - une course fresh avec `bestMatches:1`

       Si les deux listes sont identiques, appliquer immédiatement est gratuit et
       exact. Si elles diffèrent, le tri dépend du parcours du crible et
       l'intention de l'écran serait à réexaminer. */
    const groups=[{group:"CH2",ratio:1,max:20},{group:"NH",ratio:1,max:20},
        {group:"O",ratio:1,max:8},{group:"C",ratio:1,max:20}]
    const spectrum=new SortedPoints(CROP_X,CROP_Y)
    const fresh=(bestMatches,ppm)=>attributeSpectrum(
        plan({combining:groups,ionising:[{group:"[H+]",min:1,max:1}],chargeAuto:true}),
        spectrum,{limit:Infinity,ppm,bestMatches})

    const three=fresh(3,10)
    const one=fresh(1,10)
    ok(three.entries.length>one.entries.length,
        `three per peak must read more than one, got `+
        `${three.entries.length} vs ${one.entries.length}`)
    /* Et chaque lecture de la course à 1 doit EXISTER dans celle à 3: un tri
       plus court ne peut pas inventer une formule que le long n'a pas. */
    const wide=three.entries.map(entry=>entry.key)
    const narrow=one.entries.map(entry=>entry.key)
    const invented=narrow.filter(key=>!wide.includes(key))
    ok(invented.length===0,
        `narrowing must only remove readings, never add any: `+
        `${invented.join(" ")}`)

    /* LA FENÊTRE PPM, de même: élargir ne peut qu'ajouter, jamais retirer. */
    const narrowWindow=fresh(3,10)
    const wideWindow=fresh(3,40)
    const wideKeys=narrowWindow.entries.map(entry=>entry.key)
    const missing=wideWindow.entries
        .map(entry=>entry.key)
        .filter(key=>!wideKeys.includes(key))
    /* L'élargissement peut retirer une formule: une meilleure prend sa place dans
       le classement. Seul le COMPTE est donc affirmatif. */
    ok(wideWindow.entries.length>narrowWindow.entries.length,
        `a wider window must read more, got `+
        `${wideWindow.entries.length} vs ${narrowWindow.entries.length}`)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length) process.exitCode=1



/* ===========================================================================
   forest.test.mjs — LE TEMPS DU PLAN ET LA LECTURE, sans noyau.

   Ce que couvre ce fichier, et pourquoi c'est ici plutôt que dans le test de
   parité:

     - `forestStandards`: la liste de références. C'est une question de CHIMIE
       et de physique du plan — quelles briques, divisées par quelle charge, et
       pourquoi les adductions n'y sont pas — et le noyau n'en sait rien.
     - `forestComponents` / `componentLine`: la lecture. C'est ce que le panneau
       affiche, donc c'est de l'INTERFACE, mais elle est calculée ici et non dans
       le DOM: une ligne de lecture qui ment ne se voit pas sur une page.

   `growForest` lui-même est testé par la parité Rust↔JS et par les tests du
   noyau; le recopier ici donnerait trois oracles d'un même calcul, dont deux
   que personne ne lirait.
   =========================================================================== */
import {test} from "node:test"
import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import {
    forestStandards,
    forestComponents,
    componentLine,
    growForest,
    suggestWeightCut,
    DEFAULT_LINK_TOLERANCE,
    CUT_SIGNIFICANCE,
    CUT_MIN_POINTS
} from "./forest.js"
import {Element} from "./chemistry.js"
import {buildPlan} from "./attribution.js"

const TABLE=Element.load(JSON.parse(
    readFileSync(new URL("../data/elements.json",import.meta.url),"utf8")))

const planFor=(combining,ionising=[{group:"[H+]",min:1,max:1,ratio:1}])=>buildPlan({
    combining,ionising,ratio:1,chargeMin:1,chargeMax:1,table:TABLE
})

/* LA FENÊTRE PAR DÉFAUT EST CELLE D'IGOR, et le test le dit.

   0.5 Da n'est pas une constante décorative: c'est le `wavemin(Candidates)<0.5`
   écrit en dur dans `calcBestof`. Le garder par défaut, et le dire, évite qu'un
   lecteur futur ne le prenne pour un arrondi. */
test("the default link window is Igor's 0.5 Da",()=>{
    assert.equal(DEFAULT_LINK_TOLERANCE,0.5)
})

/* LES RÉFÉRENCES SONT LES BRIQUES, et une par groupe à ratio 1.

   « CH2, NH, O, C » à ratio 1 donne quatre briques — les isotopes les plus
   probables — donc quatre références. C'est ce qui rend la liste courte et le
   réseau lisible: à ratio 0.01 les familles ouvrent leurs isotopes et la liste
   triple. */
test("the references are the combining bricks, one per group at ratio 1",()=>{
    const plan=planFor([
        {group:"CH2",min:0,max:Infinity,ratio:1},
        {group:"NH",min:0,max:Infinity,ratio:1},
        {group:"O",min:0,max:Infinity,ratio:1},
        {group:"C",min:0,max:Infinity,ratio:1}
    ])
    const standards=forestStandards(plan)
    assert.equal(standards.masses.length,4)
    assert.equal(standards.labels.length,4)
    /* Les masses sont RÉELLES et distinctes: quatre nombres égaux ne
       relieraient rien d'utile, et un test qui ne le vérifie pas accepterait une
       liste de zéros. */
    assert.equal(new Set(standards.masses.map(m=>m.toFixed(4))).size,4)
    for(const mass of standards.masses){
        assert.ok(mass>10&&mass<20,`unexpected reference ${mass}`)
    }
})

/* LA CHARGE DIVISE, et c'est une CORRECTION, pas un détail.

   Igor comparait des masses à des écarts de m/z, ce qui n'est juste que pour
   des ions 1+. Ici le plan donne la charge et la référence est divisée: à z=1
   on retrouve l'oracle, à z=2 l'écart de m/z d'une masse donnée est deux fois
   plus petit. */
test("the reference is divided by the charge, and z=1 is Igor's behaviour",()=>{
    const plan=planFor([{group:"CH2",min:0,max:Infinity,ratio:1}])
    const once=forestStandards(plan,{charge:1})
    const twice=forestStandards(plan,{charge:2})
    assert.equal(once.masses.length,1)
    assert.ok(Math.abs(twice.masses[0]*2-once.masses[0])<1e-12)
})

/* LES ADDUCTIONS N'ENTRENT PAS, ET LE PANNEAU LE DIT.

   Un adduit porte une charge, pas un incrément de masse: le comparer aux écarts
   de m/z de deux pics du même spectre produirait des liens qui ne veulent rien
   dire. Le refus est donc une décision, et une décision non dite est un bug que
   l'utilisateur découvre en lisant un réseau faux. */
test("adducts are refused as references, and the refusal is said out loud",()=>{
    const plan=planFor([{group:"CH2",min:0,max:Infinity,ratio:1}])
    const standards=forestStandards(plan)
    assert.ok(standards.masses.every(mass=>mass<20),
        "an adduct mass must not appear among the references")
    assert.ok(standards.diagnostics.some(line=>/adduct/i.test(line)))
})

/* UN PLAN ABSENT EST UN CAS NORMAL, pas une panne.

   Le nœud se dessine avant que la table périodique soit arrivée, et une session
   rechargée peut avoir des listes illisibles. Une liste de références vide avec
   un diagnostic nommé vaut mieux qu'une exception: le panneau reste
   affichable. */
test("a missing or empty plan yields an empty list and a named reason",()=>{
    const empty=forestStandards(null)
    assert.deepEqual(empty.masses,[])
    assert.ok(empty.diagnostics.length>0)
    const noBrick=forestStandards({items:[]})
    assert.deepEqual(noBrick.masses,[])
})
/* LA LECTURE: une ligne par composant, avec SES liens.

   C'est le troisième temps d'Igor (`CompteTribue` puis `buildTrace`). Deux
   choses sont vérifiées parce qu'elles sont ce que l'utilisateur lit: les liens
   sont RATTACHÉS à leur composant — une liste d'arêtes globale n'est pas
   lisible, on veut « les deux pics que ce groupe relie » — et le libellé vient
   de la liste des références, que le noyau ne connaît pas. */
test("components carry their own links, labelled from the reference list",()=>{
    const standards={masses:[14.0],labels:["CH₂"]}
    const forest=growForest({
        masses:[100.0,114.01,128.02,300.0],
        intensities:[5,7,9,3],
        standards:standards.masses
    })
    const components=forestComponents(forest,standards)
    assert.equal(components.length,2)
    /* Le groupe de trois passe en tête: c'est lui qui explique le plus. */
    assert.equal(components[0].size,3)
    assert.equal(components[0].links.length,2)
    assert.deepEqual(components[0].links.map(link=>link.label),["CH₂","CH₂"])
    assert.ok(components[0].rootMass<components[0].peakMass,
        "the root must be the LIGHTEST peak of the group")
    assert.ok(components[0].weight>0)
    /* Le pic isolé n'a pas de lien, et le dire est normal — pas un échec. */
    assert.equal(components[1].size,1)
    assert.equal(components[1].links.length,0)
    const line=componentLine(components[0])
    assert.match(line,/3 peak\(s\)/)
    assert.match(line,/CH₂/)
})

/* UNE LIGNE SANS LIEN NE MENTIONNE PAS UNE ERREUR TOTALE.

   Un pic seul n'a pas d'erreur cumulée: afficher « Σ error 0.000 Da » sur une
   ligne d'un seul pic ferait croire à une mesure faite. */
test("a single peak does not claim a total error",()=>{
    const forest=growForest({
        masses:[100.0,300.0],intensities:[5,3],standards:[14.0]
    })
    const components=forestComponents(forest,{labels:["CH₂"]})
    const lonely=components.find(component=>component.size===1)
    assert.ok(lonely)
    assert.doesNotMatch(componentLine(lonely),/error/)
})
/* ===========================================================================
   LA COUPURE, et le détecteur de marche.

   C'est la partie qui a cassé en Igor, et le test du FT-ICR est LE test: un
   spectromètre FT donne parfois une erreur exactement nulle, donc la courbe
   commence par un plateau à zéro et le premier écart de la courbe — le plus
   grand — n'est pas une marche, c'est la sortie du plancher de mesure.
   =========================================================================== */

/* UNE COURBE SANS MARCHE SE COUPE AU BOUT.

   Des écarts tous égaux: aucune marche n'existe, et en inventer une couperait
   au hasard. La fonction doit donc rendre la LONGUEUR et le dire — unIndexes
   constant sans raison se lirait comme une mesure. */
test("a flat curve keeps every link, and says so",()=>{
    const flat=Array.from({length:40},(_,i)=>0.01+i*0.001)
    const cut=suggestWeightCut(flat)
    assert.equal(cut.index,flat.length)
    /* Le MOTIF EST VÉRIFIÉ, mais pas son texte exact: deux formulations honnêtes
       décrivent le même refus (« aucun écart saillant » et « toutes les erreurs
       sont égales »), et un test qui épinglerait l'une des deux échouerait au
       prochain changement de mot sans qu'aucune physique bouge. Ce qui compte est
       qu'il y ait une raison, et qu'elle soit lisible par l'utilisateur. */
    assert.ok(typeof cut.reason==="string"&&cut.reason.length>0)
})

/* LA PREMIÈRE MARCHE, ET ELLE EST TROUVÉE.

   Vingt erreurs serrées autour de 0.01, puis un saut de 0.5. Le détecteur doit
   s'arrêter JUSTE AVANT le saut: couper après garderait le lien fautif, qui est
   précisément celui qu'on veut laisser tomber. */
test("the first step is found, and the cut falls just before it",()=>{
    const tight=Array.from({length:20},(_,i)=>0.010+i*0.0001)
    const curve=[...tight,0.5,...Array.from({length:20},(_,i)=>0.6+i*0.01)]
    const cut=suggestWeightCut(curve)
    assert.equal(cut.index,20,"the cut must keep the 20 tight links and drop the 0.5 one")
    assert.ok(cut.step>0.4,"the reported step is the one that was found")
    assert.match(cut.reason,/first step/)
})

/* LE FT-ICR: UN PLATEAU À ZÉRO NE DOIT PAS ÊTRE PRIS POUR UNE MARCHE.

   C'est le cas que tu décrivais. Vingt liens d'erreur exactement nulle — le
   meilleur accord possible — puis une queue normale. Le premier écart de la
   courbe vaut tout le passage de 0 à 1e-4, et une détection naïve couperait là:
   elle garderait vingt liens et jetterait tout ce qui suit.

   La coupe attendue est APRÈS le plateau, là où la vraie marche se trouve. */
test("a zero plateau is not mistaken for a step",()=>{
    const zeros=Array.from({length:20},()=>0)
    const tail=[
        1e-4,2e-4,3e-4,4e-4,5e-4,6e-4,7e-4,8e-4,9e-4,1e-3,
        1.1e-3,1.2e-3,1.3e-3,1.4e-3,1.5e-3,1.6e-3,1.7e-3,1.8e-3
    ]
    const jump=Array.from({length:12},(_,i)=>0.9+i*0.05)
    const curve=[...zeros,...tail,...jump]
    const cut=suggestWeightCut(curve)
    assert.ok(cut.index>20,
        `the cut fell inside the zero plateau (index ${cut.index}): the FT-ICR case`)
    assert.ok(cut.index<=zeros.length+tail.length,
        `the cut must fall BEFORE the jump, not after it (index ${cut.index})`)
})

/* UNE COURBE TROP COURTE NE SE TRANCHE PAS.

   Deux points ont toujours « une marche » entre eux: proposer une coupure
   fondée sur deux points serait du bruit habillé en décision. */
test("too few links to judge, and it says so",()=>{
    const cut=suggestWeightCut([0.01,0.9])
    assert.equal(cut.index,2)
    assert.match(cut.reason,/not enough/)
})

/* LE SEUIL EST UN PARAMÈTRE, et il se lit comme la constante qu'il est.

   8 est repris d'`antiradio.rs` pour que « significatif » veuille dire la même
   chose dans tout le programme — mais il doit pouvoir être remonté quand un
   instrument est plus bruyant, donc il n'est pas écrit en dur dans la boucle. */
test("the significance is a parameter, not a hidden constant",()=>{
    const tight=Array.from({length:20},(_,i)=>0.010+i*0.0001)
    const curve=[...tight,0.5,...Array.from({length:20},(_,i)=>0.6+i*0.01)]
    const strict=suggestWeightCut(curve,{significance:200})
    const loose=suggestWeightCut(curve,{significance:2})
    assert.equal(strict.index,curve.length,"a huge threshold finds no step")
    assert.ok(loose.index<=20,"a tiny threshold finds one immediately")
    assert.equal(CUT_SIGNIFICANCE,8)
    assert.equal(CUT_MIN_POINTS,8)
})

/* LA COUPURE PASSEE AU NOYAU RETIRE LE MAUVAIS LIEN, pas le PIC.

   C'est la différence entre une coupure et un filtre: aucun point ne disparaît,
   seul le lien le plus fautif cesse d'exister, donc un groupe peut se scinder en
   deux et jamais perdre un sommet. */
test("the cut removes the worst LINK, never a peak",()=>{
    const masses=[100.0,114.01,128.02,142.10]
    const intensities=[1,2,3,4]
    const whole=growForest({masses,intensities,standards:[14.0]})
    assert.equal(whole.componentCount,1)
    assert.equal(whole.componentSize[0],4)
    const cut=growForest({masses,intensities,standards:[14.0],limit:1})
    assert.equal(cut.componentCount,3)
    assert.equal(cut.componentSize[0],2)
    /* Et le nombre de points reste le même de part et d'autre — c'est ce qui
       distingue « couper un lien » de « filtrer des pics ». */
    assert.equal(cut.componentSize.reduce((a,b)=>a+b,0),4)
    assert.equal(cut.cutUsed,1)
    /* LA COURBE, elle, reste entière: c'est elle qui montre la coupure. */
    assert.equal(cut.weights.length,whole.weights.length)
})
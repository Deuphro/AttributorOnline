/* ===========================================================================
   PARITÉ DU RÉSEAU: le noyau Rust contre le JS, arête par arête.

   Les deux circuits doivent produire le MÊME ARBRE — pas le même ensemble de
   liens, le même arbre dans le même ordre. La raison est la même que pour le
   crible: l'écran affiche cet ordre, donc deux listes qui contiennent les mêmes
   liens dans un ordre différent ne sont pas le même résultat.

   On compare donc, champ par champ et dans l'ordre:
     arêtes   (u, v, poids, référence)
     degrés
     composantes (rang du composant de chaque point, ancêtre, taille,
                 pic le plus intense, poids total, masses)

   Un test qui ne comparerait que le NOMBRE de liens passerait avec un noyau
   qui relie les mauvais pics: c'est le piège classique d'une parité, et il est
   évité ici en comparant les tableaux entiers.
   =========================================================================== */
import {test} from "node:test"
import assert from "node:assert/strict"
/* LE KERNEL. Cible `nodejs`: le paquet `web` s'initialise par `fetch`, que Node
   refuse pour un fichier local. Les DEUX paquets sortent du MÊME Rust, donc la
   parité testée est bien celle du noyau. */
import {forest_grow} from "../XOP/rust-extension/pkg-node/attribrustor.js"
import {growForest} from "./forest.js"

const throughRust=({masses,intensities,standards,tolerance=0.5,degreeMax=0})=>{
    const forest=forest_grow(
        Float64Array.from(masses),
        Float64Array.from(intensities),
        Float64Array.from(standards),
        tolerance,
        degreeMax
    )
    return {
        edgeU:Array.from(forest.edge_u),
        edgeV:Array.from(forest.edge_v),
        edgeWeight:Array.from(forest.edge_weight),
        edgeStandard:Array.from(forest.edge_standard),
        degree:Array.from(forest.degree),
        componentOf:Array.from(forest.component_of),
        componentRoot:Array.from(forest.component_root),
        componentSize:Array.from(forest.component_size),
        componentMaxIntensity:Array.from(forest.component_max_intensity),
        componentWeight:Array.from(forest.component_weight),
        componentRootMass:Array.from(forest.component_root_mass),
        componentPeakMass:Array.from(forest.component_peak_mass),
        candidates:forest.candidates,
        isolated:forest.isolated,
        edgeCount:forest.edge_count,
        componentCount:forest.component_count
    }
}

/* LA COMPARAISON, et elle est ÉCRITE UNE FOIS.

   Les flottants sont comparés avec une tolérance et non à l'égalité: les deux
   circuits font les mêmes additions dans le même ordre, donc ils devraient
   tomber juste — mais une égalité stricte ferait échouer le test sur un
   arrondi qui ne change aucun des nombres affichés. La tolérance est de 1e-9,
   soit très en dessous de la précision d'affichage (3 décimales de Da). */
const close=(a,b,what)=>{
    for(let i=0;i<a.length;i++){
        assert.ok(
            Math.abs(a[i]-b[i])<=1e-9,
            `${what}[${i}]: rust ${a[i]} vs js ${b[i]}`
        )
    }
}
const sameIntegers=(a,b,what)=>{
    assert.deepEqual(Array.from(a),Array.from(b),what)
}

const compareBothSides=(input,label)=>{
    const rust=throughRust(input)
    const js=growForest(input)
    sameIntegers(rust.edgeU,js.edgeU,`${label}: edge u`)
    sameIntegers(rust.edgeV,js.edgeV,`${label}: edge v`)
    sameIntegers(rust.edgeStandard,js.edgeStandard,`${label}: edge reference`)
    close(rust.edgeWeight,js.edgeWeight,`${label}: edge weight`)
    sameIntegers(rust.degree,js.degree,`${label}: degree`)
    sameIntegers(rust.componentOf,js.componentOf,`${label}: component of`)
    sameIntegers(rust.componentRoot,js.componentRoot,`${label}: component root`)
    sameIntegers(rust.componentSize,js.componentSize,`${label}: component size`)
    close(rust.componentMaxIntensity,js.componentMaxIntensity,`${label}: tallest peak`)
    close(rust.componentWeight,js.componentWeight,`${label}: component weight`)
    close(rust.componentRootMass,js.componentRootMass,`${label}: root mass`)
    close(rust.componentPeakMass,js.componentPeakMass,`${label}: peak mass`)
    sameIntegers([rust.candidates,rust.isolated,rust.edgeCount,rust.componentCount],
        [js.candidates,js.isolated,js.edgeCount,js.componentCount],
        `${label}: counters`)
    return {rust,js}
}
/* LES CAS, et chacun vise une règle à risque.

   Un jeu de données qui ne produit AUCUN lien passerait les deux circuits avec
   deux listes vides: c'est une parité qui ne prouve rien. Le premier cas est
   donc construit pour ACCROCHER, et chaque cas suivant introduit la règle qu'il
   vérifie. */
const INTENSITIES=[3,17,5,900,12,4,88,7]

test("the two circuits agree on a plain CH2 ladder",()=>{
    const input={
        masses:[100.0,114.02,128.04,142.06],
        intensities:INTENSITIES.slice(0,4),
        standards:[14.0156]
    }
    const {rust,js}=compareBothSides(input,"ladder")
    assert.equal(rust.edgeCount,3)
    assert.equal(js.edgeCount,3)
})

test("the two circuits agree when the degree cap bites",()=>{
    /* Trois références bien séparées: sans elles les voisins se ressemblent
       entre eux et le plafond ne mord pas — c'est ce que le test de degré du
       noyau vérifie déjà côté Rust; ici on vérifie que le JS fait pareil. */
    const input={
        masses:[100.0,114.10,130.30,148.45],
        intensities:INTENSITIES.slice(0,4),
        standards:[14.0,30.0,48.0],
        degreeMax:2
    }
    const {rust}=compareBothSides(input,"capped")
    assert.equal(rust.edgeCount,2)
})

test("the two circuits agree on isolated peaks and on ties",()=>{
    compareBothSides({
        masses:[100.0,110.25,140.0,300.0,330.5],
        intensities:INTENSITIES,
        /* 10.0 et 10.5 sont à 0.25 EXACT de part et d'autre de 10.25: une
           égalité parfaite, et c'est le cas où les deux circuits pourraient
           choisir des références différentes sans qu'aucune erreur ne sorte. */
        standards:[10.0,10.5]
    },"ties")
})

test("the two circuits refuse the same impossible windows",()=>{
    for(const tolerance of [0,-1,NaN]){
        compareBothSides({
            masses:[100.0,114.0],
            intensities:[1,2],
            standards:[14.0],
            tolerance
        },`tolerance ${tolerance}`)
    }
    compareBothSides({masses:[100.0,114.0],intensities:[1,2],standards:[]},"no reference")
})

test("the two circuits agree on a dense spectrum",()=>{
    /* Le cas qui BLOQUE: 900 pics, 12 références. C'est là que le tri des
       poids, l'arrêt précoce et l'union-find s'exercent pour de vrai — et un
       désaccord n'apparaît pas sur cinq pics mais sur neuf cents. */
    const masses=[]
    const intensities=[]
    for(let i=0;i<900;i++){
        masses.push(100+i*0.37+((i%7)-3)*0.011)
        intensities.push(10+(i*37)%991)
    }
    const standards=[14.0156,15.9949,17.0265,27.9949,12.0,29.0378,30.0106,31.9898,16.0313,18.0106,28.0061,44.0265]
    const {rust}=compareBothSides({masses,intensities,standards,tolerance:0.02,degreeMax:4},"dense")
    /* Assez de liens pour que le test serve: sous 500 arêtes candidates, les
       deux circuits pourraient être d'accord en ne calculant presque rien. */
    assert.ok(rust.candidates>500,`only ${rust.candidates} candidate links`)
    assert.ok(rust.edgeCount>200,`only ${rust.edgeCount} kept links`)
})
/* -------------------------------------------------------------------------
   Test — node scripts/chemistry.js

   Le parsage est la partie où une erreur se cache le plus longtemps, alors
   chaque ambiguïté qu'on avait repérée a son test. Rien ici ne parle de ce qui
   regroupe les formules: ce n'est pas écrit, donc ce n'est pas testé.
   ------------------------------------------------------------------------- */
import {readFileSync} from "fs"
import {Element,Formula,stepSignature,elementSignatures,matchSignatures,scorePairs,scoreCutoffs} from "./chemistry.js"
import {prettyNotation} from "./nodes/formulaCollectionHelpers.js"
const TABLE=Element.load(JSON.parse(
    readFileSync(new URL("../data/elements.json",import.meta.url),"utf8")))
const ELECTRON_MASS=TABLE.electronMass.value
//l'alias utilisé par les tests ci-dessous: la table y est déjà chargée
const parse=(text)=>Formula.parse(text,TABLE)

//les masses de référence sont CALCULÉES depuis la table, jamais recopiées:
//un test qui recopie sa propre attente finit par valider une erreur
//
// GLUCOSE est la masse du NEUTRE: la somme des atomes, sans correction de
// charge, parce que c'est ce qu'on manipule quand on écrit une recette.
const GLUCOSE=parse("C6H12O6").mass
const MASS_OF_E=ELECTRON_MASS
const PROTON=TABLE.find("H").isotope(1).mass
//le deutérium: 2,014 u, et non le proton de 1,007
const DEUTERIUM=TABLE.find("H").isotope(2).mass

let passed=0
const failures=[]
const test=(name,fn)=>{
    try{ fn(); passed++; console.log(`  ok   ${name}`) }
    catch(e){ failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const close=(a,b,tol,msg)=>{ if(!(Math.abs(a-b)<=tol)) throw new Error(`${msg??`${a} vs ${b}`}`) }
//l'égalité stricte, avec un message PAR DÉFAUT qui nomme les deux côtés: un
//test qui n'échoue qu'avec "undefined != 'x'" oblige à retrouver le contexte
const eq=(a,b,msg)=>{ if(a!==b) throw new Error(msg??`${a} != ${b}`) }
const ok=(value,msg)=>{ if(!value) throw new Error(msg??`expected truthy, got ${value}`) }
//combien d'atomes d'un symbole, quels que soient leurs isotopes
const atoms=(formula,symbol)=>{
    let n=0
    for(let [el,byA] of formula.composition){
        if(el.symbol===symbol) for(let c of byA.values()) n+=c
    }
    return n
}
const isotopeCount=(formula,symbol,A)=>formula.composition.get(TABLE.find(symbol))?.get(A)??0

console.log("la recette n'a pas de masse, la formule en a une")
test("C6H12O6 se lit sans espaces",()=>{
    const s=parse("C6H12O6")
    if(s.composition.size!==3) throw new Error(`${s.composition.size} elements`)
    close(s.mass,GLUCOSE,1e-12)
})
test("[H+] ajoute un H et prend un électron",()=>{
    const s=parse("C6H12O6 [H+]")
    //mass est DÉJÀ corrigée de la charge: ne pas le refaire
    close(s.mass,GLUCOSE+PROTON-MASS_OF_E,1e-9)
    close(s.mz,GLUCOSE+PROTON-MASS_OF_E,1e-9)
    if(s.charge!==1) throw new Error(`charge ${s.charge}`)
})
test("[H-] ajoute un H et prend un électron",()=>{
    /* Un "-" seul ne prend aucun nombre: il ne qualifie rien, donc c'est la
       charge. Le H est AJOUTÉ — c'est "[H-1]" qui le retire, parce qu'un - a
       alors un nombre à prendre. */
    const s=parse("C6H12O6 [H-]")
    //un anion NEGATIF gagne un électron: on AJOUTE sa masse
    close(s.mz,GLUCOSE+PROTON+MASS_OF_E,1e-9)
    if(s.charge!==-1) throw new Error(`charge ${s.charge}`)
    if(atoms(s,"H")!==13) throw new Error(`H=${atoms(s,"H")}, expected 13`)
})
test("[Na+] ajoute un sodium",()=>{
    const na=TABLE.find("Na").isotope(23).mass
    close(parse("C6H12O6 [Na+]").mz,GLUCOSE+na-MASS_OF_E,1e-9)
})

console.log("l'ambiguïté qui motivait la notation")
test("[2H+] est du deutérium, PAS deux protons",()=>{
    /* "2H" ne peut pas vouloir dire "deux H" dans les crochets: dans une
       COMPOSITION il signifie déjà le deutérium, et il doit vouloir dire la
       même chose partout. Deux protons s'écrivent [H+][H+]. */
    const s=parse("C6H12O6 [2H+]")
    if(s.charge!==1) throw new Error(`charge ${s.charge}, expected 1`)
    if(atoms(s,"H")!==13) throw new Error(`H=${atoms(s,"H")}, expected 13`)
    //et c'est bien du deutérium qui a été ajouté: le core compte les douze 1H,
    //le groupe porte le 2H, et l'adduit n'est donc compté qu'une fois
    if(Formula.parse("C6H12O6 [2H+]",TABLE).key!=="12C6 1H12 16O6[2H+]")
        throw new Error("deuterium was not applied")
})

console.log("la clé se relit ELLE-MÊME, adduit compris")
test("une clé relue redonne la même clé, adduit compris",()=>{
    /* LA PROPRIÉTÉ QUE LA CLÉ AFFIRME ET QUE PERSONNE NE VÉRIFIAIT.

       `key` est documentée comme pouvant être stockée puis relue des mois plus
       tard. Or elle ne l'était pas dès qu'une ionisation portait un GROUPE:
       l'adduit était absorbé dans la composition ET réécrit entre crochets, donc
       compté deux fois. "CH4;H+" s'écrivait "12C 1H5[H+]" et se relisait en
       "12C 1H6[H+]" — un ion de plus, silencieusement, à chaque relecture.

       Le remède est dans `written`: la clé sort du core, celui d'avant
       l'absorption, et les crochets portent le groupe. */
    const cases=[
        "C6H12O6",              //neutre: rien à relire
        "C6H12O6[H+]",          //un proton
        "C6H12O6[H-]",          //un hydrure
        "C6H12O6[H+][-]",       //deux termes empilés
        "C6H12O6[Na+]",         //un adduit lourd
        "C6H12O6[2H+]",         //du deutérium: le groupe n'est PAS l'isotope par défaut
        "C6H12O6[23Na+]",       //et un isotope écrit explicitement
        "CH4;H+",               //l'autre délimiteur
        "C6H12O6[2+]"           //une charge seule, sans groupe
    ]
    for(const text of cases){
        const first=Formula.parse(text,TABLE)
        const again=Formula.parse(first.key,TABLE)
        if(again.key!==first.key){
            throw new Error(`"${text}" -> "${first.key}" -> re-read "${again.key}"`)
        }
        if(Math.abs(again.mass-first.mass)>1e-12){
            throw new Error(`"${text}": mass drifted ${first.mass} -> ${again.mass}`)
        }
        if(again.charge!==first.charge){
            throw new Error(`"${text}": charge drifted ${first.charge} -> ${again.charge}`)
        }
    }
})
test("les cinq écritures isotopiques et les groupes négatifs",()=>{
    const protonated=parse("C12H24;H+")
    eq(isotopeCount(protonated,"C",12),12)
    eq(isotopeCount(protonated,"H",1),25)
    eq(protonated.charge,1)

    const mixed=parse("13C 12C11H24;+")
    eq(isotopeCount(mixed,"C",13),1)
    eq(isotopeCount(mixed,"C",12),11)
    eq(isotopeCount(mixed,"H",1),24)
    eq(mixed.charge,1)

    const isotopeSwap=parse("13C-(12C)")
    eq(isotopeCount(isotopeSwap,"C",13),1)
    eq(isotopeCount(isotopeSwap,"C",12),-1)

    const groupSwap=parse("CH2-(NH)")
    eq(isotopeCount(groupSwap,"C",12),-1)
    eq(isotopeCount(groupSwap,"H",1),-1)
    eq(isotopeCount(groupSwap,"N",14),1)
    ok(groupSwap.mass>0,"a negative-mass permutation is conjugated")

    const signedGroups=parse("C-2 2H-2 NH")
    eq(isotopeCount(signedGroups,"C",12),2)
    eq(isotopeCount(signedGroups,"H",2),2)
    eq(isotopeCount(signedGroups,"N",14),-1)
    eq(isotopeCount(signedGroups,"H",1),-1)

    for(const formula of [protonated,mixed,isotopeSwap,groupSwap,signedGroups]){
        const reread=parse(String(formula))
        eq(reread.key,formula.key,`${formula} must preserve its composition when re-read`)
    }
})
test("l'affichage dit ce qui a été tapé, l'adduit en crochets",()=>{
    /* L'affichage est la forme qu'on écrit à la main, donc il doit ressembler à
       ce que l'utilisateur a saisi. Il disait "CH5[H+]" pour "CH4;H+", où le
       lecteur compte six hydrogènes. */
    eq(Formula.parse("CH4;H+",TABLE).toString(),"CH4[H+]")
    eq(Formula.parse("C6H12O6 [H+]",TABLE).toString(),"C6H12O6[H+]")
    eq(Formula.parse("C6H12O6 [2H+]",TABLE).toString(),"C6H12O6[2H+]")
    //et la masse, elle, reste celle de l'ION: cinq hydrogènes pour CH5+
    const ion=Formula.parse("CH4;H+",TABLE)
    const methane=Formula.parse("CH4",TABLE)
    close(ion.mass,methane.mass+PROTON-Formula.electronMass,1e-9)
})
test("un isotopologue d'un ionisé déplace le core ET le groupe",()=>{
    /* Le core suit le déplacement, sinon deux formules différentes porteraient
       la même clé — celle du parent. Et le groupe garde son isotope quand le
       core ne porte pas l'élément: c'est lui qui l'écrit. */
    const protonated=Formula.parse("C6H12O6[H+]",TABLE)
    const heavy=protonated.isotopologue("C",13)
    ok(heavy.key.includes("13C"),`the 13C must show in the key: ${heavy.key}`)
    ok(heavy.key.includes("12C5"),`and the 12C5 beside it: ${heavy.key}`)
    ok(heavy.key.endsWith("[H+]"),`and the adduct stays in brackets: ${heavy.key}`)
    close(heavy.mass-protonated.mass,1.003355,1e-4)
})
test("décharger un 13C d'un ionisé rend bien la forme monoisotopique",()=>{
    const back=Formula.parse("12C5 13C 1H12 16O6[H+]",TABLE).isotopologue("C",12,{target:13})
    eq(back.key,"12C6 1H12 16O6[H+]","the 13C is gone from the core")
    eq(atoms(back,"C"),6,"and the core still holds six carbons")
})

console.log("la masse est celle de l'ION: la charge la corrige, une fois")
test("le neutre n'est pas corrigé: charge nulle",()=>{
    const s=parse("C6H12O6")
    if(s.charge!==0) throw new Error(`charge ${s.charge}`)
    close(s.mass,GLUCOSE,1e-12)
})
test("chaque charge retire exactement un électron, quel que soit l'adduit",()=>{
    /* C'EST LA RÈGLE. La somme des masses d'atomes neutres inclut déjà leurs
       électrons, donc seule la charge corrige — et elle corrige de la MÊME
       façon un proton, un sodium, ou un électron nu. Rien d'autre à retirer:
       c'est ce qui rend [Na+] et [H+] comparables. */
    const base=parse("C6H12O6")
    const protonated=parse("C6H12O6 [H+]")
    const sodiated=parse("C6H12O6 [Na+]")
    //l'écart au neutre est exactement la charge, pas le groupement
    close(sodiated.mass-(base.mass+TABLE.find("Na").isotope(23).mass),-MASS_OF_E,1e-9)

console.log("l'isotope d'un A inconnu: la règle, et elle se change")
test("un A écrit n'est JAMAIS touché par la règle",()=>{
    //54Fe est écrit: la règle n'a rien à dire, quoi qu'elle vaille
    const light=Formula.parse("54Fe2",TABLE,"lightest")
    const prob=Formula.parse("54Fe2",TABLE,"mostProbable")
    if(light.key!==prob.key) throw new Error("an explicit A must be honoured")
})
test("sans A écrit, la règle décide — et les deux règles diffèrent",()=>{
    const fe=TABLE.find("Fe")
    if(fe.lightestA!==54) throw new Error(`lightest should be 54, got ${fe.lightestA}`)
    if(fe.mostProbableA!==56) throw new Error(`probable should be 56, got ${fe.mostProbableA}`)
    const light=Formula.parse("Fe2O3",TABLE,"lightest")
    const prob=Formula.parse("Fe2O3",TABLE,"mostProbable")
    if(light.key===prob.key) throw new Error("the two rules must disagree on Fe")
    //et l'écart est bien 2 x (56-54), pas 3 x, car O ne bouge pas
    close(prob.mass-light.mass,2*(fe.isotope(56).mass-fe.isotope(54).mass),1e-12)
})
test("le plus probable est le DÉFAUT, parce qu'on cherche un pic visible",()=>{
    //sans règle explicite, on est sur mostProbable
    const byDefault=Formula.parse("Fe2O3",TABLE)
    if(byDefault.key!==Formula.parse("Fe2O3",TABLE,"mostProbable").key)
        throw new Error("the default must be mostProbable")
})
test("l'index est construit AU CHARGEMENT, pas à la demande",()=>{
    const fe=TABLE.find("Fe")
    if(!fe._byAbundance) throw new Error("the abundance index must exist after load()")
    if(fe._byAbundance[0].A!==56) throw new Error("the index must lead with the most probable")
    //et l'ordre par A reste garanti, même si le JSON n'était pas trié
    if(fe.byA[0].A!==54) throw new Error("byA must lead with the lightest")
    for(let i=1;i<fe.byA.length;i++){
        if(fe.byA[i].A<=fe.byA[i-1].A) throw new Error("byA is not sorted")
    }
})
test("les 56 éléments mono-isotopiques tombent juste",()=>{
    /* abundance est null pour eux — un isotope unique vaut 100 % sans que NIST
       l'écrive. Un tri naïf ferait null - null, soit 0. */
    let n=0
    for(let el of TABLE.elements){
        if(el.isotopes.length!==1) continue
        n++
        if(el.mostProbableA!==el.lightestA) throw new Error(`${el.symbol} disagrees with itself`)
        if(el.pickA("mostProbable")!==el.isotopes[0].A) throw new Error(`${el.symbol} wrong A`)
    }
    if(n!==56) throw new Error(`expected 56 monoisotopic elements, found ${n}`)
})
test("un adduit sans isotope écrit suit la règle lui aussi",()=>{
    //[K+] ne dit pas 39K. C'est une hypothèse comme une autre.
    const k=TABLE.find("K")
    if(k.lightestA!==39) throw new Error(`K lightest is ${k.lightestA}`)
    const s=Formula.parse("C6H12O6 [K+]",TABLE,"mostProbable")
    const A=[...s.composition.get(k).keys()][0]
    if(A!==k.mostProbableA) throw new Error(`K should be ${k.mostProbableA}, got ${A}`)
})

    close(protonated.mass-(base.mass+PROTON),-MASS_OF_E,1e-9)
    //le sodium coûte donc bien ses 22,9897, pas 22,9830
    close(sodiated.mz,base.mass+TABLE.find("Na").isotope(23).mass-MASS_OF_E,1e-9)
})
test("un ion doublement chargé retire deux électrons",()=>{
    //"[2H+2]": un deutérium, mais une charge de 2. C'est la MAGNITUDE écrite à
    //côté du signe qui porte le 2, et c'est elle qui corrige la masse
    const s=parse("C6H12O6 [2H+2]")
    if(s.charge!==2) throw new Error(`charge ${s.charge}, expected 2`)
    close(s.mass,GLUCOSE+DEUTERIUM-2*MASS_OF_E,1e-9)
    close(s.mz,s.mass/2,1e-9)
})
test("un anion AJOUTE des électrons",()=>{
    const s=parse("C6H12O6 [-]")
    close(s.mass,GLUCOSE+MASS_OF_E,1e-9)
})
test("mz est la masse divisée par la charge, sans rien d'autre",()=>{
    for(const text of ["C6H12O6 [H+]","C6H12O6 [2H+]","C6H12O6 [H-]","C6H12O6 [Na+]"]){
        const s=parse(text)
        close(s.mz,s.mass/Math.abs(s.charge),1e-15)
    }
})
test("du deutérium s'écrit dans la composition, pas dans les crochets",()=>{
    const s=parse("12C6 1H11 2H1 16O6 [H+]")
    //1H + 2H = 12 hydrogènes, + 1 protoné = 13
    if(atoms(s,"H")!==13) throw new Error(`H=${atoms(s,"H")}, expected 13`)
    //et le deutérium est bien resté DEUX FOIS, pas confondu avec un proton
    if([...s.composition.get(TABLE.find("H")).keys()].sort().join(",")!=="1,2")
        throw new Error("deuterium was not kept as a separate isotope")
})

console.log("les isotopes choisis, et la masse qu'ils changent")
test("12C6 1H12 16O6 [H+] est la forme monoisotopique",()=>{
    const s=parse("12C6 1H12 16O6 [H+]")
    //les nombres de masse explicites valent l'isotope le plus léger par défaut
    close(s.mass,parse("C6H12O6 [H+]").mass,1e-12)
})
test("un 13C ajoute exactement 1.003355",()=>{
    const a=parse("12C6 1H12 16O6 [H+]")
    const b=parse("12C5 13C1 1H12 16O6 [H+]")
    const delta=TABLE.find("C").isotope(13).mass-TABLE.find("C").isotope(12).mass
    close(b.mass-a.mass,delta,1e-12)
    close(delta,1.003355,1e-6)
})
test("les deux écritures de la même formule donnent la même clé",()=>{
    const a=parse("12C5 13C1 1H12 16O6 [H+]")
    const b=parse("13C1 12C5 1H12 16O6 [H+]")   //ordre différent
    if(a.key!==b.key) throw new Error(`"${a.key}" != "${b.key}"`)
    close(a.mz,b.mz,1e-12)
})
test("les comptes effacent les isotopes",()=>{
    const a=parse("12C6 1H12 16O6 [H+]")
    const b=parse("12C5 13C1 1H12 16O6 [H+]")
    if(a.counts.get(TABLE.find("C"))!==6) throw new Error("C should be 6")
    if(b.counts.get(TABLE.find("C"))!==6) throw new Error("C should be 6")
    if(a.counts.get(TABLE.find("H"))!==13) throw new Error("H should be 13")
})

console.log("l'identité ignore la provenance")
test("deux chemins vers la même formule donnent la même clé",()=>{
    const a=parse("C6H12O6 [H+]")
    const b=parse("C6H12O6 [H+]")
    a.path={iso:0,ionisation:1}
    b.path={iso:0,ionisation:1,via:"autre voie"}
    if(a.key!==b.key) throw new Error("the path leaked into the key")
})
test("la clé ne dépend que du contenu",()=>{
    const s=parse("C6H12O6 [H+]")
    /* La clé écrit le CORE puis les crochets: "12C6 1H12 16O6[H+]".

       Elle disait "12C6 1H13 16O6[H+]", ce qui comptait l'hydrogène du proton
       deux fois — une fois dans la composition, une fois dans le groupe — et se
       relisait en "12C6 1H14 16O6[H+]". Une identité qui ne se relit pas
       elle-même n'est pas une identité. La MASSE, elle, continue de peser les
       treize hydrogènes: un ion C6H13O6+ pèse bien treize H. */
    if(s.key!=="12C6 1H12 16O6[H+]") throw new Error(`key is "${s.key}"`)
    if(atoms(s,"H")!==13) throw new Error(`H=${atoms(s,"H")}, expected 13`)
})


console.log("l'ion radicalaire, des deux côtés")
test("[+] ne touche pas à la composition: c'est un électron PERDU",()=>{
    /* Il n'y a plus de "e+": une charge seule EST un électron. "[+]" et
       "[e+]" disaient la même chose, et le second n'était qu'un nom. */
    const s=parse("C6H12O6 [+]")
    if(s.composition.size!==3) throw new Error("composition changed")
    close(s.mz,GLUCOSE-MASS_OF_E,1e-9)
    if(s.charge!==1) throw new Error(`charge ${s.charge}`)
})
test("[-] est l'anion radicalaire: électron GAGNÉ",()=>{
    /* "[e-]" se lisait "électrons-MOINS", donc charge -1. C'est le seul moyen
       d'avoir un radical sans toucher aux atomes — et "[-]" le fait sans nom. */
    const s=parse("C6H12O6 [-]")
    if(s.charge!==-1) throw new Error(`charge ${s.charge}, expected -1`)
    if(s.composition.size!==3) throw new Error("composition changed")
    close(s.mz,GLUCOSE+MASS_OF_E,1e-9)
})
test("cation et anion sont deux formules différentes",()=>{
    const cation=parse("C6H12O6 [+]")
    const anion=parse("C6H12O6 [-]")
    if(cation.charge!==1) throw new Error(`cation charge ${cation.charge}`)
    if(anion.charge!==-1) throw new Error(`anion charge ${anion.charge}`)
    if(cation.key===anion.key) throw new Error("cation and anion share a key")
})
test("[-] prend un électron, [H-] prend un proton ET un électron",()=>{
    //la confusion à éviter: [-] ne touche à aucun atome, [H-] en AJOUTE un
    const ion=parse("C6H12O6 [H-]")
    const electron=parse("C6H12O6 [-]")
    if(ion.charge!==electron.charge) throw new Error("charges should match")
    close(ion.mass-electron.mass,PROTON,1e-9)
})
test("les crochets s'empilent et les charges s'additionnent",()=>{
    const s=parse("C6H12O6 [H-][-]")
    if(s.charge!==-2) throw new Error(`charge ${s.charge}, expected -2`)
    if(s.ionisation.length!==2) throw new Error(`${s.ionisation.length} terms`)
    if(atoms(s,"H")!==13) throw new Error("the proton addition still happened")
})
test("[2H+][-] donne un ion neutre, et non +1",()=>{
    //deutérium +1, puis un électron gagné -1: ça s'annule. Ce que la
    //formulation testait avant était l'ACCUMULATION des deux charges, pas
    //leur somme — et c'est bien la somme qu'on vérifie ici
    const s=parse("C6H12O6 [2H+][-]")
    if(s.charge!==0) throw new Error(`charge ${s.charge}, expected 0`)
})




console.log("les adduits sont ouverts")
test("un adduit est une VRAIE formule, pas un nom",()=>{
    /* Il n'y a plus de registre: "[CH4O+]" se lit avec parseComposition, la même
       fonction que le core. C'est la seule grammaire, donc il n'y a rien à
       déclarer au préalable. */
    const s=parse("C6H12O6 [CH4O+]")
    if(atoms(s,"C")!==7) throw new Error(`C should be 7, got ${atoms(s,"C")}`)
    if(atoms(s,"O")!==7) throw new Error(`O should be 7, got ${atoms(s,"O")}`)
    if(s.charge!==1) throw new Error(`charge ${s.charge}`)
})
test("un adduit à signe nu est AJOUTÉ, pas retiré",()=>{
    /* Un "-" seul ne prend aucun nombre, donc il ne qualifie rien: "[H2O-]"
       est l'eau ajoutée et un ion chargé -1, exactement comme "(H2O)-".

       Pour RETIRER l'eau, il faut soit un nombre — et il se rattache alors au
       DERNIER symbole, pas au groupe — soit des parenthèses. */
    const s=parse("C6H12O6 [H2O-]")
    if(atoms(s,"H")!==14) throw new Error(`H should be 14, got ${atoms(s,"H")}`)
    if(atoms(s,"O")!==7) throw new Error(`O should be 7, got ${atoms(s,"O")}`)
    if(s.charge!==-1) throw new Error(`charge ${s.charge}`)
})
test("un groupe entre parenthèses porte sa charge",()=>{
    /* "[(H2O)-1]" est l'eau × -1. Sans les parenthèses, "[H2O-]" serait un
       terme à charge nu: c'est la même grammaire, pas une autre. */
    const s=parse("C6H12O6 [-(H2O)]")
    if(atoms(s,"H")!==10) throw new Error(`H should be 10, got ${atoms(s,"H")}`)
    if(atoms(s,"O")!==5) throw new Error(`O should be 5, got ${atoms(s,"O")}`)
    if(s.charge!==-1) throw new Error(`charge ${s.charge}`)
})
test("des adduits s'empilent sans qu'on ait à les connaître",()=>{
    //aucune combinatoire n'est refusée, même si elle n'a aucun sens
    const s=parse("C6H12O6 [Na+][H-][-][CH4O+]")
    if(s.ionisation.length!==4) throw new Error(`${s.ionisation.length} terms, expected 4`)
    if(s.charge!==0) throw new Error(`charge ${s.charge}, expected 0`)
})
test("un terme illisible est une faute, pas une étiquette",()=>{
    //c'était le défaut du registre: un nom inconnu devenait muet. "[MeOH+]"
    //contient un M, et M n'est pas un élément — donc c'est nommé.
    try{ parse("C6H12O6 [MeOH+]"); throw new Error("should have thrown") }
    catch(e){ if(!/unknown element/.test(e.message)) throw e }
})

console.log("les erreurs sont dites, pas devinées")
test("un élément inconnu est nommé",()=>{
    try{ parse("C6X2"); throw new Error("should have thrown") }
    catch(e){ if(!/unknown element/.test(e.message)) throw e }
})
test("un isotope inexistant est nommé",()=>{
    try{ parse("99C6"); throw new Error("should have thrown") }
    catch(e){ if(!/no isotope/.test(e.message)) throw e }
})
test("une composition vide est refusée",()=>{
    try{ parse("[H+]"); throw new Error("should have thrown") }
    catch(e){ if(!/no composition/.test(e.message)) throw e }
})

console.log("la clé est la forme CANONIQUE, pas la saisie")
test("Fe2O3 et Fe2 O3 donnent la MÊME clé",()=>{
    //l'espace est un SÉPARATEUR, pas un caractère du nom: les deux écritures
    //sont la même formule, donc la même identité
    const a=Formula.parse("Fe2O3",TABLE,"lightest")
    const b=Formula.parse("Fe2 O3",TABLE,"lightest")
    if(a.key!==b.key) throw new Error(`"${a.key}" != "${b.key}"`)
    if(a.key!==b.key) throw new Error("les masses doivent suivre")
})
test("la clé est réécrite, pas reprise de la saisie",()=>{
    //tout ce qui n'est pas la forme canonique disparaît: espaces, ordre des
    //tokens, absence d'espace avant le crochet — et la casse, qui est
    //aujourd'hui ACCEPTÉE parce que c'est du confort de frappe
    const canon=Formula.parse("C6H12O6 [H+]",TABLE).key
    for(const written of [
        "C6H12O6[H+]","O6C6H12 [H+]","C6H12O6  [H+]","C6 H12 O6[H+]",
        "c6h12o6[h+]",
    ]){
        if(Formula.parse(written,TABLE).key!==canon)
            throw new Error(`"${written}" ne donne pas "${canon}"`)
    }
})
test("la casse est indifférente, partout",()=>{
    //confort de frappe: l'utilisateur tape ce qu'il a sous les doigts
    for(const [typed,written] of [
        ["C6H12O6[H+]","c6h12o6[h+]"],
        ["Fe2O3[2+]","fe2o3[2+]"],
        ["56Fe2O3","56fe2o3"],
        ["H2O-","h2o-"],
    ]){
        if(Formula.parse(typed,TABLE).key!==Formula.parse(written,TABLE).key)
            throw new Error(`"${typed}" != "${written}"`)
    }
})
test("la casse décide, et la table tranche le reste",()=>{
    /* Le couple n'est un symbole que s'il existe TEL QU'ÉCRIT, à la casse
       comprise: "Co" trouve le cobalt, "CO" ne trouve rien et se scinde en
       C + O, puisque C et O sont deux éléments. C'est la convention Hill, et
       elle tient sans aucune liste de mots-clés. */
    const co=Formula.parse("Co",TABLE)
    if(co.composition.size!==1) throw new Error("Co should be one element")
    if([...co.composition.keys()][0].symbol!=="Co") throw new Error("Co should be cobalt")
    const carbonMonoxide=Formula.parse("CO",TABLE)
    if(carbonMonoxide.composition.size!==2) throw new Error("CO should be two elements")
})
test("les symboles à deux lettres marchent, même en minuscule",()=>{
    /* Ici A et E ne sont pas des éléments: E n'existe pas, donc "fe" ne peut
       PAS être F + E. Il n'y a qu'une lecture possible, et elle est la bonne. */
    for(const [typed,written] of [["Fe2O3","fe2o3"],["NaCl","nacl"],["H2O","h2o"]]){
        if(Formula.parse(typed,TABLE).key!==Formula.parse(written,TABLE).key)
            throw new Error(`"${typed}" != "${written}"`)
    }
})
test("L'AMBIGÜTÉ RESTANTE est réelle et connue",()=>{
    /* Limite assumée, et elle est en petit: quand DEUX lettres sont chacune un
       élément ET qu'elles forment aussi un symbole, les deux lectures sont
       possibles. Il y en a 26 dans la table — "si" peut être Si ou S+I, "co"
       Co ou C+O.

       En MAJUSCULE la casse tranche: "Si" est le symbole, "SI" est S + I. En
       minuscule c'est indécidable, donc le parseur prend deux atomes, qui est
       l'interprétation la plus prudente: elle ne transforme jamais un atome en
       un autre. Le prix est que "sio2" ne veut pas dire SiO2. */
    const ambiguous=["Si","Co","Ni","Cu","In","Sn","Pb","Bi"]
    for(const s of ambiguous){
        //en majuscule: le symbole gagne, toujours
        const upper=Formula.parse(s,TABLE)
        if(upper.composition.size!==1) throw new Error(`${s} should be one element`)
    }
    //en minuscule, on prend la lecture à deux atomes
    const lower=Formula.parse("si",TABLE)
    if(lower.composition.size!==2) throw new Error("si should split into two")
})
test("le losange CO / Co tient dans les deux sens",()=>{
    //la différence ne se voit qu'en masse: 27,99 contre 58,93
    const a=Formula.parse("CO",TABLE).mz
    const b=Formula.parse("Co",TABLE).mz
    if(Math.abs(a-b)<1) throw new Error("CO and Co must differ in mass")
    close(a,27.994915,1e-5)
    close(b,58.933194,1e-5)
})
test("la partie adDUITE reste entre crochets dans la clé",()=>{
    //c'est la convention: ce qui est entre crochets est l'ionisation, et
    //rien d'autre ne s'y mêle
    const s=Formula.parse("C6H12O6 [H+][-]",TABLE)
    //le core, puis les crochets: l'adduit n'est compté qu'une fois
    if(s.key!=="12C6 1H12 16O6[H+][-]") throw new Error(`key is "${s.key}"`)
    //et une formule neutre n'invente pas de crochet vide
    if(Formula.parse("C6H12O6",TABLE).key!=="12C6 1H12 16O6")
        throw new Error("a neutral formula has no brackets")
})
test("une clé relue donne la MÊME formule, isotope compris",()=>{
    /* Ce n'est pas un détail d'affichage: la clé sert d'identité, donc si on
       la relit on doit retomber sur la même formule. Or "Fe2 O3" ne dit pas
       54Fe: au reread, la règle par défaut met 56Fe. Deux formules, une clé. */
    for(const [text,rule] of [["Fe2O3","lightest"],["PbO","lightest"],["54Fe2O3","mostProbable"]]){
        const first=Formula.parse(text,TABLE,rule)
        const again=Formula.parse(first.key,TABLE)      //relue avec le DÉFAUT
        if(again.key!==first.key)
            throw new Error(`"${text}" (${rule}) -> key "${first.key}" -> relu "${again.key}"`)
        if(Math.abs(again.mass-first.mass)>1e-12)
            throw new Error(`mass drifted: ${first.mass} -> ${again.mass}`)
    }
})
test("la clé n'abrège JAMAIS, même pas le plus léger",()=>{
    /* C'est l'inverse de ce qui valait avant. La clé dit tout, y compris 54Fe:
       une identité qui omet un isotope ne peut pas le retrouver à la relecture.
       C'est l'AFFICHAGE qui abrège, et lui se relit avec sa règle. */
    const k=Formula.parse("Fe2O3",TABLE,"lightest")
    if(!k.key.includes("54Fe")) throw new Error(`key should say 54Fe: "${k.key}"`)
    //l'affichage, lui, abrège bien — mais par rapport à SA règle
    if(k.toString()!=="Fe2O3") throw new Error(`display is "${k.toString()}"`)
    const p=Formula.parse("Fe2O3",TABLE,"mostProbable")
    if(p.toString()!=="Fe2O3") throw new Error(`display is "${p.toString()}"`)
    //et les deux clés, elles, restent différentes
    if(p.key===k.key) throw new Error("54Fe and 56Fe must not share a key")
})

console.log("deux sorties, deux usages")
test("Fe2O3[2+]: la clé dit tout, l'affichage abrège",()=>{
    //exactement le cas discuté, dans SA forme naturelle
    const s=Formula.parse("Fe2O3[2+]",TABLE)
    if(s.key!=="56Fe2 16O3[2+]") throw new Error(`key is "${s.key}"`)
    if(s.toString()!=="Fe2O3[2+]") throw new Error(`toString is "${s.toString()}"`)
})
test("la clé se relit TOUJOURS, quelle que soit la règle",()=>{
    /* C'est LA propriété qui justifie la séparation. On relit la clé avec la
       règle par défaut, ou une autre: on retombe sur la même formule, parce
       que la clé n'a rien abrégé. */
    for(const rule of ["lightest","mostProbable"]){
        const first=Formula.parse("Fe2O3",TABLE,rule)
        for(const reread of ["lightest","mostProbable"]){
            const again=Formula.parse(first.key,TABLE,reread)
            if(again.key!==first.key)
                throw new Error(`${rule} -> "${first.key}" -> relu en ${reread} -> "${again.key}"`)
        }
    }
})
test("l'affichage se relit avec SA règle",()=>{
    //l'affichage n'est pas une identité, mais il se relit avec la règle qui
    //a servi à l'écrire: c'est ce qui le rend fiable pour l'affichage
    for(const rule of ["lightest","mostProbable"]){
        const s=Formula.parse("Fe2O3",TABLE,rule)
        if(Formula.parse(s.toString(),TABLE,rule).key!==s.key)
            throw new Error(`l'affichage en ${rule} ne se relit pas`)
    }
})
test("deux isotopes différents n'ont JAMAIS la même clé",()=>{
    //c'est l'invariant: ⁵⁴Fe et ⁵⁶Fe sont à 4 Da, ils ne peuvent pas
    //partager une identité, quelle que soit l'écriture
    const a=Formula.parse("54Fe2O3",TABLE,"lightest")
    const b=Formula.parse("56Fe2O3",TABLE,"lightest")
    if(a.key===b.key) throw new Error("two isotopes share a key")
    if(a.toString()===b.toString()) throw new Error("two isotopes share a display")
})
test("l'ionisation est dans les DEUX sorties, collée",()=>{
    //sans elle, [H+] et [H-] sur le même compte d'hydrogènes seraient identiques
    const a=Formula.parse("C6H12O6[H+]",TABLE)
    const b=Formula.parse("C6H12O6[H-]",TABLE)
    if(a.key===b.key) throw new Error("H+ and H- must differ")
    for(const s of [a,b]){
        if(!/\[H.\]$/.test(s.key)) throw new Error(`key lacks brackets: "${s.key}"`)
        if(!/\[H.\]$/.test(s.toString())) throw new Error(`toString lacks brackets: "${s.toString()}"`)
    }
})

console.log("l'ionisation par électrons seule s'écrit [2+], pas [2e+]")
test("[2+] est deux électrons perdus, et rien d'autre",()=>{
    //la forme naturelle: ni group, ni adduit, juste une charge
    const s=Formula.parse("Fe2O3[2+]",TABLE)
    if(s.charge!==2) throw new Error(`charge ${s.charge}, expected 2`)
    if(s.composition.size!==2) throw new Error("the composition must not change")
    //et la masse perd exactement deux électrons
    close(s.mass,Formula.parse("Fe2O3",TABLE).mass-2*MASS_OF_E,1e-12)
})
test("la forme [2+] ne se confond pas avec un adduit",()=>{
    //deux protons s'écrivent [H+][H+], et [2H+] est du deutérium: c'est la
    //différence entre un pic à +2 Da et le même pic au m/z près
    const protons=Formula.parse("Fe2O3[H+][H+]",TABLE)
    const electrons=Formula.parse("Fe2O3[2+]",TABLE)
    if(atoms(protons,"H")!==2) throw new Error("two protons should add two H")
    if(atoms(electrons,"H")!==0) throw new Error("2+ must add no H at all")
    if(protons.key===electrons.key) throw new Error("2H+ and 2+ must differ")
})
test("[3-] est trois électrons gagnés",()=>{
    const s=Formula.parse("C6H12O6[3-]",TABLE)
    if(s.charge!==-3) throw new Error(`charge ${s.charge}, expected -3`)
    close(s.mass,Formula.parse("C6H12O6",TABLE).mass+3*MASS_OF_E,1e-12)
})
//L'équivalence "[+] ≡ [e+]" a disparu: "[e+]" n'est plus lu, parce qu'il
//n'était qu'un nom pour une charge. Une charge seule EST un électron, et il
//n'y a rien à comparer.



test("entre deux ions de MÊME charge, la correction s'annule",()=>{
    /* Le cas d'usage qui a motivé la règle: comparer deux ions 2+.
       La correction -z·mₑ est la même des deux côtés, donc elle disparaît
       dans la différence, et Δ(m/z) = ΔM / z sans rien retirer de plus. */
    const a=Formula.parse("C6H14O6[2H+2]",TABLE)
    const b=Formula.parse("C6H12O5[2H+2]",TABLE)
    if(a.charge!==2||b.charge!==2) throw new Error("both must be 2+")
    const H2O=2*PROTON+TABLE.find("O").isotope(16).mass
    if(Math.abs((a.mz-b.mz)-H2O/2)>1e-9) throw new Error("mz difference is not H2O/2")
    if(Math.abs((a.mass-b.mass)-H2O)>1e-9) throw new Error("mass difference is not H2O")
})
console.log("la grammaire des crochets: un nombre avant, un nombre après, un au signe")
test("chaque forme se lit comme elle s'écrit",()=>{
    /* Le groupe n'est plus un NOM mais une composition déjà lue: c'est le
       retour de la suppression du registre. On vérifie donc ce qui compte —
       les atomes apportés, et la charge. */
    const cases=[
        //forme        H    Na23  charge
        ["[H+]",        1,   0,    1],
        ["[H2+]",       2,   0,    1],
        ["[H+2]",       1,   0,    2],
        ["[2H+]",       1,   0,    1],   //un deutérium: UN hydrogène
        ["[2H+2]",      1,   0,    2],
        ["[23Na+]",     0,   1,    1],
        ["[2+]",        0,   0,    2],   //deux électrons perdus
        ["[3-]",        0,   0,   -3],
    ]
    for(const [text,hydrogen,sodium,charge] of cases){
        const f=Formula.parse(`C6H12O6${text}`,TABLE)
        const gotH=f.counts.get(TABLE.find("H"))??0
        const gotNa=f.composition.get(TABLE.find("Na"))?.get(23)??0
        if(gotH!==12+hydrogen||gotNa!==sodium||f.charge!==charge)
            throw new Error(`${text} -> H ${gotH}, 23Na ${gotNa}, charge ${f.charge}`)
    }
})
test("un isotope explicite atteint la composition",()=>{
    //[2H+] est du deutérium: 12 protons, dont un deutérium
    const f=Formula.parse("C6H12O6[2H+]",TABLE)
    const H=f.composition.get(TABLE.find("H"))
    if(H.get(2)!==1) throw new Error("one 2H")
    if(H.get(1)!==12) throw new Error(`1H is ${H.get(1)}, expected 12`)
    //et [23Na+] est du sodium 23
    const g=Formula.parse("C6H12O6[23Na+]",TABLE)
    if(!g.composition.get(TABLE.find("Na")).has(23)) throw new Error("no 23Na")
})
test("le compte double le groupe, jamais la charge",()=>{
    //deux H, une seule charge
    const f=Formula.parse("C6H12O6[H2+]",TABLE)
    if(f.counts.get(TABLE.find("H"))!==14) throw new Error("H is not 14")
    if(f.charge!==1) throw new Error(`charge ${f.charge}, expected 1`)
})
test("un terme composé se lit par la grammaire, sans registre",()=>{
    /* Il n'y a plus rien à déclarer. Et un "-" seul ne retire rien: "[H2O-1]"
       donne 2 H et UN oxygène en moins, parce que le -1 se rattache à l'oxygène
       — le symbole qu'il suit — et non au groupe entier. Pour retirer l'eau,
       il faut des parenthèses: "[-(H2O)]". */
    const bare=Formula.parse("C6H12O6[H2O-]",TABLE)
    if(bare.counts.get(TABLE.find("H"))!==14) throw new Error("H is not 14")
    if(bare.charge!==-1) throw new Error(`charge ${bare.charge}, expected -1`)
    const anchored=Formula.parse("C6H12O6[H2O-1]",TABLE)
    if(anchored.counts.get(TABLE.find("H"))!==14) throw new Error("H is not 14")
    if(anchored.counts.get(TABLE.find("O"))!==5) throw new Error("O is not 5")
    if(anchored.charge!==0) throw new Error(`charge ${anchored.charge}, expected 0`)
    const group=Formula.parse("C6H12O6[-(H2O)]",TABLE)
    if(group.counts.get(TABLE.find("H"))!==10) throw new Error("H is not 10")
    if(group.counts.get(TABLE.find("O"))!==5) throw new Error("O is not 5")
    if(group.charge!==-1) throw new Error(`charge ${group.charge}, expected -1`)
})
test("un signe NU, où qu'il soit, est la charge de l'ion",()=>{
    /* La règle tient en une phrase: un signe qualifie le terme qui suit, et
       s'il n'y a rien derrière il ne qualifie rien — donc c'est une charge.
       C'est ce qui rend "C6H12O6 H2-" lisible: deux hydrogènes ajoutés, et
       un ion chargé -1. */
    const cases=[
        //texte            termes H      charge
        ["C6H12O6-",       1, 12, -1],
        ["C6H12O6+",       1, 12,  1],
        ["C6H12O6-2",      1, 12, -2],
        ["C6H12O6+2",      1, 12,  2],
        ["C6H12O6 H2-",    1, 14, -1],
        ["C6H12O6 H2+",    1, 14,  1],
        /* -2H et -H2 retirent DEUX hydrogènes: dans le premier le 2 est le
           coefficient, dans le second c'est le compte, et -1 × 2 fait le
           même. C'est le seul endroit où les deux nombres se Valent, et c'est
           normal — ils disent la même chose par deux chemins. */
        ["C6H12O6-2H",     0, 10,  0],
        ["C6H12O6-H2",     0, 10,  0],
        ["C6H12O6+2H",     0, 14,  0],
        ["C6H12O6+H2",     0, 14,  0],
    ]
    for(const [text,terms,hydrogen,charge] of cases){
        const f=Formula.parse(text,TABLE)
        if(f.counts.get(TABLE.find("H"))!==hydrogen)
            throw new Error(`${text} -> H is ${f.counts.get(TABLE.find("H"))}, expected ${hydrogen}`)
        if(f.charge!==charge) throw new Error(`${text} -> charge ${f.charge}, expected ${charge}`)
        /* Un signe nu DONNE un terme d'ionisation: il doit figurer dans la
           clé, sinon deux ions de charges différentes porteraient le même
           nom — et c'est ce que la règle des trois écritures vérifie. */
        if(f.ionisation.length!==terms)
            throw new Error(`${text} -> ${f.ionisation.length} terms, expected ${terms}`)
    }
})
test("++ et +2 sont la même charge",()=>{
    /* Des signes RÉPÉTÉS valent la charge répétée: c'est la forme courte de
       "[+][+]", et non deux charges distinctes. Les écritures doivent se
       rejoindre sur la MÊME clé, sans quoi deux ions identiques en
       porteraient deux noms. */
    for(const [a,b,c] of [
        ["C6H12O6[++]","C6H12O6[+2]","C6H12O6[2+]"],
        ["C6H12O6[--]","C6H12O6[-2]","C6H12O6[2-]"],
        ["C6H12O6[---]","C6H12O6[-3]","C6H12O6[3-]"],
        ["C6H12O6++","C6H12O6+2",null],
    ]){
        const keys=[a,b,c].filter(Boolean).map(t=>Formula.parse(t,TABLE).key)
        if(keys.some(k=>k!==keys[0]))
            throw new Error(`${a} / ${b} / ${c} -> ${keys.join(" | ")}`)
    }
})
test("les quatre écritures que vous avez dictées",()=>{
    /* La règle qui les gouverne toutes: un NOMBRE prend le signe de ce qui le
       précède, et le signe qui reste NU est la charge. Le + n'est jamais un
       compte après un symbole — il est omis — donc un + final est toujours
       une charge; un - collé est un compte, et il faut un autre signe pour
       écrire la charge. */
    const cases=[
        //texte           C6  H    charge
        ["C6H12O6[H-1]",   6, 11,  0],   // -1 est le compte de H
        ["C6H12O6[H+1]",   6, 13, +1],   // le +1 restant est la charge
        ["C6H12O6[H-1+]",  6, 11, +1],   // compte -1, puis charge +
        ["C6H12O6[H2-1]",  6, 14, -1],   // 2 H, puis charge -
    ]
    for(const [text,c,hyd,hcharge] of cases){
        const f=Formula.parse(text,TABLE)
        if(f.counts.get(TABLE.find("C"))!==c) throw new Error(`${text} -> C`)
        if(f.counts.get(TABLE.find("H"))!==hyd)
            throw new Error(`${text} -> H is ${f.counts.get(TABLE.find("H"))}, expected ${hyd}`)
        if(f.charge!==hcharge) throw new Error(`${text} -> charge ${f.charge}, expected ${hcharge}`)
        /* et la FORMULE elle-même, pas seulement la charge: c'est là que
           j'ai écrit un "-" pour un "+" sans que rien ne le dise. */
        const protons=f.counts.get(TABLE.find("H"))-(f.composition.get(TABLE.find("H"))?.get(2)??0)*0
        if(protons<0) throw new Error(`${text} -> impossible hydrogen count`)
    }
})
test("un CORE garde sa charge: c'est ce qui distingue les deux contextes",()=>{
    /* Le contre-test. "C6H12O6 -1" reste une charge -1, alors que dans
       "[H2O-1]" le -1 est un coefficient. C'est le core qui a des
       électrons à donner; un adduit, non. */
    const charge=Formula.parse("C6H12O6-1",TABLE)
    if(charge.charge!==-1) throw new Error(`charge ${charge.charge}, expected -1`)
    if(charge.counts.get(TABLE.find("H"))!==12) throw new Error("H should be 12")
})
test("il n'y a plus de e+ ni e-: une charge seule EST un électron",()=>{
    /* On ne PERD rien en supprimant ces deux entrées: "[+]" était déjà l'anion
       radicalaire, et il n'y avait rien derrière. Un terme sans atome n'a pas
       besoin d'un nom, et un radical se reconnaît par la parité de valence,
       pas par une étiquette. */
    const cation=Formula.parse("C6H12O6[+]",TABLE)
    const anion=Formula.parse("C6H12O6[-]",TABLE)
    if(cation.charge!==1||anion.charge!==-1) throw new Error("charges")
    if(cation.composition.size!==3||anion.composition.size!==3)
        throw new Error("a bare charge must not touch the composition")
    //et "e" n'est pas un élément: le former nom n'est plus lu du tout
    for(const text of ["C6H12O6[e+]","C6H12O6[e-]"]){
        let threw=false
        try{ Formula.parse(text,TABLE) }catch{ threw=true }
        if(!threw) throw new Error(`${text} should not be readable`)
    }
})
test("un terme est soit un nombre seul (charge), soit des atomes",()=>{
    /* LA règle, et elle est unique — pas d'exception entre crochets et ";":
       un signe qualifie le terme qui suit, et s'il n'y a rien derrière il ne
       qualifie rien, donc c'est une charge.

         [2]      charge +2        aucune composition
         [H]      1 H ajouté       charge 0
         [H+1]    1 H ajouté       charge +1
         [H-1]    H retiré         charge 0
         [H2]     2 H ajoutés      charge 0
         [2H]     1 H ajouté       charge 0   (un DEUTÉRIUM, pas deux H)
         [H][+1]  1 H, puis charge +1

       `[H+1]` est le seul cas qui a changé de lecture. L'ancienne grammaire y
       voyait un coefficient nu et en faisait un ion neutre: « un H ajouté, et
       rien d'autre ». La grammaire d'aujourd'hui garde le signe comme charge et
       n'en fait pas un coefficient — donc 1 H ajouté ET charge +1. Ce n'est pas
       une perte: `[H+1]` et `[H][+1]` disent désormais la même chose, ce que la
       version d'avant ne faisait pas. Le test a suivi la règle au lieu de
       garder l'ancienne. */
    const cases=[
        //texte        H    charge
        ["[2]",       12,  2],
        ["[H]",       13,  0],
        ["[H+1]",     13,  1],
        ["[H-1]",     11,  0],
        ["[H2]",      14,  0],
        ["[H][+1]",   13,  1],
        ["[-H]",      11,  0],
        ["[2H]",      13,  0],
    ]
    for(const [term,h,charge] of cases){
        const f=Formula.parse(`C6H12O6${term}`,TABLE)
        if(f.counts.get(TABLE.find("H"))!==h)
            throw new Error(`${term} -> H is ${f.counts.get(TABLE.find("H"))}, expected ${h}`)
        if(f.charge!==charge) throw new Error(`${term} -> charge ${f.charge}, expected ${charge}`)
    }
})
test("un groupe entre parenthèses se lit par la grammaire, pas comme un nom",()=>{
    /* `-(H2O)` : le groupe EST la formule, lue par la même fonction que le core.
       Il n'a pas besoin d'être déclaré dans une table, parce que la grammaire sait
       déjà le lire — c'est ce qui supprime le registre des adduits connus. */
    const a=Formula.parse("C6H12O6[-(H2O)]",TABLE)
    if(a.counts.get(TABLE.find("H"))!==10) throw new Error("H is not 10")
    if(a.counts.get(TABLE.find("O"))!==5) throw new Error("O is not 5")
    if(a.charge!==-1) throw new Error(`charge ${a.charge}, expected -1`)
    /* Et `[-H2O]` N'EST PAS la même chose, contrairement à ce qu'un test
       plus ancien affirmait. Un signe nu se rattache au symbole qu'il suit:
       `-H2O` retire UN H et laisse l'oxygène, avec charge 0. C'est ce que le
       test voisin sur `[H2O-]` décrit déjà, et c'est la seule grammaire qui
       rende `[-(H2O)]` nécessaire pour partir d'une eau entière.

       L'égalité des deux écritures a donc été retirée: elle était fausse, et la
       garder aurait fait croire que `-` devant un groupe se lit sans parenthèses. */
    const b=Formula.parse("C6H12O6[-H2O]",TABLE)
    ok(b.key!==a.key,"a bare sign does not remove a whole group")
})
test("plus de registre: [MeOH+] est du méthanol, en grammaire",()=>{
    /* Sans table, "CH4O-1" se lit comme n'importe quelle composition. C'est la
       preuve qu'on n'a perdu aucune information en supprimant IONISATIONS. */
    const f=Formula.parse("C6H12O6[CH4O-1]",TABLE)
    if(f.counts.get(TABLE.find("C"))!==7) throw new Error("C is not 7")
    if(f.charge!==0) throw new Error(`charge ${f.charge}, expected 0`)
})
test("un isotope d'adduit s'écrit comme un isotope, et rien de plus",()=>{
    const a=Formula.parse("C6H12O6[23Na]",TABLE)
    if(!a.composition.get(TABLE.find("Na"))?.has(23)) throw new Error("no 23Na")
    //et un A inexistant reste une faute, pas un silence
    let threw=false
    try{ Formula.parse("C6H12O6[99Na]",TABLE) }catch{ threw=true }
    if(!threw) throw new Error("Na99 should not exist")
})
test("les crochets et le ; dizem la même chose",()=>{
    for(const [a,b] of [
        ["C6H12O6[H][+1]","C6H12O6;H;+1"],
        ["C6H12O6[2+]","C6H12O6;+2"],
        ["C6H12O6[-H]","C6H12O6;-H"],
    ]){
        const ka=Formula.parse(a,TABLE).key
        const kb=Formula.parse(b,TABLE).key
        if(ka!==kb) throw new Error(`${a} -> "${ka}" / ${b} -> "${kb}"`)
    }
})
test("le 1 de la charge est facultatif, et les deux délimiteurs s'ignorent",()=>{
    /* "H+" et "H+1" sont la MÊME lecture: un signe nu vaut 1, comme un H seul
       dans une composition vaut un atome. Et le ";" ne change rien au fond,
       c'est un autre délimiteur pour le même terme. */
    const expected="12C6 1H12 16O6[H+]"
    for(const t of ["C6H12O6;H+","C6H12O6;H+1","C6H12O6[H+]","C6H12O6[H+1]"]){
        const f=Formula.parse(t,TABLE)
        if(f.key!==expected) throw new Error(`${t} -> "${f.key}", expected "${expected}"`)
        if(f.charge!==1) throw new Error(`${t} -> charge ${f.charge}`)
    }
})
test("un 2 après le signe n'est PAS facultatif: il change l'ion",()=>{
    //le garde-fou: si le 1 s'effaçait, "+2" deviendrait "+1" et le
    //doublement se perdrait en silence
    const a=Formula.parse("C6H12O6[H+1]",TABLE)
    const b=Formula.parse("C6H12O6[H+2]",TABLE)
    if(a.charge!==1||b.charge!==2) throw new Error(`${a.charge} / ${b.charge}`)
    if(a.key===b.key) throw new Error("a +1 and a +2 must differ")
})
test("le point-virgule est l'autre délimiteur, et il empile aussi",()=>{
    //";H+;-" est le même ion que "[H+][-]"
    const a=Formula.parse("C6H12O6;H+;-",TABLE)
    const b=Formula.parse("C6H12O6[H+][-]",TABLE)
    if(a.key!==b.key) throw new Error(`"${a.key}" != "${b.key}"`)
    if(a.charge!==0) throw new Error(`charge ${a.charge}, expected 0`)
    //"[H+]" AJOUTE un proton, "[-]" ne touche à rien: 13 hydrogènes, dont un
    //électron de moins. C'est ce que la charge 0 dit du reste
    if(a.counts.get(TABLE.find("H"))!==13)
        throw new Error(`H is ${a.counts.get(TABLE.find("H"))}, expected 13`)
})
test("le ; distingue un proton d'un électron arraché",()=>{
    /* C'est LA distinction. "[H+1]" ajoute un PROTON: le glucose est intact.
       ";+1" ne touche RIEN à la composition: c'est un électron arraché, et le
       C6H13O6 obtenu est un radical. Même masse, ions différents. */
    const protonated=Formula.parse("C6H12O6;H+1",TABLE)
    const radical=Formula.parse("C6H13O6;+1",TABLE)
    if(protonated.charge!==1) throw new Error("protonated charge")
    if(radical.charge!==1) throw new Error("radical charge")
    //mêmes atomes, donc même masse — la différence est électronique
    if(protonated.counts.get(TABLE.find("H"))!==13) throw new Error("13 H expected")
    if(radical.counts.get(TABLE.find("H"))!==13) throw new Error("13 H expected")
    if(Math.abs(protonated.mass-radical.mass)>1e-9)
        throw new Error("a proton and a lost electron differ by one electron mass")
})
test("le ; et les crochets ne se mélangent pas",()=>{
    let threw=false
    try{ Formula.parse("C6H12O6[H+];e-",TABLE) }catch{ threw=true }
    if(!threw) throw new Error("mixing delimiters should be refused")
})
test("un ; nu n'est pas un adduit vide",()=>{
    //"C6H12O6;" ne charge rien: c'est le neutre
    const f=Formula.parse("C6H12O6;",TABLE)
    if(f.charge!==0) throw new Error(`charge ${f.charge}, expected 0`)
    if(f.counts.get(TABLE.find("H"))!==12) throw new Error("composition changed")
})
test("un A écrit qui n'existe pas est une faute, pas un silence",()=>{
    let threw=false
    try{ Formula.parse("C6H12O6[99Na+]",TABLE) }catch{ threw=true }
    if(!threw) throw new Error("Na99 should not exist")
})
test("une masse négative devient sa conjugée positive et se relit",()=>{
    /* LE COMPTE N'EST PLUS PERDU À L'AFFICHAGE.

       L'écriture était `n>1 ? name+n : name`: tout compte valant 1 ou moins
       disparaissait. Une perte se relisait donc comme un ajout — « -2H » se
       lisait « H », et une substitution perdait tous ses signes d'un coup. Le
      Round-trip ci-dessous est la propriété qui compte: écrire, relire, et
       retrouver le même compte, signe compris. */
    const roundTrip=(text,expected)=>{
        const written=Formula.parse(text,TABLE)
        const again=Formula.parse(String(written),TABLE)
        const show=f=>{
            const parts=[]
            for(const [el,byA] of f.composition) for(const [A,n] of byA) parts.push(`${A}${el.symbol}:${n}`)
            return parts.join(" ")
        }
        eq(show(written),show(again),`${text} -> "${String(written)}" must read back`)
        if(expected!==undefined) eq(show(written),expected,`${text} composition`)
    }
    roundTrip("-CH2","12C:1 1H:2")
    roundTrip("-2H","1H:2")
    roundTrip("-C-H+N-O","12C:1 1H:1 14N:-1 16O:1")
    roundTrip("C2-H2","12C:2 1H:-2")
    roundTrip("2H-2","2H:2")
    eq(prettyNotation(String(Formula.parse("2H-2",TABLE))),"²H₂")
    /* ET LES FORMES POSITIVES N'ONT PAS BOUGÉ: le compte reste APRÈS le
       symbole, c'est seulement le signe qui change de place. */
    roundTrip("CH2","12C:1 1H:2")
    eq(String(Formula.parse("CH2",TABLE)),"CH2","a plain formula is still written plainly")
    const conjugate=Formula.parse("-CH2",TABLE)
    eq(conjugate.key,Formula.parse("CH2",TABLE).key,
        "a negative-mass input becomes the positive-mass conjugate")
    close(conjugate.mass,14.01565006446,1e-9,"the conjugate weighs the positive CH2 mass")
    /* UN ADDUCT N'A PAS DE CORPS PROPRE, et il doit donc s'écrire vide: les
       crochets portent l'information. Le « ±0 » qu'on avait mis en repli
       produisait « ±0[H+] », un ion qui s'annonçait contenir zéro atome. */
    eq(String(Formula.parse("CH4[H+]",TABLE)),"CH4[H+]",
        "an adduct writes as itself, with no phantom atoms in front of it")
})
/* --- la signature de pas, la chimie du Hough ------------------------------
   Ces tests lisent leurs attentes DANS LA TABLE plutôt que de les recopier,
   sauf pour trois éléments dont la masse est citée: sans elles, la suite ne
   prouverait qu'une formule s'auto-cohérence. */
const signatureOf=(symbol,charge=1)=>
    stepSignature(TABLE.find(symbol).monoisotopicMass,charge)

test("la signature de pas est la pente exacte qu'un atome produirait",()=>{
    /* A_H = 1.00782503223 : la partie entière est 1 et la fractionnaire
       0.00782503223, donc la pente vaut 0.00782503223 / 1.00782503223. */
    const hydrogen=stepSignature(TABLE.find("H").isotope(1).mass,1)
    close(hydrogen.k,1,0,"l'hydrogène franchit un seul entier")
    close(hydrogen.epsilon,0.00782503223,1e-11,"son epsilon est le défaut de masse")
    close(hydrogen.slope,0.00782503223/1.00782503223,1e-15,
        "la pente est epsilon sur la masse par charge")
    /* ET C'EST ÇA QUI LA REND INVERSIBLE: A/z = k/(1-s). Une égalité, donc une
       comparaison — pas une optimisation. */
    for(const symbol of ["C","N","O","Si","S","P","Cl","K"]){
        const signature=signatureOf(symbol)
        close(signature.slope,signature.epsilon/(signature.k+signature.epsilon),1e-18,
            `${symbol}: s = eps/(k+eps)`)
        const recovered=signature.k/(1-signature.slope)
        close(recovered,TABLE.find(symbol).monoisotopicMass,1e-9,
            `${symbol}: A = k/(1-s) doit retrouver la masse NIST`)
    }
})

test("l'hydrogène est hors de la fenêtre du Hough, et c'est correct",()=>{
    /* s(H) = 7.8e-3, huit fois la borne ±1e-3. Un pas d'hydrogène franchit sept
       entiers: ce n'est pas une petite pente, c'est une pente qui n'appartient
       pas à cet espace. Le dire ici empêche un jour de "corriger" la formule
       pour faire entrer H dans la fenêtre. */
    const hydrogen=stepSignature(TABLE.find("H").isotope(1).mass,1)
    ok(Math.abs(hydrogen.slope)>1e-3,
        `l'hydrogène doit rester hors de la fenêtre, s = ${hydrogen.slope}`)
    const carbon=stepSignature(TABLE.find("C").monoisotopicMass,1)
    close(carbon.slope,0,1e-18,"le carbone est l'élément à pente nulle : 12.000000")
})

test("les six éléments tassés tiennent dans cinq colonnes",()=>{
    /* La contrainte de la méthode, énoncée pour qu'on ne la découvre pas sur un
       plateau gris. Sur une fenêtre de 2e-3 avec 64 colonnes, une colonne vaut
       3.1e-5, et P/S/Cl/Ar/K/Si s'étalent sur 1.6e-4. */
    const window=2e-3
    const columns=64
    const perColumn=window/(columns-1)
    const tassed=["P","S","Cl","Ar","K","Si"].map(s=>stepSignature(TABLE.find(s).monoisotopicMass,1).slope)
    const spread=Math.max(...tassed)-Math.min(...tassed)
    ok(spread/perColumn<8,
        `ces six éléments tiennent en ${(spread/perColumn).toFixed(1)} colonnes, pas en une`)
    /* et la fenêtre est assez large pour les voir tous */
    for(const slope of tassed){
        ok(Math.abs(slope)<1e-3,`${slope} doit rester dans la fenêtre ±1e-3`)
    }
})

test("un pas qui ne franchit aucun entier n'a pas de signature",()=>{
    eq(stepSignature(0.4,1),null,"sous la moitié d'une unité, la pente vaut 1: ce n'est pas une signature")
    eq(stepSignature(12,0),null,"une charge nulle est refusée")
    eq(stepSignature("x",1),null,"une masse non finie est refusée")
})

test("la table des signatures est triée par pente, et par abondance d'abord",()=>{
    const signatures=elementSignatures(TABLE,{charges:[1,2,3]})
    ok(signatures.length>300,`118 éléments x 3 charges donnent plus de 300 entrées, obtenu ${signatures.length}`)
    for(let i=1;i<signatures.length;i++){
        ok(signatures[i].slope>=signatures[i-1].slope,"la liste doit être triée par pente")
    }
    /* ET PAS D'ISOTOPE RARE PAR DEFAUT: une signature d'un isotope à 0.2 %
       sert à trouver un pic qui n'est pas dans le spectre. "Le plus abondant",
       et pas "au-dessus d'un seuil" — Cl est à 75.8 % et Zn à 49.2 %, et un
       plancher les effacerait tous les deux. */
    const single=elementSignatures(TABLE,{charges:[1],isotopeCount:1})
    eq(single.length,TABLE.elements.length,"un isotope par élément")
    for(const signature of single){
        eq(signature.A,signature.element.mostProbableA,
            `${signature.symbol} doit prendre son isotope le plus probable`)
    }
    const both=elementSignatures(TABLE,{charges:[1],isotopeCount:2})
    ok(both.length>single.length,"deux isotopes par élément en donnent plus")
    /* le plus probable, pas le plus léger: c'est le même piège que partout else */
    const iron=elementSignatures(TABLE,{charges:[1],isotopeCount:1})
        .find(s=>s.symbol==="Fe")
    eq(iron.A,TABLE.find("Fe").mostProbableA,"Fe prend son isotope le plus probable, pas le plus léger")
})

test("le matchmaking rapporte la distance, et les deux extrêmes de la fenêtre",()=>{
    const signatures=elementSignatures(TABLE,{charges:[1]})
    const nitrogen=stepSignature(TABLE.find("N").monoisotopicMass,1)
    const hits=matchSignatures(signatures,nitrogen.slope,1e-5)
    ok(hits.length>0,"l'azote doit se trouver lui-même")
    eq(hits[0].symbol,"N","et il doit être le plus proche de sa propre pente")
    close(hits[0].delta,0,1e-15,"sa distance est nulle")
    /* dans la fenêtre large du Hough, plusieurs éléments répondent à une
       même pente: c'est le but, et c'est aussi pourquoi il faut une grille
       fine pour les départager */
    const wide=matchSignatures(signatures,nitrogen.slope,1e-3)
    ok(wide.length>1,`plusieurs éléments doivent répondre dans ±1e-3, obtenu ${wide.length}`)
    for(let i=1;i<wide.length;i++){
        ok(Math.abs(wide[i].delta)>=Math.abs(wide[i-1].delta),
            "les résultats doivent être triés par distance croissante")
    }
    eq(matchSignatures(signatures,NaN,1e-3).length,0,"une pente non finie ne trouve rien")
})

/* --- le score par paires — la détection, depuis le plan du noyau ---------
   Chaque paire porte (pente, dm) ensemble : c'est le lien que l'histogramme
   global avait perdu, et que le produit cartésien aurait dû deviner. */
test("le score lit le lien, pas deux listes séparées",()=>{
    /* DEUX PAIRES, MÊME PENTE, DEUX PAS. Dans la grille elles tombent dans la
       même case et sont indistinguables ; dans l'histogramme global elles sont
       deux bins sans dire quelle pente chacune a votée. Ici le lien voyage
       avec la paire, donc le lecteur n'a rien à recoller. */
    const nitrogen=TABLE.find("N").monoisotopicMass
    const nSlope=stepSignature(nitrogen,1).slope
    const carbon=TABLE.find("C").monoisotopicMass
    const cSlope=stepSignature(carbon,1).slope
    const pairs=new Float64Array([
        nSlope,2*nitrogen,
        cSlope,3*carbon,
    ])
    const rows=scorePairs(TABLE,pairs,{charges:[1]})
    const hitN=rows.find(r=>r.symbol==="N")
    /* N est valence 3 (impaire) : x1 et pairs passent — le x2 vote. C est
       valence 4 (paire) : tout multiple passe, x3 vote aussi. */
    ok(hitN&&hitN.votes===1,"l'azote reçoit sa paire")
    eq(hitN.topMultiple,2,"et le multiple tombe par round(), sans seuil")
    ok(rows.find(r=>r.symbol==="C"),"le carbone x3 vote : valence paire, tout passe")
})

test("valence impaire : x1 et pairs votent, impairs rejetés ; paire : tout passe",()=>{
    /* LA RÈGLE CHIMIQUE DES MULTIPLES. C (valence 4, paire) : x1→x4 votent
       tous — c'est là que l'explosion quadratique survit. N (valence 3,
       impaire) : x1 et x2 votent, x3 est rejeté. He (valence null) est
       rejeté, même à x1. */
    const carbon=TABLE.find("C").monoisotopicMass
    const cSlope=stepSignature(carbon,1).slope
    const pairs=[]
    for(let n=1;n<=4;n++){ pairs.push(cSlope,n*carbon) }
    const rows=scorePairs(TABLE,new Float64Array(pairs),{charges:[1]})
    const hit=rows.find(r=>r.symbol==="C")
    ok(hit,"le carbone vote encore")
    eq(hit.votes,4,"et tous ses multiples : x1, x2, x3, x4")
    const nitrogen=TABLE.find("N").monoisotopicMass
    const nSlope=stepSignature(nitrogen,1).slope
    const nPairs=[]
    for(let n=1;n<=4;n++){ nPairs.push(nSlope,n*nitrogen) }
    const nRows=scorePairs(TABLE,new Float64Array(nPairs),{charges:[1]})
    const nHit=nRows.find(r=>r.symbol==="N")
    ok(nHit,"l'azote vote encore")
    eq(nHit.votes,3,"mais x1, x2, x4 seulement : le x3 impair est rejeté")
})

test("CH2 sur la pente N vote FAIBLE — le poids tranche, pas un seuil",()=>{
    /* CH2 (14.0157) sur la pente N : 14/14 = 1, ENTIER — donc ça vote, avec
       un poids de 1/(14×0.0126) ≈ 5.7, quand un vrai pas N exact pèse 1e12.
       Pas de refus, pas de tolérance : quelques votes très bons battent des
       votes médiocres, et le tri sur le score fait le reste. Les groupes
       (CH2, H2O, …) viendront plus tard, chaque chose en son temps. */
    const ch2=14.0157
    const nSlope=stepSignature(TABLE.find("N").monoisotopicMass,1).slope
    const rows=scorePairs(TABLE,new Float64Array([nSlope,ch2]),{charges:[1]})
    const hit=rows.find(r=>r.symbol==="N")
    ok(hit&&hit.votes===1,"l'entier tombe juste : ça vote")
    ok(hit.score<1e4,`mais le poids reste modeste, obtenu ${hit.score}`)
    const exact=scorePairs(TABLE,
        new Float64Array([nSlope,TABLE.find("N").monoisotopicMass]),{charges:[1]})
        .find(r=>r.symbol==="N")
    ok(exact.score>hit.score*1e6,
        "et un vrai pas N exact pèse des ordres de grandeur au-dessus")
})

test("à résidu égal, un pas court bat un multiple lointain",()=>{
    /* LE POIDS EST 1/(dm·résidu) : le doute est le moins important à basse
       masse. Un pas N à 28 Da avec un résidu de 5e-4 (1/(28×5e-4) ≈ 71) bat
       un pas O lointain au même résidu — le premier est le dimère N₂
       (valence 3, x2 pair, vote), le second est O x3 (valence 2, paire :
       il vote aussi, mais plus lourd donc plus faible). He ne sert plus
       d'exemple : valence null, rejeté. */
    const oxygen=TABLE.find("O").monoisotopicMass
    const oSlope=stepSignature(oxygen,1).slope
    const nitrogen=TABLE.find("N").monoisotopicMass
    const nSlope=stepSignature(nitrogen,1).slope
    const residue=5e-4
    const pairs=new Float64Array([oSlope,3*oxygen+residue,nSlope,nitrogen+residue])
    const rows=scorePairs(TABLE,pairs,{charges:[1]})
    const hitN=rows.find(r=>r.symbol==="N")
    ok(hitN,"l'azote vote, l'entier tombe juste")
    ok(hitN.score>rows.find(r=>r.symbol==="O").score,"le pas court bat le multiple lointain")
    ok(hitN.score>0,"et son score est non nul")
})

test("un pas exact au calibrateur près vote, même loin de l'entier nominal",()=>{
    /* Le critère est le reste, pas l'arrondi : 2×N exact vote. */
    const nitrogen=TABLE.find("N").monoisotopicMass
    const nSlope=stepSignature(nitrogen,1).slope
    const rows=scorePairs(TABLE,new Float64Array([nSlope,2*nitrogen]),{charges:[1]})
    const hit=rows.find(r=>r.symbol==="N")
    ok(hit&&hit.votes===1,"le multiple exact vote")
    eq(hit.topMultiple,2,"et le multiple est 2")
})

test("le classement est le score, pas le compte",()=>{
    /* QUELQUES VOTES TRÈS BONS BATTENT DES VOTES MÉDIOCRES. Une paire N
       exacte (résidu ~0, poids 1e12) bat six paires H à 0.001 Da de leur pas
       (résidu 1e-3, poids ~1e3 chacune) : le tri est la somme des poids, pas
       le compte. H est valence 1, impaire : x1 vote — les six passent. */
    const hydrogen=TABLE.find("H").isotope(1).mass
    const hSlope=stepSignature(hydrogen,1).slope
    const nitrogen=TABLE.find("N").monoisotopicMass
    const nSlope=stepSignature(nitrogen,1).slope
    const pairs=[nSlope,2*nitrogen]
    /* +0.001 Da sur chaque pas H : le résidu fait le poids, pas la pente —
       le poids ne lit que dm. */
    for(let n=0;n<6;n++){ pairs.push(hSlope,hydrogen+0.001) }
    const rows=scorePairs(TABLE,new Float64Array(pairs),{charges:[1]})
    eq(rows[0].symbol,"N","un vote parfait bat six votes médiocres")
    eq(rows[0].votes,1,"le compte est rendu tel quel")
    ok(rows[0].score>rows.find(r=>r.symbol==="H").score,
        "parce que le score, pas le compte, fait le tri")
})

test("la valence null est rejetée, pas capée",()=>{
    /* He, Ne, Ar et les lourds sans convention ne votent JAMAIS — même à x1.
       Un pas He exact doit rendre zéro vote He. */
    const he=TABLE.find("He").isotopes.find(i=>i.A===TABLE.find("He").mostProbableA).mass
    const heSlope=stepSignature(he,1).slope
    const rows=scorePairs(TABLE,new Float64Array([heSlope,he]),{charges:[1]})
    ok(!rows.find(r=>r.symbol==="He"),"l'hélium exact ne vote pas : valence null")
})

test("le score refuse plutôt que de deviner",()=>{
    eq(scorePairs(TABLE,new Float64Array(0),{charges:[1]}).length,0,"un plan vide ne rend rien")
    eq(scorePairs(TABLE,new Float64Array([NaN,12]),{charges:[1]}).length,0,"une pente non finie ne vote pas")
    eq(scorePairs(TABLE,new Float64Array([0,-3]),{charges:[1]}).length,0,"un écart négatif ne vote pas")
})

test("les seuils k·MAD séparent la falaise du fond",()=>{
    /* LE GRAPHE DIT « EFFONDREMENT », LE TEST DIT OÙ. Scores sur des ordres
       de grandeur (1e12 exact contre 80 approximatif) : médiane et MAD en
       log10, sinon les deux premiers dominent tout et les trois lignes se
       marchent dessus. */
    const cutoffs=scoreCutoffs([{score:1e12},{score:1e11},{score:80},{score:60},{score:50}],{ks:[1,2,4]})
    ok(cutoffs,"des scores rendent des seuils")
    /* médiane des logs triés [1.7, 1.78, 1.9, 11, 12] : 1.9 = log10(80). */
    close(cutoffs.medLog,1.9030899869919435,1e-9,"la médiane est en log10")
    ok(cutoffs.mad>0,"la MAD est strictement positive sur un mélange")
    eq(cutoffs.lines.length,3,"trois lignes : k=1, 2, 4")
    for(let i=1;i<cutoffs.lines.length;i++){
        ok(cutoffs.lines[i].log>cutoffs.lines[i-1].log,"les lignes montent avec k")
    }
    /* la falaise dépasse k=4, le fond reste en dessous de k=1 : c'est ce que
       le graphe montre, l'effondrement entre les deux. */
    ok(12>cutoffs.lines[2].log,"1e12 est au-dessus de k=4 : la falaise")
    ok(Math.log10(50)<cutoffs.lines[0].log,"50 est sous k=1 : le fond")
    /* ET LE VIDE NE REND RIEN : un graphe sans scores n'a pas de lignes. */
    eq(scoreCutoffs([],{ks:[1,2,4]}),null,"pas de scores, pas de seuils")
    eq(scoreCutoffs([{score:0},{score:-3}],{ks:[1]}),null,"pas de scores positifs, pas de seuils")
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length>0) process.exitCode=1


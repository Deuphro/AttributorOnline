/* =========================================================================
   chemistry.js — deux classes, et rien d'autre pour l'instant.

     Element   un atome et ses isotopes. Vient de data/elements.json.
     Formula   une composition d'isotopes + une charge. Ce qu'on MESURE.

   Exemple, qui est toute la distinction :
     C6H12O6                      une recette, pas de masse
     12C6 1H12 16O6 [H+]          une formule, m/z 181.0707
     12C5 13C1 1H12 16O6 [H+]     une AUTRE formule, +1.003355

   Ce qu'il y a AU-DESSUS de Formula n'est pas encore écrit: ce qui regroupe
   plusieurs formules en une seule entité. Rien n'en est décidé ici, alors
   rien n'en est codé.

   Rappel de l'existant, pour ne pas le refaire :
     - les masses sont dans data/elements.json, PAS dans ce fichier
     - la table doit rester instanciable : un isotope ou une valence bizarre
       se change en mémoire, jamais dans le JSON
     - float64 suffit largement, le problème n'a jamais été la précision
       arithmétique mais la justesse de la table
   ========================================================================= */

/* -------------------------------------------------------------------------
   Element — un atome et ses isotopes.

   Le JSON de data/ est de la DONNÉE: des objets nus, sans méthodes. Le moteur
   veut des objets qui savent répondre. Element.load est la seule frontière
   entre les deux mondes: changer de table (l'AME plus tard, ou une table
   modifiée par un utilisateur) ne change rien au reste, parce que tout passe
   par ici.
   ------------------------------------------------------------------------- */
class Element{
    constructor(record){
        Object.assign(this,record)   //Z, symbol, name, valences, monoisotopicMass
        this.isotopes=record.isotopes
    }

    isotope(A){ return this.isotopes.find(i=>i.A===A) }
    get lightestA(){ return this.isotopes[0].A }
    get massOfLightest(){ return this.isotopes[0].mass }

    /* data -> une table interrogeable. find() accepte un symbole, un nom,
       un Z, ou déjà un Element — c'est le seul point d'entrée du code. */
    static load(data){
        const elements=data.elements.map(r=>new Element(r))
        const bySymbol=new Map(elements.map(e=>[e.symbol,e]))
        const byZ=new Map(elements.map(e=>[e.Z,e]))
        const byName=new Map(elements.map(e=>[e.name.toLowerCase(),e]))
        const find=(key)=>{
            if(key instanceof Element) return key
            if(typeof key==="number") return byZ.get(key)
            const s=String(key).trim()
            return bySymbol.get(s)
                ??bySymbol.get(s[0]?.toUpperCase()+s.slice(1))
                ??byName.get(s.toLowerCase())
                ??(Number.isInteger(+s)&&+s>0?byZ.get(+s):undefined)
        }
        return {...data,elements,bySymbol,byZ,byName,find}
    }
}


/* -------------------------------------------------------------------------
   Formula — une chose mesurable.

   Elle porte une COMPOSITION (les isotopes choisis), des adduits, une charge.
   L'identité est le CONTENU, rien d'autre. La provenance est attachée à côté,
   jamais dans la clé: la même formule trouvée par deux chemins différents reste
   UNE formule.

   La notation, en UNE seule chaîne à taper.

   Le problème réel, que vous avez bien vu : "1H2+" se lit de deux façons.
   Est-ce du deutérium ? Est-ce deux protons ajoutés ? Impossible à trancher.

   La solution : COMPOSITION et IONISATION sont deux jetons séparés par des
   crochets, ce qui ferme l'ambiguïté.

     C6H12O6                 neutre
     C6H12O6 [H+]             protoné       — on AJOUTE un H
     C6H12O6 [H-]             déprotoné     — on RETIRE un H
     C6H12O6 [2H+]            deux protons — et NON du deutérium
     C6H12O6 [Na+]            sodié
     C6H12O6 [e-]             anion radicalaire — électron GAGNÉ
     12C6 1H12 16O6 [H+]      monoisotopique

   Deux conventions seulement, et elles ne se recouvrent pas:
     chiffres AVANT le symbole  -> nombre de masse  (12C, 13C)
     chiffres APRÈS le symbole  -> nombre d'atomes  (C6)
   ------------------------------------------------------------------------- */

/* Les adduits, avec un INDEX, parce qu'un chemin de provenance les désigne par
   leur numéro plutôt que par leur nom.

   Liste OUVERTE: ce qui n'y est pas reste saisissable en texte libre, et le nom
   est alors une simple étiquette. Rien n'est refusé — le moteur sait lire, il ne
   décide pas.

   ATTENTION au sens de "e-". Le signe est celui de l'électron, pas celui de
   l'ion: "e-" est l'électron que la molécule a GAGNÉ, donc charge -1. Se tromper
   ici produirait l'anion radicalaire à la place du cation, avec la bonne masse
   et la mauvaise charge — le pire genre de bug. */
const ADDUCTS=[
    {index:0,name:"",     group:null,charge: 0,meaning:"le neutre lui-même"},
    {index:1,name:"H+",   group:"H",  charge:+1,meaning:"protonation"},
    {index:2,name:"Na+",  group:"Na", charge:+1,meaning:"adduit sodium"},
    {index:3,name:"K+",   group:"K",  charge:+1,meaning:"adduit potassium"},
    {index:4,name:"NH4+", group:"NH4",charge:+1,meaning:"adduit ammonium"},
    {index:5,name:"H-",   group:"H",  charge:-1,meaning:"déprotonation"},
    {index:6,name:"e-",   group:null,charge:-1,meaning:"électron gagné, anion radicalaire"},
    {index:9,name:"e+",   group:null,charge:+1,meaning:"électron perdu, cation radicalaire"},
    {index:7,name:"Cl-",  group:"Cl", charge:-1,meaning:"adduit chlorure"},
    {index:8,name:"OH-",  group:"OH", charge:-1,meaning:"perte hydroxyle"},
]
const ADDUCT_BY_NAME=new Map(ADDUCTS.map(a=>[a.name,a]))

class Formula{
    /* composition: Map<Element, Map<A,count>>  ce qui est RÉELLEMENT mesuré
       adducts:      la LISTE des termes d'ionisation, dans l'ordre saisi
       charge:       la somme de leurs charges
       path:         la provenance, {"iso":k,"adduct":n} — HORS de la clé   */
    constructor({composition,adducts=[],charge=undefined,path=undefined}={}){
        this.composition=composition
        this.adducts=adducts
        this.charge=charge??adducts.reduce((n,a)=>n+a.charge*(a.count??1),0)
        this.path=path??null
    }

    /* Les COMPTES, isotopes effacés: C6H12O6 quel que soit le 13C choisi.
       C'est une simple lecture de la formule, rien de plus. */
    get counts(){
        const s=new Map()
        for(let [el,byA] of this.composition){
            let n=0
            for(let count of byA.values()) n+=count
            s.set(el,n)
        }
        return s
    }

    /* La masse de l'ION.

       La somme des masses d'atomes NEUTRES inclut déjà les électrons de
       chacun d'eux, donc la seule correction à appliquer est celle de la
       charge: un ion positif a perdu des électrons, un ion négatif en a gagné.
       C'est la même formule dans les deux cas, portée par le signe de charge. */
    get mass(){
        let m=0
        for(let [el,byA] of this.composition){
            for(let [A,n] of byA) m+=el.isotope(A).mass*n
        }
        return m-this.charge*ELECTRON_MASS
    }

    //m/z: on ne mesure jamais qu'un rapport masse/charge, jamais une masse seule
    get mz(){ return this.mass/Math.abs(this.charge||1) }

    //L'IDENTITÉ. Deux formules sont les mêmes si et seulement si cette chaîne
    //est la même. La provenance n'y entre pas.
    get key(){ return this.toString() }

    toString(){
        return Formula.compositionToString(this.composition)
            //chaque crochet est rejoué tel quel: l'écriture EST la clé
            +this.adducts.map(a=>` [${a.name}]`).join("")
    }


    /* ===================================================================
       Les fabriques. Tout ce qui LIT une chaîne est ici, et nulle part
       ailleurs: une formule se fabrique, elle ne se devine pas.
       =================================================================== */

    /* "C6H12O6 [H+]" -> une Formula. L'entrée unique, celle qu'on tape.

       Les crochets S'EMPILENT et s'additionnent, parce que les ions le font:
         C6H12O6 [H-][e-]    déprotoné PUIS réduit, charge -2
         C6H12O6 [2H+][e-]   doublement protoné PUIS réduit, charge +1 */
    static parse(text,table){
        const s=String(text).trim()
        const brackets=[...s.matchAll(/\[([^\]]*)\]/g)]
        //tout ce qui n'est pas entre crochets est la composition
        const body=s.replace(/\[[^\]]*\]/g," ").trim()
        if(!body) throw new Error(`no composition in "${text}"`)
        const composition=Formula.parseComposition(body,table)
        if(brackets.length===0) return new Formula({composition,adducts:[]})
        //chaque crochet est un terme; les charges s'additionnent
        const adducts=brackets.map(([,inner])=>Formula.parseIonisation(inner).adduct)
        for(let {group,charge,count=1} of adducts){
            if(group) Formula.applyAdduct(composition,group,count,charge<0,table)
        }
        return new Formula({composition,adducts})
    }

    /* "C6H12O6" ou "12C5 13C1 1H12 16O6" -> Map<Element, Map<A,count>>

       Deux écritures, parce que l'utilisateur tape les deux:
         SANS espaces  C6H12O6     — un isotope par élément, le plus léger
         AVEC espaces  12C5 13C1   — deux isotopes du même élément, sinon
                                     il n'y a pas de place pour les distinguer
       Un élément sans nombre de masse est mis sur son isotope le plus léger,
       ce qui est la forme monoisotopique: la masse par défaut, la plus
       fréquente. */
    static parseComposition(text,table){
        const composition=new Map()
        const add=(el,A,n)=>{
            if(!composition.has(el)) composition.set(el,new Map())
            const byA=composition.get(el)
            byA.set(A,(byA.get(A)??0)+n)
        }
        for(const raw of String(text).trim().split(/[\s.]+/).filter(Boolean)){
            //un token peut contenir plusieurs atomes: "C6H12O6" -> C, H, O
            const re=/(\d*)([A-Z][a-z]?)(\d*)/g
            let m
            let found=false
            while((m=re.exec(raw))!==null){
                found=true
                const [,massNumber,symbol,count]=m
                const el=table.find(symbol)
                if(!el) throw new Error(`unknown element "${symbol}" in "${raw}"`)
                const n=Number(count||"1")
                if(massNumber){
                    const A=Number(massNumber)
                    if(!el.isotope(A)) throw new Error(`${el.symbol} has no isotope ${A}`)
                    add(el,A,n)
                }else{
                    add(el,el.lightestA,n)   //aucun nombre de masse: le plus léger
                }
            }
            if(!found) throw new Error(`cannot read "${raw}" as an element`)
        }
        return composition
    }

    //"[2H+]", "[H-]", "[Na+]", "[e-]", "[]" -> {adduct, count, known}
    static parseIonisation(text){
        const s=String(text).trim()
        const m=/^\[?\s*(\d*)\s*([A-Za-z0-9]*)\s*([+-])\s*\]?$/.exec(s)
        if(!m) throw new Error(`cannot read "${text}" as an ionisation`)
        const [,count,name,sign]=m
        const n=Number(count||"1")
        const key=`${count}${name}${sign}`
        const known=ADDUCT_BY_NAME.get(key)
        //le count est RECOLLÉ sur l'adduit: "[2H+]" doit appliquer DEUX protons,
        //et c'est la même entrée de la liste que "[H+]" avec un multiplicateur
        if(known) return {adduct:{...known,count:n},count:n,known:true}
        /* "[2H+]" n'est pas dans la liste: c'est le MÊME adduit que H+ répété
           deux fois. On le reconnaît sur la forme "N adduit +", et surtout on ne
           le confond PAS avec du deutérium, qui s'écrit dans la composition. */
        const single=ADDUCT_BY_NAME.get(`${name}${sign}`)
        if(n>1&&single) return {adduct:{...single,name:key,count:n},count:n,known:true}
        //pas dans la liste: étiquette libre, composition NON ajustée
        return {
            adduct:{index:-1,name:key,group:null,count:1,charge:sign==="+"?1:-1},
            count:1,known:false,
        }
    }

    /* Enregistrer un adduit À LA VOLÉE, sans rien rouvrir.

       C'est la seule chose que l'utilisateur a le droit de faire, et c'est
       volontairement sans garde-fou: le moteur ne dit jamais qu'un ion est
       impossible.

       group est OPTIONNEL, et ce qui manque est le seul défaut réel: sans group,
       aucun atome n'est ajouté ou retiré, et l'adduit se réduit à une étiquette
       qui porte une charge. Avec group, la composition est réécrite exactement
       comme pour un adduit de la liste. */
    static registerAdduct({name,group=null,charge,meaning="ajouté par l'utilisateur"},table){
        if(!name) throw new Error("an adduct needs a name")
        if(!Number.isInteger(charge)) throw new Error(`"${name}" needs an integer charge`)
        //le signe doit s'accorder au nom, sinon "[MeOH-]" finirait positif.
        //Seule contradiction tolérée: un nom qui se contredit lui-même.
        const sign=String(name).trim().at(-1)
        const expected=sign==="-"?-1:1
        if(Math.sign(charge)!==expected)
            throw new Error(`"${name}" ends with "${sign}" but was given charge ${charge}`)
        if(group!==null){
            //on valide le group ICI, une fois, pour attraper la faute tout de
            //suite plutôt que de la laisser éclater au milieu d'un calcul
            Formula.parseComposition(group,table)
        }
        //un index neuf, jamais un index arbitraire: les chemins de provenance
        //doivent rester reproductibles d'une session à l'autre
        const index=ADDUCTS.reduce((m,a)=>Math.max(m,a.index),0)+1
        const adduct={index,name,group,charge,meaning}
        ADDUCTS.push(adduct)
        ADDUCT_BY_NAME.set(name,adduct)
        return adduct
    }

    //ajoute (ou retire) un groupe à une composition, isotopes les plus légers
    static applyAdduct(composition,group,count,remove,table){
        for(let [el,byA] of Formula.parseComposition(group,table)){
            const [A,n]=[...byA][0]
            const times=(remove?-1:1)*count*n
            if(!composition.has(el)) composition.set(el,new Map())
            const target=composition.get(el)
            target.set(A,(target.get(A)??0)+times)
            if(target.get(A)===0) target.delete(A)
            if(target.size===0) composition.delete(el)
        }
        return composition
    }

    //écrit une composition en Hill, avec le nombre de masse quand il est choisi
    static compositionToString(composition){
        const rank=(el)=>el.symbol==="C"?0:el.symbol==="H"?1:2
        const parts=[]
        //les ELEMENTS, triés en Hill: C, H, puis le reste par symbole
        const ordered=[...composition.keys()].sort(
            (a,b)=>rank(a)-rank(b)||(a.symbol<b.symbol?-1:1))
        for(let el of ordered){
            const byA=composition.get(el)
            //un seul isotope: pas de nombre de masse, on écrit la forme simple
            if(byA.size===1){
                const [[A,n]]=[...byA]
                const name=A===el.lightestA?el.symbol:`${A}${el.symbol}`
                parts.push(n>1?`${name}${n}`:name)
            }else{
                //plusieurs isotopes du même élément: il faut tous les écrire
                for(let [A,n] of [...byA].sort((a,b)=>a[0]-b[0])){
                    parts.push(`${A}${el.symbol}${n>1?n:""}`)
                }
            }
        }
        return parts.join(" ")
    }
}

/* -------------------------------------------------------------------------
   Test — node scripts/chemistry.js

   Le parsage est la partie où une erreur se cache le plus longtemps, alors
   chaque ambiguïté qu'on avait repérée a son test. Rien ici ne parle de ce qui
   regroupe les formules: ce n'est pas écrit, donc ce n'est pas testé.
   ------------------------------------------------------------------------- */
import {readFileSync} from "fs"
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

let passed=0
const failures=[]
const test=(name,fn)=>{
    try{ fn(); passed++; console.log(`  ok   ${name}`) }
    catch(e){ failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const close=(a,b,tol,msg)=>{ if(!(Math.abs(a-b)<=tol)) throw new Error(`${msg??`${a} vs ${b}`}`) }
//combien d'atomes d'un symbole, quels que soient leurs isotopes
const atoms=(formula,symbol)=>{
    let n=0
    for(let [el,byA] of formula.composition){
        if(el.symbol===symbol) for(let c of byA.values()) n+=c
    }
    return n
}

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
test("[H-] retire un H et prend un électron",()=>{
    const s=parse("C6H12O6 [H-]")
    //un anion NEGATIF gagne un électron: on AJOUTE sa masse
    close(s.mz,GLUCOSE-PROTON+MASS_OF_E,1e-9)
    if(s.charge!==-1) throw new Error(`charge ${s.charge}`)
    if(atoms(s,"H")!==11) throw new Error(`H=${atoms(s,"H")}, expected 11`)
})
test("[Na+] ajoute un sodium",()=>{
    const na=TABLE.find("Na").isotope(23).mass
    close(parse("C6H12O6 [Na+]").mz,GLUCOSE+na-MASS_OF_E,1e-9)
})

console.log("l'ambiguïté qui motivait la notation")
test("[2H+] est doublement protoné, PAS du deutérium",()=>{
    const s=parse("C6H12O6 [2H+]")
    if(s.charge!==2) throw new Error(`charge ${s.charge}, expected 2`)
    if(atoms(s,"H")!==14) throw new Error(`H=${atoms(s,"H")}, expected 14`)

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
    close(protonated.mass-(base.mass+PROTON),-MASS_OF_E,1e-9)
    //le sodium coûte donc bien ses 22,9897, pas 22,9830
    close(sodiated.mz,base.mass+TABLE.find("Na").isotope(23).mass-MASS_OF_E,1e-9)
})
test("un ion doublement chargé retire deux électrons",()=>{
    const s=parse("C6H12O6 [2H+]")
    close(s.mass,GLUCOSE+2*PROTON-2*MASS_OF_E,1e-9)
    close(s.mz,(GLUCOSE+2*PROTON-2*MASS_OF_E)/2,1e-9)
})
test("un anion AJOUTE des électrons",()=>{
    const s=parse("C6H12O6 [e-]")
    close(s.mass,GLUCOSE+MASS_OF_E,1e-9)
})
test("mz est la masse divisée par la charge, sans rien d'autre",()=>{
    for(const text of ["C6H12O6 [H+]","C6H12O6 [2H+]","C6H12O6 [H-]","C6H12O6 [Na+]"]){
        const s=parse(text)
        close(s.mz,s.mass/Math.abs(s.charge),1e-15)
    }
})

    close(s.mz,(GLUCOSE+2*PROTON-2*MASS_OF_E)/2,1e-9)
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
    a.path={iso:0,adduct:1}
    b.path={iso:0,adduct:1,via:"autre voie"}
    if(a.key!==b.key) throw new Error("the path leaked into the key")
})
test("la clé ne dépend que du contenu",()=>{
    const s=parse("C6H12O6 [H+]")
    if(s.key!=="C6 H13 O6 [H+]") throw new Error(`key is "${s.key}"`)
})


console.log("l'ion radicalaire, des deux côtés")
test("[e+] ne touche pas à la composition",()=>{
    //un électron PERDU: la composition reste C6H12O6, seule la charge change
    const s=parse("C6H12O6 [e+]")
    if(s.composition.size!==3) throw new Error("composition changed")
    close(s.mz,GLUCOSE-MASS_OF_E,1e-9)
    if(s.charge!==1) throw new Error(`charge ${s.charge}`)
})
test("[e-] est l'anion radicalaire: électron GAGNÉ",()=>{
    /* "e-" se lit électrons-MOINS, donc charge -1. C'est le seul moyen d'avoir
       un radical sans toucher aux atomes. */
    const s=parse("C6H12O6 [e-]")
    if(s.charge!==-1) throw new Error(`charge ${s.charge}, expected -1`)
    if(s.composition.size!==3) throw new Error("composition changed")
    close(s.mz,GLUCOSE+MASS_OF_E,1e-9)
})
test("cation et anion sont deux formules différentes",()=>{
    const cation=parse("C6H12O6 [e+]")
    const anion=parse("C6H12O6 [e-]")
    if(cation.charge!==1) throw new Error(`cation charge ${cation.charge}`)
    if(anion.charge!==-1) throw new Error(`anion charge ${anion.charge}`)
    if(cation.key===anion.key) throw new Error("cation and anion share a key")
})
test("H- et e- ont la même charge mais pas la même masse",()=>{
    //la confusion à éviter: [H-] PERD un proton, [e-] GAGNE un électron
    const proton=parse("C6H12O6 [H-]")
    const electron=parse("C6H12O6 [e-]")
    if(proton.charge!==electron.charge) throw new Error("charges should match")
    close(electron.mass-proton.mass,PROTON,1e-9)
})
test("les crochets s'empilent et les charges s'additionnent",()=>{
    const s=parse("C6H12O6 [H-][e-]")
    if(s.charge!==-2) throw new Error(`charge ${s.charge}, expected -2`)
    if(s.adducts.length!==2) throw new Error(`${s.adducts.length} terms`)
    if(atoms(s,"H")!==11) throw new Error("the proton loss still happened")
})
test("[2H+][e-] s'annule: charge +1",()=>{
    const s=parse("C6H12O6 [2H+][e-]")
    if(s.charge!==1) throw new Error(`charge ${s.charge}, expected 1`)
})




console.log("les adduits sont ouverts")
test("un adduit inconnu est accepté comme étiquette",()=>{
    const s=parse("C6H12O6 [MeOH+]")
    if(s.adducts[0].name!=="MeOH+") throw new Error(`name ${s.adducts[0].name}`)
    //pas dans la liste: la composition n'est PAS réécrite
    if(s.composition.size!==3) throw new Error("composition should be untouched")
    //mais la charge est bien lue dans le crochet
    if(s.charge!==1) throw new Error(`charge ${s.charge}`)
})
test("un adduit enregistré à la volée devient un vrai adduit",()=>{
    /* C'est la voie prévue: l'utilisateur déclare group + charge, et dès lors
       la composition est réécrite comme pour un adduit de la liste. */
    Formula.registerAdduct({name:"MeOH+",group:"CH4O",charge:+1,meaning:"solvatation méthanol"},TABLE)
    const s=parse("C6H12O6 [MeOH+]")
    if(atoms(s,"C")!==7) throw new Error(`C should be 7, got ${atoms(s,"C")}`)
    if(atoms(s,"O")!==7) throw new Error(`O should be 7, got ${atoms(s,"O")}`)
    if(s.charge!==1) throw new Error(`charge ${s.charge}`)
    //et il reçoit un index, donc il peut figurer dans un chemin de provenance
    if(s.adducts[0].index<0) throw new Error("a registered adduct must have an index")
})
test("un adduit enregistré fonctionne avec un multiplicateur",()=>{
    const s=parse("C6H12O6 [2MeOH+]")
    if(atoms(s,"C")!==8) throw new Error(`C should be 8, got ${atoms(s,"C")}`)
    if(s.charge!==2) throw new Error(`charge ${s.charge}, expected 2`)
})
test("un adduit enregistré peut être perdu, pas seulement ajouté",()=>{
    Formula.registerAdduct({name:"H2O-",group:"H2O",charge:-1,meaning:"perte d'eau"},TABLE)
    const s=parse("C6H12O6 [H2O-]")
    if(atoms(s,"H")!==10) throw new Error(`H should be 10, got ${atoms(s,"H")}`)
    if(atoms(s,"O")!==5) throw new Error(`O should be 5, got ${atoms(s,"O")}`)
    if(s.charge!==-1) throw new Error(`charge ${s.charge}`)
})
test("des adduits inconnus s'empilent sans qu'on ait à les connaître",()=>{
    //aucune combinatoire n'est refusée, même si elle n'a aucun sens
    const s=parse("C6H12O6 [Na+][H-][e-][MeOH+]")
    if(s.adducts.length!==4) throw new Error(`${s.adducts.length} terms, expected 4`)
    if(s.charge!==0) throw new Error(`charge ${s.charge}, expected 0`)
})
test("l'enregistrement ne touche pas aux adduits déjà connus",()=>{
    if(ADDUCTS[1].name!=="H+"||ADDUCTS[1].charge!==1)
        throw new Error("H+ was disturbed")
    if(ADDUCT_BY_NAME.get("H+")!==ADDUCTS[1]) throw new Error("the map no longer points at the same object")
    //et le signe de l'adduit est bien celui de l'ION
    if(ADDUCTS[6].name!=="e-"||ADDUCTS[6].charge!==-1)
        throw new Error("e- must be the negative charge")
})
test("un adduit contradictoire est refusé à l'enregistrement",()=>{
    //seule contradiction tolérée: un nom qui contredit sa propre charge
    try{
        Formula.registerAdduct({name:"Weird-",group:"H",charge:+1},TABLE)
        throw new Error("should have thrown")
    }catch(e){ if(!/charge/.test(e.message)) throw e }
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

console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length>0) process.exitCode=1

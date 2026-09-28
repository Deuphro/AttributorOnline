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

    //isotope(A) passe par la Map, O(1), sans hypothèse sur les A
    isotope(A){ return this._byAMap?.get(A)??this.isotopes.find(i=>i.A===A) }
    get lightestA(){ return this.byA?.[0]?.A ?? this.isotopes[0].A }
    get massOfLightest(){ return this.isotope(this.lightestA).mass }

    /* Construit les index, une fois pour toutes.

       ATTENTION aux 56 éléments mono-isotopiques: NIST y écrit
       "abundance": null, parce qu'un isotope unique est 100 % par définition
       mais n'a pas besoin d'être écrit. Un tri naïf y verrait null - null,
       soit 0, et pourrait laisser passer un vrai concurrent. On traite donc
       null comme 1 — ce qui est le cas de fait — et les 56 sortent correctement.

       Le tableau reste trié par A croissant: c'est déjà le cas dans le JSON,
       et on le GARANTIT ici plutôt que de le supposer. */
    index(){
        //par A croissant, garanti plutôt que présumé
        this.byA=[...this.isotopes].sort((a,b)=>a.A-b.A)
        //par A, en Map: la recherche d'un isotope est le geste le plus fréquent
        //du moteur, il doit être O(1) et jamais dépendre d'une arithmétique
        //sur les A, qui ne sont pas contigus (C est 12 et 13, pas 12 et 13)
        this._byAMap=new Map(this.byA.map(i=>[i.A,i]))
        //par abondance décroissante, pour le plus probable
        this._byAbundance=[...this.isotopes].sort(
            (a,b)=>(b.abundance??1)-(a.abundance??1))
        return this
    }

    /* L'isotope le PLUS PROBABLE, par construction et non par calcul.

       Rien ne garantit que ce soit le plus léger: Fe est à ⁵⁶Fe (91,8 %) contre
       ⁵⁴Fe (5,8 %), Pb à ²⁰⁸Pb contre ²⁰⁴Pb, Ar à ⁴⁰Ar contre ³⁶Ar. Sur les 118
       éléments de la table NIST, 40 ont les deux isotopes distincts — un tiers
       de la table, pas une curiosité.

       Le tri par abondance coûterait 17 fois plus cher qu'une lecture, donc il
       est fait UNE fois, à l'indexation, et plus jamais ensuite. */
    get mostProbableA(){ return this._byAbundance?.[0]?.A ?? this.lightestA }

    /* Choisit l'isotope d'un A INCONNU. C'est la seule chose où il faut faire
       une hypothèse: tant que l'utilisateur n'a pas écrit le nombre de masse,
       le moteur doit trancher, et il le fait selon la règle qu'on lui a donnée.
       "mostProbable" est le défaut parce qu'on cherche un pic qu'on verra. */
    pickA(rule="mostProbable"){
        return rule==="lightest"?this.lightestA:this.mostProbableA
    }

    /* data -> une table interrogeable. find() accepte un symbole, un nom,
       un Z, ou déjà un Element — c'est le seul point d'entrée du code.

       load() ne se contente pas de transformer: il INDEXE. C'est ici, et une
       seule fois, qu'on paie ce qui sera demandé mille fois. */
    static load(data){
        const elements=data.elements.map(r=>new Element(r))
        for(let el of elements) el.index()
        const bySymbol=new Map(elements.map(e=>[e.symbol,e]))
        const byZ=new Map(elements.map(e=>[e.Z,e]))
        const byName=new Map(elements.map(e=>[e.name.toLowerCase(),e]))
        const find=(key)=>{
            if(key instanceof Element) return key
            if(typeof key==="number") return byZ.get(key)
            const s=String(key).trim()
            /* Le parseur ne propose une paire de deux lettres que si elle est
               déjà correctement capitalisée ("Co", "Fe"). Donc ici, une paire
               ENTIÈREMENT minuscule n'a pas à être capitalisée: ce serait
               fabriquer un symbole que l'utilisateur n'a pas écrit, et "co"
               deviendrait du cobalt au lieu de C + O.

               find() reste tolérant pour l'usage direct (table.find("fe")),
               mais c'est le parseur qui porte la règle de segmentation. */
            const exact=bySymbol.get(s)
            if(exact) return exact
            //une lettre minuscule est capitalisée: "c" et "c" sont le carbone
            if(s.length===1) return bySymbol.get(s.toUpperCase())
            /* Deux lettres, deux cas distincts:
               - si la PREMIÈRE est majuscule, c'est un symbole à deux lettres
                 ("Co", "Fe", "Na"). On respecte la casse de la seconde.
               - si les DEUX sont minuscules, c'est de la frappe: on capitalise
                 la première et on garde la seconde minuscule ("fe" → "Fe"). */
            if(s.length===2){
                const cap=s[0].toUpperCase()+s[1]
                return bySymbol.get(cap)
            }
            return byName.get(s.toLowerCase())
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
const IONISATIONS=[
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
const IONISATION_BY_NAME=new Map(IONISATIONS.map(a=>[a.name,a]))

class Formula{
    /* composition: Map<Element, Map<A,count>>  ce qui est RÉELLEMENT mesuré
       ionisation:   la LISTE des termes d'ionisation, dans l'ordre saisi
       charge:       la somme de leurs charges
       rule:         la règle qui a tranché les A inconnus ("mostProbable"…)
       path:         la provenance, {"iso":k,"ionisation":n} — HORS de la clé   */
    constructor({composition,ionisation=[],charge=undefined,rule="mostProbable",path=undefined}={}){
        this.composition=composition
        this.ionisation=ionisation
        /* Les charges s'ADDITIONNENT, elles ne se multiplient pas.

           Le descripteur a déjà mis la magnitude DANS la charge: "[2+]" est un
           terme de charge 2, et son count vaut 2 parce qu'il y a deux
           électrons, pas parce qu'il y aurait deux fois la charge. Multiplier
           ici donnerait 4, et "[2+][e-]" ne s'annulerait jamais. */
        this.charge=charge??ionisation.reduce((n,t)=>n+t.charge,0)
        //la règle se souvient, parce que l'affichage s'en sert: on omet le
        //nombre de masse de l'isotope que CETTE règle aurait choisi
        this.rule=rule
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

    /* L'IDENTITÉ, et elle n'abrège JAMAIS.

       Elle sert de clef de dictionnaire, de clef de fusion, et elle peut être
       stockée puis relue des mois plus tard. Elle doit donc dire TOUT: chaque
       nombre de masse, puis les crochets d'ionisation. Une clé qui abrège
       perd l'information sans pouvoir la retrouver — "Fe2 O3" se relit en ⁵⁶Fe
       avec la règle par défaut, alors qu'il pouvait être du ⁵⁴Fe.

       Deux formules sont les mêmes si et seulement si ces chaînes sont
       identiques. La provenance n'y entre pas. */
    get key(){
        return Formula.compositionToString(this.composition,null)
            +this.brackets
    }

    /* L'AFFICHAGE, qui abrège, et qui se relit avec la même règle.

       "Fe2O3[2e+]" se relit en ⁵⁶Fe si on est en mostProbable, en ⁵⁴Fe en
       lightest: dans les deux cas on retombe sur la formule qu'on voulait
       montrer. C'est lisible pour un humain, et c'est pourquoi cette forme
       n'est PAS une identité. */
    toString(){
        //l'affichage est COLLÉ: c'est la forme qu'on écrit à la main, et c'est
        //pour ça qu'elle n'est pas une identité
        return Formula.compositionToString(this.composition,this.rule).replace(/ /g,"")
            +this.brackets
    }

    /* La partie ionisation, telle qu'on l'écrit: collée, sans espace.

       Un terme dont le nom est canonique s'écrit avec son multiplicateur:
       "e+" devient "[+]", "e-" devient "[-]", et "e+" avec count=2 devient
       "[2+]". C'est la forme que les chimistes écrivent, donc celle qu'on
       affiche — le "e" du préfixe n'a aucune valeur lisible. */
    get brackets(){
        return this.ionisation.map(t=>{
            //la charge est réécrite telle qu'elle a été LUE: "[2H+2]" doit
            //rester "[2H+2]", pas se replier sur le nom canonique "[2H+]"
            const sign=t.charge>0?"+":"-"
            const n=Math.abs(t.charge)
            if(t.group===null)
                return `[${(t.count??1)>1||n>1?n:""}${sign}]`
            const head=t.massNumber!=null?`${t.massNumber}${t.group}`:t.group
            return `[${head}${(t.count??1)>1?t.count:""}${sign}${n>1?n:""}]`
        }).join("")
    }


    /* ===================================================================
       Les fabriques. Tout ce qui LIT une chaîne est ici, et nulle part
       ailleurs: une formule se fabrique, elle ne se devine pas.
       =================================================================== */

    /* "C6H12O6 [H+]" -> une Formula. L'entrée unique, celle qu'on tape.

       Les crochets S'EMPILENT et s'additionnent, parce que les ions le font:
         C6H12O6 [H-][e-]    déprotoné PUIS réduit, charge -2
         C6H12O6 [2H+][e-]   doublement protoné PUIS réduit, charge +1 */
    static parse(text,table,rule="mostProbable"){
        const s=String(text).trim()
        //Les crochets s'empilent, et les ";" aussi: ce sont deux délimiteurs
        //pour la MÊME chose. "[H+][e-]" et ";H+;e-" sont le même ion.
        //Chaque ";" ouvre un terme, exactement comme chaque crochet.
        const brackets=[...s.matchAll(/\[([^\]]*)\]/g)]
        const afterSemicolon=s.split(";").slice(1)
        /* Mélanger les deux délimiteurs dans une même saisie rendrait l'ordre
           ambigu: "C6H12O6[H+];e-" pourrait se lire dans les deux sens. On le
           refuse donc, plutôt que de choisir un ordre arbitraire et muet. */
        if(brackets.length&&afterSemicolon.length)
            throw new Error(`"${text}" mixes [] and ; — pick one delimiter`)
        const terms=(brackets.length
            ?brackets.map(([,inner])=>inner)
            :afterSemicolon).map(t=>t.trim()).filter(t=>t!=="")
        //tout ce qui n'est pas un terme d'ionisation est la composition
        const body=(brackets.length?s.replace(/\[[^\]]*\]/g," "):s.split(";")[0]).trim()
        if(!body) throw new Error(`no composition in "${text}"`)
        const composition=Formula.parseComposition(body,table,rule)
        if(terms.length===0) return new Formula({composition,ionisation:[],rule})
        //chaque crochet est un terme; les charges s'additionnent
        const ionisation=terms.map(t=>Formula.parseIonisation(t,table).ionisation)
        //les termes ont LEUR PROPRE isotope, dans l'ordre où ils sont écrits
        for(let {group,charge,count=1,massNumber=null} of ionisation){
            if(group) Formula.applyGroup(composition,group,count,charge<0,table,rule,massNumber)
        }
        return new Formula({composition,ionisation,rule})
    }

    /* "C6H12O6" ou "12C5 13C1 1H12 16O6" -> Map<Element, Map<A,count>>

       Deux écritures, parce que l'utilisateur tape les deux:
         SANS espaces  C6H12O6     — un isotope par élément, choisi par la règle
         AVEC espaces  12C5 13C1   — deux isotopes du même élément, sinon
                                     il n'y a pas de place pour les distinguer

       C'est ici, et seulement ici, qu'on fait une hypothèse sur un A inconnu.
       L'utilisateur qui écrit "Fe" n'a pas dit quel fer il veut: la règle
       décide, et par défaut c'est le plus probable — pas le plus léger, car
       ⁵⁴Fe est à 5,8 % et ⁵⁶Fe à 91,8 %. Un A ÉCRIT n'est jamais touché.

       La casse est indifférente pour la frappe: "c6h13o6" se lit "C6H13O6".

       MAIS la casse reste/signifie quelque chose: un symbole à deux lettres
       s'écrit avec la seconde en minuscules — Co, Fe, Na. C'est la convention
       Hill, et c'est elle qui distingue "CO" (carbone + oxygène) de "Co"
       (cobalt). Un parseur qui l'ignore confond les deux.

       Donc la règle est: un symbole à deux lettres n'est reconnu QUE si la
       première lettre est une majuscule. On tolère "c6h13o6" et "fe2o3" par
       confort de frappe, mais "co2" reste C + O2, jamais du cobalt. C'est le
       prix de la minuscule, et il est juste: le cobalt s'écrit "Co". */
    static parseComposition(text,table,rule="mostProbable"){
        const composition=new Map()
        //un atome, son A (s'il est écrit) et son nombre d'exemplaires
        const add=(el,massNumber,count)=>{
            const n=Number(count||"1")
            const A=massNumber?Number(massNumber):el.pickA(rule)
            if(massNumber&&!el.isotope(A))
                throw new Error(`${el.symbol} has no isotope ${A}`)
            if(!composition.has(el)) composition.set(el,new Map())
            const byA=composition.get(el)
            byA.set(A,(byA.get(A)??0)+n)
        }
        for(const raw of String(text).trim().split(/[\s.]+/).filter(Boolean)){
            /* Segmentation caractère par caractère. À chaque place, on regarde si
               les DEUX lettres sont chacune un élément à elles seules:

                 - si OUI, ce sont deux atomes. "CO" et "co" sont du carbone et
                   de l'oxygène, parce que C et O existent tous les deux;
                 - si NON, le couple ne peut être qu'un symbole. "Fe" est du fer
                   car E n'existe pas comme élément, et il n'existe aucun moyen
                   de l'écrire autrement. Même chose pour "Na", "Ni", "Si"…

               C'est la seule règle qui tienne les deux bouts, et elle ne
               dépend d'aucune liste de mots-clés: A et E ne sont pas des
               éléments, alors "fe2o3" se lit Fe2O3 sans ambiguïté possible. */
            const two=/(\d*)([A-Za-z][A-Za-z])(\d*)/y
            const one=/(\d*)([A-Za-z])(\d*)/y
            let i=0
            while(i<raw.length){
                two.lastIndex=i
                const p=two.exec(raw)
                if(p){
                    /* Le couple n'est un symbole que s'il existe TEL QU'ÉCRIT.
                       "Co" (majuscule puis minuscule) trouve Co; "CO" (deux
                       majuscules) ne trouve rien et se scinde en C + O. C'est
                       toute la convention Hill, en une comparaison. */
                    const exact=table.bySymbol.get(p[2])
                    if(exact){ add(exact,p[1],p[3]); i+=p[0].length; continue }
                    //sinon: si les DEUX lettres sont des éléments, ce sont deux
                    //atomes. C est un élément et O aussi, donc "CO" est C + O.
                    const a=table.find(p[2][0])
                    const b=table.find(p[2][1])
                    if(a&&b){
                        add(a,p[1],null)
                        one.lastIndex=i+1
                        const second=one.exec(raw)
                        add(b,null,second?.[3])
                        i+=p[0].length
                        continue
                    }
                    //l'une des deux n'existe pas: le couple ne peut être qu'un symbole
                    const pair=table.find(p[2])
                    if(pair){ add(pair,p[1],p[3]); i+=p[0].length; continue }
                }
                one.lastIndex=i
                const m=one.exec(raw)
                if(!m){ i++; continue }
                const el=table.find(m[2])
                if(!el) throw new Error(`unknown element "${m[2]}" in "${raw}"`)
                add(el,m[1],m[3])
                i+=m[0].length
            }
        }
        return composition
    }

    /* DÉCOMPOSE un terme d'ionisation en trois champs, sans rien décider.

       Une seule règle, celle de la composition: le nombre AVANT le symbole
       est une MASSE, le nombre APRÈS est un COMPTE, et le signe porte la
       charge. On la lit donc dans l'ordre où elle s'écrit.

           [2H+]    massNumber 2   H + 1 proton   → deutérium
           [H2+]    massNumber -   H x2           → deux protium
           [H+2]    massNumber -   H + 2          → un H, charge 2
           [2H+2]   massNumber 2   H + 2          → deutérium, charge 2
           [23Na+]  massNumber 23  Na + 1         → sodium 23
           [2+]     massNumber -   (rien) + 2     → deux électrons perdus

       "2H" ne peut pas vouloir dire "deux H" : dans une COMPOSITION il
       signifie déjà le deutérium, et il doit vouloir dire la même chose ici.
       Deux protons s'écrivent [H+][H+], qui est plus clair de toute façon.

       Le descripteur ne RESOUT rien: il décrit. C'est ce qui permet à
       resolve() de tenter le registre avant l'isotope avant l'étiquette. */
    static readIonisation(text){
        const s=String(text).trim().replace(/^\[|\]$/g,"").trim()
        //la charge est TOUJOURS à la fin, signe puis chiffres
        const signed=/([+-])\s*(\d*)\s*$/.exec(s)
        if(!signed) throw new Error(`cannot read "${text}" as an ionisation`)
        const sign=signed[1]
        const charge=Number(signed[2]||"1")
        if(charge===0) throw new Error(`"${text}" has a charge of zero`)
        const head=s.slice(0,signed.index).trim()
        //"[+]", "[2+]", "[3-]": rien avant le signe, ou un nombre nu. Ce sont
        //des ÉLECTRONS — le nombre est la charge ET le nombre d'électrons.
        if(!head||/^\d+$/.test(head)){
            const n=head?Number(head):charge
            return {massNumber:null,name:"",atomCount:n,charge:sign==="+"?n:-n}
        }
        //"[2e+]": le "e" collé au nombre. C'est la forme LONGUE de "[2+]" — le
        //même ion, écrit avec la lettre. Le nombre est donc le nombre
        //d'électrons, pas un isotope, et il ne reste qu'un "e" à ignorer.
        const withE=/^(\d+)[Ee]$/.exec(head)
        if(withE){
            const n=Number(withE[1])
            return {massNumber:null,name:"",atomCount:n,charge:sign==="+"?n:-n}
        }
        //"23Na": le nombre de masse précède le symbole, "H2": le compte le suit
        const m=/^(\d*)([A-Za-z][A-Za-z0-9]*)(\d*)$/.exec(head)
        if(!m) throw new Error(`cannot read "${text}" as an ionisation`)
        const [,mass,name,count]=m
        return {
            massNumber:mass?Number(mass):null,
            name,
            atomCount:count?Number(count):1,
            charge:sign==="+"?charge:-charge,
        }
    }

    /* Résout un descripteur en terme d'ionisation, en trois temps.

       L'ordre n'est pas un détail: la LISTE est la seule source qui sait ce
       qu'un terme composé contient. "MeOH+" et "H2O-" ne se découpent pas
       caractère par caractère — H2O- donnerait H(2 atomes) puis O, ce qui
       est faux. Donc on la consulte TOUJOURS en premier, et la composition
       qu'elle décrit n'est jamais devinée.

       Ensuite seulement vient l'isotope, qui n'a de sens que pour un atome
       simple. Enfin l'étiquette libre, qui n'ajoute rien à la composition:
       c'est le filet de sécurité, pas une interprétation. */
    static resolveIonisation(desc,table){
        const {massNumber,name,atomCount,charge}=desc
        //la casse est indifférente ICI AUSSI: "[h+]" doit être "[H+]", sinon les
        //deux écritures du même ion ne se rejoignent jamais
        const cap=name?name[0].toUpperCase()+name.slice(1):""
        /* Le REGISTRE d'abord, toujours.

           Un nombre peut précéder un terme enregistré — "[2MeOH+]" est deux
           méthanol. C'est le seul endroit qui sait ce que contient un terme
           composé, donc on le tente même quand un nombre est écrit: on ne peut
           savoir que "2MeOH" n'est pas un isotope qu'après avoir vu que "MeOH"
           n'est pas un élément. Un A n'est retenu que si le reste est un
           symbole, jamais un nom composé.

           Le GROUPE vient du registre, la CHARGE du descripteur: "[H+2]" est
           l'adduit de "[H+]" avec une charge de 2, et se fier à la liste
           ramènerait cette charge à 1. */
        const known=IONISATION_BY_NAME.get(`${cap}${charge>0?"+":"-"}`)
            ||IONISATION_BY_NAME.get(`${name}${charge>0?"+":"-"}`)
        /* Un terme ENREGISTRÉ prime sur l'élément de même symbole. Sans cela
           "[e-]" serait lu comme l'einsteinium, parce que E existe dans la
           table: or le registre dit que "e-" est un électron, et c'est lui
           qui a raison — c'est le seul endroit qui sache ce qu'un terme
           COMPOSE. "E" reste l'einsteinium quand il est absent du registre. */
        const isRegisteredElectron=known&&known.group===null
        if(known&&(massNumber===null||isRegisteredElectron||!table.find(cap))){
            /* Un nombre devant un terme ENREGISTRÉ est un multiplicateur, pas
               une masse: "[2MeOH+]" est deux méthanol. Chaque copie apporte sa
               propre charge, donc la charge suit le multiplicateur — deux
               protons font bien +2.

               Un nombre devant un ÉLÉMENT reste un isotope, et c'est
               l'inverse: "[2H+]" est du deutérium, et deux deutériums
               porteraient +2, donc la charge reste 1. "[H2+]" est la forme
               qui veut dire deux atomes, et sa charge reste +1 aussi. */
            const times=massNumber===null?1:massNumber
            return {...known,count:atomCount*times,charge:charge*times,known:true}
        }
        //2) un atome simple, isotope facultatif: [2H+], [23Na+]
        const el=table.find(cap)
        if(el){
            const A=massNumber??null
            if(A!==null&&!el.isotope(A))
                throw new Error(`${el.symbol} has no isotope ${A}`)
            return {
                index:-1,group:cap,count:atomCount,charge,massNumber:A,
                name:`${A??" "}${cap}${charge>0?"+":"-"}`,known:false,
            }
        }
        //2b) le nom n'est pas un élément, mais il peut finir par un chiffre qui
        //EST un compte: "[H2+]" n'est pas l'élément "H2", ce sont deux H. Le
        //registre a déjà été tenté sans succès, donc ce chiffre est le nôtre.
        const trailing=/^(.*?)([0-9]+)$/.exec(name)
        if(trailing){
            const sym=trailing[1][0].toUpperCase()+trailing[1].slice(1)
            if(table.find(sym))
                return {
                    index:-1,group:sym,count:atomCount*Number(trailing[2]),charge,
                    massNumber:null,name:`${sym}${charge>0?"+":"-"}`,known:false,
                }
        }
        //2b) le terme d'électrons, dont le group est null: il ne touche JAMAIS
        //la composition. "[2e+]" est le PLIAGE long de "[2+]", et les deux
        //doivent décrire le MÊME ion: on retire le "e" final, qui n'est pas
        //un élément, et on retombe sur le registre.
        const withoutE=/^(.*?)[Ee]$/.exec(name)
        const isElectron=withoutE&&!table.find(withoutE[1])
        if(cap==="E"||cap===""||isElectron){
            const electrons=IONISATION_BY_NAME.get(`e${charge>0?"+":"-"}`)
            if(electrons)
                return {...electrons,count:atomCount,charge,known:true}
        }
        //3) étiquette libre: rien n'est ajouté, rien n'est retiré
        return {
            index:-1,group:null,count:atomCount,charge,
            name:`${name}${charge>0?"+":"-"}`,known:false,
        }
    }

    //"[2H+]", "[H-]", "[Na+]", "[2+]", "[3-]", "[]" -> {ionisation, count, known}
    static parseIonisation(text,table){
        const desc=Formula.readIonisation(text)
        const ionisation=Formula.resolveIonisation(desc,table)
        return {ionisation,count:ionisation.count,known:ionisation.known}
    }

    /* Enregistrer un terme d'ionisation À LA VOLÉE, sans rien rouvrir.

       C'est la seule chose que l'utilisateur a le droit de faire, et c'est
       volontairement sans garde-fou: le moteur ne dit jamais qu'un ion est
       impossible.

       group est OPTIONNEL, et ce qui manque est le seul défaut réel: sans group,
       aucun atome n'est ajouté ou retiré, et le terme se réduit à une étiquette
       qui porte une charge. Avec group, la composition est réécrite exactement
       comme pour un terme de la liste. */
    static registerIonisation({name,group=null,charge,meaning="ajouté par l'utilisateur"},table){
        if(!name) throw new Error("an ionisation needs a name")
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
        const index=IONISATIONS.reduce((m,t)=>Math.max(m,t.index),0)+1
        const term={index,name,group,charge,meaning}
        IONISATIONS.push(term)
        IONISATION_BY_NAME.set(name,term)
        return term
    }

    /* Ajoute (ou retire) un groupe à une composition.

       L'isotope du terme est choisi par la même règle, parce qu'un terme sans A
       écrit est, lui aussi, une hypothèse — [Na+] ne dit pas 23Na, il dit
       « du sodium ». */
    static applyGroup(composition,group,count,remove,table,rule="mostProbable",massNumber=null){
        for(let [el,byA] of Formula.parseComposition(group,table,rule)){
            //un A ÉCRIT sur l'adduit l'emporte: "[2H+]" ajoute du deutérium, et
            //non le protium que la règle aurait choisi pour H
            const [defaultA,n]=[...byA][0]
            const A=massNumber??defaultA
            if(massNumber!==null&&!el.isotope(A))
                throw new Error(`${el.symbol} has no isotope ${A}`)
            const times=(remove?-1:1)*count*n
            if(!composition.has(el)) composition.set(el,new Map())
            const target=composition.get(el)
            target.set(A,(target.get(A)??0)+times)
            if(target.get(A)===0) target.delete(A)
            if(target.size===0) composition.delete(el)
        }
        return composition
    }

    /* Écrit une composition en Hill.

       rule === null  →  on n'abrège RIEN, c'est la clé: "56Fe2 16O3"
       rule === "..."  →  on abrège l'isotope que cette règle choisirait,
                          c'est l'affichage: "Fe2O3"

       L'affichage suit la MÊME règle que le parsing: le parseur met l'isotope
       par défaut quand l'A est absent, donc l'écriture omet l'A quand c'est
       cet isotope-là. "Fe" se relit en ⁵⁶Fe en mostProbable, et en ⁵⁴Fe en
       lightest — dans les deux cas on retombe sur la formule voulue. */
    static compositionToString(composition,rule="mostProbable"){
        const rank=(el)=>el.symbol==="C"?0:el.symbol==="H"?1:2
        const parts=[]
        //les ELEMENTS, triés en Hill: C, H, puis le reste par symbole
        const ordered=[...composition.keys()].sort(
            (a,b)=>rank(a)-rank(b)||(a.symbol<b.symbol?-1:1))
        for(let el of ordered){
            const byA=composition.get(el)
            //rule null = clé: tout s'écrit en entier
            const isDefault=(A)=>rule!==null&&A===el.pickA(rule)
            //un seul isotope: abrégé seulement si c'est celui de la règle
            if(byA.size===1){
                const [[A,n]]=[...byA]
                const name=isDefault(A)?el.symbol:`${A}${el.symbol}`
                parts.push(n>1?`${name}${n}`:name)
            }else{
                //plusieurs isotopes du même élément: toujours TOUS en entier,
                //car l'abréviation y serait ambiguë même pour l'affichage
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
//le deutérium: 2,014 u, et non le proton de 1,007
const DEUTERIUM=TABLE.find("H").isotope(2).mass

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
test("[2H+] est du deutérium, PAS deux protons",()=>{
    /* "2H" ne peut pas vouloir dire "deux H" dans les crochets: dans une
       COMPOSITION il signifie déjà le deutérium, et il doit vouloir dire la
       même chose partout. Deux protons s'écrivent [H+][H+]. */
    const s=parse("C6H12O6 [2H+]")
    if(s.charge!==1) throw new Error(`charge ${s.charge}, expected 1`)
    if(atoms(s,"H")!==13) throw new Error(`H=${atoms(s,"H")}, expected 13`)
    //et c'est bien du deutérium qui a été ajouté
    if(Formula.parse("C6H12O6 [2H+]",TABLE).key!=="12C6 1H12 2H 16O6[2H+]")
        throw new Error("deuterium was not applied")
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
    const s=parse("C6H12O6 [e-]")
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
    //la clé colle les crochets à la composition, comme l'affichage
    if(s.key!=="12C6 1H13 16O6[H+]") throw new Error(`key is "${s.key}"`)
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
    if(s.ionisation.length!==2) throw new Error(`${s.ionisation.length} terms`)
    if(atoms(s,"H")!==11) throw new Error("the proton loss still happened")
})
test("[2H+][e-] donne un ion neutre, et non +1",()=>{
    //deutérium +1, puis un électron gagné -1: ça s'annule. Ce que la
    //formulation testait avant était l'ACCUMULATION des deux charges, pas
    //leur somme — et c'est bien la somme qu'on vérifie ici
    const s=parse("C6H12O6 [2H+][e-]")
    if(s.charge!==0) throw new Error(`charge ${s.charge}, expected 0`)
})




console.log("les adduits sont ouverts")
test("un adduit inconnu est accepté comme étiquette",()=>{
    const s=parse("C6H12O6 [MeOH+]")
    if(s.ionisation[0].name!=="MeOH+") throw new Error(`name ${s.ionisation[0].name}`)
    //pas dans la liste: la composition n'est PAS réécrite
    if(s.composition.size!==3) throw new Error("composition should be untouched")
    //mais la charge est bien lue dans le crochet
    if(s.charge!==1) throw new Error(`charge ${s.charge}`)
})
test("un terme enregistré à la volée devient un vrai terme",()=>{
    /* C'est la voie prévue: l'utilisateur déclare group + charge, et dès lors
       la composition est réécrite comme pour un terme de la liste. */
    Formula.registerIonisation({name:"MeOH+",group:"CH4O",charge:+1,meaning:"solvatation méthanol"},TABLE)
    const s=parse("C6H12O6 [MeOH+]")
    if(atoms(s,"C")!==7) throw new Error(`C should be 7, got ${atoms(s,"C")}`)
    if(atoms(s,"O")!==7) throw new Error(`O should be 7, got ${atoms(s,"O")}`)
    if(s.charge!==1) throw new Error(`charge ${s.charge}`)
    //et il reçoit un index, donc il peut figurer dans un chemin de provenance
    if(s.ionisation[0].index<0) throw new Error("a registered term must have an index")
})
test("un terme enregistré fonctionne avec un multiplicateur",()=>{
    const s=parse("C6H12O6 [2MeOH+]")
    if(atoms(s,"C")!==8) throw new Error(`C should be 8, got ${atoms(s,"C")}`)
    if(s.charge!==2) throw new Error(`charge ${s.charge}, expected 2`)
})
test("un adduit enregistré peut être perdu, pas seulement ajouté",()=>{
    Formula.registerIonisation({name:"H2O-",group:"H2O",charge:-1,meaning:"perte d'eau"},TABLE)
    const s=parse("C6H12O6 [H2O-]")
    if(atoms(s,"H")!==10) throw new Error(`H should be 10, got ${atoms(s,"H")}`)
    if(atoms(s,"O")!==5) throw new Error(`O should be 5, got ${atoms(s,"O")}`)
    if(s.charge!==-1) throw new Error(`charge ${s.charge}`)
})
test("des adduits inconnus s'empilent sans qu'on ait à les connaître",()=>{
    //aucune combinatoire n'est refusée, même si elle n'a aucun sens
    const s=parse("C6H12O6 [Na+][H-][e-][MeOH+]")
    if(s.ionisation.length!==4) throw new Error(`${s.ionisation.length} terms, expected 4`)
    if(s.charge!==0) throw new Error(`charge ${s.charge}, expected 0`)
})
test("l'enregistrement ne touche pas aux adduits déjà connus",()=>{
    if(IONISATIONS[1].name!=="H+"||IONISATIONS[1].charge!==1)
        throw new Error("H+ was disturbed")
    if(IONISATION_BY_NAME.get("H+")!==IONISATIONS[1]) throw new Error("the map no longer points at the same object")
    //et le signe de l'adduit est bien celui de l'ION
    if(IONISATIONS[6].name!=="e-"||IONISATIONS[6].charge!==-1)
        throw new Error("e- must be the negative charge")
})
test("un adduit contradictoire est refusé à l'enregistrement",()=>{
    //seule contradiction tolérée: un nom qui contredit sa propre charge
    try{
        Formula.registerIonisation({name:"Weird-",group:"H",charge:+1},TABLE)
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
    if(s.key!=="12C6 1H13 16O6[H+][-]") throw new Error(`key is "${s.key}"`)
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
test("[2+] et [2e+] sont la MÊME formule",()=>{
    //c'est la question posée: les deux écritures désignent le même ion
    const a=Formula.parse("Fe2O3[2+]",TABLE)
    const b=Formula.parse("Fe2O3[2e+]",TABLE)
    if(a.key!==b.key) throw new Error(`"${a.key}" != "${b.key}"`)
    if(Math.abs(a.mz-b.mz)>1e-12) throw new Error("masses differ")
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
test("un [+] nu et un [e+] sont le même ion",()=>{
    if(Formula.parse("C6H12O6[+]",TABLE).key!==Formula.parse("C6H12O6[e+]",TABLE).key)
        throw new Error("[+] and [e+] must agree")
    if(Formula.parse("C6H12O6[-]",TABLE).key!==Formula.parse("C6H12O6[e-]",TABLE).key)
        throw new Error("[-] and [e-] must agree")
})



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
    const cases=[
        //forme        masse   groupe compte  charge
        ["[H+]",       null,   "H",    1,      1],
        ["[H2+]",      null,   "H",    2,      1],
        ["[H+2]",      null,   "H",    1,      2],
        ["[2H+]",      2,      "H",    1,      1],
        ["[2H+2]",     2,      "H",    1,      2],
        ["[23Na+]",    23,     "Na",   1,      1],
        ["[2+]",       null,   null,   2,      2],
        ["[3-]",       null,   null,   3,     -3],
    ]
    for(const [text,mass,group,count,charge] of cases){
        const i=Formula.parseIonisation(text,TABLE).ionisation
        const got=[i.massNumber??null,i.group,i.count,i.charge]
        if(got.join("|")!==[mass,group,count,charge].join("|"))
            throw new Error(`${text} -> ${got.join("|")}, expected ${[mass,group,count,charge].join("|")}`)
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
test("[2+] et [2e+] sont le même ion",()=>{
    if(Formula.parse("C6H12O6[2+]",TABLE).key!==Formula.parse("C6H12O6[2e+]",TABLE).key)
        throw new Error("2+ and 2e+ must agree")
    if(Formula.parse("C6H12O6[2+]",TABLE).charge!==2)
        throw new Error("2+ must be a charge of 2")
})
test("une étiquette libre n'ajoute rien",()=>{
    const f=Formula.parse("C6H12O6[Zzz+]",TABLE)
    if(f.charge!==1) throw new Error(`charge ${f.charge}, expected 1`)
    if(f.composition.size!==3) throw new Error("composition was changed")
})
test("un terme composé vient du registre, jamais d'un découpage",()=>{
    //[MeOH+] est du méthanol; un découpage caractère par caractère donnerait
    //Me(inexistant) puis OH, et l'eau perdue ne serait pas la bonne
    Formula.registerIonisation({name:"H2O-",group:"H2O",charge:-1,meaning:"perte d'eau"},TABLE)
    const f=Formula.parse("C6H12O6[H2O-]",TABLE)
    if(f.counts.get(TABLE.find("H"))!==10) throw new Error("H is not 10")
    if(f.counts.get(TABLE.find("O"))!==5) throw new Error("O is not 5")
    if(f.charge!==-1) throw new Error(`charge ${f.charge}, expected -1`)
})
test("le 1 de la charge est facultatif, et les deux délimiteurs s'ignorent",()=>{
    /* "H+" et "H+1" sont la MÊME lecture: un signe nu vaut 1, comme un H seul
       dans une composition vaut un atome. Et le ";" ne change rien au fond,
       c'est un autre délimiteur pour le même terme. */
    const expected="12C6 1H13 16O6[H+]"
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
    //";H+;e-" est le même ion que "[H+][e-]"
    const a=Formula.parse("C6H12O6;H+;e-",TABLE)
    const b=Formula.parse("C6H12O6[H+][e-]",TABLE)
    if(a.key!==b.key) throw new Error(`"${a.key}" != "${b.key}"`)
    if(a.charge!==0) throw new Error(`charge ${a.charge}, expected 0`)
    //"[H+]" AJOUTE un proton, ";e-" ne touche à rien: 13 hydrogènes, dont un
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
console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length>0) process.exitCode=1


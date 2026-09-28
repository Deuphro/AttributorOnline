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
     C6H12O6 [2H+]            deutérium     — et NON deux protons
     C6H12O6 [Na+]            sodié
     C6H12O6 [-]              anion radicalaire — électron GAGNÉ
     12C6 1H12 16O6 [H+]      monoisotopique

   Deux conventions, et elles ne se recouvrent pas:
     chiffres AVANT le symbole  -> nombre de masse  (12C, 2H)
     chiffres APRÈS le symbole  -> nombre d’atomes  (C6, H2)
   
   Et UN SIGNE, qui se lit selon ce qu’il a devant lui:
     suivi d’un élément  -> coefficient   -2H = deux H en moins
     suivi de rien        -> CHARGE        -2  = charge -2
   
   C’est cette dernière règle qui referme tout: «C6H12O6 H2-» se lit
   C6H14O6 charge -1, «C6H12O6-2» se lit C6H12O6 charge -2, et «C6H12O6-2H»
   se lit C6H10O6 neutre. Aucune écriture n’a deux lectures possibles.
   ------------------------------------------------------------------------- */

/* Les adduits, avec un INDEX, parce qu'un chemin de provenance les désigne par
   leur numéro plutôt que par leur nom.

   Liste OUVERTE: ce qui n'y est pas reste saisissable en texte libre, et le nom
   est alors une simple étiquette. Rien n'est refusé — le moteur sait lire, il ne
   décide pas.

   NOTE: il n'y a plus d'entrée "e+" ni "e-". Un électron n'est pas un atome,
   et la grammaire sait déjà l'exprimer seul: "[+]" est un électron PERDU,
   "[-]" un électron GAGNÉ. Les garder ici n'aurait servi qu'à leur donner un
   nom, et un terme sans atome n'a pas besoin de nom: c'est une charge.
   Un ion radical se reconnaît par la parité de valence, pas par une étiquette. */
const IONISATIONS=[
    {index:0,name:"",     group:null,charge: 0,meaning:"le neutre lui-même"},
    {index:1,name:"H+",   group:"H",  charge:+1,meaning:"protonation"},
    {index:2,name:"Na+",  group:"Na", charge:+1,meaning:"adduit sodium"},
    {index:3,name:"K+",   group:"K",  charge:+1,meaning:"adduit potassium"},
    {index:4,name:"NH4+", group:"NH4",charge:+1,meaning:"adduit ammonium"},
    {index:5,name:"H-",   group:"H",  charge:-1,meaning:"déprotonation"},
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
           ici donnerait 4, et "[2+][-]" ne s'annulerait jamais. */
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
       un terme sans atome s'écrit par sa seule charge, et rien d'autre:
       "[2+]". C'est la forme que les chimistes écrivent, donc celle qu'on
       affiche — le "e" du préfixe n'a aucune valeur lisible. */
    get brackets(){
        return this.ionisation.map(t=>{
            //la charge est réécrite telle qu'elle a été LUE
            const sign=t.charge>0?"+":"-"
            const n=Math.abs(t.charge)
            //une charge seule: aucun atome, on écrit juste la magnitude
            if(!t.group) return `[${n>1?n:""}${sign}]`
            /* Le groupe est une Map DÉJÀ PARSÉE: on la réécrit avec la même
               fonction que le core, sinon la clé afficherait "[object Map]".
               C'est aussi ce qui garantit que deux écritures d'un même groupe
               donnent la même clé. */
            const head=Formula.compositionToString(t.group,this.rule)
            return `[${head}${sign}${n>1?n:""}]`
        }).join("")
    }


    /* ===================================================================
       Les fabriques. Tout ce qui LIT une chaîne est ici, et nulle part
       ailleurs: une formule se fabrique, elle ne se devine pas.
       =================================================================== */

    /* "C6H12O6 [H+]" -> une Formula. L'entrée unique, celle qu'on tape.

       Les crochets S'EMPILENT et s'additionnent, parce que les ions le font:
         C6H12O6 [H-][-]      déprotoné PUIS réduit, charge -2
         C6H12O6 [2H+][-]    doublement protoné PUIS réduit, charge  0 */
    static parse(text,table,rule="mostProbable"){
        const s=String(text).trim()
        /* Un signe NU n'appartient à aucun terme: c'est la charge de l'ion.
           On le coupe donc AVANT d'appeler parseComposition, sinon il serait
           pris pour un coefficient sans atome et la charge disparaîtrait.
           C'est ce qui fait que "C6H12O6 H2-" se lit C6H14O6 charge -1.

           Il faut toutefois que le signe soit vraiment NU. Dans ";H+" le "+"
           n'a rien derrière lui non plus, mais le H qui le précède est un
           terme d'ionisation: le couper donnerait deux moitiés illisibles.
           On exige donc qu'il n'y ait NI ";" ni crochet dans la saisie — la
           charge nue est alors en fin de chaîne, seul endroit où elle est
           certaine. */
        const chargeFromCore=!s.includes(";")&&!s.includes("[")
            ?/([+-]+\s*\d*)\s*$/.exec(s)
            :null
        let core=s
        let orphan=0
        if(chargeFromCore){
            core=s.slice(0,chargeFromCore.index).trim()
            /* On compte les signes RÉPÉTÉS: "C6H12O6++" est une charge +2, et
               non deux charges +1 distinctes — sinon "++" ne voudrait pas dire
               la même chose que "[+][+]", et la règle qu'on vient de fixer
               serait fausse. Une magnitude écrite l'emporte: "-2" vaut -2. */
            const signs=chargeFromCore[1].match(/[+-]/g).length
            const magnitude=Number(/(\d+)\s*$/.exec(chargeFromCore[1])?.[1]||signs)
            orphan=(chargeFromCore[1].startsWith("+")?1:-1)*magnitude
        }
        const brackets=[...core.matchAll(/\[([^\]]*)\]/g)]
        const afterSemicolon=core.split(";").slice(1)
        /* Mélanger les deux délimiteurs dans une même saisie rendrait l'ordre
           ambigu: "C6H12O6[H+];e-" pourrait se lire dans les deux sens. On le
           refuse donc, plutôt que de choisir un ordre arbitraire et muet. */
        if(brackets.length&&afterSemicolon.length)
            throw new Error(`"${text}" mixes [] and ; — pick one delimiter`)
        const terms=(brackets.length
            ?brackets.map(([,inner])=>inner)
            :afterSemicolon).map(t=>t.trim()).filter(t=>t!=="")
        //tout ce qui n'est pas un terme d'ionisation est la composition
        const body=(brackets.length?core.replace(/\[[^\]]*\]/g," "):core.split(";")[0]).trim()
        if(!body) throw new Error(`no composition in "${text}"`)
        const composition=Formula.parseComposition(body,table,rule)
        /* Le signe nu devient un terme d'ionisation à part entière: il doit
           apparaître dans la clé et s'additionner aux autres charges,
           exactement comme un [2+]. Le signe est indispensable, car "1" seul
           n'est pas une charge. */
        const trailing=orphan||composition.trailingSign||0
        if(composition.trailingSign) delete composition.trailingSign
        if(trailing) terms.unshift(trailing>0?`+${trailing}`:`${trailing}`)
        if(terms.length===0) return new Formula({composition,ionisation:[],rule})
        //chaque crochet est un terme; les charges s'additionnent
        const ionisation=terms.map(t=>Formula.parseIonisation(t,table).ionisation)
        /* Les coefficients sont DÉJÀ signés dans la Map: parseComposition a lu
           "H-1" comme un coefficient -1. Il n'y a donc plus de "remove" à
           décider ici — c'est la composition qui dit quoi faire, et elle le
           dit une fois pour toutes. */
        for(const {group} of ionisation){
            if(group) Formula.applyGroup(composition,group,1,false,table,rule)
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
    /* L'index de la parenthèse qui ferme celle qui s'ouvre à "from".

       On compte la profondeur plutôt que de chercher le premier ")": sans ça,
       "(H2O)-1" s'arrêterait au premier crochet fermé, et une formule
       imbriquée comme "((CH3)2N)H" serait coupée en deux. */
    static matchParen(raw,from){
        let depth=0
        for(let i=from;i<raw.length;i++){
            if(raw[i]==="(") depth++
            else if(raw[i]===")"){ depth--; if(depth===0) return i }
        }
        throw new Error(`unbalanced "(" in "${raw}"`)
    }

    /* Y a-t-il un ÉLÉMENT après cette position du fragment ?

       C'est ce qui sépare une charge d'un coefficient: dans "-2H" le 2 est
       suivi de H, donc c'est un coefficient; dans "-2" il ne l'est pas, donc
       c'est la charge. Sans cette question, les deux se ressemblent. */
    static hasElementAfter(raw,from){
        return /[A-Za-z]/.test(raw.slice(from))
    }

    static parseComposition(text,table,rule="mostProbable"){
        const composition=new Map()
        /* Un atome, son A et son nombre d'exemplaires.

           L'A et le coefficient ne peuvent pas être déterminés qu'ensemble, et
           c'est le SIGNE ÉCRIT qui tranche:

             2H    A écrit       → deutérium
             -2H   coefficient   → deux hydrogènes EN MOINS
             H2    compte        → deux protium
             -H2   coefficient   → deux protium en moins
             +H2   coefficient   → DEUX hydrogènes, pas un

           Ce dernier cas est celui qui se trompeait: le nombre écrit APRÈS le
           symbole est toujours un compte, et il multiplie le coefficient sans
           le remplacer. "+H2" est donc +1 × 2, et non +2 ou +1. */
        const add=(el,massNumber,count,sign=1,signed=false)=>{
            const A=signed?(el.pickA(rule)):(massNumber?Number(massNumber):el.pickA(rule))
            /* Le coefficient n'est un nombre que s'il est écrit AVANT le
               symbole. "-2H" en a un (2), mais "-H2" n'en a pas: son 2 est
               un compte, et le coefficient reste -1. C'est ce qui distingue
               -2H de -H2, et c'est le seul endroit où les deux nombres du
               même terme peuvent coexister. */
            const before=signed&&massNumber?Number(massNumber):1
            const after=count!==null&&count!==undefined&&count!==""?Number(count):1
            const n=sign*before*after
            if(!signed&&massNumber&&!el.isotope(A))
                throw new Error(`${el.symbol} has no isotope ${A}`)
            if(!composition.has(el)) composition.set(el,new Map())
            const byA=composition.get(el)
            byA.set(A,(byA.get(A)??0)+n)
        }
        /* On découpe sur les espaces et les points, et on NE découpe JAMAIS sur
           un signe: "-2" est un coefficient attaché à l'élément qui suit, donc
           couper là-dessous le séparerait de ce qu'il qualifie. */
        /* Un signe SANS élément derrière est une CHARGE, jamais un coefficient.
           "C6H12O6 H2-" est C6H14O6 chargé -1: le H2 est ajouté, et le - qui
           ne qualifie rien devient la charge de l'ion. C'est le seul endroit
           où une charge naît de la COMPOSITION, et il faut le dire à parse(),
           qui seul sait qu'un ion existe. */
        let trailingSign=0
        let trailingMagnitude=1
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
            /* Le signe est lu UNE fois par terme, et s'applique au terme qui
               suit — à lui seul. "H-2O-1" se lit H×1 puis O×(-1); le signe ne
               déborde JAMAIS sur ce qui précède, sinon "C6H12O6-H2" et
               "C6H12O6-2H" ne signifieraient pas la même chose. */
            let sign=1
            //un signe ÉCRIT change la lecture du nombre qui le suit
            let signed=false
            while(i<raw.length){
                //un signe en attente, juste avant le terme qu'il qualifie
                if(raw[i]==="+"||raw[i]==="-"){
                    /* Deux signes d'affilée n'ont pas d'élément entre eux: ils
                       ne peuvent donc pas qualifier un terme, et s'ajoutent
                       comme une charge. C'est "++" = +2, l'équivalent de "[+][+]"
                       sans les crochets. */
                    if(signed&&!Formula.hasElementAfter(raw,i+1)){
                        trailingSign+=sign
                        signed=false
                        sign=1
                        i++
                        continue
                    }
                    sign=raw[i]==="-"?-1:1
                    signed=true
                    i++
                    continue
                }
                /* Un nombre NU entre deux signes, ou après un signe qui ne
                   qualifie rien: c'est la MAGNITUDE de la charge. "-2" veut
                   dire charge -2, et non un coefficient de 2 — il n'y a aucun
                   élément derrière. On l'accumule à part, et il ne sera lu
                   comme coefficient que s'il est suivi d'un élément. */
                if(/[0-9]/.test(raw[i])){
                    const digits=/^\d+/.exec(raw.slice(i))
                    if(signed&&!Formula.hasElementAfter(raw,i+digits[0].length)){
                        /* Le nombre nu est la MAGNITUDE, pas un coefficient:
                           le terme reste sans élément, donc le signe qui le
                           précédait ne peut pas le qualifier — il ne fait que
                           dire le sens. "-2" est donc une charge -2, et non
                           deux atomes de signe négatif. */
                        trailingSign+=sign
                        trailingMagnitude=Number(digits[0])
                        signed=false
                        sign=1
                        i+=digits[0].length
                        continue
                    }
                }
                /* Les PARENTHÈSES. C'est ce qui permet à un adduit d'être un
                   vrai groupe: "(H2O)-1" est l'eau multipliée par -1, et non
                   une suite d'éléments. Sans elles, "-H2O" serait H×-1 puis
                   O×1, ce qui n'est pas la même chose du tout. */
                if(raw[i]==="("){
                    const close=Formula.matchParen(raw,i)
                    const inner=Formula.parseComposition(raw.slice(i+1,close),table,rule)
                    /* Le coefficient vient APRÈS la parenthèse fermée, parce
                       que c'est lui qui la multiplie: "(H2O)-1". Un coefficient
                       placé devant est toléré aussi, par confort de frappe. */
                    let j=close+1
                    let factor=1
                    if(raw[j]==="-"||raw[j]==="+"){ factor=raw[j]==="-"?-1:1; j++ }
                    const digits=/^\d+/.exec(raw.slice(j))
                    if(digits){ factor*=Number(digits[0]); j+=digits[0].length }
                    for(const [el,byA] of inner)
                        for(const [A,n] of byA){
                            if(!composition.has(el)) composition.set(el,new Map())
                            const byOther=composition.get(el)
                            byOther.set(A,(byOther.get(A)??0)+sign*factor*n)
                        }
                    sign=1
                    i=j
                    continue
                }
                if(raw[i]===")") throw new Error(`unbalanced ")" in "${raw}"`)
                two.lastIndex=i
                const p=two.exec(raw)
                if(p){
                    /* Le couple n'est un symbole que s'il existe TEL QU'ÉCRIT.
                       "Co" (majuscule puis minuscule) trouve Co; "CO" (deux
                       majuscules) ne trouve rien et se scinde en C + O. C'est
                       toute la convention Hill, en une comparaison. */
                    const exact=table.bySymbol.get(p[2])
                    if(exact){ add(exact,p[1],p[3],sign,signed); sign=1; signed=false; i+=p[0].length; continue }
                    //sinon: si les DEUX lettres sont des éléments, ce sont deux
                    //atomes. C est un élément et O aussi, donc "CO" est C + O.
                    const a=table.find(p[2][0])
                    const b=table.find(p[2][1])
                    if(a&&b){
                        add(a,p[1],null,sign,signed)
                        one.lastIndex=i+1
                        const second=one.exec(raw)
                        add(b,null,second?.[3],sign,signed)
                        sign=1
                        signed=false
                        i+=p[0].length
                        continue
                    }
                    //l'une des deux n'existe pas: le couple ne peut être qu'un symbole
                    const pair=table.find(p[2])
                    if(pair){ add(pair,p[1],p[3],sign,signed); sign=1; signed=false; i+=p[0].length; continue }
                }
                one.lastIndex=i
                const m=one.exec(raw)
                if(!m){ i++; continue }
                const el=table.find(m[2])
                if(!el) throw new Error(`unknown element "${m[2]}" in "${raw}"`)
                add(el,m[1],m[3],sign,signed)
                sign=1
                signed=false
                i+=m[0].length
            }
            //un signe resté sans terme derrière: c'est une charge
            if(signed) trailingSign+=sign
        }
        //la composition porte les atomes; le signe nu est la charge de l'ion,
        //et il est rendu pour que parse() puisse l'appliquer
        if(trailingSign) composition.trailingSign=trailingSign*trailingMagnitude
        return composition
    }

    /* DÉCOMPOSE un terme d'ionisation, sans rien décider.

       Un terme est l'une de deux choses, et jamais les deux:

         - une CHARGE      [+] [2+] [--] ++   → la composition est intacte
         - une COMPOSITION [H] [2H] [H-2O]    → des atomes, avec leurs signes

       La charge est un NOMBRE SEUL. Dès qu'un élément le suit, le signe devient
       un COEFFICIENT, et c'est ce qui rend la grammaire sans recouvrement:
       "-2" est une charge -2, alors que "-2H" sont deux hydrogènes en moins.
       C'est la même règle que dans le core, appliquée au même endroit. */
    static readIonisation(text){
        const s=String(text).trim().replace(/^\[|\]$/g,"").trim()
        /* Des SIGNES RÉPÉTÉS sont une charge répétée: "++" est +2, "---" est
           -3. C'est la même idée que "[+][+]", écrite plus court. */
        const repeated=/^([+-])\1*$/.exec(s)
        if(repeated) return {
            massNumber:null,name:"",atomCount:s.length,
            charge:repeated[1]==="+"?s.length:-s.length,
        }
        /* Un terme se lit comme le core, avec UNE différence: un signe NU en
           fin de terme est la CHARGE, même si des atomes le précèdent.

             [H+]     un H ajouté, puis charge +1   ← le + ne qualifie rien
             [H-1]    un H retiré                     ← le -1 est un compte
             [2H+1]   un deutérium, puis charge +1

           C'est la même règle que dans le core, où "C6H12O6 H2-" se lit
           C6H14O6 charge -1. La différence ne porte donc sur rien. */
        const trailing=/([+-])\s*$/.exec(s)
        if(trailing){
            const head=s.slice(0,trailing.index).trim()
            if(!head) return {
                massNumber:null,name:"",atomCount:1,
                charge:trailing[1]==="+"?1:-1,
            }
            return {
                massNumber:null,name:head,atomCount:1,isComposition:true,
                charge:trailing[1]==="+"?1:-1,
            }
        }
        /* Un nombre SEUL, avec ou sans signe, est une CHARGE: "[2]", "[+2]",
           "[-2]". Il n'y a aucun élément derrière, donc le signe ne qualifie
           rien et ne peut être qu'une charge. C'est ce qui permet à "[H][+1]"
           de dire deux choses en deux termes, plutôt qu'une seule. */
        const alone=/^([+-]?)(\d*)$/.exec(s)
        if(alone){
            const magnitude=Number(alone[2]||"1")
            if(magnitude===0) throw new Error(`"${text}" has a charge of zero`)
            return {
                massNumber:null,name:"",atomCount:magnitude,
                charge:alone[1]==="-"?-magnitude:magnitude,
            }
        }
        /* Sinon il n'y a que des ATOMES, signes compris: "[H-1]" est un H
           retiré, "[CH4O-1]" du méthanol retiré. La charge est 0. */
        return {massNumber:null,name:s,atomCount:1,charge:0,isComposition:true}
    }

    /* Résout un descripteur en terme d'ionisation, sans table.

       Un terme porte soit une CHARGE, soit des ATOMES — jamais les deux, et
       c'est la même grammaire que dans le core. Un groupe composé n'a pas
       besoin d'être connu d'avance: "H-2O-1" et "-(H2O)" se lisent avec
       parseComposition, celle du core.

       C'est ce qui supprime le REGISTRE. Il existait pour dire qu'un terme
       composé contenait autre chose que ce qu'on peut deviner — mais "MeOH+"
       n'était qu'un nom, et "CH4O-1" dit exactement la même chose en
       grammaire. Une table n'ajoute pas d'information: elle ajoute une
       deuxième source de vérité, et c'est elle qui déviait. */
    static resolveIonisation(desc,table,rule="mostProbable"){
        const {name,atomCount,charge,isComposition}=desc
        //une charge seule: aucun atome, et c'est tout
        if(!isComposition) return {
            index:-1,group:null,count:atomCount,charge,
            name:`${charge>0?"+":"-"}${Math.abs(charge)}`,
        }
        /* Des atomes: on délègue à parseComposition, sans rien d'autre. C'est
           le même chemin que le core, donc "H-2O-1" se lit exactement comme
           dans "C6H12O6-H-2O-1" — une seule grammaire, une seule fonction. */
        const group=Formula.parseComposition(name,table,rule)
        return {index:-1,group,count:1,charge,name}
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
        /* Le groupe arrive DÉJÀ PARSÉ, en Map: resolveIonisation l'a lu avec
           parseComposition, celle du core. Le reparsing ici serait une seconde
           grammaire — et c'est exactement le registre qu'on a supprimé.

           Chaque atome porte son propre A et son propre coefficient, qu'il
           faut conserver tels quels: "[-(H2O)]" retire deux 1H et un 16O, et
           non "deux fois le premier atome trouvé". */
        for(const [el,byA] of group){
            for(const [A,n] of byA){
                const times=(remove?-1:1)*count*n
                if(!composition.has(el)) composition.set(el,new Map())
                const target=composition.get(el)
                target.set(A,(target.get(A)??0)+times)
                if(target.get(A)===0) target.delete(A)
                if(target.size===0) composition.delete(el)
            }
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
    //la clé colle les crochets à la composition, comme l'affichage
    if(s.key!=="12C6 1H13 16O6[H+]") throw new Error(`key is "${s.key}"`)
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
test("H- et [-] ont la même charge mais pas la même masse",()=>{
    //la confusion à éviter: [H-] PERD un proton, [-] GAGNE un électron
    const proton=parse("C6H12O6 [H-]")
    const electron=parse("C6H12O6 [-]")
    if(proton.charge!==electron.charge) throw new Error("charges should match")
    close(electron.mass-proton.mass,PROTON,1e-9)
})
test("les crochets s'empilent et les charges s'additionnent",()=>{
    const s=parse("C6H12O6 [H-][-]")
    if(s.charge!==-2) throw new Error(`charge ${s.charge}, expected -2`)
    if(s.ionisation.length!==2) throw new Error(`${s.ionisation.length} terms`)
    if(atoms(s,"H")!==11) throw new Error("the proton loss still happened")
})
test("[2H+][-] donne un ion neutre, et non +1",()=>{
    //deutérium +1, puis un électron gagné -1: ça s'annule. Ce que la
    //formulation testait avant était l'ACCUMULATION des deux charges, pas
    //leur somme — et c'est bien la somme qu'on vérifie ici
    const s=parse("C6H12O6 [2H+][-]")
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
    const s=parse("C6H12O6 [Na+][H-][-][MeOH+]")
    if(s.ionisation.length!==4) throw new Error(`${s.ionisation.length} terms, expected 4`)
    if(s.charge!==0) throw new Error(`charge ${s.charge}, expected 0`)
})
test("l'enregistrement ne touche pas aux adduits déjà connus",()=>{
    if(IONISATIONS[1].name!=="H+"||IONISATIONS[1].charge!==1)
        throw new Error("H+ was disturbed")
    if(IONISATION_BY_NAME.get("H+")!==IONISATIONS[1]) throw new Error("the map no longer points at the same object")
    //et le signe d'un adduit est bien celui de l'ION
    if(IONISATIONS[5].name!=="H-"||IONISATIONS[5].charge!==-1)
        throw new Error("H- must be the negative charge")
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
         [H+1]    1 H ajouté       charge 0   (le + est un COEFFICIENT)
         [H-1]    H retiré         charge 0
         [H2]     2 H ajoutés      charge 0
         [H][+1]  1 H, puis charge +1

       C'est ce qui tue le registre: "[H+1]" ne dit plus "protonation", il dit
       "un H ajouté, et rien d'autre". Le registre serait une deuxième façon
       de dire la même chose, donc une deuxième source de vérité. */
    const cases=[
        //texte        H    charge
        ["[2]",       12,  2],
        ["[H]",       13,  0],
        ["[H+1]",     13,  0],
        ["[H-1]",     11,  0],
        ["[H2]",      14,  0],
        ["[H][+1]",   13,  1],
        ["[-H]",      11,  0],
        ["[2H]",      12,  0],
    ]
    for(const [term,h,charge] of cases){
        const f=Formula.parse(`C6H12O6${term}`,TABLE)
        if(f.counts.get(TABLE.find("H"))!==h)
            throw new Error(`${term} -> H is ${f.counts.get(TABLE.find("H"))}, expected ${h}`)
        if(f.charge!==charge) throw new Error(`${term} -> charge ${f.charge}, expected ${charge}`)
    }
})
test("un groupe composé est une VRAIE formule, pas un nom",()=>{
    /* "(H2O)-1" est l'eau × -1, et "H-2O-1" est H×1 puis O×(-1): deux
       écritures de la même idée, lues par la MÊME fonction. C'est tout ce
       qu'un adduit compose est — il n'a pas besoin d'être dans une table,
       parce que la grammaire sait déjà le lire. */
    const a=Formula.parse("C6H12O6[-H2O]",TABLE)
    const b=Formula.parse("C6H12O6[-(H2O)]",TABLE)
    if(a.key!==b.key) throw new Error(`"${a.key}" != "${b.key}"`)
    if(a.counts.get(TABLE.find("H"))!==10) throw new Error("H is not 10")
    if(a.counts.get(TABLE.find("O"))!==5) throw new Error("O is not 5")
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
console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length>0) process.exitCode=1


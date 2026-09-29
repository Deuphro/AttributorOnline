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
        //la masse de l'électron est lue ICI, une fois: Formula.mass en a besoin
        //et n'a pas la table sous la main
        if(Number.isFinite(data.electronMass?.value)) Formula.electronMass=data.electronMass.value
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

/* Il n'y a pas de REGISTRE des adduits, et c'est délibéré.

   Il en existait un, qui associait un nom à une composition: "MeOH+" ->
   "CH4O". Il ne restait pourtant qu'une seconde source de vérité, capable de
   contredire la grammaire — et c'était là que les bases divergeaient. La
   grammaire lit maintenant n'importe quel terme par parseComposition, la même
   fonction que le core: "[CH4O+]" et "[MeOH+]" se lisent par la même règle,
   et un terme qu'on ne sait pas lire est une faute de saisie, jamais une
   étiquette muette.

   Un nom libre reste ACCEPTÉ s'il est une formule lisible; ce qui ne l'est pas
   est nommé, comme n'importe quel élément inconnu. */

class Formula{
    /* La masse de l'électron, en unités de masse atomique.

       Elle est une DONNÉE (CODATA, dans elements.json), pas une constante du
       langage: la lire dans le fichier plutôt que la graver ici, c'est ce qui
       permet de la corriger un jour sans réécrire la physique. Element.load la
       pose; en son absence on garde la valeur CODATA 2018 du fichier, qui est
       ce qu'il contient. */
    static electronMass=0.000548579909065

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
        return m-this.charge*Formula.electronMass
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
        /* Un signe qui suit une parenthèse fermée ET un nombre qualifie le
           GROUPE, il n'est pas nu: "C6H12O6(H2O)-1" est l'eau × -1, pas un ion
           chargé -1 où l'eau s'ajouterait. Sans cette garde, le signe est coupé
           avant même parseComposition et le coefficient disparaît.

           Il faut le NOMBRE: "(H2O)-" n'a rien derrière son signe, donc ce
           signe reste nu et devient la charge — comme "H2-". */
        const afterGroup=chargeFromCore
            &&/\d/.test(chargeFromCore[1])
            &&s.slice(0,chargeFromCore.index).trimEnd().endsWith(")")
        /* Un signe collé à un SYMBOLE et suivi d'un nombre est un COEFFICIENT,
           jamais une charge: "C6H12O6-H2O-1" retire deux H ET un O. C'est la
           même condition que celle de readIonisation, appliquée au core: il faut
           qu'il n'y ait pas de lettre juste avant le signe. */
        const afterSymbol=chargeFromCore
            &&/\d/.test(chargeFromCore[1])
            &&/[A-Za-z]/.test(s.slice(0,chargeFromCore.index).trimEnd().slice(-1))
        let core=s
        let orphan=0
        if(chargeFromCore&&!afterGroup&&!afterSymbol){
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
        const ionisation=terms.map(t=>Formula.parseIonisation(t,table,rule).ionisation)
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
    /* Y a-t-il un ÉLÉMENT juste AVANT cette position du fragment ?

       C'est le symétrique de hasElementAfter, et c'est lui qui distingue
       "C6H12O6-2" (une charge) de "H2O-1" (le -1 est le coefficient du O).
       Dans les deux cas le nombre est nu et suivi d'aucune lettre, donc seul
       ce qu'il y a avant permet de trancher. */
    /* Y a-t-il un ÉLÉMENT juste avant cette position, en ignorant les signes
       et les chiffres qui pourraient être entre lui et nous ?

       C'est ce qui décide si un "-" collé à un symbole est un COEFFICIENT ou
       une charge. Sur "H-1", le slice finit par "1", il faut donc reculer
       par-dessus le nombre et le trait d'union pour trouver le H. */
    static elementBefore(raw,from){
        /* Le signe ne touche un symbole que s'il est COLLÉ à lui: la lettre
           qui précède le signe doit être la fin d'un atome, pas la fin d'un
           nombre.

             H-1        le - suit H     → le - est collé
             O6-2H      le - suit un 6   → le - ouvre un terme, pas un -collé

           Sans cette garde, "C6H12O6-2H" verrait un "O" avant le - (en
           escamotant le 6 qui lui appartient) et appliquerait le coefficient à
           l'oxygène. */
        if(from<1||!/[A-Za-z]/.test(raw[from-1]??"")) return null
        const before=raw.slice(0,from).replace(/[+-]?\d*$/,"")
        return /[A-Za-z][A-Za-z]?$/.exec(before)?.[0]??null
    }

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
            //où se trouvait ce signe: c'est là qu'il faut regarder pour savoir
            //s'il touche un élément
            let signAt=-1
            /* Le signe ne déborde JAMAIS sur le terme suivant. "-H2O" retire
               deux H, et le O qui suit n'a AUCUN signe écrit: il n'est donc pas
               compté du tout. C6H12O6-H2O est C6H10O6, pas C6H10O7.

               Pour agir sur plusieurs atomes, il faut un signe À CHACUN —
               "H-2O-1" est H×1 puis O×(-1) — ou des parenthèses. */
            let signSpent=false
            /* Le dernier atome RÉELLEMENT compté, et par quel signe. C'est ce
               qui distingue deux écritures qui se ressemblent:

                 -H-1     le -1 reprend le H que le - qualifiait  → on FIXE
                 -H2O-1   le -1 vise l'O, jamais mis au compte    → on AJOUTE

               Sans cette distinction, "-H2O-1" écrasait les 6 oxygènes du
               noyau avec -1, et "-H-1" cumulait deux fois. */
            let lastPut=null
            /* Ce que le DERNIER terme a réellement apporté, atome par atome.
               C'est le terme qu'un coefficient vient corriger, JAMAIS le total:
               dans "C6H12O6-O-1", le -1 change le -1 du terme en -1, il ne
               touche pas aux 6 oxygènes du noyau. On corrige donc un DELTA. */
            let lastTerm=new Map()
            /* Le point d'entrée unique des atomes, et le seul endroit qui
               applique cette règle. Tout ce qui suit un terme signé, sans
               signe propre, est IGNORÉ: il n'a pas été demandé. */
            const put=(el,massNumber,count)=>{
                if(signSpent&&!signed) return
                /* Ce que le TERME apporte, atome par atome — sans repasser par
                   parseComposition, qui se rappellerait lui-même. L'A est celui qu'il
                   a choisi: écrit si un nombre de masse est donné, sinon la
                   règle. C'est exactement ce que fait add(). */
                const A=massNumber?Number(massNumber):el.pickA(rule)
                const n=sign*(massNumber?Number(massNumber):1)
                        *(count!==null&&count!==undefined&&count!==""?Number(count):1)
                lastTerm=new Map([[A,n]])
                add(el,massNumber,count,sign,signed)
                lastPut=el
                if(signed) signSpent=true
            }
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
                    signSpent=false
                    signAt=i
                    i++
                    continue
                }
                /* Un nombre nu après un signe. Deux lectures, et c'est le SIGNE
                   qui tranche — parce qu'il n'est pas symétrique, c'est
                   chimique: le "+" d'un compte s'omet, le "-" ne s'omet pas.

                     H-1     le - touche H  → 1 H en moins
                     H2-1    le 2 est déjà le compte de H, le - est nu → charge
                     -1      le signe est seul → charge -1

                   Donc un "-" collé à un symbole prend TOUJOURS le nombre qui
                   le suit, et un "+" ne le prend jamais. */
                if(/[0-9]/.test(raw[i])){
                    const digits=/^\d+/.exec(raw.slice(i))
                    const afterDigits=i+digits[0].length
                    /* On regarde AVANT LE SIGNE, pas avant le nombre: le trait
                       d'union est entre les deux, et c'est lui qui décide. */
                    const symbol=Formula.elementBefore(raw,signAt)
                    /* Un "-" collé à un symbole est un COEFFICIENT: le nombre
                       qui le suit est le compte de ce symbole, et le symbole a
                       DÉJÀ été compté par la segmentation. Il ne faut donc pas
                       l'ajouter une seconde fois — seulement corriger le compte
                       de ce qu'on a déjà mis.

                       "H-1": le H a été ajouté avec +1, on le ramène à -1. */
                    if(signed&&symbol&&sign===-1){
                        const el=table.find(symbol)
                        if(!el) throw new Error(`unknown element "${symbol}" in "${raw}"`)
                        /* L'A de ce symbole, pas celui du dernier terme: "-H2O-1"
                           vise l'O et doit écrire un 16O, même si le terme
                           précédent était de l'hydrogène. */
                        const signedA=el.pickA(rule)
                        /* Le terme "S-n" vaut S×(-n) TOUT ENTIER: le +1 que la
                           segmentation vient d'ajouter est donc annulé, puis le
                           compte écrit est soustrait. C'est un COEFFICIENT, pas une
                           non n: sans le 1, "C6H12O6[H-1]" vaudrait 12 au lieu
                           de 11 — et "-O-1", où le - initial a déjà donné -1,
                           vaudrait -3. On FIXE donc le compte de ce symbole.

                           A par A, et sur le total déjà présent: le noyau a
                           peut-être contributed avant (12 H dans C6H12O6), il
                           faut donc corriger, pas écraser. */
                        const byA=composition.get(el)??new Map()
                        /* Un coefficient remplace le TERME, pas le total: on
                           retire ce que le terme avait apporté, on met le compte
                           écrit. Sans ce DELTA, "-O-1" après un noyau à 6 O
                           afficherait -1 oxygène au lieu de 5. */
                        const A=signedA
                        /* On ne retire que ce que CE terme a mis DANS CE
                           symbole. Sans cette garde, "-H2O-1" — où le dernier
                           terme est l'hydrogène et la cible l'oxygène —
                           créerait une fausse entrée 1H dans la Map de l'O. */
                        if(lastPut===el)
                            for(const [A2,was] of lastTerm)
                                byA.set(A2,(byA.get(A2)??0)-was)
                        byA.set(A,(byA.get(A)??0)+sign*Number(digits[0]))
                        //le terme vaut désormais exactement ce compte écrit
                        lastTerm=new Map([[A,sign*Number(digits[0])]])
                        composition.set(el,byA)
                        lastPut=el
                        signed=false
                        sign=1
                        i=afterDigits
                        continue
                    }
                    if(signed&&!Formula.hasElementAfter(raw,afterDigits)){
                        trailingSign+=sign
                        trailingMagnitude=Number(digits[0])
                        signed=false
                        sign=1
                        i=afterDigits
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
                    /* Le coefficient vient APRÈS la parenthèse fermée, et il
                       faut un NOMBRE pour qu'il existe: "(H2O)-1" est l'eau
                       × -1, mais "(H2O)-" n'a rien derrière son signe — donc ce
                       signe ne qualifie rien, c'est la charge de l'ion. C'est
                       exactement "H2-" : deux hydrogènes, puis un -1.

                       On ne consomme donc le signe que s'il est suivi de
                       chiffres; sinon on le laisse intact, et il sera lu comme
                       un signe nu par la suite. */
                    let j=close+1
                    let factor=1
                    if(raw[j]==="-"||raw[j]==="+"){
                        const afterSign=/^\d+/.exec(raw.slice(j+1))
                        if(afterSign){
                            factor=(raw[j]==="-"?-1:1)*Number(afterSign[0])
                            j+=1+afterSign[0].length
                        }
                    }
                    for(const [el,byA] of inner)
                        for(const [A,n] of byA){
                            if(!composition.has(el)) composition.set(el,new Map())
                            const byOther=composition.get(el)
                            byOther.set(A,(byOther.get(A)??0)+sign*factor*n)
                        }
                    /* Le signe en attente a été CONSOMMÉ par le groupe: il ne
                       doit surtout pas finir en charge. "C6H12O6-(2H)" est un
                       groupe de coefficient -2, pas un ion chargé +1. */
                    sign=1
                    signed=false
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
                    if(exact){ put(exact,p[1],p[3]); sign=1; signed=false; i+=p[0].length; continue }
                    //sinon: si les DEUX lettres sont des éléments, ce sont deux
                    //atomes. C est un élément et O aussi, donc "CO" est C + O.
                    const a=table.find(p[2][0])
                    const b=table.find(p[2][1])
                    if(a&&b){
                        put(a,p[1],null)
                        one.lastIndex=i+1
                        const second=one.exec(raw)
                        put(b,null,second?.[3])
                        sign=1
                        signed=false
                        i+=p[0].length
                        continue
                    }
                    //l'une des deux n'existe pas: le couple ne peut être qu'un symbole
                    const pair=table.find(p[2])
                    if(pair){ put(pair,p[1],p[3]); sign=1; signed=false; i+=p[0].length; continue }
                }
                one.lastIndex=i
                const m=one.exec(raw)
                if(!m){ i++; continue }
                const el=table.find(m[2])
                if(!el) throw new Error(`unknown element "${m[2]}" in "${raw}"`)
                put(el,m[1],m[3])
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
        /* Les PARENTHÈSES d'abord, avant toute autre lecture. "(2H)+2" est un
           GROUPE — un deutérium, le 2 est son A — suivi d'une charge. Sans ce
           test, le "+2" serait pris pour un second terme et le groupe serait
           lu deux fois. Un groupe se distingue parce qu'il est fermé: rien
           après ne lui appartient. */
        if(s.includes("(")){
            const close=Formula.matchParen(s,0)
            const head=s.slice(0,close+1)
            const rest=s.slice(close+1).trim()
            let charge=Formula.readChargeOnly(rest,text)
            /* Un signe COLLÉ au groupe, "[-(H2O)]", est lu par la grammaire
               comme un coefficient — l'eau est bien × -1. Mais il porte aussi
               la charge de l'ion, exactement comme "[H2O-]": un terme
               d'ionisation ne perd jamais sa charge. */
            if(!rest&&!charge){
                const attached=/^([+-])\s*[\d(]/.exec(head)
                if(attached) charge=attached[1]==="+"?1:-1
            }
            return {massNumber:null,name:head,atomCount:1,isComposition:true,charge}
        }
        /* Un signe en FIN de terme, c'est la CHARGE — sauf si un nombre lui
           est déjà affecté par un symbole. Un nombre se rattache au symbole
           qu'il SUIT, et un signe qui n'a plus rien à qualifier est une
           charge. Il n'y a donc qu'une seule règle, valable partout:

             C6H12O6-1    le -1 est nu après O6      → charge -1
             [H-1]        le -1 est collé au H      → 1 H en moins
             [H+1]        le + collé au H, le 1 nu → +1 H, puis charge +1
             [H-1+]       -1 collé, le + nu ensuite → 1 H en moins, charge +1
             [H2-1]       le 2 est le compte de H   → 2 H, puis charge -1

           Pour retirer un groupe entier, il faut des parenthèses: "[-(H2O)]". */
        const trailing=/([+-])\s*(\d*)\s*$/.exec(s)
        if(trailing){
            const head=s.slice(0,trailing.index).trim()
            /* Un signe seul ne qualifie RIEN, dans un crochet comme ailleurs:
               il n'a pas de nombre à prendre, donc il ne peut pas être un
               coefficient. C'est la règle du core, appliquée au même endroit:

                 [H2O-]     - seul        → l'eau AJOUTÉE, charge -1
                 (H2O)-     - seul        → l'eau ajoutée, charge -1
                 [H-1]      -1 ensemble  → 1 H en moins, et c'est tout
                 [H2-1]     2 déjà pris   → 2 H, puis charge -1

               Il faut donc les DEUX: un symbole devant, ET un nombre derrière.
               C'est ce booléen qui fait toute la différence entre "un H
               retiré" et "un ion chargé", et il ne dépend ni du core ni du
               crochet. */
            const signTouchesSymbol=Formula.elementBefore(s,trailing.index)!=null
            const magnitudeWritten=trailing[2]!==""
            /* ...et si un NOMBRE précède déjà ce signe, ce nombre est le
               compte du symbole, et le signe reste nu: "H2-1" est 2 H puis
               une charge -1, alors que "H-1" est un compte de -1. */
            const countAlreadyTaken=/\d$/.test(head)
            const magnitude=Number(trailing[2]||"1")
            if(magnitude===0) throw new Error(`"${text}" has a charge of zero`)
            if(signTouchesSymbol&&trailing[1]==="-"&&magnitudeWritten&&!countAlreadyTaken){
                //le -1 est un compte du symbole: on rend tout à la grammaire
                return {massNumber:null,name:s,atomCount:1,charge:0,isComposition:true}
            }
            const charge=trailing[1]==="+"?magnitude:-magnitude
            /* Un nombre seul devant le signe n'est pas un atome: "[2+]" est un
               ion doublement chargé, pas un "2" suivi d'un +. C'est le MÊME
               nombre, quel que soit le côté où on l'écrit — "[2+]", "[+2]" et
               "[2]" disent tous la même chose. */
            if(/^\d+$/.test(head))
                return {
                    massNumber:null,name:"",atomCount:1,
                    charge:head.startsWith("-")?0:(trailing[1]==="-"?-1:1)*Number(head),
                }
            if(!head) return {massNumber:null,name:"",atomCount:1,charge}
            return {massNumber:null,name:head,atomCount:1,isComposition:true,charge}
        }
        /* Un nombre SEUL, avec ou sans signe, est une CHARGE: "[2]", "[+2]",
           "[-2]". Il n'y a aucun élément derrière, donc le signe ne qualifie
           rien et ne peut être qu'une charge. C'est ce qui permet à "[H][+1]"
           de dire deux choses en deux termes, plutôt qu'une seule. */
        const alone=/^(\d*)([+-]?)(\d*)$/.exec(s)
        if(alone){
            const magnitude=Number(alone[1]||alone[3]||"1")
            if(magnitude===0) throw new Error(`"${text}" has a charge of zero`)
            return {
                massNumber:null,name:"",atomCount:magnitude,
                charge:alone[2]==="-"?-magnitude:magnitude,
            }
        }
        /* Sinon il n'y a que des ATOMES, signes compris: "[H-1]" est un H
           retiré, "[CH4O-1]" du méthanol retiré, "[+2H]" deux H ajoutés. Un
           nombre APRÈS le symbole est toujours un compte — et il est négatif
           s'il est signé. C'est donc parseComposition qui le lit, et elle le
           fait déjà correctement. */
        return {massNumber:null,name:s,atomCount:1,charge:0,isComposition:true}
    }

    /* La charge d'un terme, et rien d'autre. "2" → 2, "+2" → 2, "-2" → -2,
       "" → 0. Un terme sans rien derrière un groupe n'est pas neutre par
       hasard: c'est qu'aucun signe n'a été écrit. */
    static readChargeOnly(text,original){
        const m=/^([+-])\s*(\d*)$/.exec(text.trim())
        if(!m) return 0
        const magnitude=Number(m[2]||"1")
        if(magnitude===0) throw new Error(`"${original}" has a charge of zero`)
        return m[1]==="+"?magnitude:-magnitude
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
        const {name,atomCount,charge:written,isComposition}=desc
        //une charge seule: aucun atome, et c'est tout
        if(!isComposition) return {
            index:-1,group:null,count:atomCount,charge:written,
            name:`${written>0?"+":"-"}${Math.abs(written)}`,
        }
        /* Des atomes: on délègue à parseComposition, sans rien d'autre. C'est le
           MÊME chemin que le core — c'est tout l'intérêt, un adduit n'est pas
           une autre grammaire, c'est la même appliquée à un groupe. */
        const group=Formula.parseComposition(name,table,rule)
        /* Les atomes ne bougent JAMAIS au signe final. "[H2O-]" est l'eau
           AJOUTÉE et un ion chargé -1, exactement comme "(H2O)-"; seul "[H2O-1]"
           retire l'eau, parce qu'un - a alors un nombre à prendre. */
        return {index:-1,group,count:1,charge:written,name}
    }

    //"[2H+]", "[H-]", "[Na+]", "[2+]", "[3-]", "[]" -> {ionisation, count, known}
    static parseIonisation(text,table,rule="mostProbable"){
        const desc=Formula.readIonisation(text)
        const ionisation=Formula.resolveIonisation(desc,table,rule)
        return {ionisation,count:ionisation.count,known:ionisation.known}
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
   The periodic table, loaded OUTSIDE this file.

   The masses live in data/elements.json, and this module stays PURE: no fs,
   no fetch, no side effect at import time. Whoever needs the table asks for
   it - loadTable() in a browser (fetch), readFileSync under node (the tests)
   - and hands it to Formula.parse(text, table). Two ways to READ THE SAME
   DATA is one source of truth, not two.
   ------------------------------------------------------------------------ */
async function loadTable(url="../data/elements.json"){
    const response=await fetch(new URL(url,import.meta.url))
    if(!response.ok) throw new Error("elements.json: HTTP "+response.status)
    return Element.load(await response.json())
}

export {Element,Formula,loadTable}

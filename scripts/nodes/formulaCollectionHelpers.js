/* ---- small pure helpers for the collection reader ----------------------
   They live out of the class because none of them touches the DOM, and a
   number format is exactly the thing that must be testable on its own. */

//"1 234 567" — the counts here reach six digits per collection, and a column
//of "1234567" is a column nobody can compare down
export function formatCount(value){
    const n=Math.trunc(Number(value))
    if(!Number.isFinite(n)) return "—"
    return Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g," ")
}
export function formatMz(mz){
    return Number.isFinite(mz)?mz.toFixed(4):"—"
}
//six significant figures: enough to tell two isotopologues apart in ppm,
//short enough to fit a 60 px cell
export function formatValue(value){
    if(!Number.isFinite(value)) return "—"
    if(value===0) return "0"
    const magnitude=Math.abs(value)
    if(magnitude>=1e6||magnitude<1e-3) return value.toExponential(2)
    return value.toPrecision(6).replace(/0+$/,"").replace(/\.$/,"")
}
const SUBSCRIPTS={"0":"₀","1":"₁","2":"₂","3":"₃","4":"₄","5":"₅","6":"₆","7":"₇","8":"₈","9":"₉"}
const SUPERSCRIPTS={"0":"⁰","1":"¹","2":"²","3":"³","4":"⁴","5":"⁵","6":"⁶","7":"⁷","8":"⁸","9":"⁹","+":"⁺","-":"⁻"}
/* The notation, made readable: the COUNTS go down (C₆H₁₂O₆), the MASS NUMBERS
   go up and to the LEFT (¹²C₆), and the charge goes up at the end (H⁺).

   TROIS POSITIONS, et c'est cela qui rend la ligne lisible. Un nombre de masse
   précède son symbole et un compte le suit: ce qui les distingue est donc
   OÙ ils sont, et non la façon dont on les dessine. ¹²C₆ et C₁₂₆ sont la même
   chose écrite deux fois, et celle du bas se lit « douze carbones » — un A
   subscripté perd le seul endroit où l'œil sait le chercher. L'exposant est aussi
   la forme qu'un chimiste recopie ailleurs.

   LA RÈGLE TIENT PARCE QUE LA CHAÎNE EST BIEN FORMÉE. Une suite de chiffres
   precedée d'une lettre est un compte, et sinon un nombre de masse: c'est vrai
   tant que `toString` ne colle pas un compte à l'A qui suit, et il ne le fait
   plus — il garde l'espace exactement là où la fusion serait lue autrement.

   The key itself is NEVER touched: it is the identity, it never abbreviates,
   and it is what a downstream node re-parses. This is a display of it. */
export function prettyNotation(notation){
    const text=String(notation)
    let out=""
    let i=0
    while(i<text.length){
        const ch=text[i]
        if(/[0-9]/.test(ch)){
            /* One pass, and ONE order: a loop that handled the digits first
               and the letters afterwards printed "₆₁₂₆CHO", which is not a
               formula in any language. */
            const before=text[i-1]??""
            let digits=""
            while(i<text.length&&/[0-9]/.test(text[i])) digits+=text[i++]
            const rest=text.slice(i)
            //what decides a mass number is that a LETTER follows it; what
            //decides a charge magnitude is that a SIGN does
            const sign=/^[^\+\-]*?([\+\-])/.exec(rest)
            if(/[A-Za-z\]]/.test(before)){
                //a COUNT, and it goes down under the symbol it follows
                out+=[...digits].map(d=>SUBSCRIPTS[d]).join("")
            }else if(sign&&!/^[A-Za-z]/.test(rest)){
                //the MAGNITUDE of a charge, and it goes up with its sign:
                //SO4[2-] is SO₄²⁻, never SO₄₂⁻
                out+=[...digits].map(d=>SUPERSCRIPTS[d]).join("")+SUPERSCRIPTS[sign[1]]
                //the sign is consumed here, so the main loop must not see it
                i+=sign.index+sign[0].length
            }else{
                /* A MASS NUMBER, and it goes UP, on the left of its symbol.

                   It used to stay on the baseline, which was defensible — ¹²C₆
                   and ₁₂C₆ are different writings — but the baseline is not a
                   position anyone reads an A in, and the row filled with a dozen
                   of them became a column of figures with nothing to say which
                   number was which. The exponent is where the A is looked for
                   first, and it is the only place it cannot be mistaken for a
                   count, since the count is the one AFTER the symbol. */
                out+=[...digits].map(d=>SUPERSCRIPTS[d]).join("")
            }
            continue
        }
        if(ch==="+"||ch==="-"){
            out+=SUPERSCRIPTS[ch]
            i++
            continue
        }
        //the brackets of an ionisation are structure, not content: what they
        //contain is written out, and they are not drawn
        if(ch!=="["&&ch!=="]") out+=ch
        i++
    }
    return out
}
//the colour of a trace, taken from the palette the inspector already uses so
//a collection keeps the same colour in the graph as in the list
const TRACE_COLORS=["#e74c3c","#3498db","#2ecc71","#f39c12","#9b59b6","#1abc9c","#e67e22","#16a085"]
export function traceColor(index){
    return TRACE_COLORS[((index%TRACE_COLORS.length)+TRACE_COLORS.length)%TRACE_COLORS.length]
}
/* Delete and Backspace, as ONE predicate.

   Two keys for one verb is not redundancy, it is the two keyboards: the Delete
   key of a PC sits far from the home position, and on a Mac there is no forward
   Delete at all — Backspace is what is under the right hand. The nodes of the
   flow have accepted both since the beginning (Node's key handler), and a panel
   that answered only one of them would feel like a different application.

   It also has to IGNORE the keystrokes that only LOOK like deletion, which is
   why the callers pair it with a check on what has the focus: Backspace inside
   the formula field, the filter or the note is an edit, and a panel that
   swallowed it would make those three fields unusable. */
export function isDeleteKey(event){
    return event.key==="Delete"||event.key==="Backspace"
}
/* Les ordres que la liste accepte. Chacun renvoie 0 pour « égal » : l'appelant
   ajoute le m/z puis la clé comme départage, parce qu'une liste dont l'ordre
   bouge entre deux peintures identiques est une liste qui déplace la ligne sous
   le curseur.

   TOUTE COMPARAISON NUMÉRIQUE PASSE PAR `ordered`, et c'est nécessaire : sans
   elle, deux valeurs absentes produisent `Infinity - Infinity`, c'est-à-dire
   `NaN`. `NaN` est FAUX, donc le `||` du départage le rattrapait et le tri
   « fonctionnait » — par un accident de représentation, pas par une règle. Le
   jour où le départage aurait été un `?:` au lieu d'un `||`, l'ordre aurait
   simplement été indéfini, sans lever la moindre erreur. Un `NaN` dans un
   comparateur ne se voit jamais: `Array.sort` le propage en silence. */
const ordered=(a,b)=>{
    const left=Number.isFinite(a)?a:null
    const right=Number.isFinite(b)?b:null
    /* Une valeur ABSENTE n'est pas « égale » à une autre valeur absente: les
       deux sont inconnues, et le départage doit encore décider. On leur donne
       donc +∞ — « le plus loin possible » — et le départage tranche ensuite sur
       le m/z et la clé, qui, eux, existent toujours. */
    const l=left===null?Infinity:left
    const r=right===null?Infinity:right
    return l-r||0
}
export const FORMULA_SORTS={
    mz:{label:"m/z",compare:(a,b)=>ordered(a.mz,b.mz)},
    /* Décroissant: le plus intense d'abord, parce qu'on cherche le signal
       dominant. Une ligne sans intensité mesurée part donc en FIN, jamais en
       tête — un `?? 0` la ferait passer devant toutes les autres. */
    intensity:{label:"intensity",compare:(a,b)=>ordered(b.intensity,a.intensity)},
    error:{label:"error",compare:(a,b)=>ordered(Math.abs(a.errorPpm),Math.abs(b.errorPpm))},
    /* LE NOMBRE DE PICS, et c'est le seul ordre qui ne parle ni de la formule
       ni de la mesure prise isolément: il répond « combien de points mesurés
       cette ligne explique-t-elle ». Pour une molécule c'est la somme de ses
       feuilles — c'est ce qu'on cherche quand on trie par pics, puisque c'est
       la couverture du signal qui compte, pas le nombre de formules.

       DÉCROISSANT comme l'intensité, pour la même raison: on cherche d'abord ce
       qui explique le plus. Une ligne sans cible vaut 0 par la construction des
       lignes elle-même, donc elle part en FIN — jamais en tête. */
    peaks:{label:"peaks",compare:(a,b)=>ordered(b.peaks??0,a.peaks??0)},
    notation:{label:"notation",compare:(a,b)=>(a.notation<b.notation?-1:a.notation>b.notation?1:0)}
}
/* THE COMPARATOR, as a function — never as a table entry.

   `FORMULA_SORTS[name]` is an OBJECT ({label, compare}), and calling it threw
   "sort is not a function" the first time a row was clicked: the list was
   silently empty from the start and the exception only surfaced when a stale
   row was activated. So the lookup, the fallback and the tie-breakers all live
   here, and the caller does `rows.sort(formulaComparator(...))` — there is no
   longer a shape to get wrong.

   `hasOwnProperty` and not a plain read, so a name like "constructor" or
   "toString" resolves to nothing rather than to something inherited from
   Object.prototype that happens to be callable.

   An UNKNOWN order falls back to m/z instead of throwing: the order is a
   display choice stored in a session file, and a file this build did not write
   must not be able to blank the list. */
/* L'ordre des clés, et RIEN D'AUTRE.

   Isolé du comparateur parce qu'il ne sert qu'à lui, et parce qu'il mérite son
   propre commentaire: c'est la fonction la plus simple du fichier et celle dont
   l'erreur serait la plus discrète. Renvoie 0 sur l'égalité, sans quoi le
   comparateur n'est plus réflexif. */
const byKeyOrder=(a,b)=>{
    const left=a??""
    const right=b??""
    if(left===right) return 0
    return left<right?-1:1
}
export function formulaComparator(name){
    const sort=Object.prototype.hasOwnProperty.call(FORMULA_SORTS,name)?FORMULA_SORTS[name]:null
    const compare=sort?.compare??FORMULA_SORTS.mz.compare
    /* Le départage final renvoyait 1 SUR L'ÉGALITÉ: `(a.key<b.key?-1:1)`
       répond 1 même quand les deux clés sont identiques. Un comparateur se
       doit d'être réflexif — `cmp(a,a) === 0` — sinon l'implémentation de tri
       n'a plus d'ordre stable à suivre et peut rendre deux résultats
       différents pour le MÊME tableau, selon la méthode qu'elle choisit.

       Ici, deux lignes ne devraient jamais partager une clé, puisque `byKey`
       garantit l'unicité dans la collection. C'est donc une faute qui ne
       pouvait pas se montrer — mais elle est fausse, et une fonction fausse
       dans un comparateur se révèle dès qu'on trie autre chose. */
    return (a,b)=>compare(a,b)||ordered(a.mz,b.mz)||byKeyOrder(a.key,b.key)
}



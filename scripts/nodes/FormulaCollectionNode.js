import {NodeWithAccordionGraph} from "./NodeWithAccordionGraph.js"
import {Accordion} from "../ui/Accordion.js"
import {Wave,XYTrace} from "../formats.js"
import {Formula,Stoichiometry,FormulaCollection} from "../chemistry.js"
import {computePool} from "../workerPool.js"
import {CE,stylize,DC} from "../util.js"
import {VirtualRowList} from "./VirtualRowList.js"
import {segmentToggle,scaleToggle} from "../utils/index.js"
import {formatCount,formatMz,formatValue,prettyNotation,traceColor,isDeleteKey,FORMULA_SORTS,formulaComparator} from "./formulaCollectionHelpers.js"

/* -------------------------------------------------------------------------
   FormulaCollectionNode — a READER for collections of Formula.

   ONE input, multiplexed: Flow.parentSynapse already gathers every link that
   lands on a single anchor into one Map, so a hundred collections of molecules
   arrive on one socket. Nothing here invents a second mechanism for it.

   THREE panels, and each answers a different question:
     - LEFT  : WHAT there is. Level 1 the collections (name, size, two
               checkboxes, a handle); level 2 the rows of the collection on
               screen, virtualized, filterable, sortable — and the toolbar that
               filters and sorts them sits with them, not above the collections.
     - CENTER: what it LOOKS like. One stick trace per collection ticked for
               the graphs, drawn in the node's own dialog.
     - RIGHT : what a given formula IS. The unabridged key, the mass, every
               measured target with its error, and a free-text annotation.

   The Formula / Stoichiometry / Peaks switch is a VIEW and never a
   transformation. "Fold to stoichiometry" groups the leaves of a graph under
   their root — the engine already knows that lineage, so the grouping is a
   grouping and not a guess — and unfolding hands back every key, m/z and target
   untouched.

   A LINE IS FOLDABLE, and what it unfolds depends on what it IS. There is
   a HANDLE on every line that has something inside, and opening is done on
   the handle — never on the line itself, because reading a line and opening
   one are two different intentions and one click cannot be both.

   And a fold opens ONE thing, one level deep:
     - Formula view      : the formulas are the lines, and a formula opens
                           its TARGET PEAKS — the measured mass, the intensity
                           and where the point came from. Not the formulae.
     - Stoichiometry view: the stoichiometries are the lines, and one opens
                           its FORMULAS.
     - Peaks view        : the measured points are the lines, and one opens
                           the formula that took it.
   ------------------------------------------------------------------------- */
export class FormulaCollectionNode extends NodeWithAccordionGraph{
    /* CE QUE LE GRAPHE MONTRE PAR DÉFAUT. */
    static GRAPH_MODE_DEFAULT="error"
    //one line of the list. Fixed, and the reason the windowing is cheap. It
    //MUST equal the height of .fc-row in main.css: the offsets the list
    //computes are multiples of this, and a one-pixel disagreement puts the row
    //the user clicked somewhere else than the row they clicked on.
    static ROW_HEIGHT=22


    /* LEVEL 2 — the formulas of the collection on screen.

       The list is VIRTUALIZED and it has to be: the brief is tens of thousands
       of formulas per collection, and ten thousand DOM rows is ten thousand
       layout boxes the browser will rebuild on every scroll. The rows are a
       recycled pool — only the visible window exists, and scrolling re-fills
       the same elements instead of appending new ones.

       One deliberate consequence: a row of fixed height, and the targets of a
       formula are NOT expanded in place. They are in the detail panel on the
       right, one click away, and the row shows their NUMBER. Variable heights
       would break the offset arithmetic that makes the windowing cheap, and
       the alternative — a nested scrollable block inside a virtualized row —
       is worse to use than a panel that is already there. */
    buildFormulaBand(){
        const band=CE("div",{
            className:"fc-formulas",
            /* NO overflow and NO contain here. This band became a GRID when the
               write line was added above the list, and the scrolling and the
               containment belong to the middle row — `.fc-viewport-wrap`. Left
               on the band, `contain:strict` also brings SIZE containment: the
               grid is then laid out as if it were empty, the row collapses, and
               the list below it has nothing to show. */
            style:{minHeight:"0",display:"grid","grid-template-rows":"auto auto minmax(0,1fr) auto"}
        },[])
        /* The toolbar is the FIRST ROW of this band, and not a band of its own
           above it: it filters and orders these rows, so it belongs to the same
           box they are in — one gesture away from what it acts on, and visibly
           attached to it. */
        const toolbar=this.buildToolbar()
        toolbar.style.marginBottom="2px"
        /* The write line, and it is ABOVE the list: what you are adding goes at
           the top of a list you are reading downward, not at the bottom where
           you would have to scroll past fifty thousand rows to see it land.

           It is shown only for a collection this node owns. On a collection a
           parent made it is not disabled but REPLACED by a line of text saying
           why — a control that is visibly not applicable teaches, and one that
           silently does nothing does not. */
        this.addRow=CE("div",{className:"fc-addrow-wrap"},[])
        /* Le wrap est créé AVANT la liste, parce que c'est LUI qui défile et que
           la virtualisation a besoin de le savoir dès sa construction. Fabriquer
           la liste d'abord imposerait de lui retrouver son parent après coup —
           et c'est exactement ce que la version d'avant faisait implicitement, en
           supposant que `.fc-viewport` était le conteneur: il ne l'est pas. */
        const viewport=CE("div",{className:"fc-viewport-wrap"},[])
        this.list=new VirtualRowList({
            rowHeight:FormulaCollectionNode.ROW_HEIGHT,
            onRow:(element,row)=>this.drawRow(element,row),
            scrollElement:viewport
        })
        viewport.appendChild(this.list.element)
        viewport.addEventListener("scroll",()=>this.list?.paint(),{passive:true})
        /* The band is focusable so the arrow keys have somewhere to arrive:
           without a tabindex the browser sends them to the next control, and a
           list of formulas is not readable with the mouse alone. */
        viewport.tabIndex=0
        viewport.addEventListener("keydown",(event)=>this.onListKeyDown(event))
        this.diagnosticsBand=CE("div",{style:{maxHeight:"5.5em",overflow:"auto",minHeight:"0"}},[])
        band.append(toolbar,this.addRow,viewport,this.diagnosticsBand)
        this.formulaBand=band
        this.renderAddRow()
        return band
    }
    /* The write line, and it is ALWAYS there.

       It was conditional on the collection being local, which left a field that
       simply did not exist in most states — and a user who types "C" into the
       only other text field on the panel (the filter) sees nothing happen and
       concludes the node is broken. So: always visible, always writable, and
       every refusal SAYS WHY on the line itself.

       The input is built ONCE and reused. Rebuilding it on every render — which
       is what a naive renderAll does — throws away the caret, the focus and
       whatever is half-typed, so a field meant for entering a dozen formulas in
       a row would lose the user after the first one. */
    renderAddRow(){
        if(!this.addRow) return
        if(!this.formulaInput){
            this.addRow.append(this.buildFormulaInput())
        }
        const collection=this.currentCollection
        this.formulaInput.placeholder=collection?.local
            ?"C6H12O6 [H+]   then Enter"
            :"C6H12O6 [H+]   then Enter — will be added to a collection of yours"
        this.formulaInput.title=collection?.local
            ?`Formula to add to "${collection.name}". Enter adds it, Escape clears.`
            :"Enter adds this formula to a collection of this node"
        if(this.addHint){
            this.addHint.textContent=collection?.local
                ?""
                :"no collection of yours is on screen — Enter will use your first one, or create one"
        }
    }
    /* A row is selected by being READ, and read by being the selection: one
       gesture, no "details" button to find.

       ET LE PLI EST DEHORS DE CE GESTE. Un clic sur une ligne la SÉLECTIONNE;
       c'est la POIGNÉE — ou la barre d'espace — qui la déplie. Les deux
       confondus obligent à regarder la liste pour savoir ce qu'on est en train
       de faire, et le pli devient un accident: on ouvre en voulant lire, et on
       lit en voulant ouvrir. La ligne est donc lue, la poignée est actionnée,
       et chacune dit la sienne dans son infobulle.

       L'ensemble dépend de ce que la ligne EST — c'est la même règle que
       `visibleRows`, et elle est écrite deux fois parce qu'elle est le contrat
       entre les deux: si `visibleRows` et `toggleFold` divergeaient sur
       l'ensemble, la poignée replierait ce qui vient de se déplier. */
    foldSetFor(row){
        if(row.kind==="molecule") return this.openMolecules
        if(row.kind==="peak") return this.openPeaks
        return this.openEntries
    }
    foldKeyFor(row){
        return row.kind==="molecule"?row.molecule:row.key
    }
    isFolded(row){
        return this.foldSetFor(row).has(this.foldKeyFor(row))
    }
    /* What key a line ANSWERS to when the question is "which one is selected?".

       A peak line does not answer to its own key — it answers to the formula it
       was measured on. Without this, the arrows could never FIND the line the
       user was on in the peaks view: the selection holds a formula key, the
       peak line carries `key#index`, `findIndex` returned -1, and every ArrowDown
       jumped back to the top of the list.

       It is also what tints the peaks of the selected formula, which is worth
       having: opening a formula and seeing its points lit answers "which points
       are these?" without reading a single m/z. */
    selectionKeyOf(row){
        return row.kind==="peak"?row.entry.key:row.key
    }
    isSelected(row){
        return this.parameters.selection===this.selectionKeyOf(row)
    }
    /* OUVRIR OU FERMER, et RIEN D'AUTRE: la sélection ne bouge pas.

       Elle ne bouge pas parce qu'ouvrir une stœchiométrie au-dessus de la
       formule qu'on vient de lire ne doit pas vider le panneau de détail — on a
       déployé une abstraction, on n'a pas changé de sujet. */
    toggleFold(row){
        /* UNE LIGNE SANS CONTENU N'A PAS DE POIGNÉE, donc pas de pli: y
           enregistrer sa clé ferait grossir un ensemble de lignes qui ne
           peuvent rien montrer, et la ligne afficherait une marque d'ouverture
           sur un vide. */
        if(!row?.childCount) return
        const set=this.foldSetFor(row)
        const foldKey=this.foldKeyFor(row)
        if(set.has(foldKey)) set.delete(foldKey)
        else set.add(foldKey)
        this.origin?.saveSessionSoon?.()
        this.renderRows()
    }
    activateRow(row){
        if(row.kind==="molecule"){
            /* A stoichiometry stands for no single formula, so there is nothing
               to select and nothing for the right panel to show. The selection is
               deliberately left alone rather than cleared: the user was reading
               a formula a moment ago, and opening the line above it is not a
               reason to lose it. */
        }else{
            /* A peak is a measurement OF a formula, so reading a peak line
               selects that formula: the next question is always « which formula
               is this? », and the detail panel is what answers it. */
            this.parameters.selection=this.selectionKeyOf(row)
            this.selectedEntry=row.entry??null
        }
        this.origin?.saveSessionSoon?.()
        this.renderRows()
        this.renderSelection()
    }
    /* The keyboard path. The list is a scroll box, so a page-down there is the
       list's own business — but the ARROWS are this node's, because moving
       along a list of formulas is reading it, and a user with both hands on
       the keyboard should never have to reach for the mouse to move down one
       row.

       ET LE PLI A SES DEUX TOUCHES, parce que la poignée est un bouton: une
       poignée qu'on ne peut pas atteindre au clavier est une poignée qui
       n'existe pas pour la moitié des utilisateurs. ESPACE ouvre et ferme — le
       geste de la poignée —, ENTRÉE lit. Et les deux flèches latérales font ce
       qu'elles font dans tous les arbres: DROITE ouvre, GAUCHE ferme, et quand
       la ligne ne peut pas s'ouvrir elles redeviennent des flèches de déplacement. */
    onListKeyDown(event){
        const rows=this.rows??[]
        if(!rows.length) return
        /* `isSelected`, and not a comparison of keys: a peak line answers to the
           formula it was measured on, and comparing raw keys would leave the
           arrows with no line to start from in the peaks view. */
        const current=rows.findIndex(row=>this.isSelected(row))
        let next=current
        if(event.key==="ArrowDown") next=current<0?0:Math.min(rows.length-1,current+1)
        else if(event.key==="ArrowUp") next=current<0?rows.length-1:Math.max(0,current-1)
        else if(event.key==="Home") next=0
        else if(event.key==="End") next=rows.length-1
        else if(isDeleteKey(event)){
            /* No selection means nothing to remove, and SAYING so beats eating
               the keystroke: the alternative is a user who pressed Delete on a
               list, saw nothing happen, and pressed it harder. */
            if(current<0){
                event.preventDefault()
                this.reportDeletion("select a formula first — the arrows move, Delete removes")
                return
            }
            event.preventDefault()
            this.deleteVisibleRow(rows[current])
            return
        }else if(event.key===" "){
            if(current>=0){
                event.preventDefault()
                this.toggleFold(rows[current])
            }
            return
        }else if(event.key==="Enter"){
            if(current>=0){
                event.preventDefault()
                this.activateRow(rows[current])
            }
            return
        }else if(event.key==="ArrowRight"||event.key==="ArrowLeft"){
            const open=event.key==="ArrowRight"
            const row=rows[current]
            /* Une ligne fermée AVALE une flèche droite, comme un dossier fermé
               avale un Entrée: la flèche sert d'abord à ouvrir, et ne sert
               qu'ensuite à se déplacer. Sur une ligne sans contenu il n'y a
               rien à ouvrir, donc elle est un simple déplacement. */
            if(current>=0&&row?.childCount&&this.isFolded(row)!==open){
                event.preventDefault()
                this.toggleFold(row)
                return
            }
            next=open
                ?current<0?0:Math.min(rows.length-1,current+1)
                :current<0?rows.length-1:Math.max(0,current-1)
        }else{
            return
        }
        event.preventDefault()
        /* The arrows move the SELECTION, and a peak answers to its formula — so
           moving onto a peak selects the formula it belongs to, and the detail
           panel follows. `selectedEntry` is read the same way, otherwise the
           panel would empty itself on every peak the cursor crossed. */
        this.parameters.selection=this.selectionKeyOf(rows[next])
        this.selectedEntry=rows[next].kind==="molecule"?null:rows[next].entry??null
        this.list?.scrollToRow(next)
        this.renderRows()
        this.renderSelection()
    }
    /* Remove whatever the given row stands for, and say what happened.

       The row is not always ONE formula. In the stoichiometry view a row is a
       MOLECULE — a group of isotopologues folded under one line — and Delete on
       it has to mean the whole group, because that is the object the user sees
       and picked. Anything else would be a lie about what the list is showing:
       the row disappears, three of its five formulae come back on the next
       resolve, and the key looks broken in the one view built to be tidy.

       It is therefore sequential and not parallel. The removals each end in a
       full resolve, and a hundred resolves fired at once would interleave their
       rebuilds against one shared `this.collections` — the last one to land
       would win, and the list would show a state no single request ever asked
       for. One at a time is the price of the list and the graph agreeing, and a
       molecule is a handful of rows, not a hundred thousand. */
    async deleteVisibleRow(row){
        const collection=this.currentCollection
        if(!collection) return
        /* UN PIC NE SE SUPPRIME PAS: LE POINT MESURÉ APPARTIENT À LA MESURE.

           Il est arrivé par le lien et il revient à la prochaine résolution,
           exactement comme une formule d'un parent. Ce que l'utilisateur peut
           jeter, c'est la formule qui l'a pris — et c'est ce qu'il verra
           disparaître: la ligne et son point ensemble. Supprimer le point seul
           le ferait revenir aussitôt et rendrait Delete cassé. */
        const keys=row.kind==="molecule"
            ?row.entries.map(entry=>entry.key)
            :[row.kind==="peak"?row.entry.key:row.key]
        /* Every key goes, or none does. Half a molecule is not a molecule, and a
           partial removal is the one outcome that would have to be explained. */
        for(const key of keys){
            const result=await this.deleteFormula(collection.name,key)
            if(!result.ok){
                this.reportDeletion(result.message,true)
                return
            }
        }
        this.reportDeletion(
            row.kind==="molecule"
                ?`removed ${formatCount(keys.length)} formulae of ${collection.name}`
                :row.kind==="peak"
                    /* On a peak line, Delete removed the FORMULA, and saying
                       "removed from X" would leave the user watching the list
                       to work out what had just gone. */
                    ?`removed ${prettyNotation(row.entry.notation)} and its measured points, from ${collection.name}`
                    :`removed from ${collection.name}`
        )
    }
    /* What a refusal or a success looks like, on the line under the field.

       The add row is where the user already looks after pressing Enter, so it is
       where a verdict belongs — and it is the only piece of the panel that is
       guaranteed to be on screen whatever state the list is in. A Dialog would
       be heavier than the event and would have to be dismissed. */
    reportDeletion(message,bad=false){
        if(!this.addHint) return
        this.addHint.textContent=message
        this.addHint.className=bad?"fc-addrow-note fc-addrow-bad":"fc-addrow-note fc-addrow-ok"
    }
    /* --- creating things, as opposed to reading them ------------------- */
    /* A READER that can only read is half a tool: the collections a user
       accumulates by hand have to live somewhere, and the answer cannot be
       "type them into a node upstream" — that node does not exist yet, and the
       user should not have to wait for it to write down a formula.

       A collection made here is LOCAL, and the difference is not cosmetic: it
       is rebuilt from the session at every resolve, so it can be added to and
       deleted, where a collection a parent made would swallow both silently
       and put the formula back on the next resolve. */
    /* The collection a typed formula belongs to, and the rule is deliberately
       forgiving because the alternative is a field that silently does nothing.

       In order: the collection on screen if this node owns it; else the first
       collection this node owns; else a new one. So a user who has never
       pressed "+ New collection" can still type a formula and press Enter, and
       it lands somewhere they can see. The stricter rule — "only into a local
       collection, and say so if there is none" — reads well and behaves like a
       form that refuses to submit, which is not what a field in a node is. */
    async targetLocalCollection(){
        if(this.currentCollection?.local) return this.currentCollection
        const first=this.parameters.localCollections[0]
        if(first){
            return this.collections.find(c=>c.name===first.name)??null
        }
        /* No collection of ours at all: one is made, and QUIETLY.

           A prompt here would be a modal popping out of a keystroke the user
           thought was a simple one, and Escape would then look like "Enter did
           nothing" all over again. The name is provisional and the handle menu
           renames it; the hint line says which collection it landed in.

           It is AWAITED: createCollection ends in a resolve, and reading
           `currentCollection` one microtask before that resolve finished would
           hand back a half-built collection — or null. */
        await this.createCollection("Formules",{ask:false})
        return this.currentCollection
    }
    async createCollection(defaultName="collection",{ask=true}={}){
        const name=ask
            ?prompt("Name of the new collection:",defaultName)?.trim()
            :defaultName
        if(!name) return null
        if(this.parameters.localCollections.some(local=>local.name===name)){
            //two collections under one name would SHARE their state record, so
            //unticking one would untick the other
            this.origin?.notice?.("Name already used",`"${name}" is already a collection here.`)
            return null
        }
        this.parameters.localCollections.push({name,keys:[]})
        this.parameters.current=name
        this.parameters.selection=null
        this.origin?.saveSessionSoon?.()
        //a resolve, like everywhere else: the new collection has to reach the
        //graph and the output without the user having to remember to ask
        await this.startResolve()
        this.resolveChildren()
        return this.currentCollection
    }
    async deleteCollection(name){
        const index=this.parameters.localCollections.findIndex(local=>local.name===name)
        /* A collection a parent made is NOT deletable: it would come back at the
           next resolve and the list would flicker. The verb is greyed out in
           the menu for the same reason.

           From the KEYBOARD it says so out loud instead of returning false in
           silence: Delete is not a button the user aimed at, it is a key they
           pressed, and a key that does nothing at all reads as a broken panel
           rather than as a refusal that has a reason. */
        if(index<0){
            this.origin?.notice?.(
                "Not yours to delete",
                `"${name}" was made by another node. It is rebuilt from that node at every resolve, so deleting it here would only make it disappear for a moment.`
            )
            return false
        }
        this.parameters.localCollections.splice(index,1)
        delete this.parameters.collectionState[name]
        /* The name is gone, so anything still pointing at it now points at
           nothing. syncCurrentCollection falls back to the first collection on
           the next resolve, but the SELECTION is a formula key and is not
           re-derived there: left alone, it would keep the detail panel
           describing a formula this node no longer holds. */
        this.parameters.selection=null
        this.selectedEntry=null
        this.openEntries.clear()
        this.openMolecules.clear()
        this.origin?.saveSessionSoon?.()
        await this.startResolve()
        this.resolveChildren()
        return true
    }
    /* The formula written into a local collection, as the text the user typed.

       The text and not the Formula, for the same reason as everywhere else: a
       session carrying formulas would carry a periodic table with them. The KEY
       would be wrong twice over — it is an identity, not a spelling, and for a
       group adduct it does not read back to the same formula. */
    async addFormulaToLocal(text){
        const typed=text.trim()
        if(!typed) return {ok:false,message:""}
        /* The table is fetched HERE, not at resolve time: the user is typing,
           and a field that answers "table…" to someone who has not pressed
           Resolve yet is a field that looks broken. Waiting here is invisible,
           because they are still holding the keyboard. */
        const table=await this.table()
        const collection=await this.targetLocalCollection()
        if(!collection){
            //the user dismissed the name prompt, or the name was taken
            return {ok:false,message:"no collection to add to"}
        }
        const local=this.parameters.localCollections.find(l=>l.name===collection.name)
        if(!local) return {ok:false,message:`"${collection.name}" is not a collection of this node`}
        /* Already there is a SUCCESS, not a refusal: the user asked for this
           formula to be in the list, and it is. Answering "no" would light the
           field red for doing exactly what they wanted. */
        if(local.keys.includes(typed)) return {ok:true,message:"already in the list"}
        //read it FIRST: a formula that does not parse must not be stored, or it
        //would come back as a diagnostic on every single resolve
        const problems=[]
        if(!table){
            return {ok:false,message:"the periodic table is not available yet, try again"}
        }
        if(!this.localFormula(typed,collection.name,problems)){
            return {ok:false,message:problems[0]??`"${typed}" is not a formula`}
        }
        local.keys.push(typed)
        /* The collection the user is looking at is DISCARDED and rebuilt from
           the texts, rather than patched. The patch would be faster; the rebuild
           is the one that cannot leave the list, the graph, the output and the
           session disagreeing — and it is also what re-resolves, which is what
           the user is entitled to expect after typing a formula in. */
        await this.startResolve()
        this.resolveChildren()
        return {ok:true,message:`added to ${collection.name}`}
    }
    /* The mirror of addFormulaToLocal: take ONE formula out of a collection of
       this node, and only of this node.

       THE LOOKUP IS THE WHOLE PROBLEM. The list shows `entry.key`, the canonical
       identity — "C6H12O6" is stored as "12C6 1H12 16O6" — while
       `localCollections[].keys` holds the TEXT the user typed. Those two strings
       are not equal and must never be compared as if they were: splicing the key
       out of a list of texts removes nothing, the formula survives the next
       resolve, and Delete looks broken in the one case where the user is most
       certain it should have worked.

       So the stored text is what is removed, and the row is located by RE-READING
       each stored text and asking for its canonical key. It costs one parse per
       formula in the collection, which is why it is done here and not in the
       render path: deletion is a deliberate act, a repaint is not.

       `collection.sources` would have answered this in O(1), and does not: the
       local collections are rebuilt from Formula OBJECTS, and asFormula only
       records a source for a STRING — so that map holds key→key for them, which
       is the very equality that must not be relied on. */
    async deleteFormula(collectionName,canonicalKey){
        const collection=this.collections.find(c=>c.name===collectionName)
        if(!collection) return {ok:false,message:"that collection is not on screen"}
        /* Only a collection this node OWNS can be written to. A parent's
           collection is rebuilt from the link at every resolve, so the formula
           would come straight back — and a Delete that undoes itself is worse
           than one that refuses and says why. */
        if(!collection.local){
            return {ok:false,message:`"${collectionName}" belongs to a parent — it comes back on the next resolve`}
        }
        const local=this.parameters.localCollections.find(l=>l.name===collectionName)
        if(!local) return {ok:false,message:`"${collectionName}" is not a collection of this node`}
        const table=this.loadedTable??await this.table()
        if(!table) return {ok:false,message:"the periodic table is not available yet, try again"}
        const stored=local.keys.findIndex(text=>{
            try{ return Formula.parse(text,table).key===canonicalKey }
            /* A text that no longer reads is NOT a reason to refuse the deletion:
               it is already dead weight in the list, and the one thing the user
               asked for is that the formula they clicked goes away. */
            catch(error){ return false }
        })
        if(stored<0) return {ok:false,message:`${prettyNotation(collection.find(canonicalKey)?.notation??canonicalKey)} is not stored here`}
        local.keys.splice(stored,1)
        /* The annotation goes with the formula. It is keyed by the canonical key
           and nothing else would ever read it again, so keeping it would grow
           every deleted formula's note forever in the session file. */
        delete this.collectionState(collectionName).notes[canonicalKey]
        if(this.parameters.selection===canonicalKey){
            this.parameters.selection=null
            this.selectedEntry=null
        }
        this.openEntries.delete(canonicalKey)
        /* Les PLICS DE PICS de cette formule partent avec elle. Ils sont les
           seules clés de `openPeaks` qui commencent par la clé canonique —
           `key#index` — donc c'est le seul endroit où ils peuvent être
           reconnus sans les lister tous. Les laisser est inoffensif (une clé
           qui ne correspond à aucune ligne ne s'affiche pas) mais ferait
           grossir l'ensemble sur une session où l'on ajoute et retire sans
           arrêt. */
        for(const folded of this.openPeaks){
            if(folded.startsWith(`${canonicalKey}#`)) this.openPeaks.delete(folded)
        }
        this.origin?.saveSessionSoon?.()
        await this.startResolve()
        this.resolveChildren()
        return {ok:true,message:`removed from ${collectionName}`}
    }
    setView(view){
        /* THREE positions, and an unknown one falls back instead of sticking:
           `view` travels in a session file, and a file this build did not write
           must not be able to leave the list in a state no switch can show —
           there would be no way back to it except reloading the file. */
        const wanted=["formula","stoichiometry","peaks"].includes(view)?view:"formula"
        if(this.parameters.view===wanted) return
        this.parameters.view=wanted
        /* The folds are cleared because a fold means nothing across views: a key
           open under "formula" is a formula, and the same key in "peaks" view is
           a peak, and the user did not ask for that. The selection survives —
           it names a formula, which exists in all three views. */
        this.openMolecules.clear()
        this.openEntries.clear()
        this.openPeaks.clear()
        this.viewToggle?.paint()
        this.renderRows()
        this.origin?.saveSessionSoon?.()
    }
    /* The FKMD gesture, on ONE line: what you type is READ as you type, and
       ENTER commits it into the list.

       Same split as FKMDNode and for the same reason — a live reading is cheap
       and catches a typo on the spot, while adding to a collection is not a
       thing you want to do by accident. The readout sits BESIDE the field on
       the same line, so "write, check, commit" is one glance at one row and
       never a second place to look. */
    buildFormulaInput(){
        const input=CE("input",{
            type:"text",
            spellcheck:false,
            placeholder:"C6H12O6 [H+]   then Enter",
            title:"Formula to add to a collection of this node. Enter adds it, Escape clears.",
            style:{width:"100%",minWidth:"0",padding:"2px 4px"}
        },[])
        this.formulaInput=input
        this.formulaReadout=CE("span",{className:"fc-readout"},[""])
        /* The RESULT of the last Enter, on the same line. Without it a refusal
           is invisible — the field would simply stay full and the list would
           not move, which is the "nothing happened" the user cannot debug. */
        this.addHint=CE("span",{className:"fc-addrow-note"},[""])
        input.addEventListener("input",()=>this.readTypedFormula(input.value))
        input.addEventListener("keydown",(event)=>{
            if(event.key==="Enter"){
                event.preventDefault()
                this.commitTypedFormula()
            }else if(event.key==="Escape"){
                input.value=""
                this.formulaReadout.textContent=""
                this.addHint.textContent=""
                input.blur()
            }
        })
        const commit=CE("button",{
            type:"button",
            title:"Add this formula to a collection of this node",
            style:{cursor:"pointer",padding:"1px 6px",flex:"none"}
        },["↵"])
        commit.addEventListener("click",()=>this.commitTypedFormula())
        return CE("div",{className:"fc-addrow"},[input,this.formulaReadout,commit,this.addHint])
    }
    /* Enter, and the ↵ button, are ONE function.

       The field is emptied only when the formula really landed, and the reason
       is written on the line either way: a formula that did not parse stays on
       screen with its error, because wiping it would throw the user's typing
       away along with the message. */
    async commitTypedFormula(){
        const input=this.formulaInput
        if(!input) return
        /* A resolve is a full re-read, and that is the POINT: the collection is
           rebuilt from the texts that were typed, so what the list shows and
           what the session holds cannot drift apart. It is also what removes
           the need to remember to press Resolve — a collection that changed and
           did not re-resolve would leave the graph and the output describing
           the collection as it was a minute ago.

           The typed text is read ONCE, before the await, because the user may
           keep typing while the table downloads. */
        const text=input.value
        const result=await this.addFormulaToLocal(text)
        //a newer keystroke may have replaced what we committed
        if(this.formulaInput!==input) return
        this.formulaReadout.textContent=""
        this.formulaReadout.className="fc-readout"
        if(result.ok){
            if(input.value===text) input.value=""
            this.addHint.textContent=result.message
            this.addHint.className="fc-addrow-note fc-addrow-ok"
            input.focus()
        }else{
            this.addHint.textContent=result.message||"nothing to add"
            this.addHint.className="fc-addrow-note fc-addrow-bad"
        }
    }
    /* The live reading. It NEVER throws: a typing mistake is a result, not an
       exception, and a resolve in flight must not die on a half-typed symbol.

       When the table is not in yet it says so and ASKS FOR IT, then re-reads
       itself once it lands. Without the second half the field would keep
       saying "table…" for ever on a node that has simply never been resolved,
       which is the state the user meets first. */
    readTypedFormula(text){
        if(!this.formulaReadout) return
        const typed=text.trim()
        if(!typed){
            this.formulaReadout.textContent=""
            this.formulaReadout.className="fc-readout"
            return
        }
        if(!this.loadedTable){
            this.formulaReadout.textContent="loading the table…"
            this.formulaReadout.className="fc-readout fc-readout-warn"
            const asked=text
            this.table().then(()=>{
                //only if the field still holds what we read for it
                if(this.formulaInput?.value===asked) this.readTypedFormula(asked)
            })
            return
        }
        try{
            const formula=Formula.parse(typed,this.loadedTable)
            this.formulaReadout.textContent=
                `${formatMz(formula.mz)} · ${prettyNotation(String(formula))}`
            this.formulaReadout.className="fc-readout"
        }catch(error){
            this.formulaReadout.textContent=error.message
            this.formulaReadout.className="fc-readout fc-readout-error"
        }
    }
    setupRightPanel(){
        const content=this.accordionRight.DOMelt.content
        content.replaceChildren()
        this.accordionRight.setSizingMode("content")
        stylize(content,{
            display:"grid",
            "grid-template-rows":"minmax(0, 1fr) auto auto",
            minHeight:"0",
            height:"100%",
            overflow:"hidden",
            padding:"3px",
            gap:"3px"
        })
        this.detail=CE("div",{
            style:{overflow:"auto",minHeight:"0",display:"grid",gap:"2px",alignContent:"start",fontSize:"0.95em"}
        },[])
        this.graphOptions=CE("div",{style:{borderTop:"1px solid var(--border)",paddingTop:"3px"}},[])
        this.clusteringOptions=CE("div",{style:{borderTop:"1px solid var(--border)",paddingTop:"3px"}},[])
        content.append(this.detail,this.graphOptions,this.clusteringOptions)
        this.renderGraphOptions()
        this.renderClusteringOptions()
    }
    renderDiagnostics(){
        if(!this.diagnosticsBand) return
        this.diagnosticsBand.replaceChildren()
        if(!this.diagnostics?.length) return
        const block=CE("div",{className:"fc-diagnostics"},[])
        block.append(CE("div",{className:"pp-caption"},["Diagnostics"]))
        for(const line of this.diagnostics.slice(0,40)){
            block.append(CE("div",{style:{opacity:"0.8"}},[line]))
        }
        if(this.diagnostics.length>40){
            block.append(CE("div",{style:{opacity:"0.6"}},[`… and ${this.diagnostics.length-40} more`]))
        }
        this.diagnosticsBand.append(block)
    }

    /* The HANDLE: the small grip under the row that opens a menu.

       A menu and not a third checkbox, because what a collection needs is a
       handful of verbs — isolate it, fold it, forget it, retitle it — and a
       panel of little boxes for verbs is a worse panel than one grip. */
    collectionHandle(collection,state){
        const handle=CE("button",{
            type:"button",
            className:"fc-handle",
            title:"Menu of this collection",
            style:{cursor:"pointer",padding:"0 3px",flex:"none"}
        },["⋮"])
        handle.addEventListener("click",(event)=>{
            event.stopPropagation()
            this.openCollectionMenu(collection,state,handle)
        })
        return handle
    }
    openCollectionMenu(collection,state,anchor){
        const others=this.collections.filter(c=>c.name!==collection.name)
        this.closeCollectionMenu()
        const items=[
            {
                label:"Isolate: graphs",
                hint:"only this collection is drawn",
                run:()=>{
                    for(const other of this.collections) this.collectionState(other.name).inGraphs=other.name===collection.name
                }
            },
            {
                label:"Isolate: output",
                hint:"only this collection leaves the node",
                run:()=>{
                    for(const other of this.collections) this.collectionState(other.name).inOutput=other.name===collection.name
                }
            },
            {
                /* The verb TOGGLES between the two ends and never mentions the
                   third: "Peaks" is not the opposite of "Stoichiometry", so a
                   two-way verb would say "Unfold the molecules" while the list is
                   showing peaks, which is neither. The switch above the list
                   names all three; this verb only moves between the two it can
                   describe, and the label always describes where it would GO. */
                label:this.parameters.view==="stoichiometry"?"Unfold the molecules":"Fold to stoichiometry",
                hint:"one row per molecule instead of per formula",
                run:()=>{
                    this.setView(this.parameters.view==="stoichiometry"?"formula":"stoichiometry")
                }
            },
            {
                label:state.open?"Hide the formulas":"Show the formulas",
                run:()=>{
                    state.open=!state.open
                    if(state.open) this.parameters.current=collection.name
                }
            },
            {
                label:"Rename…",
                hint:"the name is how the state remembers this collection",
                run:()=>{
                    const typed=prompt("Name of this collection:",collection.name)
                    if(!typed||typed.trim()===collection.name) return
                    const next=typed.trim()
                    //the notes and the checkboxes follow the name, or renaming
                    //would silently discard everything the user had said here
                    const previousName=collection.name
                    this.parameters.collectionState[next]=state
                    delete this.parameters.collectionState[previousName]
                    collection.name=next
                    if(this.parameters.current===previousName) this.parameters.current=next
                }
            },
            {
                label:"Forget its information",
                hint:"drops the annotations, keeps the formulas",
                disabled:Object.keys(state.notes).length===0,
                run:()=>{
                    state.notes={}
                    this.renderAll()
                }
            },
            {
                label:"Delete this collection",
                /* Only for a collection this node owns. Deleting one that a
                   parent made would put it back on the next resolve, and the
                   list would flicker — so the verb is shown greyed with its
                   reason rather than hidden, which teaches where the boundary
                   is. */
                hint:collection.local?"and its annotations with it":"only for a collection made here",
                disabled:!collection.local,
                run:()=>this.deleteCollection(collection.name)
            }
        ]
        const menu=CE("div",{className:"fc-menu"},[])
        for(const item of items){
            if(!item) continue
            const button=CE("button",{type:"button",title:item.hint??""},[
                CE("span",{className:"fc-menu-label"},[item.label]),
                item.hint?CE("span",{className:"fc-menu-hint"},[item.hint]):null
            ])
            if(item.disabled) button.disabled=true
            button.addEventListener("click",()=>{
                this.closeCollectionMenu()
                item.run()
                this.origin?.saveSessionSoon?.()
                this.renderAll()
                this.refreshGraph()
                this.publishOutput()
                this.resolveChildren()
            })
            menu.appendChild(button)
        }
        document.body.appendChild(menu)
        this.collectionMenu=menu
        const box=anchor.getBoundingClientRect()
        //clamped to the window: a menu that opens off-screen is a menu that
        //cannot be dismissed, because the button that closes it is not visible
        const height=menu.getBoundingClientRect().height
        menu.style.left=`${Math.max(4,Math.min(box.left,window.innerWidth-menu.offsetWidth-4))}px`
        menu.style.top=`${Math.max(4,Math.min(box.bottom+2,window.innerHeight-height-4))}px`
        this.menuCloser=(event)=>{
            if(!menu.contains(event.target)) this.closeCollectionMenu()
        }
        /* Escape closes it too. Without this the only ways out are a click
           elsewhere and a choice from the menu — and `addEventListener` with an
           undefined handler is a no-op that fails silently, so the listener
           below looked installed and was not. */
        this.menuEscape=(event)=>{
            if(event.key==="Escape"){
                event.stopPropagation()
                this.closeCollectionMenu()
            }
        }
        setTimeout(()=>{
            globalThis.addEventListener("mousedown",this.menuCloser,true)
            globalThis.addEventListener("keydown",this.menuEscape,true)
        },0)
    }
    closeCollectionMenu(){
        if(!this.collectionMenu) return
        this.collectionMenu.remove()
        this.collectionMenu=null
        globalThis.removeEventListener("mousedown",this.menuCloser,true)
        globalThis.removeEventListener("keydown",this.menuEscape,true)
    }

    /* LEVEL 1 — the collections. One row each: name, how many formulas it
       holds, the two checkboxes, and a handle that opens a menu.

       The name is a BUTTON, not a label. It is what puts that collection on
       screen underneath, and a name you cannot click is a name you read twice
       to work out which of the four rows you are already looking at. */
    buildCollectionBand(){
        this.collectionBand=CE("div",{
            className:"fc-collections",
            style:{overflow:"auto",minHeight:"0",display:"grid",gap:"2px",alignContent:"start"}
        },[])
        /* "New collection" sits at the TOP of the band, not at the bottom of
           the node: it is a verb, and a verb that scrolls away under a hundred
           collections is a verb nobody finds twice. The rows go in their own
           container so that re-rendering the list does not destroy the button
           and its handler along with it. */
        const create=CE("button",{
            type:"button",
            className:"fc-newcollection",
            title:"Create a collection here, and type formulas into it",
            style:{cursor:"pointer",padding:"2px 6px",justifySelf:"start",marginBottom:"2px"}
        },["+ New collection"])
        create.addEventListener("click",()=>this.createCollection())
        this.collectionRows=CE("div",{style:{display:"grid",gap:"2px",alignContent:"start"}},[])
        this.collectionBand.append(create,this.collectionRows)
        return this.collectionBand
    }
    renderCollections(){
        if(!this.collectionRows) return
        this.collectionRows.replaceChildren()
        if(!this.collections.length){
            this.collectionRows.append(CE("div",{
                style:{opacity:"0.7",fontSize:"0.85em",padding:"4px"}
            },["No collection yet. Create one, or connect a node that publishes Formula."]))
            return
        }
        for(const collection of this.collections){
            this.collectionRows.append(this.buildCollectionRow(collection))
        }
    }
    /* Selecting a collection is ONE function, and every control on the row calls
       it. There were two handlers — the caret and the name — each repeating the
       same five lines, and the caret's version additionally TOGGLED `open`. Two
       copies of "what happens when you pick this" is how a row ends up looking
       selected while the list under it shows something else. */
    selectCollection(name){
        if(!this.collections.some(collection=>collection.name===name)) return false
        this.parameters.current=name
        this.parameters.selection=null
        this.selectedEntry=null
        this.collectionState(name).open=true
        this.syncCurrentCollection()
        /* Clear clustering results when switching collections — they're collection-specific */
        if(this.parameters.clustering.enabled){
            this.parameters.clustering.results=null
        }
        this.origin?.saveSessionSoon?.()
        this.renderAll()
        //belt and braces: the list measures its box at paint time, and a paint
        //that happened before the panel settled would leave it stale
        this.list?.paintLater()
        this.renderClusteringOptions()
        return true
    }
    buildCollectionRow(collection){
        const state=this.collectionState(collection.name)
        const isCurrent=this.currentCollection?.name===collection.name
        const row=CE("div",{
            className:`fc-collection${isCurrent?" current":""}`,
            tabIndex:0,
            title:`${collection.name} — ${formatCount(collection.entries.length)} formulas. Delete removes it when it is yours.`
        },[])
        /* The dot is rendered on EVERY row, empty or not. It is the first cell,
           which is why it is also the first column of the grid: leaving it out
           on the rows that do not own a collection would push every other cell
           one column to the left, and a list whose controls are in a staircase
           is a list nobody trusts. */
        row.append(CE("span",{
            className:collection.local?"fc-collection-local":"fc-collection-local off",
            title:collection.local
                ?"Made in this node: it can be written to and deleted"
                :"A collection a parent made: it comes back on the next resolve"
        },[collection.local?"●":""]))
        const open=CE("button",{
            type:"button",
            className:"fc-collection-open",
            title:isCurrent?"Hide the formulas of this collection":"Show the formulas of this collection",
            /* the inline `flex` here used to do nothing at all — the row is a
               GRID, so the widths come from the template and the cells only
               need to be told not to overflow their track */
            style:{cursor:"pointer",minWidth:"0"}
        },[state.open&&isCurrent?"▾":"▸"])
        open.addEventListener("click",(event)=>{
            event.stopPropagation()
            if(this.currentCollection?.name===collection.name){
                //already on it: the caret only folds, and the list stays put
                state.open=!state.open
                this.origin?.saveSessionSoon?.()
                this.renderAll()
            }else{
                this.selectCollection(collection.name)
            }
        })
        const name=CE("button",{
            type:"button",
            className:"fc-collection-name",
            title:`${collection.name} — click to read its formulas`,
            style:{cursor:"pointer",textAlign:"left",minWidth:"0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}
        },[collection.name])
        name.addEventListener("click",()=>this.selectCollection(collection.name))
        const count=CE("span",{
            className:"fc-collection-count",
            title:`${formatCount(collection.entries.length)} formulas, ${formatCount(collection.entries.reduce((n,e)=>n+e.targets.length,0))} measured points`
        },[formatCount(collection.entries.length)])
        /* The two checkboxes, and they mean two DIFFERENT things, which is why
           they are two boxes and not one tristate: "output" is what leaves this
           node, "graph" is what is drawn in the central dialog. A user who
           wants a collection compared but not propagated ticks the second and
           not the first, and a single box could not express it. */
        const inOutput=this.collectionCheck(state,"inOutput","Include this collection in the node's output")
        const inGraphs=this.collectionCheck(state,"inGraphs","Draw this collection in the central dialog")
        const handle=this.collectionHandle(collection,state)
        row.append(open,name,count,inOutput,inGraphs,handle)
        /* DELETE / BACKSPACE on the row itself.

           The row is focusable (tabIndex above) and this is its key handler.
           Without it the user has to aim at a ⋮ and then hunt the verb in a
           floating menu to throw away a collection they just made by accident —
           which is the one moment deletion is most likely to be what they want.

           Both keys do the same thing, like they do on the nodes of the flow:
           Mac keyboards have no Delete, and Backspace is what sits under the
           right hand there. */
        row.addEventListener("keydown",(event)=>{
            if(!isDeleteKey(event)) return
            /* a checkbox that has the focus must keep Space and Enter for
               itself, and Backspace on one is not "delete the collection" —
               the row's own handler must not answer for its children */
            if(event.target!==row) return
            event.preventDefault()
            event.stopPropagation()
            this.deleteCollection(collection.name)
        })
        /* NO "focus selects" handler, and that is deliberate.

           `selectCollection` calls renderAll, which rebuilds every row of the
           band — so selecting from `focus` would destroy the very element that
           had just taken the focus, the ring would go back to the body, and the
           Delete that follows would reach nothing. The row is its own delete
           target, so it needs no state change to be deletable, and the focus
           ring alone already shows which collection the key is about to throw
           away. Selecting a collection to READ it stays a click. */
        return row
    }
    collectionCheck(state,key,title){
        const box=CE("input",{type:"checkbox",title,style:{margin:"0",flex:"none"}},[])
        box.checked=!!state[key]
        box.addEventListener("change",()=>{
            state[key]=box.checked
            this.origin?.saveSessionSoon?.()
            if(key==="inGraphs") this.refreshGraph()
            this.publishOutput()
            this.resolveChildren()
        })
        return box
    }

    /* The LEFT panel, in TWO bands: the collections, and the formulas of the
       collection on screen.

       The toolbar used to be a THIRD band, at the very top, above both — and
       that placement is what made it feel like it belonged to the collections.
       It does not: the filter keeps rows whose NOTATION matches, and the order
       menu reads a m/z, an error or an intensity. A column of collection names
       has none of those. So the toolbar sits with the formula list, directly
       above the rows it filters, where the object it acts on is one gesture
       away — and the collections get the whole top of the panel for themselves.

       The heights are decided ONCE, here, and not by the content: the
       collection list gets a bounded share and the formula list takes the rest,
       because a formula list has no natural height — it has "as much as you
       scroll" — and an accordion that grew with it would push every other
       node's panel off the panel. */
    setupLeftPanel(){
        const content=this.accordion.DOMelt.content
        content.replaceChildren()
        this.accordion.setSizingMode("viewport",{height:520})
        this.accordion.DOMelt.container.style.maxHeight="75%"
        stylize(content,{
            display:"grid",
            "grid-template-rows":"minmax(0, 34%) minmax(0, 1fr)",
            minHeight:"0",
            height:"100%",
            overflow:"hidden",
            padding:"3px",
            gap:"3px"
        })
        content.append(this.buildCollectionBand(),this.buildFormulaBand())
    }
    /* ONE row: what the list shows, what it keeps, how it is ordered, how many.
       All four are about the same list, which is why they are on one line and
       why that line belongs to the list and not to the collections above it. */
    buildToolbar(){
        const bar=CE("div",{className:"pp-row",style:{gridTemplateColumns:"auto minmax(0,1fr) auto",fontSize:"0.95em"}},[])
        /* THREE POSITIONS, and the control grew to hold them: what a line of
           the list STANDS FOR — a formula, the molecule it belongs to, or the
           measured point it was matched to. Those are three different objects,
           and a two-state switch could only name two of them, which is why
           "peaks" had no place until now.

           `segmentToggle` compares the VALUES, so `get` answers the view itself
           and not a boolean about it. The boolean form was also the one place
           the switch had been exactly backwards — the accent lit
           "Stoichiometry" while the list still showed formulae, and clicking
           "Stoichiometry" called setView("formula"). Reading the value that is
           stored removes the possibility of that class of mistake: there is no
           second value to keep in step with the first. */
        this.viewToggle=segmentToggle({
            get:()=>this.parameters.view,
            set:(value)=>this.setView(value),
            states:[
                {value:"formula",label:"Formula"},
                {value:"stoichiometry",label:"Stoichiometry"},
                {value:"peaks",label:"Peaks"}
            ],
            title:"What one line of the list stands for: a formula, the molecule it belongs to, or the measured point it was matched to"
        })
        this.filterInput=CE("input",{
            type:"search",
            value:this.parameters.filter,
            placeholder:"filter…",
            spellcheck:false,
            title:"Keep only the rows whose notation contains this text",
            style:{width:"100%",minWidth:"0",padding:"2px 4px"}
        },[])
        this.filterInput.addEventListener("input",()=>{
            this.parameters.filter=this.filterInput.value
            this.renderRows()
        })
        this.sortSelect=CE("select",{title:"Column the list is ordered by"},[])
        for(const [value,sort] of Object.entries(FORMULA_SORTS)){
            this.sortSelect.appendChild(new Option(sort.label,value))
        }
        this.sortSelect.value=this.parameters.sort
        this.sortSelect.addEventListener("change",()=>{
            this.parameters.sort=this.sortSelect.value
            this.renderRows()
        })
        this.countLabel=CE("span",{className:"pp-readout"},["—"])
        this.sortField=CE("label",{style:{display:"flex",alignItems:"center",gap:"4px",minWidth:"0"}},[this.sortSelect])
        this.sortField.title="Order of the list"
        bar.append(this.viewToggle,this.filterInput,CE("div",{style:{display:"flex",alignItems:"center",gap:"4px"}},[this.sortField,this.countLabel]))
        /* The wide "Fold to stoichiometry" button that used to sit under this row
           is GONE, and the toggle above takes its place.

           They were the same verb twice: the button called setView("stoichiometry")
           and cleared the open sets, which is what the toggle does too when it is
           moved to the right. What it cost was a full-width button under the
           toolbar — the loudest object on a panel whose whole job is a quiet
           column of formulae — to say something the first control already said.

           So the toolbar is ONE row again: view, filter, order, count. */
        return bar
    }

    /* --- the three panels ------------------------------------------------ */
    constructor(title,origin,destinationFlow,position={x:180,y:10}){
        //ONE input, and it is multiplexed: Flow.parentSynapse gathers every
        //link landing on that single anchor into one Map, so a hundred
        //collections arrive on one socket instead of a hundred sockets.
        /* TWO outputs now, and they are TWINS: the same collections, the same
           entries, the same order of collections — read two ways.

             0  the collections themselves, as data
             1  the same collections as XY waves, one per collection

           Why the second one: a collection is an object graph. Nothing that reads
           spectra can take it — not a plot, not the trimmer, not the attribution
           node. So the numbers the list is showing could not be LOOKED at, only
           read. Wiring output 1 into a plot makes the list checkable: what the
           panel claims, and what the data says, side by side.

           A second anchor, not a second list on the first: the collections and
           the waves are different kinds of thing and a consumer should say which
           it wants. Index 0 is untouched, so every link a session already has
           keeps its socket. */
        super(title,[[]],[[],[]],origin,destinationFlow,position)
        this.status="floating"
        /* formula = one row per measurable formula.
           stoichiometry = one row per MOLECULE, the isotopologues folded under
           it. The toggle is a VIEW, never a transformation: the rows below are
           the same objects either way, and unfolding restores them untouched. */
        this.parameters.view="formula"
        this.parameters.filter=""
        this.parameters.sort="mz"
        //the tolerance that pairs a formula with the points measured on it
        this.parameters.ppmWindow=5
        this.parameters.logY=false
        /* VAN KREVELEN PARAMETERS: scale and offset for O/C and H/C axes.
           These allow zooming and panning the diagram without re-computing ratios. */
        /* Van Krevelen custom axis formulas: user writes expressions like "O/C" or "1+C+N/2-H/2".
           Defaults give the classic van Krevelen O/C vs H/C. */
        this.parameters.vkXFormula="O/C"
        this.parameters.vkYFormula="H/C"
        /* CE QUE LE GRAPHE MONTRE, et l'erreur est le DÉFAUT.

           Une collection n'est pas une liste de hauteurs: c'est une liste de
           MESURES, et ce qu'un lecteur de masse veut voir d'abord est l'écart
           entre le prédit et le mesuré. L'intensité reste disponible d'un clic —
           elle dit autre chose (le signal), et elle ne doit pas disparaître, mais
           elle n'est pas la question par défaut. */
        this.parameters.graphMode=FormulaCollectionNode.GRAPH_MODE_DEFAULT
        //the collection on screen, and the formula read inside it, both by NAME
        this.parameters.current=null
        this.parameters.selection=null
        //per collection: the two checkboxes, the notes, and nothing else
        this.parameters.collectionState={}
        /* the collections the user makes HERE. Only the text they typed is
           stored, one string per formula: a Formula holds a Map indexed by
           Element, so a session carrying them would carry a periodic table
           with it. They are rebuilt at every resolve, which is why a local
           collection can be added to while a parent one cannot. */
        this.parameters.localCollections=[]
        /* CLUSTERING PARAMETERS */
        this.parameters.clustering={
            enabled:false,
            nClusters:2,
            mode:"kmeans", // "kmeans" or "spectral"
            /* PCA runs by DEFAULT: standardising each feature (centring and
               dividing by its spread) equalises the SCALES, but three
               correlated features are still one direction repeated — the
               distance between two points is then the distance along that
               dominant direction, which for m/z, intensity and error is the
               detector, not the chemistry. PCA is the step that DECORRELATES
               them, so it is on unless the user says otherwise. `0` keeps every
               component (a pure rotation — full decorrelation, no variance
               lost); a positive number keeps that many, which also denoises. */
            pcaComponents:0, // 0 = all components (decorrelate), else keep N PCs
            sigma:0, // for spectral clustering
            kNeighbors:10, // for spectral clustering
            maxIter:100, // for k-means
            seed:42, // for reproducibility
            results:null, // cached clustering results per collection
            /* LA SOURCE PAR DÉFAUT EST LE GRAPHE, et plus les cibles.

               « Targets » cluster en 3D sur [m/z, intensité, erreur ppm] des
               cibles de chaque formule. « Graph » cluster en 2D sur les points
               réellement à l'écran. Le second est le défaut parce que c'est
               celui que l'utilisateur VOIT : les clusters qu'il regarde sont
               ceux du nuage affiché, et non un nuage invisible calculé sur une
               projection qu'il n'a pas demandée. Les deux affichent les mêmes
               couleurs, mais seul le second peut plus jamais contredire l'image
               — il en est la source. */
            dataSource:"graph" // "targets" = 3D from entries, "graph" = 2D from plotted traces
        }
        //runtime only, rebuilt by every resolve
        this.collections=[]
        this.diagnostics=[]
        this.currentCollection=null
        this.selectedEntry=null
        this.loadedTable=null
        this.list=null
        this.rows=[]
        /* THE TABLE IS ASKED FOR HERE, AT CONSTRUCTION, and not on first use.

           A node that waits to be asked is a node that answers "loading…" to a
           keystroke typed AFTER the table had already arrived — which is what
           happened, and it looked like the node was broken. The App is already
           fetching it; all this does is attach to that fetch from the start.

           And when it lands, the node PUTS ITSELF RIGHT: the collections that
           were stored as text could not be read a moment ago, because a formula
           without a table is only a name. So they are re-read and the resolve
           runs, which is why a formula typed before the page finished loading
           still shows up on its own. */
        this.table().then(()=>{
            if(!this.accordion) return
            this.renderAll()
            if(this.parameters.localCollections.length) this.startResolve()
        })
        /* THE THREE FOLDS, and there are three because there are three kinds of row.

           A molecule is folded on its `molecule`, a formula on its `key`, and a
           peak on `key#index` — the peak's own key, never the formula's, or
           opening the second peak of a formula would close the first.

           They are NOT saved with the session, and that is deliberate: they are
           where the user happens to be reading, not a choice about the data.
           A file that reopened with yesterday's folds open would show a list
           longer than the collection it is a list of. */
        this.openMolecules=new Set()
        this.openEntries=new Set()
        this.openPeaks=new Set()
        const inputAnchors=this.DOMelt.querySelectorAll('.input.anchor')
        if(inputAnchors[0]){
            inputAnchors[0].innerHTML='<title>Input: any number of collections of Formula, all on this one anchor</title>'
        }
        const outputAnchors=this.DOMelt.querySelectorAll('.output.anchor')
        if(outputAnchors[0]){
            outputAnchors[0].innerHTML='<title>Output: the collections ticked for output</title>'
        }
        if(outputAnchors[1]){
            /* The second anchor, and what it says matters: a Wave is NOT a
               measurement. Its intensity is the one the collection's matching
               gave the formula — often zero, because nothing was matched on it.
               Saying "masses/intensities" without that would let it be read as a
               spectrum, and it is the opposite: it is the list, in numbers. */
            outputAnchors[1].innerHTML='<title>Output: one XY wave per ticked collection — m/z against the intensity its match gave it. Unmatched formulas are at 0, so a flat row means "no match", not "no signal"</title>'
        }
    }
    registered(e){
        if(e.detail.msg.caster!==this||this.accordionRight){
            return
        }
        super.registered(e)
        const {channel,registrationName,label}=e.detail.msg
        /* The right panel is the DETAIL of what the left list has selected:
           the full key, the mass, every target with its error, and the free
           text. The left panel stays a list — putting ten thousand rows and
           their commentary in one column would make both unreadable. */
        this.accordionRight=new Accordion(
            `${label} (detail)`,
            this.origin,
            this.origin.main.querySelector(".vertical.right.content")
        )
        channel.register(`${registrationName}:detail`,this.accordionRight,`${label} (detail)`)
        this.setupLeftPanel()
        this.setupRightPanel()
        /* Wrap graph.drawGraph so van Krevelen centroids, barycentric poles, and cluster centroids redraw on every zoom/pan. */
        const origDrawGraph=this.graph.drawGraph.bind(this.graph)
        this.graph.drawGraph=()=>{
            origDrawGraph()
            this.drawVkCentroids()
            this.drawBarycentricPoles()
            this.drawClusterCentroids()
        }
        this.drawVkCentroids=function(){
            const svg=this.graph.graphSVG
            if(!svg) return
            let xScale,yScale
            try{ ({xScale,yScale}=this.graph.plotScales()) }catch{ return }
            if(!xScale||!yScale) return
            const anchor=svg.select(".anchor")
            if(anchor.empty()) return
            const visible=this.parameters.graphMode==="vankrevelen"?this.centroids??[]:[]
            const centroidGroup=anchor.selectAll("g.vk-centroid")
                .data(visible,d=>d.collection.name)
            const enter=centroidGroup.enter()
                .append("g")
                .attr("class","vk-centroid")
            enter.merge(centroidGroup)
                .attr("transform",d=>`translate(${xScale(d.meanX)},${yScale(d.meanY)})`)
                .each(function(d){
                    const g=d3.select(this)
                    g.selectAll("*").remove()
                    g.append("circle").attr("r",10).attr("fill","none").attr("stroke",d.color).attr("stroke-width",3).attr("opacity",0.5)
                    g.append("circle").attr("r",4).attr("fill",d.color).attr("stroke","white").attr("stroke-width",1.5)
                })
            centroidGroup.exit().remove()
        }.bind(this)
        this.drawBarycentricPoles=function(){
            const svg=this.graph.graphSVG
            if(!svg) return
            let xScale,yScale
            try{ ({xScale,yScale}=this.graph.plotScales()) }catch{ return }
            if(!xScale||!yScale) return
            const anchor=svg.select(".anchor")
            if(anchor.empty()) return
            const visible=this.parameters.graphMode==="barycentric"?this.barycentricPoles??[]:[]
            const poleGroup=anchor.selectAll("g.barycentric-pole")
                .data(visible,d=>`${d.collection.name}:${d.element}`)
            const enter=poleGroup.enter()
                .append("g")
                .attr("class","barycentric-pole")
            anchor.selectAll("circle.barycentric-unit").remove()
            const poleColors=this.collections
            enter.merge(poleGroup)
                .attr("transform",d=>`translate(${xScale(d.x)},${yScale(d.y)})`)
                .each(function(d){
                    const g=d3.select(this)
                    const color=d.collection?traceColor(poleColors.indexOf(d.collection)):"#666"
                    g.selectAll("*").remove()
                    g.append("circle").attr("r",14).attr("fill","none").attr("stroke","#fff").attr("stroke-width",2).attr("opacity",0.9)
                    g.append("text")
                        .attr("text-anchor","middle")
                        .attr("dominant-baseline","central")
                        .attr("dy","0.05em")
                        .attr("font-size","16px")
                        .attr("font-weight","bold")
                        .attr("fill","#fff")
                        .text(d=>d?.element?.symbol??String(d?.element??""))
                })
            poleGroup.exit().remove()
        }.bind(this)
        this.drawClusterCentroids=function(){
            const svg=this.graph.graphSVG
            if(!svg) return
            let xScale,yScale
            try{ ({xScale,yScale}=this.graph.plotScales()) }catch{ return }
            if(!xScale||!yScale) return
            const anchor=svg.select(".anchor")
            if(anchor.empty()) return
            const clust=this.parameters.clustering
            /* CLUSTER MEANS ARE DRAWN IN EVERY MODE, as a RING. A cluster is
               computed almost independently of what is drawn — the point cloud
               below is the selected graph type (error, intensity, van Krevelen
               or barycentric), coloured by the clusters, and the means are
               rings so a mean is never mistaken for a point. A targets-source
               cluster only has an m/z and an intensity/error to place, so on a
               van Krevelen or barycentric axis those means fall off the data
               (clusterCenterXY returns NaN) and are simply not drawn there —
               which is correct, not a bug: run the clustering on the graph
               traces to get means that sit on a ratio plot.

               ROND ET NON CARRÉ: les autres marques du graphique sont des
               points ronds, et un carré se lit comme un changement de nature
               alors qu'il n'y en a pas — le rectangle disait « mesuré » là où
               le cercle dit « moyen ». Un disque plein collé au nuage se
               confondait avec un point de données; le cercle creux garde la
               distinction de taille et de trait qu'un carré donnait, sans
               l'angle droit qui avait l'air d'une erreur d'affichage. */
            /* RIEN À DESSINER N'EST UN CAS LÉGITIME, PAS UNE RAISON DE SORTIR.

               Le retrait doit avoir lieu même quand il n'y a plus rien à
               tracer. Retourner ici laissait les groupes `g.cluster-centroid`
              restaient dans le DOM après le décochage: d3 n'a jamais eu l'occasion
               de voir une sélection vide, donc rien n'est sorti, et les
               étiquettes restaient peintes sur un graphique qui ne portait plus
               aucun cluster. `drawVkCentroids` et `drawBarycentricPoles` ne
               tombent pas dans le piège parce qu'ils construisent une liste
               `visible` vide et laissent `exit().remove()` faire son travail —
               c'est la forme à imiter. */
            const live=!!(clust.enabled&&clust.results&&clust.results.centers)
            const pairs=[]
            if(live){
                const nClusters=clust.results.nClusters
                for(let i=0;i<nClusters;i++){
                    const [x,y]=this.clusterCenterXY(i)
                    if(Number.isFinite(x)&&Number.isFinite(y)){
                        pairs.push({x,y,index:i})
                    }
                }
            }
            const self=this
            const centroidGroup=anchor.selectAll("g.cluster-centroid")
                .data(pairs,d=>d.index)
            const enter=centroidGroup.enter()
                .append("g")
                .attr("class","cluster-centroid")
                .style("cursor","pointer")
            enter.merge(centroidGroup)
                .attr("transform",d=>`translate(${xScale(d.x)},${yScale(d.y)})`)
                .each(function(d){
                    const g=d3.select(this)
                    const color=self.getClusterColor(d.index,clust.results.nClusters)
                    g.selectAll("*").remove()
                    /* LE ROND: un moyen, pas une mesure. Couronne creuse dans
                       la couleur du cluster, l'index au centre, pour qu'il ne
                       se confonde jamais avec un point du nuage voisin. */
                    g.append("circle")
                        .attr("r",11)
                        .attr("fill","none")
                        .attr("stroke",color)
                        .attr("stroke-width",3)
                        .attr("opacity",0.9)
                    g.append("circle")
                        .attr("r",7)
                        .attr("fill",color)
                        .attr("stroke","white")
                        .attr("stroke-width",2)
                    g.append("text")
                        .attr("text-anchor","middle")
                        .attr("dominant-baseline","central")
                        .attr("font-size","11px")
                        .attr("font-weight","bold")
                        .attr("fill","white")
                        .attr("stroke","black")
                        .attr("stroke-width","0.5")
                        .attr("paint-order","stroke fill")
                        .text(d.index+1)
                })
                .on("click",(event,d)=>{
                    event.stopPropagation()
                    self.selectClusterInList(d.index)
                })
            centroidGroup.exit().remove()
        }.bind(this)
    }
    renderAll(){
        this.renderCollections()
        this.renderAddRow()
        this.renderRows()
        this.renderSelection()
        this.renderDiagnostics()
    }

    /* --- the rows the left panel shows ---------------------------------- */
    /* One list, three shapes, and the difference is only in what a row HOLDS.

       In "formula" view a row is a leaf. In "stoichiometry" view a row is a
       molecule: the leaves that share a root are folded into it, and the count
       in front says how many. The fold is a GROUPING, never a merge: the
       formulas keep their own keys, their own m/z and their own targets, and
       unfolding gives every one of them back exactly as it was. What is lost
       by folding is the noise of a thousand isotopologues competing for one
       line, and nothing else. */
    visibleRows(){
        const collection=this.currentCollection
        if(!collection) return []
        const entries=collection.entries
        const filter=this.parameters.filter.trim().toLowerCase()
        const openEntries=this.openEntries
        const openMolecules=this.openMolecules
        const openPeaks=this.openPeaks
        /* LE PLI, ET CE QU'IL OUVRE.

           Un pli est une CLÉ dans un ensemble, jamais un drapeau posé sur la
           ligne: la ligne est reconstruite à chaque peinture, donc un drapeau
           qu'elle porterait serait perdu au premier rendu. Les trois ensembles
           sont les trois questions — qu'est-ce que je déplie ? — et ils sont lus
           avec `?.` parce qu'une collection peut être là sans qu'aucun pli ne
           soit ouvert: une liste qu'on n'a pas dépliée ne doit pas lever. */
        const peakCount=(entry)=>(entry.targets??[]).length
        /* LA PROVENANCE D'UN PIC, et c'est une question de traçabilité.

           Un point mesuré arrive par le lien. Ce qui l'a attaché à CETTE formule
           est soit une clé qu'il portait lui-même — le producteur l'a nommé, et
           c'est une affirmation de l'amont — soit la proximité que NOUS avons
           décidée, et c'est un calcul. Les deux se disent, et les confondre
           ferait passer une décision locale pour une mesure amont.

           Le `cost` est le prix que l'appariement a payé pour ce point; il ne
           dit pas d'où il vient mais ce qu'il a coûté, et il est sur la cible
           depuis le début — il était déjà dans le panneau de détail, où il
           n'était visible qu'après un clic.

           `named` est lu sur la cible et, à défaut, sur le point source: une cible
           qui a survécu à un adoption peut n'avoir plus son `source`, et alors
           la provenance se déduit de ce qu'il reste — ou se dit absente. */
        const provenance=(target)=>{
            if(!target) return "measured"
            const named=target.named??(typeof target.source?.key==="string")
            const parts=[named?"named":"nearest"]
            if(Number.isFinite(target.cost)) parts.push(`cost ${target.cost.toFixed(3)}`)
            return parts.join(" · ")
        }
        /* UNE LIGNE DE PIC. Ce n'est pas la formule: c'est le point MESURÉ, tel
           que l'appariement l'a retenu.

           La case large n'affiche PAS la notation de la formule qui l'a pris:
           elle affiche la PROVENANCE du point. En vue « formula » la formule est
           juste au-dessus, et en vue « peaks » elle est dans le pli — donc dans
           les deux cas la ligne dit ce que la ligne ne peut pas déjà dire. Ce
           qu'elle porte, c'est l'intensité mesurée, le m/z mesuré, l'erreur, et
           d'où vient le point. */
        const peakRow=(entry,index,depth,parentKey)=>{
            const target=entry.targets[index]
            return {
                kind:"peak",
                depth,
                parentKey,
                entry,
                target,
                key:`${entry.key}#${index}`,
                ownerKey:entry.key,
                /* La notation reste lisible — elle est dans l'infobulle et dans
                   le filtre — mais ce n'est plus elle qui est écrite. */
                notation:entry.notation,
                provenance:provenance(target),
                /* LE m/z MESURÉ, et non celui de la formule: la ligne EST le
                   point, donc elle porte la mesure. La formule affiche déjà la
                   sienne, et les deux se suivent ligne après ligne. */
                mz:target.mz,
                intensity:target.intensity,
                errorPpm:target.errorPpm,
                /* UN pic est UN pic. L'ordre « peaks » dégénère donc en ordre du
                   m/z dans cette vue — ce qui est la seule réponse honnête: on ne
                   va pas faire passer un pic devant un autre en comptant ses
                   voisins. L'ordre par nombre de pics se choisit dans les deux
                   autres vues, où la ligne est une formule ou une molécule et le
                   compte a un sens. */
                peaks:1,
                note:entry.note??"",
                /* UN PIC OUVRE UNE SEULE CHOSE: la formule qui l'a pris. */
                childCount:1
            }
        }
        /* UNE LIGNE DE FORMULE, et la même que celle de la vue « formula ». `depth`
           vaut l'indentation, et `parentKey` nomme la ligne qui l'a ouverte:
           les deux sont posés ici plutôt que déduits à l'affichage, parce que
           la ligne est reconstruite à chaque peinture et ne peut donc pas se
           souvenir d'où elle vient. */
        const formulaRow=(entry,depth,parentKey)=>({
            kind:"formula",
            depth,
            parentKey,
            entry,
            key:entry.key,
            notation:entry.notation,
            mz:entry.mz,
            /* Les deux champs que le comparateur LIT, posés à plat sur la
               ligne. Ils vivaient dans `entry`, et le comparateur les
               cherchait sur la ligne: il y trouvait `undefined` aux deux
               endroits, donc `intensity` et `error` renvoyaient 0 pour
               toutes les paires et retombaient sur le m/z. Choisir « erreur »
               dans le menu ne changeait donc RIEN à l'ordre — sans lever la
               moindre exception, ce qui est la pire façon de ne pas
               fonctionner. */
            intensity:entry.intensity,
            errorPpm:entry.errorPpm,
            peaks:peakCount(entry),
            note:entry.note??"",
            /* UNE FORMULE OUVRE SES PICS CIBLES, et rien d'autre. Le compte est
               posé ici parce que c'est lui qui décide si la ligne a une
               poignée: une formule sans cible n'a rien à montrer, et une
               poignée qui s'ouvre sur du vide est une poignée qui ment. */
            childCount:peakCount(entry)
        })
        /* LES ENFANTS, ET LA RÈGLE EST UN NIVEAU.

           Ce qu'une ligne ouvre dépend de ce qu'elle EST, et elle n'ouvre
           QU'UNE chose:
             - une formule déplie ses PICS CIBLES — la mesure, avec sa masse
               mesurée, son intensité et sa provenance, et PAS les formules;
             - une molécule déplie ses FORMULES — la stœchiométrie est la ligne,
               ses formules sont le contenu;
             - un pic déplie LA FORMULE qui l'a pris — le pic est la ligne, sa
               formule est le contenu.

           Un seul niveau, et c'est une règle de lecture autant qu'une sécurité:
           la ligne dépliée est le DÉTAIL de la ligne qui la contient, et un
           détail qui se redéplie devient une deuxième arborescence à gérer pour
           une information qu'on lit déjà sur la ligne du dessus. La boucle
           vicieuse que cela autorisait — pic → formule → le MÊME pic → formule —
           devient impossible par construction, et non plus par un plafond. */
        const childrenOf=(row)=>{
            if(row.kind==="molecule") return row.entries.map(entry=>formulaRow(entry,row.depth+1,row.key))
            if(row.kind==="peak") return [formulaRow(row.entry,row.depth+1,row.key)]
            return (row.entry.targets??[]).map((target,index)=>peakRow(row.entry,index,row.depth+1,row.key))
        }
        const isOpen=(row)=>{
            if(row.kind==="molecule") return !!openMolecules?.has(row.molecule)
            if(row.kind==="peak") return !!openPeaks?.has(row.key)
            return !!openEntries?.has(row.key)
        }
        /* LA PROFONDEUR EST 1, et elle n'est plus un PLAFOND de sécurité: c'est la règle
           du pli, celle qu'on vient d'écrire. Elle reste une constante nommée
           parce que la lire dans la boucle coûte moins cher que de la redécouvrir
           à chaque ligne, et parce qu'un jour une vue en aura besoin d'autre
           chose — et ce jour-là le numéro sera là, avec le test qui compte. */
        const MAX_DEPTH=1
        let rows
        if(this.parameters.view==="peaks"){
            /* LA VUE « PICS », et c'est la troisième lecture de la même
               collection: la liste ne montre plus ce qui a été PRÉDIT mais ce qui
               a été MESURÉ. Une ligne est un point du pic de la formule qui l'a
               pris, donc la formule est écrite à côté de lui — sans elle, la
               ligne serait un m/z sans auteur.

               Elle répond à la question que les deux autres vues ne peuvent pas:
               « qu'est-ce qui a été mesuré, et par qui ? ». Les deux autres
               répondent « qu'est-ce qui a été prédit, et avec quelle erreur ? ».
               Les pics y sont donc rangés par erreur ou par intensité sans qu'on
               ait à les chercher feuille par feuille. */
            rows=[]
            for(const entry of entries){
                const targets=entry.targets??[]
                for(let index=0;index<targets.length;index++){
                    rows.push(peakRow(entry,index,0,null))
                }
            }
        }else if(this.parameters.view==="stoichiometry"){
            const groups=new Map()
            for(const entry of entries){
                const key=entry.molecule??entry.key
                if(!groups.has(key)) groups.set(key,{molecule:key,entries:[]})
                groups.get(key).entries.push(entry)
            }
            rows=[...groups.values()].map(group=>({
                kind:"molecule",
                depth:0,
                parentKey:null,
                molecule:group.molecule,
                entries:group.entries,
                /* La clé d'une molécule est la sienne, préfixée — et non celle de
                   sa première feuille, comme c'était le cas. Deux raisons, et la
                   seconde est celle qui casse: la feuille était aussi la clé de la
                   LIGNE qui la représente, donc une molécule et l'une de ses
                   feuilles ne pouvaient pas être sélectionnées l'une sans l'autre,
                   et « la ligne sélectionnée » devenait ambiguë dès qu'on dépliait.
                   Le préfixe rend les deux lignes distinctes, donc les deux
                   sélectionnables, donc dépliables sans que l'une mange l'autre. */
                key:`mol:${group.molecule}`,
                /* The group is LABELLED with the key that grouped it, not with
                   the notation of whichever leaf happened to come first.

                   `String(root)` is what this used to print, and it is wrong for
                   every protonated or adducted species: toString writes from
                   `written` — the core — while the grouping reads `counts`, which
                   carries the absorbed group. So CH4;H+ is grouped as CH5+ and then
                   LABELLED "CH4[H+]", a formula with five hydrogens written as
                   four plus a bracket. The row said one thing and the count in
                   front of it (×2, both spellings) said another.

                   moleculeKey is the one string guaranteed to describe the whole
                   group: it is what put these leaves in this box, and it is
                   already a display form — Hill order, no isotope mass numbers.
                   Printing it also makes the label independent of the ORDER of
                   the entries, which "the first leaf" never was: the same
                   collection could show CH4[H+] or CH5[+] on two machines that
                   enumerated their parents differently. */
                notation:group.molecule,
                /* LE m/z DE LA STŒCHIOMÉTRIE, et non la moyenne de ses feuilles.

                   La moyenne était un nombre que rien ne mesure: elle ne
                   correspond ni à une masse prédite, ni à une masse observée, et
                   elle se trouvait dans la MÊME colonne que le m/z des autres
                   lignes — donc comparable, donc fausse. La racine, elle, a une
                   masse à elle, calculée par la même table que les feuilles.

                   Elle n'est pas toujours là: une entrée reconstruite par un
                   adoptiveur externe peut n'avoir pas de `root`, et alors on
                   garde la moyenne — moins juste, mais présente, ce qui vaut
                   mieux qu'un tiret sur une ligne dont la masse est connue par
                   ses feuilles. */
                mz:Number.isFinite(group.entries[0].root?.mz)
                    ?group.entries[0].root.mz
                    :group.entries.reduce((n,e)=>n+e.mz,0)/group.entries.length,
                count:group.entries.length,
                /* LES DEUX CHAMPS DE TRI D'UNE MOLÉCULE, et ils ne se moyennent
                   pas de la même façon — délibérément.

                   L'INTENSITÉ S'ADDITIONNE. C'est une quantité de signal: une
                   molécule dont dix isotopologues sont mesurés porte dix fois le
                   signal, et c'est cette ligne-là qu'on cherche quand on trie par
                   intensité. Une moyenne répondrait « chaque isotopologue
                   contribue également », ce qui est une autre question et pas
                   celle qu'on pose.

                   L'ERREUR, ELLE, N'EXISTE PAS POUR UN GROUPE: une molécule n'a
                   pas été mesurée, ses feuilles l'ont été. Lui donner une moyenne
                   fabriquerait un nombre qui ne correspond à rien de mesuré, et
                   le placerait à côté des vraies erreurs. Elle vaut donc
                   `Infinity`, ce qui la met en FIN de liste par défaut — une
                   molécule ne se glisse jamais devant une feuille qu'elle ne peut
                   pas concurrencer. */
                intensity:group.entries.reduce((n,e)=>n+(Number.isFinite(e.intensity)?e.intensity:0),0),
                errorPpm:Infinity,
                /* LE NOMBRE DE PICS d'une molécule est la SOMME de ceux de ses
                   feuilles, pour la même raison que l'intensité: c'est du signal,
                   et c'est la somme qui dit ce que la molécule couvre. Une
                   moyenne répondrait « chaque isotopologue couvre autant », ce qui
                   n'est pas du tout la même question. */
                peaks:group.entries.reduce((n,e)=>n+peakCount(e),0),
                /* UNE STŒCHIOMÉTRIE OUVRE SES FORMULES, et rien d'autre. */
                childCount:group.entries.length
            }))
        }else{
            rows=entries.map(entry=>formulaRow(entry,0,null))
        }
        if(filter){
            rows=rows.filter(row=>String(row.notation??"").toLowerCase().includes(filter)
                ||(row.kind==="molecule"&&row.entries.some(e=>e.key.toLowerCase().includes(filter))))
        }
        rows.sort(formulaComparator(this.parameters.sort))
        /* LE DÉPLOIEMENT, et il se fait ICI, après l'ordre — jamais avant.

       Le tri s'applique aux lignes de TÊTE, et les enfants tiennent à leur
       parent: un pic garde la place de la formule qui l'a pris, quelle que
       soit l'intensité qu'on ait choisi de suivre. Les enfants sont donc insérés
       une fois la liste de tête dans son ordre, et ils la suivent partout.

       LA PILE, ET NON UN `push` DANS `rows`. Les deux font le même nombre de
       lignes et pas la même liste: pousser à la fin les plaçait TOUS en bas,
       si bien qu'une formule dépliée affichait ses pics sous les trois lignes
       qui la suivent — donc pas sous elle. Une liste de mesures rangée sous des
       formules auxquelles elle n'appartient pas est pire qu'une liste sans
       plis du tout. La pile sort un ENFANT AVANT son frère, donc chaque parent
       est suivi immédiatement des siens.

       `return rows` reste le nom du résultat, et `heads` la liste triée: les
       deux sont des lignes de la même liste, l'une avant déploiement et l'autre
       après, et le tri ne s'applique qu'à la première. */
        const heads=rows
        rows=[]
        const stack=[...heads].reverse()
        while(stack.length){
            const row=stack.pop()
            rows.push(row)
            if(row.depth>=MAX_DEPTH||!isOpen(row)) continue
            const children=childrenOf(row)
            for(let i=children.length-1;i>=0;i--){
                /* UN ENFANT EST UNE FEUILLE, et il le devient ICI, une fois pour
                   toutes, plutôt que dans les trois constructeurs: une formule
                   sait qu'elle a des pics, mais celle qui est déjà le contenu d'un
                   pli n'a plus rien à ouvrir. Sans cela elle afficherait une
                   poignée qui s'ouvrirait sur du vide — une poignée qui ment,
                   et le pli ne s'y produirait pas puisque la boucle s'arrête
                   au premier niveau. */
                children[i].childCount=0
                stack.push(children[i])
            }
        }
        return rows
    }
    renderRows(){
        if(!this.list) return
        const rows=this.visibleRows()
        this.rows=rows
        this.list.setRows(rows)
        this.updateCountReadout(rows)
    }
    updateCountReadout(rows){
        if(!this.countLabel) return
        const collection=this.currentCollection
        if(!collection){
            this.countLabel.textContent="—"
            this.countLabel.title="no collection selected"
            return
        }
        const entries=collection.entries
        const view=this.parameters.view
        /* LE DÉNOMINATEUR EST CELUI DE LA VUE, et non le nombre de formules.

           Le numérateur, lui, ne compte que les lignes de TÊTE: une ligne
           dépliée est sur l'écran mais ne fait pas partie de ce que la vue
           compte, et un « 12 / 8 » serait illisible. Les enfants se voient dans
           le pli qui les a ouverts. */
        const shown=rows.reduce((n,row)=>n+(row.depth===0?1:0),0)
        const molecules=new Set(entries.map(e=>e.molecule??e.key)).size
        const peaks=entries.reduce((n,e)=>n+(e.targets?.length??0),0)
        const pool=view==="stoichiometry"?molecules:view==="peaks"?peaks:entries.length
        this.countLabel.textContent=`${formatCount(shown)} / ${formatCount(pool)}`
        this.countLabel.title=[
            `${formatCount(shown)} shown`,
            `${formatCount(entries.length)} formulas`,
            `${formatCount(molecules)} molecules`,
            `${formatCount(peaks)} measured points`
        ].join(", ")
    }
    /* The row itself. Plain divs, not the Table class: that one is a grid of
       strings with a ruler, and what is needed here is a row with a note
       marker, a title, and a click that means something.

       TWO MODES IN ONE FUNCTION, because the pool must not grow a second kind
       of element: a null element BUILDS a fresh one, a real one gets FILLED.
       Two callbacks would mean two pools of the same thing, and a recycled
       element must never activate the formula it used to be showing — which is
       why the row is re-attached on every single fill. */
    drawRow(element,row){
        if(!element){
            const root=CE("div",{className:"fc-row"},[])
            /* LA POIGNÉE, et elle est un BOUTON dans la ligne, pas la ligne
               elle-même. Un clic sur le nom ne doit plus ouvrir et fermer: lire
               une ligne et la déplier sont deux gestes, et les confondre oblige
               à regarder la liste pour savoir si l'on lit ou si l'on navigue.

               Elle est dans le flux de la ligne — la première colonne — et non
               posée par-dessus: une poignée en surimpression vole la place du
               texte qu'elle recouvre, et la colonne fait que toutes les lignes
               s'alignent, poignée ou non. Une ligne sans rien à ouvrir garde la
               colonne vide (`.fc-fold` est invisible par défaut), parce qu'une
               colonne qui saute selon la ligne est une colonne qu'on ne peut
               plus lire en diagonale. */
            const fold=CE("button",{
                type:"button",
                className:"fc-fold",
                title:"Open or close this line"
            },["▸"])
            const notation=CE("span",{className:"fc-cell fc-notation"},[""])
            const mz=CE("span",{className:"fc-cell fc-num"},[""])
            const error=CE("span",{className:"fc-cell fc-num"},[""])
            const intensity=CE("span",{className:"fc-cell fc-num"},[""])
            const note=CE("span",{className:"fc-cell fc-note"},[""])
            root.append(fold,notation,mz,error,intensity,note)
            //one listener, not the app's delegated handleClick AND one of our
            //own: both would fire on a single click and toggle the row twice
            root.addEventListener("click",(event)=>{
                event.stopPropagation()
                if(root.row) this.activateRow(root.row)
            })
            /* La poignée remonte l'événement ET s'arrête là: sans ça le clic
               remonterait jusqu'à la ligne, qui sélectionnerait la formule en
               même temps qu'elle la déplierait — un seul clic, deux effets, et
               la sélection qui saute sur une ligne qu'on voulait juste lire. */
            fold.addEventListener("click",(event)=>{
                event.stopPropagation()
                if(root.row) this.toggleFold(root.row)
            })
            root.cells=[fold,notation,mz,error,intensity,note]
            root.notation=notation
            root.fold=fold
            return root
        }
        const [fold,notation,mz,error,intensity,note]=element.cells
        element.row=row
        /* LA POIGNÉE, et elle ne se voit que sur une ligne qui a quelque chose
           à montrer. `foldable` est posée même quand la ligne est fermée, parce
           que la question « y a-t-il quelque chose dedans ? » se pose avant la
           question « est-ce ouvert ? », et une poignée absente répond aux deux
           par la négative. */
        const foldable=(row.childCount??0)>0
        const unfolded=this.isFolded(row)
        element.classList.toggle("foldable",foldable)
        fold.textContent=foldable?(unfolded?"▾":"▸"):""
        fold.title=foldable
            ?unfolded?"Close this line":`Open the ${row.kind==="peak"?"formula":"lines"} of this one`
            :""
        /* LA CASE LARGE, et elle ne dit pas la même chose selon la ligne.

           Une formule s'affiche par sa notation; un pic par sa PROVENANCE,
           parce que la formule qui l'a pris est soit la ligne juste au-dessus,
           soit le contenu de son pli — donc toujours déjà lue. Écrire la
           notation sur les deux ferait de la case large une colonne qui répète,
           et c'est la colonne qui porterait alors l'information la plus
           importante: celle qui dit d'où vient la mesure. */
        notation.textContent=row.kind==="peak"
            ?row.provenance
            :prettyNotation(row.notation)
        element.notation.title=row.kind==="molecule"
            ?`${formatCount(row.count)} formulas on this stoichiometry — open it to see them`
            :row.kind==="peak"
                /* A peak's identity is the PAIR: the point that was measured, and
                   the formula that took it. The wide cell already says where the
                   point came from, so the title says which point and whose. */
                ?`${row.provenance}\nmeasured at ${formatMz(row.mz)}, intensity ${formatValue(row.intensity)}\ntaken by ${row.ownerKey}`
                :row.key
        mz.textContent=formatMz(row.mz)
        if(row.kind==="molecule"){
            /* The count REPLACES the error column in this view: a molecule has
               no error of its own, and "how many did I just fold" is the
               number the user is looking for at that moment. */
            error.textContent=`×${formatCount(row.count)}`
            error.className="fc-cell fc-count"
            intensity.textContent=""
            note.textContent=""
            note.title=""
        }else{
            /* A peak reads its own numbers — the point's, not the formula's — and
               they are not the same thing: a formula carries the error of its
               CLOSEST target only, while the line the user just unfolded is a
               particular target with its own error. Printing the formula's error
               on every one of its lines would say the same number twice and be
               wrong on all but the first. */
            const measured=row.kind==="peak"
            const errorPpm=measured?row.errorPpm:row.entry.errorPpm
            const value=measured?row.intensity:row.entry.intensity
            const entryNote=row.entry.note??""
            error.textContent=Number.isFinite(errorPpm)
                ?`${errorPpm>=0?"+":""}${errorPpm.toFixed(1)}`
                :"—"
            error.className="fc-cell fc-num"
            intensity.textContent=Number.isFinite(value)?formatValue(value):"—"
            /* The pen belongs to the FORMULE, so it shows on a formula line and
               on the peak lines of that same formula — a note written against a
               peak has to be findable from the peak. */
            note.textContent=entryNote?"✎":""
            note.title=entryNote||"no information yet — write some in the panel on the right"
        }
        /* L'INDENTATION, et elle est le seul signe qu'une ligne est un enfant.

           Une barre de couleur ne suffirait pas: la ligne est déjà teintée quand
           elle est sélectionnée, et deux teintes sur une ligne de cette densité
           sont deux signaux de trop. Le retrait se lit sans concurrencer quoi que
           ce soit, et il survit au changement de vue parce qu'il est dans la
           classe et pas dans la couleur. Le PAS est une variable CSS — la
           géométrie de la ligne reste dans la feuille de style, et cette méthode
           ne dit que QUELLE ligne c'est. */
        const depth=row.depth??0
        element.style.setProperty("--fc-depth",String(depth))
        element.classList.toggle("child",depth>0)
        element.classList.toggle("selected",this.isSelected(row))
        element.classList.toggle("unfolded",this.isFolded(row))
        return element
    }

/* --- the central graph: one trace per collection the user ticked ----- */
    /* What is drawn is the COLLECTION, not the formula list: one trace per
       ticked collection. WHAT a point SAYS is the choice — `graphMode`, whose
       default is the error against the measured mass.

        TROIS QUESTIONS, et aucune ne répond à la place de l'autre:

          error       x = the mass actually MEASURED (target.mz), y = the error in
                      ppm the matching computed against the formula. C'est la vue
                      par défaut, parce que c'est elle qui répond à « cette
                      collection est-elle juste ? » — et la réponse se lit à l'œil:
                      un nuage resserré autour de zéro, ou deux groupes nettement
                      décalés, se voient sans qu'on lise une seule valeur.

          intensity   x = the same measured mass, y = the signal. C'est le
                      spectre, et c'est ce qu'il faut quand la question est
                      « y a-t-il du signal ? ».

          vankrevelen x = O/C ratio (oxygen/carbon), y = H/C ratio (hydrogen/carbon).
                      C'est le diagramme de van Krevelen, utilisé pour classer
                      la matière organique. Les points sont les formules elles-mêmes,
                      pas des pics mesurés. Deux champs de réglage (scale/offset)
                      permettent de zoomer/déplacer le diagramme.

        Le mode est dans les PARAMÈTRES, donc dans la session — un graphe qui
        changerait de sens au chargement serait un graphe qu'on ne peut pas
        comparer d'un jour à l'autre.

        Le BUDGET est le même dans les trois modes: un arrêt dur, dit tout haut.
        Cent collections de cinquante mille formules, c'est cinq millions de
        points, et un tampon WebGL de cette taille n'est pas un graphe lent,
        c'est un onglet mort. Ce qui a été écarté est COMPTÉ dans le readout
        plutôt que de saigner en silence dans l'image. */
    /* LE POINT N'EST PAS LE MÊME DANS LES TROIS CAS, et l'écart le dit.

        En ERREUR/INTENSITÉ, un point = un PIC MESURÉ apparié à une formule.
        En VAN KREVELEN, un point = une FORMULE (sa composition élémentaire).
        Les formules sans carbone sont exclues (division par zéro). */
    async refreshGraph(){
        if(!this.graph) return
        /* LE MODE EST LU ICI ET PAS DÉJÀ NORMALISÉ ailleurs, parce que c'est le
           seul endroit qui sait ce qu'un point EST: `restoreState` ne fait que
           vérifier que le nom existe, et une valeur inconnue retombe sur le
           défaut au lieu d'effacer le graphe. */
        const mode=this.parameters.graphMode??FormulaCollectionNode.GRAPH_MODE_DEFAULT
        const isVankrevelen=mode==="vankrevelen"
        const byError=!isVankrevelen&&mode!=="intensity"
        const traces=[]
        let eligible=0
        let drawn=0
        this.centroids=[] // {collection, meanX, meanY, color}
        this.barycentricPoles=[] // {element, x, y} for pole labels

        const isBarycentric=mode==="barycentric"

        /* THE CLUSTER RESULTS, READ ONCE FOR EVERY MODE. Clustering on the
           "graph" data source decorrelates and partitions WHATEVER is on
           screen — which in van Krevelen is one point per formula and in
           barycentric is one point per formula projected on the unit circle.
           The partition lives in `results.clusteredTraces`, and each mode below
           draws it the same way the error/intensity mode already does: coloured
           per cluster instead of one flat collection colour. Reading `results`
           here, before the mode branch, is what lets the three modes share it. */
        const clust=this.parameters.clustering??null
        const results=clust&&clust.enabled&&clust.results?clust.results:null

        if(isBarycentric){
            /* BARYCENTRIC: one point per FORMULA, projected onto unit circle poles.
               Uses Rust kernel if available, falls back to JS. */
            const table=this.loadedTable
            if(!table){
                console.warn("[FormulaCollectionNode] no periodic table for barycentric")
            }else{
                /* Build global element order across all visible collections.
                   Stable order: atomic number Z ascending, then symbol as tie-breaker,
                   so the same elements always occupy the same poles. */
                const elementSet=new Set()
                for(const collection of this.collections){
                    if(!this.collectionState(collection.name).inGraphs) continue
                    for(const entry of collection.entries){
                        const formula=entry.formula
                        if(!formula) continue
                        for(const [el] of formula.counts){
                            elementSet.add(el)
                        }
                    }
                }
                const sortedElements=[...elementSet].sort((a,b)=>(a.Z??0)-(b.Z??0)||String(a.symbol??"").localeCompare(String(b.symbol??"")))
                const elementOrder=new Map()
                for(let i=0;i<sortedElements.length;i++){
                    elementOrder.set(sortedElements[i],i)
                }
                const k=elementOrder.size
                if(k<3){
                    console.warn("[FormulaCollectionNode] barycentric needs at least 3 elements, got",k)
                }else{
                    const elementsByIndex=new Array(k)
                    for(const [el,idx] of elementOrder){
                        elementsByIndex[idx]=el
                    }

                    for(const collection of this.collections){
                        if(!this.collectionState(collection.name).inGraphs) continue
                        /* WHETHER THIS COLLECTION WAS CLUSTERED ON ITS PLOTTED
                           POINTS (dataSource "graph"). When it was, the barycentric
                           x/y per formula still have to be computed — the POLE
                           positions come from the same projection — but the
                           points themselves are drawn from the pre-coloured
                           `clusteredTraces` instead of one flat collection colour.
                           The flag selects which block runs AFTER the projection;
                           it never skips the projection, or the poles vanish. */
                        const clustered=!!(results&&results.dataSource==="graph"&&results.graphMode===mode&&results.collectionName===collection.name&&results.clusteredTraces)
                        const compositions=[]
                        const validEntries=[]
                        for(const entry of collection.entries){
                            const formula=entry.formula
                            if(!formula) continue
                            const counts=formula.counts
                            const row=new Array(k).fill(0)
                            let hasAny=false
                            for(const [el,n] of counts){
                                const idx=elementOrder.get(el)
                                if(idx!==undefined){
                                    row[idx]=n
                                    hasAny=true
                                }
                            }
                            if(hasAny){
                                compositions.push(row)
                                validEntries.push(entry)
                            }
                        }
                        if(compositions.length===0) continue

                        const flat=new Float64Array(compositions.length*k)
                        for(let i=0;i<compositions.length;i++){
                            flat.set(compositions[i],i*k)
                        }

                        let answer=null
                        try{
                            answer=await computePool.run("barycentric",{
                                compositions:Array.from(flat),
                                n:compositions.length,
                                k
                            })
                        }catch(err){
                            console.warn("[FormulaCollectionNode] barycentric kernel failed, JS fallback:",err)
                        }
                        let result=answer?.points??null
                        if(!result){
                            result=FormulaCollectionNode.barycentricProjectJS(flat,compositions.length,k)
                        }

                        if(!result||result.length!==(compositions.length+k)*2) continue

                        const xs=[]
                        const ys=[]
                        for(let i=0;i<compositions.length;i++){
                            xs.push(result[i*2])
                            ys.push(result[i*2+1])
                        }

                        const poleStart=compositions.length*2
                        const poles=[]
                        for(let i=0;i<k;i++){
                            const rawEl=elementsByIndex[i]
                            poles.push({
                                element:rawEl?.symbol??String(rawEl),
                                x:result[poleStart+i*2],
                                y:result[poleStart+i*2+1]
                            })
                        }
                        this.barycentricPoles.push(...poles.map(p=>({collection,x:p.x,y:p.y,element:p.element})))

                        const x=new Float64Array(xs)
                        const y=new Float64Array(ys)
                        if(clustered){
                            /* CLUSTERED: draw the pre-coloured per-cluster traces
                               built by computeClustering from these very points,
                               not the flat collection trace. */
                            for(const trace of results.clusteredTraces){
                                traces.push(trace)
                                drawn+=trace.pointCount
                            }
                            eligible+=results.nPoints
                        }else{
                            traces.push(new XYTrace({
                                id:`${collection.name}:barycentric`,
                                title:`${collection.name} — barycentric (${xs.length})`,
                                wave:Wave.fromCoordinates(
                                    x,
                                    y,
                                    {collection:collection.name, quantity:"barycentric"},
                                    ["Rx","Ry"]
                                ),
                                options:{
                                    color:traceColor(this.collections.indexOf(collection)),
                                    mode:"points",
                                    marker:{shape:"circle",size:4},
                                    layer:"gl"
                                }
                            }))
                            drawn+=xs.length
                            eligible+=xs.length
                        }
                    }
                    /* POLES AS A TRACE: the overlay labels are SVG, invisible to
                       dataBounds/autoDomain — without this the wheel zoom-out and
                       the dblclick reset frame only the measured points and the
                       poles sit outside the view. One hidden point per pole per
                       visible collection widens the fit bounds to the unit circle. */
                    const poleXs=[]
                    const poleYs=[]
                    for(const pole of this.barycentricPoles){
                        if(Number.isFinite(pole.x)&&Number.isFinite(pole.y)){
                            poleXs.push(pole.x)
                            poleYs.push(pole.y)
                        }
                    }
                    if(poleXs.length){
                        traces.push(new XYTrace({
                            id:"barycentric:poles",
                            title:`barycentric poles (${poleXs.length})`,
                            wave:Wave.fromCoordinates(
                                new Float64Array(poleXs),
                                new Float64Array(poleYs),
                                {collection:"barycentric", quantity:"barycentric-poles"},
                                ["Rx","Ry"]
                            ),
                            options:{
                                color:"#666",
                                mode:"points",
                                marker:{shape:"circle",size:0},
                                layer:"gl",
                                hidden:true
                            }
                        }))
                    }
                }
            }
        }else if(isVankrevelen){
            /* VAN KREVELEN: one point per FORMULA (not per measured target).
               Evaluate user formulas in JS using each formula's element counts. */
            const xFormula=this.parameters.vkXFormula??"O/C"
            const yFormula=this.parameters.vkYFormula??"H/C"
            const table=this.loadedTable
            this.centroids=[] // reset for this render
            if(!table){
                console.warn("[FormulaCollectionNode] no periodic table for van Krevelen")
            }else{
                const evalX=FormulaCollectionNode.compileVkFormula(xFormula,table)
                const evalY=FormulaCollectionNode.compileVkFormula(yFormula,table)
                for(const collection of this.collections){
                    if(!this.collectionState(collection.name).inGraphs) continue
                    /* CLUSTERED VAN KREVELEN: same rule as barycentric — a
                       partition computed on the plotted ratios (dataSource
                       "graph") for THIS collection arrives as pre-coloured
                       clustered traces; draw those and skip the flat pass. The
                       collection centroid below is then not added, so the vk
                       centroid ring does not sit on a point cloud that has been
                       recoloured by cluster. */
                    if(results&&results.dataSource==="graph"&&results.graphMode===mode&&results.collectionName===collection.name&&results.clusteredTraces){
                        for(const trace of results.clusteredTraces){
                            traces.push(trace)
                            drawn+=trace.pointCount
                        }
                        eligible+=results.nPoints
                        continue
                    }
                    const xs=[]
                    const ys=[]
                    for(const entry of collection.entries){
                        const formula=entry.formula
                        if(!formula) continue
                        const counts=formula.counts
                        const xv=evalX(counts,table,entry.formula)
                        const yv=evalY(counts,table,entry.formula)
                        if(Number.isFinite(xv)&&Number.isFinite(yv)){
                            xs.push(xv)
                            ys.push(yv)
                        }
                    }
                    if(xs.length===0) continue
                    const meanX=xs.reduce((a,b)=>a+b,0)/xs.length
                    const meanY=ys.reduce((a,b)=>a+b,0)/ys.length
                    const x=new Float64Array(xs)
                    const y=new Float64Array(ys)
                    traces.push(new XYTrace({
                        id:`${collection.name}:vankrevelen`,
                        title:`${collection.name} — van Krevelen (${xs.length})`,
                        wave:Wave.fromCoordinates(
                            x,
                            y,
                            {collection:collection.name, quantity:"vankrevelen"},
                            [xFormula,yFormula]
                        ),
                        options:{
                            color:traceColor(this.collections.indexOf(collection)),
                            mode:"points",
                            marker:{shape:"circle",size:3},
                            layer:"gl"
                        }
                    }))
                    drawn+=xs.length
                    eligible+=xs.length
                    this.centroids.push({collection,meanX,meanY,color:traceColor(this.collections.indexOf(collection))})
                }
            }
        }else{
            /* ERROR or INTENSITY: one point per MEASURED TARGET. */
            for(const collection of this.collections){
                if(!this.collectionState(collection.name).inGraphs) continue
                // If clustering was done on graph traces, use the pre-clustered traces
                if(results&&results.dataSource==="graph"&&results.graphMode===mode&&results.collectionName===collection.name&&results.clusteredTraces){
                    for(const trace of results.clusteredTraces){
                        traces.push(trace)
                        drawn+=trace.pointCount
                    }
                    eligible+=results.nPoints
                    continue
                }
                const scoped=results&&results.collectionName===collection.name&&results.pointKeys
                    ?new Map(results.pointKeys.map((key,i)=>[key,results.assignments[i]]))
                    :null
                const fallbackColor=traceColor(this.collections.indexOf(collection))
                const points=[]
                const pointColors=[]
                const pointAssignments=[]
                for(let entryIdx=0;entryIdx<collection.entries.length;entryIdx++){
                    const entry=collection.entries[entryIdx]
                    const targets=entry.targets??[]
                    for(let targetIdx=0;targetIdx<targets.length;targetIdx++){
                        const target=targets[targetIdx]
                        if(!Number.isFinite(target.mz)) continue
                        if(byError){
                            if(!Number.isFinite(target.errorPpm)) continue
                            points.push([target.mz,target.errorPpm])
                        }else{
                            if(!Number.isFinite(target.intensity)) continue
                            points.push([target.mz,target.intensity])
                        }
                        //by KEY, not by position: this list holds fewer points
                        //than were clustered whenever a target lacks the other
                        //measurement, and a shifted index colours the wrong
                        //points with a straight face
                        const assign=scoped?scoped.get(`${entryIdx}#${targetIdx}`):undefined
                        if(assign!==undefined){
                            pointAssignments.push(assign)
                            pointColors.push(this.getClusterColor(assign,results.nClusters))
                        }else{
                            pointAssignments.push(-1)
                            pointColors.push(fallbackColor)
                        }
                    }
                }
                const hasClustering=scoped!=null
                if(!points.length) continue
                eligible+=points.length
                points.sort((a,b)=>a[0]-b[0])
                // Reorder colors and assignments to match sorted points
                const sortedIndices=points.map((_,i)=>i).sort((a,b)=>points[a][0]-points[b][0])
                const x=new Float64Array(points.length)
                const y=new Float64Array(points.length)
                const colors=new Array(points.length)
                for(let i=0;i<points.length;i++){
                    const src=sortedIndices[i]
                    x[i]=points[src][0]
                    y[i]=points[src][1]
                    colors[i]=pointColors[src]
                }
                if(hasClustering&&pointColors.some(c=>c!==fallbackColor)){
                    // Split into per-cluster traces for proper coloring
                    const clusters=new Map()
                    for(let i=0;i<points.length;i++){
                        const assign=pointAssignments[sortedIndices[i]]
                        if(!clusters.has(assign)) clusters.set(assign,{xs:[],ys:[]})
                        clusters.get(assign).xs.push(x[i])
                        clusters.get(assign).ys.push(y[i])
                    }
                    for(const [assign,{xs,ys}] of clusters){
                        if(xs.length===0) continue
                        const color=assign>=0?this.getClusterColor(assign,results.nClusters):fallbackColor
                        const cx=new Float64Array(xs)
                        const cy=new Float64Array(ys)
                        traces.push(new XYTrace({
                            id:`${collection.name}:cluster${assign}:${byError?"error":"sticks"}`,
                            title:`${collection.name} — cluster ${assign>=0?assign+1:"unassigned"} (${xs.length})`,
                            wave:Wave.fromCoordinates(
                                cx,
                                cy,
                                {collection:collection.name, quantity:byError?"errorPpm":"intensity", cluster:assign},
                                ["m/z",byError?"error (ppm)":"intensity"]
                            ),
                            options:{
                                color,
                                mode:byError?"points":"sticks-to-zero",
                                marker:{shape:"circle",size:3},
                                layer:"gl"
                            }
                        }))
                        drawn+=xs.length
                    }
                }else{
                    traces.push(new XYTrace({
                        id:`${collection.name}:${byError?"error":"sticks"}`,
                        title:byError
                            ?`${collection.name} — error (${points.length})`
                            :`${collection.name} (${points.length})`,
                        wave:Wave.fromCoordinates(
                            x,
                            y,
                            {collection:collection.name, quantity:byError?"errorPpm":"intensity"},
                            ["m/z",byError?"error (ppm)":"intensity"]
                        ),
                        options:{
                            color:traceColor(this.collections.indexOf(collection)),
                            mode:byError?"points":"sticks-to-zero",
                            marker:{shape:"circle",size:3},
                            layer:"gl"
                        }
                    }))
                    drawn+=points.length
                }
            }
        }
        this.graph.setTraces(traces)
        if(isBarycentric){
            this.graph.parameters.axis.left.scale="linear"
            this.graph.parameters.axis.bottom.scale="linear"
            this.graph.parameters.axis.bottom.label="Rx"
            this.graph.parameters.axis.bottom.autoLabel=false
            this.graph.parameters.axis.left.label="Ry"
            this.graph.parameters.axis.left.autoLabel=false
            this.graph.parameters.axis.bottom.domain=[-1.1,1.1]
            this.graph.parameters.axis.left.domain=[-1.1,1.1]
            this.graph.parameters.axis.bottom.autoDomain=false
            this.graph.parameters.axis.left.autoDomain=false
        }else if(isVankrevelen){
            this.graph.parameters.axis.left.scale="linear"
            const xAxisLabel=(this.parameters.vkXFormula??"").trim()||"O/C"
            const yAxisLabel=(this.parameters.vkYFormula??"").trim()||"H/C"
            this.graph.parameters.axis.bottom.label=xAxisLabel
            this.graph.parameters.axis.bottom.autoLabel=false
            this.graph.parameters.axis.left.label=yAxisLabel
            this.graph.parameters.axis.left.autoLabel=false
            /* RETURN THE FRAME TO THE DATA. Van Krevelen carries no fixed box of
               its own, but it may be arriving FROM barycentric, which locked the
               axes to [-1.1,1.1] with autoDomain off. Left as they are, ratios
               outside that box (an H/C of 2, an O/C of 0.5 on a big molecule)
               would fall off a view that no longer matches them. Re-arming
               autoDomain on both axes lets the plot fit what is drawn. */
            this.graph.parameters.axis.bottom.autoDomain=true
            this.graph.parameters.axis.left.autoDomain=true
            this.graph.parameters.axis.bottom.domain=null
            this.graph.parameters.axis.left.domain=null
        }else{
            this.graph.parameters.axis.left.scale=(!byError&&this.parameters.logY)?"log":"linear"
            this.graph.parameters.axis.bottom.label="Measured m/z"
            this.graph.parameters.axis.bottom.autoLabel=false
            this.graph.parameters.axis.left.label=byError?"Error (ppm)":"Intensity"
            this.graph.parameters.axis.left.autoLabel=false
            /* THE RETURN FROM BARYCENTRIC IS EXACT, and this is where it was
               broken. Barycentric pins both axes to [-1.1,1.1] with autoDomain
               OFF; switching back to Error or Intensity did not undo that, so
               m/z in the hundreds and errors in ppm were framed against a
               one-unit box and vanished off-screen. autoDomain back on and the
               fixed domain dropped, the plot refits the measured points. */
            this.graph.parameters.axis.bottom.autoDomain=true
            this.graph.parameters.axis.left.autoDomain=true
            this.graph.parameters.axis.bottom.domain=null
            this.graph.parameters.axis.left.domain=null
        }
        this.graph.drawGraph()
        if(this.graphReadout){
            const txt=`${formatCount(drawn)} / ${formatCount(eligible)}`
            this.graphReadout.textContent=txt
            this.graphReadout.style.color=""
            if(this.vkReadout){
                this.vkReadout.textContent=txt
                this.vkReadout.style.color=""
            }
            if(isVankrevelen){
                this.graphReadout.title="Points drawn / formulas with carbon — formulas without carbon are not shown"
                if(this.vkReadout) this.vkReadout.title=this.graphReadout.title
            }else if(isBarycentric){
                this.graphReadout.title="Points drawn / formulas with ≥3 elements — formulas with fewer elements are not shown"
                if(this.vkReadout) this.vkReadout.title=this.graphReadout.title
            }else{
                this.graphReadout.title=byError
                    ?"Points drawn / points eligible — a measured point counted here only when it carries an error"
                    :"Points drawn / points eligible — a measured point counted here only when it carries an intensity"
                if(this.vkReadout) this.vkReadout.title=this.graphReadout.title
            }
        }
    }

    /* --- Van Krevelen expression evaluator ------------------------------------ */
    /* Compile a user formula like "O/C" or "1+C+N/2-H/2" into an evaluator.
       Variables are element symbols (C, H, O, N, S, P, etc.). Returns a function
       that takes a formula's `counts` Map<Element,number> and the periodic table. */
    /* DBE d'une formule: 1 + Σ nᵢ·(vᵢ−2)/2 sur la composition NEUTRE écrite
       (le core quand on s'en souvient — l'adduit d'ionisation ne compte pas
       comme une insaturation). La valence lue est `valences.default` de
       elements.json; les halogènes (valence 1) comptent donc comme H, ce qui
       est la convention standard. Un élément sans valence renseignée est
       ignoré, et une formule sans aucun atome à valence donne NaN. */
    static dbeOfFormula(formula){
        if(!formula) return NaN
        //neutral written part: the core when remembered, else the composition
        const written=formula.core??formula.composition
        if(!(written instanceof Map)) return NaN
        let sum=0
        let seen=false
        for(const [element,byA] of written){
            let n=0
            for(const count of byA?.values?.()??[]) n+=count
            if(!n) continue
            const valence=element?.valences?.default
            if(!Number.isFinite(valence)) continue
            seen=true
            sum+=n*(valence-2)/2
        }
        return seen?1+sum:NaN
    }

    static compileVkFormula(expr,table){
        if(!expr||!expr.trim()) return ()=>NaN
        const s=expr.trim()
        let i=0
        /* Recursive descent parser with precedence:
           cmp    = expr (('=='|'!='|'<='|'>='|'<'|'>') expr)*
           expr   = term (('+'|'-') term)*
           term   = factor (('*'|'/') factor)*
           factor = number | variable | '(' expr ')' | ('+'|'-') factor
           variable = element symbol (1-2 letters, first uppercase),
                      or a reserved word (any case): DBE, Mass
           Comparisons yield 1 (true) or 0 (false); NaN on either side
           propagates as NaN so the point is excluded, not counted false. */
        const peek=()=>i<s.length?s[i]:''
        const consume=()=>s[i++]
        const parseNumber=()=>{
            const start=i
            while(i<s.length&&/[\d.]/.test(s[i])) i++
            const n=parseFloat(s.slice(start,i))
            return Number.isFinite(n)?n:NaN
        }
        const parseVariable=()=>{
            if(i>=s.length) return null
            if(!/[A-Za-z]/.test(s[i])) return null
            //letters only (case-insensitive match below): a following digit
            //ends the name, so "C2" still reads C then 2, never "C2"
            let run=s[i++]
            while(i<s.length&&/[A-Za-z]/.test(s[i])) run+=s[i++]
            //reserved word (any case): consume it whole
            if(["DBE","MASS"].includes(run.toUpperCase())) return run
            //otherwise an element symbol: an uppercase letter plus at most
            //one lowercase; a leading lowercase letter never starts one
            if(!/[A-Z]/.test(run[0])) return run[0]
            let len=1
            if(run.length>1&&/[a-z]/.test(run[1])) len=2
            i-=run.length-len
            return run.slice(0,len)
        }
        const parseFactor=()=>{
            while(peek()===' ') i++
            const ch=peek()
            if(ch==='+'||ch==='-'){
                const op=consume()
                const val=parseFactor()
                return op==='-'?(counts,tbl,formula)=>-val(counts,tbl,formula):val
            }
            if(ch==='('){
                consume()
                //full expression inside parens (comparison level included):
                //"(DBE==1)+(DBE==4)" must parse, not stop at the '=='
                const node=parseCmp()
                if(peek()===')') consume()
                return node
            }
            if(/\d/.test(ch)){
                const n=parseNumber()
                return ()=>n
            }
            const sym=parseVariable()
            if(sym){
                const upper=sym.toUpperCase()
                //reserved words, resolved against the FORMULA, not the table:
                //Mass is the ion mass (absorbed composition, charge-corrected),
                //DBE the unsaturation count (see dbeOfFormula)
                if(upper==="MASS") return (counts,tbl,formula)=>formula?.mass??NaN
                if(upper==="DBE") return (counts,tbl,formula)=>FormulaCollectionNode.dbeOfFormula(formula)
                return (counts,tbl)=>{
                    const el=tbl?.bySymbol?.get(sym)
                    return el?counts.get(el)??0:0
                }
            }
            return ()=>NaN
        }
        const parseTerm=()=>{
            let node=parseFactor()
            while(true){
                while(peek()===' ') i++
                const ch=peek()
                if(ch!=='*'&&ch!=='/') break
                const op=consume()
                const right=parseFactor()
                const left=node
                node=op==='*'
                    ?(counts,tbl,formula)=>left(counts,tbl,formula)*right(counts,tbl,formula)
                    :(counts,tbl,formula)=>right(counts,tbl,formula)!==0?left(counts,tbl,formula)/right(counts,tbl,formula):NaN
            }
            return node
        }
        const parseExpr=()=>{
            let node=parseTerm()
            while(true){
                while(peek()===' ') i++
                const ch=peek()
                if(ch!=='+'&&ch!=='-') break
                const op=consume()
                const right=parseTerm()
                const left=node
                node=op==='+'
                    ?(counts,tbl,formula)=>left(counts,tbl,formula)+right(counts,tbl,formula)
                    :(counts,tbl,formula)=>left(counts,tbl,formula)-right(counts,tbl,formula)
            }
            return node
        }
        /* Comparisons, lowest precedence. Result is 1 or 0 (JS booleans are
           coerced so downstream math stays numeric); if either operand is NaN
           the comparison is NaN, which excludes the point downstream instead
           of silently counting it as "false" (0). */
        const parseCmp=()=>{
            let node=parseExpr()
            while(true){
                while(peek()===' ') i++
                const ch=peek()
                if(ch!=='='&&ch!=='!'&&ch!=='<'&&ch!=='>') break
                let op=''
                if((ch==='='||ch==='!')&&s[i+1]==='='){op=s.slice(i,i+2);i+=2}
                else if((ch==='<'||ch==='>')&&s[i+1]==='='){op=s.slice(i,i+2);i+=2}
                //typo tolerance: a lone '=' means '==' and a lone '!' means '!='
                else if(ch==='='){op='==';i++}
                else if(ch==='!'){op='!=';i++}
                else if(ch==='<'||ch==='>'){op=ch;i++}
                else break
                const right=parseExpr()
                const left=node
                node=(counts,tbl,formula)=>{
                    const a=left(counts,tbl,formula)
                    const b=right(counts,tbl,formula)
                    if(!Number.isFinite(a)||!Number.isFinite(b)) return NaN
                    switch(op){
                        case '==': return a===b?1:0
                        case '!=': return a!==b?1:0
                        case '<' : return a<b?1:0
                        case '<=': return a<=b?1:0
                        case '>' : return a>b?1:0
                        case '>=': return a>=b?1:0
                        default  : return NaN
                    }
                }
            }
            return node
        }
        const ast=parseCmp()
        /* Anything left over means the expression is malformed ("DBE==1)").
           Returning NaN excludes the point rather than plotting a value
           computed from a prefix of what the user typed. */
        while(peek()===' ') i++
        if(i<s.length) return ()=>NaN
        return (counts,tbl,formula)=>ast(counts,tbl,formula)
    }

    /* --- Barycentric projection (JS fallback) ----------------------------------- */
    /* Projects compositions onto unit circle poles.
       Input: flat Float64Array [n0, n1, ..., nk-1, n0, n1, ...] for n_compositions
       Output: flat array [Rx0, Ry0, Rx1, Ry1, ..., px0, py0, px1, py1, ...]
       Poles are at theta_i = 2π*i/k on unit circle. */
    static barycentricProjectJS(flat,n_compositions,k){
        if(n_compositions===0||k<3||flat.length!==n_compositions*k){
            return new Float64Array(0)
        }
        const twoPi=2*Math.PI
        const result=new Float64Array((n_compositions+k)*2)

        for(let comp=0;comp<n_compositions;comp++){
            const offset=comp*k
            let sum=0
            for(let i=0;i<k;i++) sum+=flat[offset+i]
            if(sum===0){
                result[comp*2]=0
                result[comp*2+1]=0
                continue
            }
            let rx=0, ry=0
            for(let i=0;i<k;i++){
                const xi=flat[offset+i]/sum
                const theta=twoPi*i/k
                rx+=xi*Math.cos(theta)
                ry+=xi*Math.sin(theta)
            }
            result[comp*2]=rx
            result[comp*2+1]=ry
        }

        const poleStart=n_compositions*2
        for(let i=0;i<k;i++){
            const theta=twoPi*i/k
            result[poleStart+i*2]=Math.cos(theta)
            result[poleStart+i*2+1]=Math.sin(theta)
        }
        return result
    }

    /* What this node publishes: the ticked collections, and nothing else.

       A collection is published as a PLAIN descriptor, not as Formula objects.
       Two reasons, and the second is the decisive one: a downstream node that
       wants the chemistry re-parses `key` against the same table (it never
       abbreviates, so it round-trips exactly), and a session that stored live
       formulas would store a periodic table along with each of them. */
    /* LES DEUX SORTIES, ET ELLES NAISSENT ENSEMBLE.

       Une boucle, deux représentations. C'est la seule façon d'éviter que les
       deux sorties divergent — et diverger ici ne serait pas spectaculaire: on
       verrait une collection de 240 formules et une vague de 238 points, sans
       qu'aucune des deux ne soit fausse. C'est le genre d'écart qui se cherche
       une demi-journée. En les construisant dans le même passage, il n'y a pas
       d'écart possible.

       CE QUE LA VAGUE EST, ET CE QU'ELLE N'EST PAS. Ce n'est PAS une mesure:
       c'est la liste, en nombres. L'abscisse est le m/z calculé de la formule —
       jamais la masse d'un pic mesuré — et l'ordonnée est l'intensité que
       l'appariement de la collection a donnée à cette formule.

       UNE FORMULE SANS APPARIEMENT VA À ZÉRO, ET ELLE Y VAIT. Elle est
       retirée, la collection perdrait une ligne sans que rien ne le dise, et la
       vague compterait moins de points que la sortie n°1 n'a de formules. Zéro
       est une affirmation — « rien n'a été mesuré là » — et elle est vraie,
       alors qu'une absence serait un silence. Le décompte de ces lignes part
       dans les métadonnées pour qu'on puisse les compter.

       LE m/z EST TRIÉ CROISSANT, et c'est la seule chose que la vague réordonne.
       Une onde qu'un nœud à spectre consomme doit être croissante en masse: le
       trimmer, le traceur et l'attribution cherchent par dichotomie, et une
       entrée non triée donne des résultats faux SANS lever la seule erreur. La
       sortie n°1 garde l'ordre de la collection — une liste de formules n'a pas
       d'ordre, et le changer ici n'aurait aucun bénéfice. */
    publishOutput(){
        const published=[]
        const waves=[]
        for(const collection of this.collections){
            if(!this.collectionState(collection.name).inOutput) continue
            const formulas=collection.entries.map(entry=>({
                key:entry.key,
                notation:entry.notation,
                mz:entry.mz,
                mass:entry.mass,
                charge:entry.charge,
                molecule:entry.molecule,
                errorPpm:entry.errorPpm,
                intensity:entry.intensity,
                note:entry.note,
                targets:entry.targets.map(t=>({
                    mz:t.mz,
                    intensity:t.intensity,
                    errorPpm:t.errorPpm,
                    cost:Number.isFinite(t.cost)?t.cost:null
                }))
            }))
            published.push({name:collection.name,formulas})

            /* UN m/z INFINI OU ABSENT SORT DE LA VAGUE, et il est compté. Un NaN
               dans une onde ne se voit pas: le tracé l'ignore, une dichotomie
               renvoie n'importe quoi, et le nœud en aval perd un point sans
               jamais le dire. On l'écarte donc — mais on le DIT, dans les
               métadonnées, parce qu'un point perdu en silence est exactement le
               défaut qu'on est en train de corriger partout ailleurs. */
            const usable=formulas.filter(f=>Number.isFinite(f.mz)&&f.mz>0)
            const dropped=formulas.length-usable.length
            const ordered=[...usable].sort((a,b)=>a.mz-b.mz)
            const x=new Float64Array(ordered.length)
            const y=new Float64Array(ordered.length)
            let unattributed=0
            for(let i=0;i<ordered.length;i++){
                x[i]=ordered[i].mz
                const intensity=Number.isFinite(ordered[i].intensity)?ordered[i].intensity:0
                if(!Number.isFinite(ordered[i].intensity)) unattributed++
                y[i]=intensity
            }
            waves.push(Wave.fromCoordinates(x,y,{
                title:`${collection.name} (m/z, intensity)`,
                collection:collection.name,
                /* the position of the same collection in output 0, so a consumer
                   holding both can pair them without guessing on the name */
                collectionIndex:published.length-1,
                formulas:formulas.length,
                unmatched:unattributed,
                dropped,
                sourceWave:collection.name,
                traceMode:"sticks-to-zero"
            },["mz","intensity"]))
        }
        this.outputs[0]=published
        this.outputs[1]=waves
    }
    async startResolve(){
        this.status="pending"
        await this.table()
        this.readCollections()
        this.syncCurrentCollection()
        this.publishOutput()
        this.renderAll()
        /* REFRESH THE CLUSTERING PANEL NOW THAT A COLLECTION EXISTS. The panel
           was first built at registration, before any resolve, when
           `currentCollection` was still null — so its enable checkbox was drawn
           disabled and labelled "select a collection first". Nothing re-rendered
           it after the first resolve, so that stale state survived even once a
           collection was on screen and selected. Re-rendering reads the live
           `currentCollection` and rebuilds the controls from the clustering
           parameters (the single source of truth), so the checkbox turns live the
           moment there is something to cluster — no forced click. renderAll
           itself does not cover this panel, hence the explicit call. */
        this.renderClusteringOptions()
        this.refreshGraph()
        this.setStatus(this.collections.length?"resolved":"floating")
    }
    /* The periodic table, ONCE and on demand.

       The table belongs to the ORIGINE and is AWAITED, never read directly: the
       App loads it in the background, so a node that read `origin.table` the
       instant it woke would report "no table" for a table still in flight. The
       same shape as FKMDNode's, deliberately.

       THE CACHE IS CALLED `loadedTable`, and that is not a style choice. A node
       with a method `table()` cannot also have a field `table`: assigning
       `this.table = null` in the constructor puts an OWN property on the
       instance that shadows the method, and the next `this.table()` throws
       "this.table is not a function" — which is exactly what happened, and it
       took the whole node down at creation. The method asks; the App owns the
       data; the node keeps one reading of it under a name that cannot collide. */
    async table(){
        if(this.origin.table){
            this.loadedTable=this.origin.table
            return this.loadedTable
        }
        const loaded=await this.origin.tableReady
        this.loadedTable=loaded??null
        return this.loadedTable
    }
    /* The collection on screen, chosen by name and never by index.

       After a resolve the collections are rebuilt from the parents, so a
       selection held as an index would silently move to a different collection
       as soon as one was added above it. A name survives that, and a name that
       has gone away simply falls back to the first one. */
    syncCurrentCollection(){
        const names=this.collections.map(c=>c.name)
        if(this.parameters.current&&names.includes(this.parameters.current)){
            this.currentCollection=this.collections.find(c=>c.name===this.parameters.current)
        }else{
            this.currentCollection=this.collections[0]??null
            this.parameters.current=this.currentCollection?.name??null
        }
        this.selectedEntry=this.currentCollection&&this.parameters.selection
            ?this.currentCollection.entries.find(e=>e.key===this.parameters.selection)??null
            :null
    }
    setStatus(status){
        this.status=status
        dispatchEvent(this.events.broadcast.nodeStatusChanged.call(this,status))
    }

    /* --- reading the multiplexed input ----------------------------------- */
    /* The ONE input is a Map parent -> outputs, and Flow.parentSynapse fills
       it from EVERY link that lands on it. That is the multiplexing: no
       bookkeeping here, and a hundred cables on a single anchor behave exactly
       like one.

       A collection is whatever a parent publishes. Three shapes are accepted,
       because the producers do not agree yet and a reader that refused two of
       them would be useless on the flow as it stands:
         - a Formula / Stoichiometry: a collection of one,
         - an array of them: one collection named after the parent,
         - an object with `formulas` and an optional `points` array: the full
           form, where each point carries the m/z that was measured.
       Anything else is named in the diagnostics rather than dropped in
       silence: a collection the user cannot see is one they will spend an
       hour looking for. */
    /* THE collections of this node, at every resolve: the ones that arrive on
       the input, plus the ones the user made here.

       The local ones come LAST and deliberately so. They are the ones this node
       owns, and burying them under a hundred parents' collections would make
       them the hardest to find, for no gain: a collection the user created is
       the one they are looking for. */
    readCollections(){
        const collections=[]
        const diagnostics=[]
        const input=this.inputs[0]
        if(input instanceof Map){
            for(const [parent,values] of input){
                const parentName=parent.events?.registrationName??parent.title
                for(const output of values??[]){
                    for(const raw of (Array.isArray(output)?output:[output])){
                        const collection=this.asCollection(raw,parentName,diagnostics)
                        if(collection) collections.push(collection)
                    }
                }
            }
        }
        for(const local of this.parameters.localCollections){
            const collection=this.buildCollection(
                local.name,
                (local.keys??[]).map(key=>this.localFormula(key,local.name,diagnostics)).filter(Boolean),
                [],
                diagnostics,
                {local:true}
            )
            if(collection) collections.push(collection)
        }
        this.collections=collections
        this.diagnostics=diagnostics
    }
    /* The objects behind a local collection's stored keys.

       Only the KEYS are stored, never the formulas: a Formula holds a Map
       indexed by Element, so a session carrying them would drag the periodic
       table along. `key` never abbreviates, so re-reading it is exact — and if
       it cannot be re-read (a table still loading, a key from another table)
       that is a diagnostic on ONE collection, not a failure of the node. */
    localFormula(key,name,diagnostics){
        if(!this.loadedTable){
            diagnostics.push(`${name}: the periodic table is not ready, "${key}" is not shown`)
            return null
        }
        try{
            /* The text as TYPED, not `key`. It looks redundant next to the
               notation, and it is the only spelling that comes back identical:
               a formula carrying a group adduct does not survive being
               re-read from its key, because the adduct's atom is counted once
               in the composition and once in the brackets. The user typed a
               string that parses to what they meant, so that string is what
               this node keeps. */
            return Formula.parse(key,this.loadedTable)
        }catch(error){
            diagnostics.push(`${name}: ${error.message}`)
            return null
        }
    }
    asCollection(raw,parentName,diagnostics){
        /* FOUR shapes, and the fourth is the one the class itself produces.

           The node is a reader, and a reader that only understood one shape
           would be useless on the flow as it stands — the producers do not
           agree yet. So: a Formula alone, an array of them, a {name, formulas,
           points} object, and a FormulaCollection coming back from another
           node. Anything else is NAMED in the diagnostics rather than dropped in
           silence: a collection the user cannot see is one they will spend an
           hour looking for. */
        /* ADOPTER, quand la collection vient d'un autre nœud.

           Le producteur a DÉJÀ fabriqué ses entrées — clé, notation, masse, m/z,
           racine, famille de molécule. Les rebâtir ici recalculait tout ça, à
           13 µs la formule, pour un objet que l'autre venait de fabriquer. Sur
           17 689 formules c'était la moitié du temps du chemin complet.

           On adopte donc les entrées, en copie superficielle: le lecteur garde
           les siennes parce qu'il y écrit sa note, mais il ne recalcule rien.
           `buildCollection` reste le chemin des quatre autres formes d'entrée —
           une chaîne, un tableau, un objet nu — où il n'y a rien à adopter.

           Et la fenêtre ppm N'EST PLUS ÉCRASÉE. Elle l'était, et c'était un
           défaut: le lecteur remplaçait silencieusement les 10 ppm du nœud
           d'attribution par son propre 5, sans champ pour le dire, donc sans
           moyen de les aligner. Une collection qui arrive apprise garde la
           fenêtre qui a décidé de son contenu — c'est la seule qui ait le
           droit de la fixer. */
        if(raw instanceof FormulaCollection){
            const state=this.collectionState(raw.name||parentName)
            const adopted=new FormulaCollection({
                name:raw.name||parentName,
                table:this.loadedTable,
                ppm:raw.ppm
            })
            adopted.adoptAll(raw.entries,{
                notes:state.notes,
                points:raw.points??[]
            })
            adopted.local=false
            adopted.state=state
            diagnostics.push(...adopted.diagnostics)
            adopted.diagnostics=[]
            return adopted
        }
        if(raw instanceof Formula||raw instanceof Stoichiometry){
            return this.buildCollection(parentName,[raw],[],diagnostics)
        }
        if(Array.isArray(raw)){
            return this.buildCollection(parentName,raw,[],diagnostics)
        }
        if(raw&&typeof raw==="object"){
            const name=raw.name??raw.title??parentName
            const formulas=raw.formulas??raw.entries??raw.items??null
            if(Array.isArray(formulas)){
                return this.buildCollection(name,formulas,raw.points??raw.targets??[],diagnostics)
            }
        }
        diagnostics.push(`${parentName}: nothing readable (${raw?.constructor?.name??typeof raw})`)
        return null
    }

    /* Builds ONE collection — and hands the chemistry to the class that owns it.

       The pairing, the ppm window, the "closest wins" rule, the deduplication
       by key and the family of every formula all live in FormulaCollection,
       in chemistry.js. This method only decides WHAT a collection is made of
       and stamps the node's own annotations onto it.

       The annotations are stamped here and not in the class, and that is the
       boundary: a note is something the USER said about a formula, not a fact
       about it. A chemistry file that carried user annotations would be
       describing a panel. */
    buildCollection(name,formulas,points,diagnostics,{local=false}={}){
        const state=this.collectionState(name)
        const collection=new FormulaCollection({
            name,
            table:this.loadedTable,
            ppm:this.parameters.ppmWindow
        })
        /* `addAll`, PAS une boucle de `add`. Les deux chemins produisent exactement
           les mêmes entrées — `match()` est idempotent, et les doublons sont
           écartés par `byKey` dans les deux cas — mais pas au même coût.

           `add` appelle `match()` à CHAQUE ajout, et `match()` retrie toutes les
           entrées puis réapplique tous les points: ajouter N formules revient donc
           à apparier N fois un ensemble qui grandit, soit O(N² log N). Mesuré sur
           cette fonction, sur des formules réelles:

               N=200    boucle  23 ms   addAll   6 ms
               N=800    boucle  86 ms   addAll  18 ms
               N=3200   boucle 1368 ms   addAll  54 ms

           Le rapport grandit avec N, parce qu'il n'y a rien de linéaire là-dedans.
           Un lecteur branché sur une grosse collection — un peak list large, un
           ratio isotopique bas, une fenêtre de masse généreuse — passe donc de
           « instantané » à « le navigateur abandonne » sans qu'aucune ligne
           n'ait l'air fausse: chaque appel individuellement est correct, c'est
           leur NOMBRE qui est le problème.

           C'est le même défaut que celui du producteur, corrigé du même côté :
           l'appariement se fait une fois, à la fin, sur l'ensemble terminé. */
        /* Les entrées peuvent être :
           - des instances de Formula / Stoichiometry (collections locales)
           - des objets plats {key, notation, mz, ...} publiés par un autre nœud
           - des chaînes (texte tapé)

           Les objets plats ne sont PAS des instances de Formula, donc `addAll`
           les rejetterait en silence. On les convertit via Formula.parse()
           avant de les lui passer, afin qu'une chaîne de deux nœuds
           FormulaCollectionNode relaye bien ses formules. */
        const prepared=(formulas??[]).map(formula=>{
            if(formula instanceof Formula||formula instanceof Stoichiometry){
                return {formula, sourceText:String(formula)}
            }
            if(typeof formula==="string"){
                if(!this.loadedTable){
                    diagnostics.push(`${name}: the periodic table is not ready, cannot read "${formula}"`)
                    return null
                }
                try{
                    const parsed=Formula.parse(formula,this.loadedTable)
                    return {formula:parsed, sourceText:formula}
                }catch(e){
                    diagnostics.push(`${name}: cannot read "${formula}" — ${e.message}`)
                    return null
                }
            }
            if(formula&&typeof formula==="object"){
                const notation=formula.notation??formula.key??String(formula)
                if(!this.loadedTable){
                    diagnostics.push(`${name}: the periodic table is not ready, cannot read "${notation}"`)
                    return null
                }
                try{
                    const parsed=Formula.parse(notation,this.loadedTable)
                    return {formula:parsed, sourceText:notation}
                }catch(e){
                    diagnostics.push(`${name}: cannot read "${notation}" — ${e.message}`)
                    return null
                }
            }
            diagnostics.push(`${name}: cannot read formula entry`)
            return null
        }).filter(Boolean)
        collection.addAll(prepared)
        /* On apparie d'ABORD, puis on restaure — et non l'inverse.

           `setPoints` appelle `match()`, et `match()` remet À ZÉRO targets,
           target, errorPpm et intensity de CHAQUE entrée avant de les
           recalculer depuis `this.points` (chemistry.js:2455 et 2482-2487).
           Or `publishOutput` ne relaie QUE `{name, formulas}`, jamais les
           points qui ont produit ces erreurs — donc `this.points` est vide,
           `match()` n'apparie rien, et tout retombe à null/0/[]. Une
           restauration placée AVANT `setPoints` était donc écrasée dans la
           seconde qui suivait: les erreurs perdues en cours de route.

           On ne comble que les LACUNES: si `match()` a trouvé une cible avec
           les points de CE nœud, c'est elle qui fait foi — une mesure fraîche
           vaut mieux qu'un instantané du producteur, calculé sous une autre
           fenêtre ppm. Les chaînes et les instances de Formula ne portent pas
           ces champs — seuls les objets plats {key, errorPpm, ...} en ont. */
        collection.setPoints(points??[])
        const sourceByKey=new Map()
        for(const raw of formulas??[]){
            if(raw&&typeof raw==="object"&&raw.key) sourceByKey.set(raw.key,raw)
        }
        for(const entry of collection.entries){
            /* Appariée ici, sur les points de ce nœud: rien à restaurer. */
            if(entry.targets.length) continue
            const src=sourceByKey.get(entry.key)
            if(!src) continue
            if(Array.isArray(src.targets)&&src.targets.length){
                entry.targets=src.targets.map(t=>({...t}))
                let best=null
                for(const t of entry.targets){
                    if(!Number.isFinite(t.errorPpm)) continue
                    if(!best||Math.abs(t.errorPpm)<Math.abs(best.errorPpm)) best=t
                }
                entry.target=best??null
            }
            /* La cible reconstituée porte la même erreur que celle du
               producteur (même formule, même nearestTarget): inutile de la
               deviner à deux endroits. */
            if(entry.errorPpm===null){
                entry.errorPpm=entry.target
                    ?entry.target.errorPpm
                    :(Number.isFinite(src.errorPpm)?src.errorPpm:null)
            }
            /* On n'arrive ici que si `match()` n'a rien apparié (le `continue`
               plus haut l'a garantie): l'intensité locale est donc un 0 vide,
               et celle du producteur fait foi. */
            if(Number.isFinite(src.intensity)) entry.intensity=src.intensity
        }
        for(const entry of collection.entries) entry.note=state.notes[entry.key]??""
        //`local` is the one thing the class cannot know: a collection this node
        //made can be written to and deleted, a collection a parent made is
        //rebuilt at every resolve and would swallow the change silently
        collection.local=local
        collection.state=state
        diagnostics.push(...collection.diagnostics)
        collection.diagnostics=[]
        return collection
    }
    /* The state record of a collection, created on first sight. The name is
       the key, not an index: indices move when a parent is rewired, and a
       checkbox that jumps to another collection after a reload is a bug the
       user cannot work around. */
    collectionState(name){
        const states=this.parameters.collectionState
        if(!states[name]){
            states[name]={inOutput:true,inGraphs:true,notes:{},open:true}
        }
        const state=states[name]
        if(typeof state.inOutput!=="boolean") state.inOutput=true
        if(typeof state.inGraphs!=="boolean") state.inGraphs=true
        if(!state.notes||typeof state.notes!=="object") state.notes={}
        return state
    }

    renderSelection(){
        if(!this.detail) return
        this.detail.replaceChildren()
        const entry=this.selectedEntry
        if(!entry){
            this.detail.append(CE("div",{className:"pp-caption"},["Selection"]))
            this.detail.append(CE("div",{style:{opacity:"0.7",fontSize:"0.85em"}},[
                this.collections.length
                    ?"Pick a formula in the list on the left."
                    :"Connect a node that publishes a collection of Formula."
            ]))
            return
        }
        const state=this.currentCollection?this.collectionState(this.currentCollection.name):null
        const line=(label,value)=>{
            const row=CE("div",{className:"fc-field"},[])
            row.append(
                CE("span",{className:"fc-field-label"},[label]),
                CE("span",{className:"fc-field-value"},[String(value)])
            )
            return row
        }
        this.detail.append(CE("div",{className:"pp-caption"},["Selection"]))
        this.detail.append(CE("div",{className:"fc-bigkey",title:entry.notation},[prettyNotation(entry.notation)]))
        this.detail.append(line("m/z",formatMz(entry.mz)))
        this.detail.append(line("mass",Number.isFinite(entry.mass)?entry.mass.toFixed(6):"—"))
        this.detail.append(line("charge",entry.charge>0?`+${entry.charge}`:`${entry.charge}`))
        this.detail.append(line("molecule",entry.molecule?prettyNotation(entry.molecule):"—"))
        this.detail.append(line("intensity",formatValue(entry.intensity)))
        this.detail.append(line("error",Number.isFinite(entry.errorPpm)?`${entry.errorPpm>=0?"+":""}${entry.errorPpm.toFixed(2)} ppm`:"—"))
        /* The KEY is the identity and it never abbreviates, so it is shown
           verbatim and wrapped: comparing two rows means reading every mass
           number, and an ellipsis in the middle of one is worse than no key. */
        this.detail.append(line("key",entry.key))
        this.detail.append(CE("div",{className:"pp-caption"},[`Targets (${entry.targets.length})`]))
        if(!entry.targets.length){
            this.detail.append(CE("div",{style:{opacity:"0.7",fontSize:"0.85em"}},[
                `No measured point within ${this.parameters.ppmWindow} ppm.`
            ]))
        }else{
            const table=CE("div",{className:"fc-targets"},[])
            table.append(CE("div",{className:"fc-targets-line fc-targets-head"},["m/z","intensity","error","cost"]))
            for(const target of entry.targets){
                table.append(CE("div",{className:"fc-targets-line"},[
                    formatMz(target.mz),
                    formatValue(target.intensity),
                    Number.isFinite(target.errorPpm)?`${target.errorPpm>=0?"+":""}${target.errorPpm.toFixed(2)}`:"—",
                    Number.isFinite(target.cost)?target.cost.toFixed(3):"—"
                ]))
            }
            this.detail.append(table)
        }
        this.detail.append(CE("div",{className:"pp-caption"},["Information"]))
        /* The free text is the "add information" the list promises. It is
           written on every keystroke into the state, so a reload finds the
           annotation where the user left it. */
        this.noteField=CE("textarea",{
            className:"fc-note",rows:"3",spellcheck:false,
            placeholder:"anything worth remembering about this formula"
        },[])
        this.noteField.value=state?.notes?.[entry.key]??""
        this.noteField.addEventListener("input",()=>{
            if(!state) return
            const text=this.noteField.value
            if(text) state.notes[entry.key]=text
            else delete state.notes[entry.key]
            this.origin?.saveSessionSoon?.()
            this.renderRows()
        })
        this.detail.append(this.noteField)
    }

    /* --- the two halves of the state, and the restorations -------------- */
    serializeState(){
        /* Only the CHOICES are stored, never the chemistry.

           The collections come from the links: a skeleton knows which parents
           are wired, and the resolve rebuilds what they say. A state carrying
           ten thousand Formula objects would be a session file measured in
           hundreds of megabytes, and a SECOND copy of data the flow already
           holds — the thing nodeRestoreData explicitly avoids when it says
           "inputs keep their shape only".

           What is worth keeping is what no resolve can guess: the collections
           the user unticked, the one they were reading, the filters, and the
           annotations they typed. The graph half is the inherited one, because
           the axes and the trace options are as much the user's as these are. */
        return {
            ...(super.serializeState()??{}),
            view:this.parameters.view,
            filter:this.parameters.filter,
            sort:this.parameters.sort,
            ppmWindow:this.parameters.ppmWindow,
            logY:this.parameters.logY,
            /* LE MODE DU GRAPHE EST UN CHOIX COMME LES AUTRES: il ne se déduit
               d'aucun resolve, donc sans lui un fichier de session rouvrirait
               le nœud sur une autre lecture que celle qu'on a quittée. */
            graphMode:this.parameters.graphMode,
            current:this.parameters.current,
            selection:this.parameters.selection,
            collectionState:DC(this.parameters.collectionState),
            //the collections the user made here, as the text they typed. They
            //are the only collections this state carries, and carrying them as
            //texts is what keeps a session from growing a periodic table
            localCollections:DC(this.parameters.localCollections),
            //van Krevelen custom axis formulas
            vkXFormula:this.parameters.vkXFormula,
            vkYFormula:this.parameters.vkYFormula,
            //Clustering parameters
            clustering:this.parameters.clustering?{
                enabled:this.parameters.clustering.enabled,
                nClusters:this.parameters.clustering.nClusters,
                mode:this.parameters.clustering.mode,
                pcaComponents:this.parameters.clustering.pcaComponents,
                sigma:this.parameters.clustering.sigma,
                kNeighbors:this.parameters.clustering.kNeighbors,
                maxIter:this.parameters.clustering.maxIter,
                seed:this.parameters.clustering.seed,
                dataSource:this.parameters.clustering.dataSource
            }:null
        }
    }
    restoreState(state){
        super.restoreState(state)
        if(!state){
            return
        }
        /* A view this build does not know falls back instead of sticking. It
           matters more now that there are three: the old test was "formula or
           stoichiometry", and anything else left the two-position switch painting
           half a state — a lit "Stoichiometry" over a list of formulae, which is
           the one place a reader checks. */
        this.parameters.view=["formula","stoichiometry","peaks"].includes(state.view)
            ?state.view
            :"formula"
        this.parameters.filter=typeof state.filter==="string"?state.filter:""
        this.parameters.sort=FORMULA_SORTS[state.sort]?state.sort:"mz"
        if(Number.isFinite(state.ppmWindow)&&state.ppmWindow>0){
            this.parameters.ppmWindow=state.ppmWindow
        }
        this.parameters.logY=!!state.logY
        /* UN MODE INCONNU RETOMBE SUR LE DÉFAUT, comme la vue et l'ordre: un
           fichier écrit par un autre build ne doit pas pouvoir vider le
           graphique en demandant une troisième lecture qui n'existe pas. */
        this.parameters.graphMode=["error","intensity","vankrevelen","barycentric"].includes(state.graphMode)
            ?state.graphMode
            :FormulaCollectionNode.GRAPH_MODE_DEFAULT
        this.parameters.current=typeof state.current==="string"?state.current:null
        this.parameters.selection=typeof state.selection==="string"?state.selection:null
        this.parameters.collectionState=state.collectionState&&typeof state.collectionState==="object"
            ?DC(state.collectionState)
            :{}
        /* A saved collection is a name and a list of texts. Anything else in
           here is a session file this build did not write, and dropping it
           quietly would be better than throwing on it: the collection comes
           back empty and the user retypes what they had. */
        this.parameters.localCollections=Array.isArray(state.localCollections)
            ?state.localCollections
                .filter(local=>local&&typeof local.name==="string")
                .map(local=>({name:local.name,keys:Array.isArray(local.keys)?local.keys.filter(k=>typeof k==="string"):[]}))
            :[]
        /* Van Krevelen parameters. */
        if(typeof state.vkXFormula==="string") this.parameters.vkXFormula=state.vkXFormula
        if(typeof state.vkYFormula==="string") this.parameters.vkYFormula=state.vkYFormula
        /* Clustering parameters. */
        if(state.clustering&&typeof state.clustering==="object"){
            const c=state.clustering
            if(typeof c.enabled==="boolean") this.parameters.clustering.enabled=c.enabled
            if(Number.isFinite(c.nClusters)&&c.nClusters>=2) this.parameters.clustering.nClusters=c.nClusters
            if(["kmeans","spectral"].includes(c.mode)) this.parameters.clustering.mode=c.mode
            if(Number.isFinite(c.pcaComponents)&&c.pcaComponents>=0) this.parameters.clustering.pcaComponents=c.pcaComponents
            if(Number.isFinite(c.sigma)&&c.sigma>=0) this.parameters.clustering.sigma=c.sigma
            if(Number.isFinite(c.kNeighbors)&&c.kNeighbors>=1) this.parameters.clustering.kNeighbors=c.kNeighbors
            if(Number.isFinite(c.maxIter)&&c.maxIter>=10) this.parameters.clustering.maxIter=c.maxIter
            if(Number.isFinite(c.seed)&&c.seed>=0) this.parameters.clustering.seed=c.seed
            if(["targets","graph"].includes(c.dataSource)) this.parameters.clustering.dataSource=c.dataSource
        }
        /* The widgets only exist once the node has been REGISTERED, and a
           restore happens after — but a headless restore must not throw on a
           node that never opened a panel, so every repaint is guarded. */
        this.viewToggle?.paint()
        if(this.sortSelect) this.sortSelect.value=this.parameters.sort
        if(this.filterInput) this.filterInput.value=this.parameters.filter
        /* SELECT THE FIRST COLLECTION BY DEFAULT, and do it on the restore path
           too — not only after the resolve that follows. A restored session whose
           saved `current` name has gone away (a parent dropped, a local collection
           renamed) would otherwise leave NO row highlighted until the next resolve
           lands, which reads as "nothing is selected". `syncCurrentCollection`
           falls back to collections[0] for a name that no longer exists, so the
           first collection on screen is the one shown — no dark pattern, no forced
           click. On a fresh restore `this.collections` is still empty and this is
           a harmless no-op; the resolve that follows fills them and selects. */
        if(this.collections.length) this.syncCurrentCollection()
        this.renderCollections()
        this.renderRows()
        this.renderSelection()
        this.renderGraphOptions()
        this.renderClusteringOptions()
    }
    restoreAfterImport(){
        super.restoreAfterImport()
        /* The panels are drawn EMPTY on purpose. The collections arrive with
           the resolve that follows the import; re-reading them here would
           resolve this node outside the flow's own order — the rule
           DelimitedTextNode and SimpleXYPlotNode both follow. */
        this.renderCollections()
        this.renderRows()
    }
    refreshFromLinks(){
        /* The undo path: this is a NEW instance whose inputs are empty Maps,
           and the command has just drawn the links again. Same contract as
           SimpleXYPlotNode — rebuild from the live links, never from a copy
           the command happens to be holding. */
        this.destination?.syncInputs(this).then(()=>this.startResolve())
    }

    async setGraphMode(mode){
        /* LE MODE EST UN CHOIX DE LECTURE, pas un filtre: changer de mode ne
           touche à rien d'autre — ni les collections cochées, ni les filtres, ni
           les notes. Le dire ici évite le glissement bien connu qui consiste à
           « réinitialiser le graphe » et à perdre les deux. */
        if(this.parameters.graphMode===mode) return
        this.parameters.graphMode=mode
        this.origin?.saveSessionSoon?.()
        /* LE PANNEAU SE REFAIT, parce que les contrôles dépendent du mode:
           Lin/Log seulement en intensité, scale/offset seulement en van Krevelen. */
        this.renderGraphOptions()
        /* THE TRACES MUST EXIST BEFORE ANYTHING READS THEM, and refreshGraph is
           async — in barycentric and van Krevelen it awaits the projection
           kernel before it calls setTraces. computeClustering re-clusters by
           reading graph.traces, so if the two ran at once it would read the
           PREVIOUS mode's points, tag them with the new mode, and draw one
           mode's cloud on another's axes (or nothing at all, off the unit
           circle). AWAIT the redraw first; the graph is the selected mode, then
           the clustering follows the points now actually on screen. */
        await this.refreshGraph()
        /* A CLUSTERING DONE ON THE PLOTTED POINTS belongs to the mode it was
           run in: its clustered traces carry that mode's coordinates (m/z vs
           error, O/C vs H/C, or the barycentric projection). Left as they are,
           switching the mode would draw one mode's points on another mode's
           axes. So changing the view RE-RUNS the partition on the new points —
           the graph is always the selected mode, the clustering follows the data
           it is pointed at, and the colouring stays true to what is on screen.

           NO RESULTS REQUIRED, and that is the whole point: guarded on
           `clust.results`, the FIRST arrival in a mode (error or intensity ->
           barycentric, with clustering already on) drew the mode flat and
           uncoloured, because there was nothing to refresh yet. The run had to
           be started, not re-started. */
        const clust=this.parameters.clustering
        if(clust?.enabled&&clust.dataSource==="graph"){
            this.computeClustering()
        }
    }
    async applyVkFormulas(){
        /* READ THE TWO AXIS FIELDS, redraw, and re-cluster on the new ratios.
           Changing O/C to H/C moves EVERY van Krevelen point, so a partition
           computed on the old coordinates is stale: without the re-cluster the
           colouring (and the cluster means) still described the previous axes,
           and only a round-trip to another mode would have refreshed them. */
        this.parameters.vkXFormula=this.vkXFormula.value
        this.parameters.vkYFormula=this.vkYFormula.value
        this.origin?.saveSessionSoon?.()
        const clust=this.parameters.clustering
        const reclustering=clust?.enabled&&clust.dataSource==="graph"
        /* A GRAPH-SOURCE PARTITION IS VALID ONLY FOR THE COORDINATES IT WAS
           COMPUTED ON. Changing O/C to H/C moves every van Krevelen point, so
           the cached clusteredTraces describe the OLD axes — and because the
           mode is still "vankrevelen", refreshGraph would happily REPLAY them
           and the new formula would never reach the diagram (this is why it
           worked with clustering off and not on). Drop the stale result before
           the redraw so refreshGraph recomputes from the new formulas, then
           re-cluster those fresh points below. */
        if(reclustering) clust.results=null
        /* AWAIT THE REDRAW FIRST, for the same reason as setGraphMode: the
           re-cluster below reads the plotted points, and it must read the ones
           computed from the NEW formulas, not the old traces still on the graph. */
        await this.refreshGraph()
        /* NO RESULTS REQUIRED, for the same reason as in setGraphMode: the very
           first partition of the new ratios has to be STARTED, not refreshed. */
        if(reclustering){
            this.computeClustering()
        }
    }
    renderGraphOptions(){
        if(!this.graphOptions) return
        this.graphOptions.replaceChildren()
        const mode=this.parameters.graphMode
        const isVankrevelen=mode==="vankrevelen"
        const isBarycentric=mode==="barycentric"
        const byError=!isVankrevelen&&!isBarycentric&&mode!=="intensity"
        /* CE QUE LE GRAPHE MONTRE, et c'est le PREMIER contrôle de la section:
           les deux autres (échelle, budget) ne se lisent qu'en sachant ce qu'il
           y a sur l'axe. */
        this.graphModeToggle=segmentToggle({
            get:()=>this.parameters.graphMode,
            set:(value)=>this.setGraphMode(value),
            states:[
                {value:"error",label:"Error"},
                {value:"intensity",label:"Intensity"},
                {value:"vankrevelen",label:"van Krevelen"},
                {value:"barycentric",label:"Barycentric"}
            ],
            title:"What one point of the central graph says: error in ppm, signal intensity, van Krevelen ratios (O/C vs H/C), or barycentric projection of elemental compositions"
        })
        /* VAN KREVELEN CONTROLS: custom X and Y axis formulas.
           User writes expressions using element symbols, e.g., "O/C", "1+C+N/2-H/2".
           The graph recomputes on COMMIT only — blur (leaving the field) and
           Enter — not on every keystroke. A half-typed expression like "O/" is
           not a valid ratio, and re-plotting it on each character would flash a
           broken diagram mid-typing; waiting for the commit reads the field once,
           when it holds a complete formula. `change` fires on both, so one
           handler covers blur and Enter alike. */
        const commitVkRefresh=()=>this.applyVkFormulas()
        this.vkXFormula=CE("input",{
            type:"text",
            value:this.parameters.vkXFormula,
            placeholder:"X · O/C",
            title:"X-axis formula using element symbols (C, H, O, N, S, P, etc.), DBE, Mass and comparisons (==, !=, <, <=, >, >=). Example: O/C or DBE==1",
            style:{width:"100%",minWidth:"0",boxSizing:"border-box",padding:"2px 4px",fontFamily:"monospace",fontSize:"0.9em"}
        },[])
        this.vkXFormula.addEventListener("change",commitVkRefresh)
        this.vkYFormula=CE("input",{
            type:"text",
            value:this.parameters.vkYFormula,
            placeholder:"Y · H/C",
            title:"Y-axis formula using element symbols (C, H, O, N, S, P, etc.), DBE, Mass and comparisons (==, !=, <, <=, >, >=). Example: H/C or DBE==1",
            style:{width:"100%",minWidth:"0",boxSizing:"border-box",padding:"2px 4px",fontFamily:"monospace",fontSize:"0.9em"}
        },[])
        this.vkYFormula.addEventListener("change",commitVkRefresh)
        this.vkReadout=CE("span",{
            className:"pp-readout",
            title:"Points drawn / points eligible",
            style:{justifySelf:"end"}
        },[""])
        /* Van Krevelen controls stack VERTICALLY: readout on top (it was pushed
           off the panel by the old 3-column grid), X/Y inputs side by side
           below. No visible "X:"/"Y:" spans — the axis lives in each input's
           title and placeholder, and the inputs flex instead of holding a
           fixed 200px that overflowed the narrow right panel. */
        this.vkFields=CE("div",{style:{display:"grid",gridTemplateColumns:"minmax(0,1fr) minmax(0,1fr)",gap:"4px",minWidth:"0"}},[])
        this.vkFields.append(this.vkXFormula,this.vkYFormula)
        this.vkRow=CE("div",{className:"pp-row",style:{gridTemplateColumns:"minmax(0,1fr)",fontSize:"0.95em",gap:"2px",paddingLeft:"0",paddingRight:"0"}},[])
        this.vkRow.append(this.vkReadout,this.vkFields)
        if(!isVankrevelen){
            this.vkRow.style.display="none"
        }
        this.logToggle=scaleToggle({
            get:()=>this.parameters.logY,
            set:(on)=>{
                this.parameters.logY=on
                this.graph.parameters.axis.left.scale=on?"log":"linear"
                this.graph.drawGraph()
            },
            leftLabel:"Lin",
            rightLabel:"Log",
            title:"Scale of the intensity axis"
        })
        /* LE LOG N'EST PROPOSÉ QU'EN INTENSITÉ. Pas « désactivé », PAS
           simplement ignoré: absent. Une erreur en ppm est négative pour la
           moitié des points, et un graphique en log SUPPRIMERAIT ces points
           sans rien dire — l'utilisateur verrait un graphe vide alors que tout
           va bien, ce qui est la pire des deux erreurs possibles. */
        this.logRow=CE("label",{style:{display:"flex",alignItems:"center",gap:"4px",minWidth:"0"}},[])
        if(!byError && !isVankrevelen && !isBarycentric){
            this.logRow.append(this.logToggle)
        }else{
            this.logRow.append(CE("span",{style:{opacity:"0.6",fontSize:"0.9em"}},["Lin"]))
            this.logRow.title=isVankrevelen
                ?"Logarithmic scale not available for van Krevelen ratios (can be zero or negative)"
                :isBarycentric
                ?"Logarithmic scale not available for barycentric projection (Rx/Ry in [-1,1])"
                :"A logarithmic axis would delete every point whose error is zero or negative, without saying so — so it is not offered here"
        }
        this.graphReadout=CE("span",{
            className:"pp-readout",
            title:"Points drawn / points eligible"
        },[""])
        const row=CE("div",{className:"pp-row",style:{gridTemplateColumns:"auto minmax(0,1fr) auto",fontSize:"0.95em"}},[])
        row.append(this.logRow,this.graphReadout)
        if(isVankrevelen || isBarycentric){
            row.style.display="none"
        }
        /* LE MODE EN PREMIER, sur sa propre ligne: il dit ce qu'on regarde, et
           les deux lignes du dessous sont les réglages de CETTE lecture. */
        const modeRow=CE("div",{className:"pp-row",style:{gridTemplateColumns:"minmax(0,1fr)",fontSize:"0.95em",paddingLeft:"0"}},[])
        this.graphModeToggle.style.justifySelf="start"
        modeRow.append(this.graphModeToggle)
        this.graphOptions.append(
            CE("div",{className:"pp-caption"},["Graphs"]),
            modeRow,
            row,
            this.vkRow
        )
    }
    renderClusteringOptions(){
        if(!this.clusteringOptions) return
        this.clusteringOptions.replaceChildren()
        const clust=this.parameters.clustering
        const hasCurrent=this.currentCollection!=null
        /* Enable checkbox */
        this.clustEnableToggle=CE("input",{
            type:"checkbox",
            checked:clust.enabled,
            title:"Enable clustering on the current collection's points"
        },[])
        this.clustEnableToggle.addEventListener("change",()=>{
            clust.enabled=this.clustEnableToggle.checked
            this.origin?.saveSessionSoon?.()
            this.renderClusteringOptions()
            if(clust.enabled) this.computeClustering()
            else this.clearClustering()
        })
        const enableRow=CE("div",{className:"pp-row",style:{gridTemplateColumns:"auto minmax(0,1fr)",fontSize:"0.95em",alignItems:"center",gap:"4px"}},[])
        enableRow.append(
            this.clustEnableToggle,
            CE("span",{style:{fontWeight:"500"}},[hasCurrent?"Clustering":"Clustering (select a collection first)"])
        )
        if(!hasCurrent) this.clustEnableToggle.disabled=true
        /* Number of clusters input */
        this.clustNClusters=CE("input",{
            type:"number",
            min:2,
            max:20,
            value:clust.nClusters,
            title:"Number of clusters (classes) to find",
            style:{width:"60px",padding:"2px 4px",fontSize:"0.9em"}
        },[])
        this.clustNClusters.addEventListener("change",()=>{
            const v=parseInt(this.clustNClusters.value,10)
            if(Number.isFinite(v)&&v>=2) clust.nClusters=v
            this.origin?.saveSessionSoon?.()
            if(clust.enabled) this.computeClustering()
        })
        /* Clustering mode selector */
        this.clustModeSelect=CE("select",{
            value:clust.mode,
            title:"Clustering algorithm: K-means (centroid-based) or Spectral Partitioning (graph-based)",
            style:{padding:"2px 4px",fontSize:"0.9em",minWidth:"0"}
        },[])
        this.clustModeSelect.appendChild(new Option("K-means","kmeans"))
        this.clustModeSelect.appendChild(new Option("Spectral Partitioning","spectral"))
        /* SET THE VALUE AFTER THE OPTIONS EXIST. `CE` applies `.value` while the
           select is still empty — and `.value` on a select with no options does
           nothing — so the rebuilt control always fell back to its FIRST option
           and "Spectral Partitioning" appeared to snap back to "K-means" the
           instant it was chosen, even though `clust.mode` was stored correctly. */
        this.clustModeSelect.value=clust.mode
        this.clustModeSelect.addEventListener("change",()=>{
            clust.mode=this.clustModeSelect.value
            this.origin?.saveSessionSoon?.()
            this.renderClusteringOptions()
            if(clust.enabled) this.computeClustering()
        })
        /* Data source selector: 3D from targets or 2D from graph traces */
        this.clustDataSourceSelect=CE("select",{
            value:clust.dataSource,
            title:"Data source for clustering: 3D [mz,intensity,error] from targets, or 2D [x,y] from plotted graph traces",
            style:{padding:"2px 4px",fontSize:"0.9em",minWidth:"0"}
        },[])
        this.clustDataSourceSelect.appendChild(new Option("Targets (3D: mz,intensity,error)","targets"))
        this.clustDataSourceSelect.appendChild(new Option("Graph traces (2D: current x,y)","graph"))
        /* SAME BUG, SAME FIX: set the value once the options are in place, or the
           rebuilt control shows its first entry ("Targets") no matter what was
           stored, and the source selector looks like it refuses to move. */
        this.clustDataSourceSelect.value=clust.dataSource
        this.clustDataSourceSelect.addEventListener("change",()=>{
            clust.dataSource=this.clustDataSourceSelect.value
            this.origin?.saveSessionSoon?.()
            this.renderClusteringOptions()
            if(clust.enabled) this.computeClustering()
        })
        /* PCA components input. `0` (the default) decorrelates and keeps every
           component; a positive number reduces to that many; `-1` turns PCA
           off entirely and clusters on the standardised features as they are. */
        this.clustPcaComponents=CE("input",{
            type:"number",
            min:-1,
            max:50,
            value:clust.pcaComponents,
            title:"PCA for decorrelation: 0 = keep all components (default), N>0 = keep N components (also denoises), -1 = PCA off",
            style:{width:"60px",padding:"2px 4px",fontSize:"0.9em"}
        },[])
        this.clustPcaComponents.addEventListener("change",()=>{
            const v=parseInt(this.clustPcaComponents.value,10)
            if(Number.isFinite(v)&&v>=-1) clust.pcaComponents=v
            this.origin?.saveSessionSoon?.()
            if(clust.enabled) this.computeClustering()
        })
        /* Spectral-specific: sigma */
        this.clustSigma=CE("input",{
            type:"number",
            min:0,
            step:0.1,
            value:clust.sigma,
            title:"Sigma for RBF kernel (0 = auto-estimate from data)",
            style:{width:"70px",padding:"2px 4px",fontSize:"0.9em"}
        },[])
        this.clustSigma.addEventListener("change",()=>{
            const v=parseFloat(this.clustSigma.value)
            if(Number.isFinite(v)&&v>=0) clust.sigma=v
            this.origin?.saveSessionSoon?.()
            if(clust.enabled&&clust.mode==="spectral") this.computeClustering()
        })
        /* Spectral-specific: k-neighbors */
        this.clustKNeighbors=CE("input",{
            type:"number",
            min:1,
            max:50,
            value:clust.kNeighbors,
            title:"Number of neighbors for k-NN graph (spectral clustering only)",
            style:{width:"60px",padding:"2px 4px",fontSize:"0.9em"}
        },[])
        this.clustKNeighbors.addEventListener("change",()=>{
            const v=parseInt(this.clustKNeighbors.value,10)
            if(Number.isFinite(v)&&v>=1) clust.kNeighbors=v
            this.origin?.saveSessionSoon?.()
            if(clust.enabled&&clust.mode==="spectral") this.computeClustering()
        })
        /* K-means specific: max iterations */
        this.clustMaxIter=CE("input",{
            type:"number",
            min:10,
            max:1000,
            value:clust.maxIter,
            title:"Maximum iterations for K-means",
            style:{width:"70px",padding:"2px 4px",fontSize:"0.9em"}
        },[])
        this.clustMaxIter.addEventListener("change",()=>{
            const v=parseInt(this.clustMaxIter.value,10)
            if(Number.isFinite(v)&&v>=10) clust.maxIter=v
            this.origin?.saveSessionSoon?.()
            if(clust.enabled&&clust.mode==="kmeans") this.computeClustering()
        })
        /* Seed for reproducibility */
        this.clustSeed=CE("input",{
            type:"number",
            min:0,
            max:2147483647,
            value:clust.seed,
            title:"Random seed for reproducibility",
            style:{width:"80px",padding:"2px 4px",fontSize:"0.9em"}
        },[])
        this.clustSeed.addEventListener("change",()=>{
            const v=parseInt(this.clustSeed.value,10)
            if(Number.isFinite(v)&&v>=0) clust.seed=v
            this.origin?.saveSessionSoon?.()
            if(clust.enabled) this.computeClustering()
        })
        /* Run button */
        this.clustRunBtn=CE("button",{
            type:"button",
            title:"Run clustering on the current collection",
            style:{padding:"2px 8px",cursor:"pointer",fontSize:"0.9em",justifySelf:"start"}
        },["Run Clustering"])
        this.clustRunBtn.addEventListener("click",()=>this.computeClustering())
        if(!hasCurrent) this.clustRunBtn.disabled=true
        /* Status readout */
        this.clustReadout=CE("span",{
            className:"pp-readout",
            style:{justifySelf:"end",fontSize:"0.85em"}
        },[clust.results?`${clust.results.nClusters} clusters, ${clust.results.nPoints} points`:""])
        /* Build rows */
        /* UNE LIGNE PAR SÉLECTEUR, ET CHACUNE À SA LARGEUR.

           Trois réglages sur une ligne, c'est trois occasions de tronquer: à
           la largeur du panneau, la plus longue des options — « Targets (3D:
           mz,intensity,error) », « Spectral Partitioning » — mange les deux
           autres, qui disparaissent derrière un `minmax(0,1fr)` qu'elles ne
           peuvent pas remplir. Une ligne par réglage rend la troncature
           impossible sans rien retirer à personne.

           LE MODE SEUL SUR SA LIGNE PARCE QU'IL VAUT PLUS QUE LES DEUX
           AUTRES: c'est lui qui change le résultat le plus, et c'est le seul
           des trois dont le changement ne se voie pas immédiatement — une
           partition spectrale se distingue d'une k-means à la forme des
           groupes, pas à l'affichage du panneau. */
        const modeRow=CE("div",{className:"pp-row",style:{gridTemplateColumns:"minmax(0,1fr)",fontSize:"0.95em",alignItems:"center",gap:"4px"}},[])
        modeRow.append(
            CE("label",{style:{display:"flex",alignItems:"center",gap:"4px",fontSize:"0.9em"}},[CE("span",{},["Mode:"]),this.clustModeSelect])
        )
        const sourceRow=CE("div",{className:"pp-row",style:{gridTemplateColumns:"minmax(0,1fr)",fontSize:"0.95em",alignItems:"center",gap:"4px"}},[])
        sourceRow.append(
            CE("label",{style:{display:"flex",alignItems:"center",gap:"4px",fontSize:"0.9em"}},[CE("span",{},["Source:"]),this.clustDataSourceSelect])
        )
        const nClustersRow=CE("div",{className:"pp-row",style:{gridTemplateColumns:"auto minmax(0,1fr) auto",fontSize:"0.95em",alignItems:"center",gap:"4px"}},[])
        nClustersRow.append(
            CE("label",{style:{display:"flex",alignItems:"center",gap:"4px",fontSize:"0.9em"}},[CE("span",{},["Clusters:"]),this.clustNClusters]),
            this.clustReadout
        )
        const pcaRow=CE("div",{className:"pp-row",style:{gridTemplateColumns:"auto minmax(0,1fr) auto",fontSize:"0.95em",alignItems:"center",gap:"4px"}},[])
        pcaRow.append(
            CE("label",{style:{display:"flex",alignItems:"center",gap:"4px",fontSize:"0.9em"}},[CE("span",{},["PCA comps:"]),this.clustPcaComponents]),
            this.clustRunBtn
        )
        const spectralRow=CE("div",{className:"pp-row",style:{gridTemplateColumns:"auto minmax(0,1fr)",fontSize:"0.95em",alignItems:"center",gap:"4px"}},[])
        spectralRow.append(
            CE("label",{style:{display:"flex",alignItems:"center",gap:"4px",fontSize:"0.9em"}},[CE("span",{},["Sigma:"]),this.clustSigma]),
            CE("label",{style:{display:"flex",alignItems:"center",gap:"4px",fontSize:"0.9em"}},[CE("span",{},["k-NN:"]),this.clustKNeighbors])
        )
        if(clust.mode!=="spectral") spectralRow.style.display="none"
        const kmeansRow=CE("div",{className:"pp-row",style:{gridTemplateColumns:"auto minmax(0,1fr)",fontSize:"0.95em",alignItems:"center",gap:"4px"}},[])
        kmeansRow.append(
            CE("label",{style:{display:"flex",alignItems:"center",gap:"4px",fontSize:"0.9em"}},[CE("span",{},["Max iter:"]),this.clustMaxIter]),
            CE("label",{style:{display:"flex",alignItems:"center",gap:"4px",fontSize:"0.9em"}},[CE("span",{},["Seed:"]),this.clustSeed])
        )
        if(clust.mode!=="kmeans") kmeansRow.style.display="none"
        /* LE CONTENEUR NE DÉFILE QUE EN VERTICAL.

           Il portait `overflow:auto`, qui ouvre une barre horizontale dès qu'un
           enfant dépasse — et un enfant dépasse toujours ici, parce que le
           centre du cluster est du monospace qu'on a interdit de rétrécir.
           Le défilement vertical reste (six clusters ne tiennent pas en
           150 px); l'horizontal disparaît, parce qu'aucune information ne se
           trouve à droite du bord: ce qui ne tient pas doit se tronquer ou
           disparaître, pas rendre le panneau scrollable de côté pour aller
           chercher deux chiffres. */
        this.clustManager=CE("div",{
            style:{marginTop:"6px",maxHeight:"150px",overflowY:"auto",overflowX:"hidden",
                border:"1px solid var(--border)",borderRadius:"3px",padding:"4px",
                fontSize:"0.85em",display:"none"}
        },[])
        this.clusteringOptions.append(
            CE("div",{className:"pp-caption"},["Clustering"]),
            enableRow,
            modeRow,
            sourceRow,
            nClustersRow,
            pcaRow,
            spectralRow,
            kmeansRow,
            this.clustManager
        )
        if(clust.enabled&&clust.results) this.updateClusterManager()
    }
    updateClusterManager(){
        if(!this.clustManager) return
        const clust=this.parameters.clustering
        const results=clust.results
        this.clustManager.replaceChildren()
        /* NO RESULTS, NO MANAGER. Returning early used to leave the rows of
           the previous run on screen after the toggle cleared the results —
           a list of clusters that no longer exist. */
        if(!clust.enabled||!results){
            this.clustManager.style.display="none"
            return
        }
        this.clustManager.style.display="block"
        this.clustManager.append(CE("div",{style:{fontWeight:"600",marginBottom:"2px",borderBottom:"1px solid var(--border)",paddingBottom:"2px"}},["Cluster Manager"]))
        for(let c=0;c<results.nClusters;c++){
            const count=results.counts[c]
            const [cx,cy]=this.clusterCenterXY(c)
            const color=this.getClusterColor(c,results.nClusters)
            const row=CE("div",{
                style:{
                    display:"flex",alignItems:"center",gap:"4px",
                    padding:"2px 4px",marginBottom:"2px",
                    background:color+"20",border:"1px solid "+color+"60",borderRadius:"3px",
                    cursor:"pointer",transition:"background 0.1s",
                    /* `minWidth:0` ET `maxWidth:100%` SUR LA LIGNE, parce que
                       ses trois enfants s'additionnent: swatch (fixe), libellé
                       (élastique) et centre (fixe). Sans la borne, la
                       largeur minimale de la ligne est la somme des deux
                       parties fixes — et le conteneur, qui a une bordure, la
                       déborde de deux pixels, ce qui suffit à faire apparaître
                       l'ascenseur horizontal sur une liste de six lignes dont
                       aucune n'a de quoi le mériter. */
                    minWidth:"0",maxWidth:"100%",boxSizing:"border-box"
                },
                title:`Cluster ${c+1}: ${count} points (click to select the first formula of the cluster)\nCenter: (${Number.isFinite(cx)?cx.toFixed(3):"?"}, ${Number.isFinite(cy)?cy.toFixed(3):"?"})`
            },[])
            const swatch=CE("div",{style:{width:"12px",height:"12px",borderRadius:"50%",background:color,flex:"none",border:"1px solid #fff"}},[])
            const label=CE("span",{style:{flex:"1",minWidth:"0",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}, [`Cluster ${c+1} (${count} pts)`])
            /* LE CENTRE, ET C'EST LUI QUI PROVOQUE LE DÉBORDEMENT. Il était
               `flex:"none"`, donc sa largeur était un plancher: deux fois cinq
               chiffres en monospace plus les parenthèses, et la ligne ne
               pouvait plus rétrécir — elle poussait le conteneur bordered de
               quelques pixels, ce qui suffisait à faire apparaître
               l'ascenseur horizontal. Il peut maintenant perdre ses décimales
               les moins utiles (`toFixed(1)`) et se tronquer si le panneau
               devient vraiment étroit: le titre de la ligne, lui, garde les
               trois décimales, donc rien n'est perdu — c'est le cas typique du
               texte secondaire qu'on rétrécit en premier. */
            const centerText=CE("span",{
                style:{opacity:"0.7",fontFamily:"monospace",fontSize:"0.8em",
                    flex:"0 1 auto",minWidth:"0",whiteSpace:"nowrap",overflow:"hidden"}
            }, [`(${Number.isFinite(cx)?cx.toFixed(1):"?"}, ${Number.isFinite(cy)?cy.toFixed(1):"?"})`])
            row.append(swatch,label,centerText)
            row.addEventListener("mouseenter",()=>row.style.background=color+"40")
            row.addEventListener("mouseleave",()=>row.style.background=color+"20")
            row.addEventListener("click",()=>this.selectClusterInList(c))
            this.clustManager.append(row)
        }
        /* Partition button */
        if(results.nClusters>0){
            /* LE BOUTON EST UN BOUTON, PAS UNE AFFICHE.

           Il était `background:var(--accent)` — ce vert acide du thème, posé
           en pleine largeur dans le coin du panneau — et il criait plus fort
           que le graphique qu'il était censé concerner, alors qu'il ne fait
           qu'écrire six sous-collections. Aucune couleur d'accent, aucun
           aplat : les mêmes fond, texte et bordure que les autres boutons du
           programme, avec juste une bordure pour marquer la clique. Un
           élément qui attire l'œil doit mériter qu'on le regarde ; celui-là
           décrit son action dans son texte. */
            const partitionBtn=CE("button",{
                type:"button",
                style:{marginTop:"6px",padding:"4px 8px",cursor:"pointer",
fontSize:"0.85em",background:"var(--bg)",
                    color:"inherit",border:"1px solid var(--border)",borderRadius:"3px",
                    /* PLEINE LARGEUR, ET C'EST BIEN. Le bouton est la seule
                       action de la boîte: le laisser à sa largeur naturelle le
                       ferait flotter au milieu de la liste au lieu de la
                       clore. `boxSizing:border-box` EXPLICITE pour que les
                       100 % se mesurent sur la bordure comprise — sans quoi le
                       bouton dépasse d'un pixel de chaque côté et se fait
                       rogner par l'`overflow-x:hidden` du conteneur. C'est le
                       seul endroit du fichier où la largeur pleine et la
                       bordure ne sont pas compatibles sans cela. */
                    width:"100%",boxSizing:"border-box"},
                title:"Split the current collection into sub-collections, one per cluster"
            },["Partition into Sub-collections"])
            partitionBtn.addEventListener("click",()=>this.partitionCollectionByClusters())
            this.clustManager.append(partitionBtn)
        }
    }
    getClusterColor(index,total){
        // Use the same color palette as traces
        const palette=["#e74c3c","#3498db","#2ecc71","#f39c12","#9b59b6","#1abc9c","#e67e22","#16a085"]
        return palette[index%palette.length]
    }
    /* THE CENTER OF A CLUSTER, IN THE COORDINATES ON SCREEN. The x is always
       the mean m/z of the cluster's points; the y is the mean error in
       "error" mode and the mean intensity in "intensity" mode. One fixed
       (x,y) pair would answer to the wrong axis the moment the mode
       changed — which is how a marker ended up drawn in mid-air. */
    clusterCenterXY(index){
        const clust=this.parameters.clustering
        const results=clust?.results
        const centers=results?.centers
        if(!centers||!centers.mz) return [NaN,NaN]
        /* A GRAPH-SOURCE CLUSTER WAS COMPUTED FROM THE POINTS ON SCREEN, so its
           centre is the mean of those plotted coordinates: mean x sits in
           centers.mz, mean y in centers.intensity, in whatever units the current
           mode draws. That pair is correct in EVERY mode — error, intensity, van
           Krevelen or barycentric — because it is literally the centroid of what
           is being drawn. */
        if(results.dataSource==="graph"){
            return [centers.mz[index], centers.intensity?centers.intensity[index]:NaN]
        }
        /* A TARGETS-SOURCE CLUSTER carries a real m/z and a real error/intensity.
           Those only line up with the POINT modes, where a point IS a target; on
           a van Krevelen or barycentric axis a mean m/z has no position, so no
           marker is drawn there. */
        const mode=this.parameters.graphMode
        const vertical=mode==="intensity"?centers.intensity:centers.errorPpm
        return [centers.mz[index], vertical?vertical[index]:NaN]
    }
    selectClusterInList(clusterIndex){
        // Highlight/select formulas belonging to this cluster in the left list
        const clust=this.parameters.clustering
        if(!clust.results||!this.currentCollection) return
        const results=clust.results
        if(results.collectionName&&results.collectionName!==this.currentCollection.name) return
        const entries=this.currentCollection.entries
        /* BY ENTRY, NOT BY POINT. A cluster holds POINTS — one per measured
           target — and the i-th point is not the i-th formula: an entry owns
           several targets or none at all, so indexing entries with an
           assignment count selected whatever happened to sit at that row.
           entryAssignments is the cluster of each FORMULA (the cluster of its
           first measured target), which is what a row in the list is. */
        const entryAssignments=results.entryAssignments??[]
        const keysInCluster=new Set()
        for(let i=0;i<entryAssignments.length&&i<entries.length;i++){
            if(entryAssignments[i]===clusterIndex) keysInCluster.add(entries[i].key)
        }
        // Select first formula in this cluster
        for(const entry of entries){
            if(keysInCluster.has(entry.key)){
                this.parameters.selection=entry.key
                this.selectedEntry=entry
                this.origin?.saveSessionSoon?.()
                this.renderRows()
                this.renderSelection()
                this.refreshGraph() // Will color points by cluster
                break
            }
        }
    }
    async computeClustering(){
        /* ONE RUN AT A TIME, and only the LAST request matters. Eight
           controls and the button call this with no debounce, and the pool
           is FIFO: a burst of changes used to queue the whole pipeline once
           per change, one behind the other — and while a spectral run sat
           in the queue, every later task, PCA and k-means included, waited
           behind it. A request that arrives mid-run is remembered and run
           once, when the current one lands, with the parameters as they
           stand by then. */
        if(this.clusteringBusy){
            this.clusteringPending=true
            return
        }
        const clust=this.parameters.clustering
        if(!this.currentCollection) return
        const collection=this.currentCollection
        let points, pointKeys, entryIndices, n_features
        if(clust.dataSource==="graph"){
            const extracted=this.extractPointsFromGraphTraces(collection.name)
            points=extracted.points
            pointKeys=extracted.pointKeys
            entryIndices=extracted.entryIndices
            n_features=extracted.n_features
            // For graph source, store the trace-to-cluster mapping directly
            clust.results={
                ...clust.results,
                pointKeys,
                assignments:null, // Will be filled after clustering
                collectionName:collection.name,
                dataSource:"graph"
            }
        }else{
            //Gather the POINTS, and remember WHICH target each one is. A point
            //here is a target carrying all three measurements; the graph draws a
            //target that has the m/z and whichever quantity is on screen, so the
            //POSITION of a point in this list cannot be trusted to match its
            //position in the graph's — the key is what makes them agree.
            //Filter targets the SAME WAY the current graph mode does, so the
            //keys match exactly what refreshGraph will plot.
            const mode=this.parameters.graphMode
            const needIntensity=mode==="intensity"
            const needError=mode==="error"||mode===FormulaCollectionNode.GRAPH_MODE_DEFAULT
            points=[]
            pointKeys=[]
            entryIndices=[]
            for(let i=0;i<collection.entries.length;i++){
                const entry=collection.entries[i]
                const targets=entry.targets??[]
                for(let t=0;t<targets.length;t++){
                    const target=targets[t]
                    if(!Number.isFinite(target.mz)) continue
                    if(needIntensity&&!Number.isFinite(target.intensity)) continue
                    if(needError&&!Number.isFinite(target.errorPpm)) continue
                    // Feature vector: [mz, intensity, errorPpm] (use 0 for missing)
                    const mz=target.mz
                    const intensity=Number.isFinite(target.intensity)?target.intensity:0
                    const errorPpm=Number.isFinite(target.errorPpm)?target.errorPpm:0
                    points.push(mz,intensity,errorPpm)
                    entryIndices.push(i)
                    pointKeys.push(`${i}#${t}`)
                }
            }
            n_features=3
        }
        if(points.length<clust.nClusters*n_features){
            if(this.clustReadout){
                this.clustReadout.textContent=`Need at least ${clust.nClusters*n_features} points`
                this.clustReadout.style.color="var(--warn)"
            }
            return
        }
        const n_samples=points.length/n_features
        if(this.clustReadout){
            this.clustReadout.textContent="Computing..."
            this.clustReadout.style.color="var(--accent)"
        }
        this.clusteringBusy=true
        if(this.clustRunBtn) this.clustRunBtn.disabled=true
        try{
            /* THREE SCALES, ONE DISTANCE. m/z is hundreds, the intensity is
               millions and the error is a few ppm: measured as they stand the
               distance between two points IS the distance between their
               intensities, and the clusters report on the detector rather than
               on the chemistry. Each feature is centred and divided by its own
               spread first — the standardisation every distance-based method
               assumes, and what makes the optional PCA below a decorrelation
               rather than a rescaling of whatever happens to be largest. */
            const scaled=new Float64Array(points.length)
            {
                const means=new Float64Array(n_features)
                const stds=new Float64Array(n_features)
                for(let i=0;i<n_samples;i++) for(let j=0;j<n_features;j++) means[j]+=points[i*n_features+j]
                for(let j=0;j<n_features;j++) means[j]/=n_samples
                for(let i=0;i<n_samples;i++){
                    for(let j=0;j<n_features;j++){
                        const d=points[i*n_features+j]-means[j]
                        stds[j]+=d*d
                    }
                }
                //n-1, as the covariance in pca.rs uses it; a constant feature
                //has no spread to divide by and stays a constant (as 1)
                for(let j=0;j<n_features;j++) stds[j]=Math.sqrt(stds[j]/(n_samples-1))||1
                for(let i=0;i<points.length;i++) scaled[i]=(points[i]-means[i%n_features])/stds[i%n_features]
            }
            // Step 1: PCA — decorrelates the features. ON by default (`0` keeps
            // every component, a pure rotation that removes the correlation the
            // standardisation leaves behind; `-1` turns it off). A positive
            // number keeps that many components and denoises as it reduces.
            let projected=null
            let useData=scaled
            let useFeatures=n_features
            if(clust.pcaComponents>=0){
                const pcaResult=await computePool.run("pca",{
                    data:scaled,
                    n_samples,
                    n_features,
                    n_components:clust.pcaComponents>0?Math.min(clust.pcaComponents,n_features):n_features
                })
                if(pcaResult.projected&&pcaResult.projected.length>0){
                    projected=pcaResult.projected
                    useData=Array.from(projected)
                    useFeatures=pcaResult.projected.length/n_samples
                }
            }
            // Step 2: Clustering
            let result
            if(clust.mode==="kmeans"){
                result=await computePool.run("kmeans",{
                    data:useData,
                    n_samples,
                    n_features:useFeatures,
                    n_clusters:clust.nClusters,
                    max_iter:clust.maxIter,
                    seed:clust.seed
                })
            }else{
                result=await computePool.run("spectral",{
                    data:useData,
                    n_samples,
                    n_features:useFeatures,
                    n_clusters:clust.nClusters,
                    sigma:clust.sigma,
                    k_neighbors:clust.kNeighbors
                })
            }
            if(!result||!result.assignments||result.assignments.length!==n_samples){
                throw new Error("Clustering returned invalid result")
            }
            // Cluster counts - needed for both data sources
            const counts=new Uint32Array(clust.nClusters)
            // For graph data source: create clustered traces directly from the trace points
            let clusteredTraces=null
            if(clust.dataSource==="graph"){
                // Build traces split by cluster using the extracted trace points
                const tracePointsByCluster=new Map()
                for(let i=0;i<result.assignments.length;i++){
                    const assign=result.assignments[i]
                    if(!tracePointsByCluster.has(assign)) tracePointsByCluster.set(assign,{xs:[],ys:[]})
                    tracePointsByCluster.get(assign).xs.push(points[i*n_features])
                    tracePointsByCluster.get(assign).ys.push(points[i*n_features+1])
                }
                clusteredTraces=[]
                const graphCounts=new Uint32Array(clust.nClusters)
                for(const [assign,{xs,ys}] of tracePointsByCluster){
                    if(xs.length===0) continue
                    graphCounts[assign]=xs.length
                    counts[assign]=xs.length
                    const color=this.getClusterColor(assign,clust.nClusters)
                    const cx=new Float64Array(xs)
                    const cy=new Float64Array(ys)
                    clusteredTraces.push(new XYTrace({
                        id:`${collection.name}:cluster${assign}:graph`,
                        title:`${collection.name} — cluster ${assign+1} (${xs.length})`,
                        wave:Wave.fromCoordinates(
                            cx,
                            cy,
                            {collection:collection.name, cluster:assign},
                            clust.results.labels??["x","y"]
                        ),
                        options:{
                            color,
                            mode:"points",
                            marker:{shape:"circle",size:3},
                            layer:"gl"
                        }
                    }))
                }
                // Use graph counts for the cluster manager
                counts.set(graphCounts)
            }
            // Map assignments back to entries (for targets data source)
/* LE -1 EST UN INDEX VALIDÉ ET IL FAUT L'IGNORER.

               En source graph, `extractPointsFromGraphTraces` ne sait pas
               quelle formule a produit quel point et inscrit -1. Écrire
               `entryAssignments[-1]` ne lève rien: c'est une propriété
               NOMMEe d'un tableau, hors des elements, que rien ne relira
               jamais. Le tableau restait donc entièrement à -1, et chaque
               écriture sur `entryCounts` se faisait sur le même trou
               noir — le décompte des entrées par cluster restait nul sans
               qu'aucune erreur ne le dise.

               Le garde ici n'est pas une précaution: sans lui, la source
               graph produit une table de répartition vide et muette. */
            const entryAssignments=new Array(collection.entries.length).fill(-1)
            const entryCounts=new Array(collection.entries.length).fill(0)
            for(let i=0;i<entryIndices.length;i++){
                const entryIdx=entryIndices[i]
                if(!Number.isInteger(entryIdx)||entryIdx<0||entryIdx>=entryAssignments.length) continue
                const assign=result.assignments[i]
                if(entryAssignments[entryIdx]===-1) entryAssignments[entryIdx]=assign
                entryCounts[entryIdx]++
            }
            // Compute cluster centers in the units the graph can show
            const centers={
                mz:new Float64Array(clust.nClusters).fill(NaN),
                errorPpm:new Float64Array(clust.nClusters).fill(NaN),
                intensity:new Float64Array(clust.nClusters).fill(NaN)
            }
            const sums={
                mz:new Float64Array(clust.nClusters),
                errorPpm:new Float64Array(clust.nClusters),
                intensity:new Float64Array(clust.nClusters)
            }
            /* THE CENTERS ARE OF THE POINTS, not of the entries: the mean
               intensity of an entry's targets is a different number from the
               entry's own intensity, and a center whose y is an intensity
               drawn against an error axis sits anywhere. One center per
               cluster per quantity — the drawing picks the pair the mode on
               screen shows (clusterCenterXY). */
            for(let i=0;i<entryIndices.length;i++){
                const assign=result.assignments[i]
                if(assign<0||assign>=clust.nClusters) continue
                // Graph traces were already counted when their clustered traces
                // were built from the trace points, so their counts are already
                // right there and must not be added to again.
                if(clust.dataSource!=="graph") counts[assign]++
                // For graph source, entryIndices[i] is -1, so use the point index directly
                const pointIdx=i
                if(clust.dataSource==="graph"){
                    // Graph traces carry only an x and a y (no error width), so
                    // the cluster's m/z is the mean x and its vertical centre is
                    // the mean y of its trace points.
                    sums.mz[assign]+=points[pointIdx*n_features]
                    sums.intensity[assign]+=points[pointIdx*n_features+1]
                }else{
                    sums.mz[assign]+=points[pointIdx*n_features]
                    sums.intensity[assign]+=points[pointIdx*n_features+1]
                    sums.errorPpm[assign]+=points[pointIdx*n_features+2]
                }
            }
            // For graph source, the trace's second axis is the plotted quantity
            // (intensity or error), so its mean is the cluster's vertical
            // centre regardless of the mode on screen: reuse the intensity
            // mean for the error coordinate instead of averaging an absent
            // error width (which is what the old out-of-bounds read did).
            for(let c=0;c<clust.nClusters;c++){
                if(counts[c]>0){
                    centers.mz[c]=sums.mz[c]/counts[c]
                    centers.intensity[c]=sums.intensity[c]/counts[c]
                    centers.errorPpm[c]=clust.dataSource==="graph"?centers.intensity[c]:sums.errorPpm[c]/counts[c]
                }
            }
            clust.results={
                collectionName:collection.name,
                nClusters:clust.nClusters,
                nPoints:n_samples,
                /* LES COORDONNÉES BRUTES DU CLOUD, pour la source graph.
                   `pointKeys` ne les porte pas — c'est un nom de trace et un
                   rang dans la trace — et le découpage a besoin de (x, y) pour
                   remonter à la formule qui a produit le point. Les garder
                   coûte une copie de tableau déjà en mémoire, et évite au
                   découpage de relire un graphique qui a pu changer depuis. */
                graphPoints:clust.dataSource==="graph"?Array.from(points):null,
                n_features,
                assignments:Array.from(result.assignments),
                pointKeys,
                entryAssignments,
                entryCounts,
                centers,
                counts:Array.from(counts),
                projected:projected?Array.from(projected):null,
                pcaComponents:clust.pcaComponents,
                mode:clust.mode,
                dataSource:clust.dataSource,
                /* THE MODE THE CLUSTERED TRACES WERE BUILT IN. A graph-source
                   partition is made of the coordinates the selected graph mode
                   plotted (m/z vs error, O/C vs H/C, or the barycentric
                   projection). The traces are only reused while that is still
                   the mode on screen; switch the mode and refreshGraph falls
                   back to the flat traces of the NEW mode, which is what the
                   re-run then clusters. Without this tag a mode switch would
                   paint one mode's points onto another's axes. */
                graphMode:this.parameters.graphMode,
                clusteredTraces:clusteredTraces,
                labels:clust.dataSource==="graph"?(clust.results?.labels??["x","y"]):undefined
            }
            if(this.clustReadout){
                this.clustReadout.textContent=`${clust.nClusters} clusters, ${n_samples} points`
                this.clustReadout.style.color=""
            }
            this.updateClusterManager()
            this.refreshGraph() // Recolor points by cluster
        }catch(err){
            console.error("[FormulaCollectionNode] Clustering failed:",err)
            if(this.clustReadout){
                this.clustReadout.textContent=`Error: ${err.message}`
                this.clustReadout.style.color="var(--error)"
            }
        }finally{
            if(this.clustRunBtn) this.clustRunBtn.disabled=false
            this.clusteringBusy=false
            if(this.clusteringPending){
                this.clusteringPending=false
                this.computeClustering()
            }
        }
    }
    clearClustering(){
        this.parameters.clustering.results=null
        this.clustReadout.textContent=""
        this.updateClusterManager()
        this.refreshGraph()
    }
    /* L'ENTRÉE D'UN POINT DU GRAPHE, À PARTIR DU POINT LUI-MÊME.

       C'est la question que le découpage doit pouvoir poser, et elle se pose
       par la MESURE parce que le graphique est construit par cible : dans les
       modes m/z-erreur et m/z-intensité, chaque point est le couple
       (target.mz, target.errorPpm|intensity), donc le (x, y) qu'on voit
       désigne une cible, et la cible désigne son entrée. En van Krevelen et
       barycentric, en revanche, chaque point est une FORMULE projetée sur un
       ratio, pas une cible: il n'y a rien à retrouver, et la fonction rend
       `null` — le découpage sait alors qu'il ne peut pas fonctionner et le
       dit, au lieu de répartir les formules au hasard.

       L'INDEX SE RESSERRE: une entrée a quelques cibles, pas des centaines, et
       la comparer à chaque point d'un nuage de plusieurs milliers coûterait
       des millions de tests par clic. On filtre donc d'abord sur le m/z —
       un seul accès par point — et on ne regarde le contenu que des rares
       entrées qui tombent juste. */
    buildGraphPointEntryIndex(collection){
        /* m/z → la liste des (entrée, cible) qui la portent. Deux cibles
           peuvent partager un m/z, et le m/z seul ne suffit donc pas à les
           départager — la seconde coordonnée le fera. */
        const byMz=new Map()
        for(let e=0;e<collection.entries.length;e++){
            const targets=collection.entries[e]?.targets??[]
            for(let t=0;t<targets.length;t++){
                const mz=targets[t]?.mz
                if(!Number.isFinite(mz)) continue
                let bucket=byMz.get(mz)
                if(!bucket){ bucket=[]; byMz.set(mz,bucket) }
                bucket.push([e,t,targets[t]])
            }
        }
        return {byMz,entryOf:(x,y)=>{
            const bucket=byMz.get(x)
            if(!bucket||bucket.length===0) return -1
            if(bucket.length===1) return bucket[0][0]
            /* PLUSIEURS CIBLES AU MÊME m/z: on ne garde que celles dont la
               seconde coordonnée est celle du graphique, et il ne doit en
               rester qu'une. Deux cibles qui collent ambas, la formule reste
               ambiguë et l'on ne l'attribue à personne. */
            let found=-1
            let matches=0
            for(const [e,t,target] of bucket){
                if(target.errorPpm===y||target.intensity===y){ found=e; matches++ }
            }
            return matches===1?found:-1
        }}
    }

    /* LE DÉCOUPAGE PAR CLUSTERS, POUR LES DEUX SOURCES.

       Le verrou sur « targets » venait d'un fait réel mais mal formulé : en
       source graph, les points clustering n'étaient rattachés à aucune entrée.
       Le verrou bloquait donc un cas où l'information existait bel et bien
       dans le graphique affiché — il suffisait de la remonter. On la remonte
       par la mesure (voir `buildGraphPointEntryIndex`), donc le découpage
       marche dans les deux sources ; seul un graphique de RATIO, où un point
       est une formule et non une cible, reste réellement impossible — et là
       on le dit clairement, au lieu d'un message qui ne s'explique pas. */
    async partitionCollectionByClusters(){
        const clust=this.parameters.clustering
        if(!clust.results||!this.currentCollection) return
        const results=clust.results
        const collection=this.currentCollection
        if(results.collectionName&&results.collectionName!==collection.name) return
        /* UNE SEULE LECTURE DU MODE, ET ELLE DIT SI LE DÉCOUPAGE EST
           POSSIBLE: chaque point du cluster doit être rattachable à une
           formule, donc le graphique doit être un graphique de cibles. */
        const mode=this.parameters.graphMode??FormulaCollectionNode.GRAPH_MODE_DEFAULT
        const byEntry=mode==="error"||mode==="intensity"
        if(!byEntry){
            this.origin?.notice?.("Not available on a ratio plot",
                "A van Krevelen or barycentric point is a FORMULA projected on a ratio, "+
                "not a measured target: there is nothing to map back to a formula. "+
                "Switch the graph to Error or Intensity to split by cluster.")
            return
        }
        /* UNE TABLE D'ENTRÉE PAR POINT, ET ON LA REMPLIT EN UNE PASSE.
           `clusterOf` répond « quel cluster pour CETTE formule »; on le remplit
           en parcourant les POINTS, parce que la source graph nous donne un
           point et pas une formule — l'inverse. Une formule peut avoir ses
           cibles réparties sur deux clusters: elle rejoint le PREMIER, et
           l'autre cluster garde le reste de ses points. C'est le seul choix
           possible, une formule ne pouvant être dans deux sous-collections à
           la fois; le dire ici évite d'y revenir. */
        const clusterOf=new Int32Array(collection.entries.length).fill(-1)
        const n_features=results.n_features??(results.dataSource==="graph"?2:3)
        const points=results.graphPoints
        const assignments=results.assignments
        if(results.dataSource==="graph"&&points&&points.length){
            const {entryOf}=this.buildGraphPointEntryIndex(collection)
            for(let i=0;i<assignments.length&&i<points.length/n_features;i++){
                const assign=assignments[i]
                if(assign<0||assign>=results.nClusters) continue
                const e=entryOf(points[i*n_features],points[i*n_features+1])
                if(e>=0&&clusterOf[e]===-1) clusterOf[e]=assign
            }
        }else{
            const byEntryAssignments=results.entryAssignments
            for(let e=0;e<byEntryAssignments.length&&e<collection.entries.length;e++){
                clusterOf[e]=byEntryAssignments[e]
            }
        }
        const groups=[]
        for(let c=0;c<results.nClusters;c++){
            const texts=[]
            for(let e=0;e<collection.entries.length;e++){
                if(clusterOf[e]!==c) continue
                const entry=collection.entries[e]
                //the notation, not the key: a group adduct's key does not
                //read back to the same formula (see localFormula)
                const text=entry.notation??entry.key
                if(text&&!texts.includes(text)) texts.push(text)
            }
            if(texts.length) groups.push({name:`${collection.name} - Cluster ${c+1}`,texts})
        }
        if(!groups.length){
            this.origin?.notice?.("No formulas to partition",
                "No formula matched a point of the clusters. A point is matched to a formula "+
                "through its measured m/z and its error or intensity, so a collection whose "+
                "points carry neither cannot be split.")
            return
        }
        const created=[]
        for(const group of groups){
            if(this.parameters.localCollections.some(local=>local.name===group.name)){
                this.origin?.notice?.("Name already used",`"${group.name}" already exists here.`)
                continue
            }
            const local={name:group.name,keys:[]}
            const problems=[]
            for(const text of group.texts){
                //read BEFORE stored, exactly like the add field: a spelling
                //that does not parse would come back as a diagnostic on every
                //single resolve, forever
                if(this.localFormula(text,group.name,problems)&&!local.keys.includes(text)){
                    local.keys.push(text)
                }
            }
            if(!local.keys.length) continue
            this.parameters.localCollections.push(local)
            created.push({name:group.name,count:local.keys.length})
        }
        if(!created.length) return
        this.parameters.selection=null
        this.origin?.saveSessionSoon?.()
        await this.startResolve()
        this.resolveChildren()
        this.origin?.notice?.(
            "Partitioned",
            `Created ${created.length} sub-collections from "${collection.name}": `+
            created.map(c=>`${c.name} (${c.count})`).join(", ")
        )
    }
    /* EXTRACT 2D POINTS FROM THE GRAPH TRACES of the given collection.
       Returns {points, pointKeys, entryIndices, n_features, labels}.
       Uses the currently displayed traces (what the user sees). */
    extractPointsFromGraphTraces(collectionName){
        const points=[]
        const pointKeys=[]
        const entryIndices=[]
        let n_features=2
        let xLabel="x", yLabel="y"
        if(!this.graph||!this.graph.traces) return {points,pointKeys,entryIndices,n_features,labels:[xLabel,yLabel]}
        for(const trace of this.graph.traces){
            if(!trace.wave||!trace.wave.core) continue
            const wave=trace.wave
            const count=wave.dims[0]
            const core=wave.core
            xLabel=wave.labels?.[0]??"x"
            yLabel=wave.labels?.[1]??"y"
            // Match trace to collection by name in trace.id or metadata
            const traceColl=trace.id?.split(":")[0]??trace.title?.split(" — ")[0]??trace.title
            if(traceColl!==collectionName) continue
            for(let i=0;i<count;i++){
                const x=core[i]
                const y=core[count+i]
                if(!Number.isFinite(x)||!Number.isFinite(y)) continue
                points.push(x,y)
                pointKeys.push(`${traceColl}#${i}`)
                // We don't have entry index from graph traces, use -1
                entryIndices.push(-1)
            }
        }
        return {points,pointKeys,entryIndices,n_features,labels:[xLabel,yLabel]}
    }
    suicide(options={}){
        /* The scroll list holds a ResizeObserver and a pool of rows: without
           this, a deleted node leaves an observer watching a detached box. */
        this.list?.dispose()
        this.list=null
        this.accordionRight?.suicide()
        this.accordionRight=null
        super.suicide(options)
    }
}


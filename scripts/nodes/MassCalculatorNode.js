import {Node} from "../core/index.js"
import {Dialog} from "../ui/Dialog.js"
import {Plot2D} from "../ui/Plot2D.js"
import {Formula,Stoichiometry,loadTable,positiveMassConjugate} from "../chemistry.js"
import {Wave,XYTrace} from "../formats.js"
import {CE,stylize} from "../util.js"

export class MassCalculatorNode extends Node{
    constructor(title,origin,destinationFlow,position={x:180,y:10}){
        super(title,[],[],origin,destinationFlow,position)
        this.status="floating"
        this.parameters.formula=""
        this.parameters.charge=0
        this.parameters.ratio=0.01
        this.dialog=null
        this.plot=null
        this.tablePromise=null
        this.elements=[]
        this.currentStoich=null
        this.elementButtons=new Map()
        this.isotopeBand=null
        this.isotopeBandElement=null
        this._hoveredBtn=null
        this._isoModifierInstalled=false
    }

    /* Un seul observateur keydown global, installé une fois: si le pointeur est
       sur un élément et que Ctrl/Alt/Meta vient d'être pressé, on ouvre la
       bande. Cela complète `mouseenter`, qui ne re-déclenche pas quand le
       modificateur arrive APRÈS le survol. */
    installModifierWatcher(){
        if(this._isoModifierInstalled) return
        this._isoModifierInstalled=true
        globalThis.addEventListener("keydown",(e)=>{
            if(!e.ctrlKey&&!e.altKey&&!e.metaKey) return
            if(!this._hoveredBtn) return
            if(this.isotopeBandElement===this._hoveredBtn.element) return
            this.openIsotopeBand(this._hoveredBtn.element,this._hoveredBtn.anchor)
        },true)
    }

    async ensureTable(){
        if(this.tablePromise) return this.tablePromise
        this.tablePromise=loadTable().then(table=>{
            this.elements=table.elements
            return table
        })
        return this.tablePromise
    }

    registered(e){
        const {channel,registrationName,label,caster}=e.detail.msg
        if(caster!==this||this.dialog){
            return
        }
        this.dialog=new Dialog(label,this.origin,this.origin.botContent[0])
        this.dialog.DOMelt.dismisser.remove()
        stylize(this.dialog.DOMelt.window,{
            top:"0%",
            right:"0%",
            width:"42%",
            height:"100%"
        })
        channel.register(`${registrationName}:masscalc`,this.dialog,`${label} mass calc`)
        this.render()
    }

    async render(){
        await this.ensureTable()
        const content=this.dialog.DOMelt.content
        content.replaceChildren()
        stylize(content,{
            display:"grid",
            height:"100%",
            minHeight:"0",
            overflow:"hidden",
            padding:"4px",
            gap:"4px"
        })

        const centerWrap=this.buildCenterArea()

        content.append(centerWrap)
        this.updateAll()
    }

    /* Left stack: inputs on one row (formula input capped so the row never
       exceeds the 591px table), table in the middle, readout at the bottom —
       all three fit the table width, so the plot keeps the full window
       height on the right, down to the very bottom. */
    buildCenterArea(){
        const wrap=CE("div",{style:{display:"grid",gridTemplateColumns:"max-content minmax(0, 1fr)",gap:"8px",height:"100%",minHeight:"0",minWidth:"0",overflow:"auto"}},[])
        /* Rows are auto/minmax(0,1fr)/auto: the middle one — the table — is
           the only one allowed to shrink, and its OWN wrap scrolls (see
           buildPeriodicTable), so the inputs and the readout never leave
           the screen. The wrap's overflow is a horizontal fallback only:
           children are exactly 100% tall, so it never scrolls vertically. */
        const leftCol=CE("div",{style:{display:"grid",gridTemplateRows:"auto minmax(0,1fr) auto",gap:"4px",height:"100%",minHeight:"0",minWidth:"0",width:"610px"}},[])
        const formulaBar=this.buildFormulaBar()
        const periodicTable=this.buildPeriodicTable()
        const infoBar=this.buildInfoBar()
        leftCol.append(formulaBar,periodicTable,infoBar)
        const plotArea=this.buildPlotArea()
        stylize(plotArea,{height:"100%",minHeight:"0",minWidth:"0"})
        wrap.append(leftCol,plotArea)
        return wrap
    }

    buildFormulaBar(){
        const wrap=CE("div",{style:{display:"grid",gap:"4px",gridTemplateColumns:"auto minmax(0,180px) auto 50px auto 60px auto",alignItems:"center",maxWidth:"591px"}},[])

        const formulaLabel=CE("label",{style:{fontSize:"0.85em",color:"var(--text-muted)"}},["Formula"])
        this.formulaInput=CE("input",{
            type:"text",
            value:this.parameters.formula,
            placeholder:"C6H12O6  or  C6H12O6 [H+]",
            title:"Enter formula with optional ionisation group in brackets. Examples: C6H12O6, C6H12O6 [H+], C6H12O6 [Na+], C6H12O6 [-]"
        },[])
        this.formulaInput.addEventListener("input",()=>{
            this.parameters.formula=this.formulaInput.value.trim()
            this.debouncedUpdateFromFormula()
        })
        this.formulaInput.addEventListener("keydown",(e)=>{
            if(e.key==="Enter") this.updateFromFormula()
        })

        const chargeLabel=CE("label",{style:{fontSize:"0.85em",color:"var(--text-muted)"}},["Charge"])
        this.chargeInput=CE("input",{
            type:"number",
            value:this.parameters.charge,
            min:-5,
            max:5,
            step:1,
            style:{width:"50px"},
            title:"Ion charge (overrides bracket group if both present)"
        },[])
        this.chargeInput.addEventListener("change",()=>{
            this.parameters.charge=parseInt(this.chargeInput.value)||0
            this.updateFromFormula()
        })

        const ratioLabel=CE("label",{style:{fontSize:"0.85em",color:"var(--text-muted)"}},["Threshold"])
        this.ratioInput=CE("input",{
            type:"number",
            value:this.parameters.ratio,
            min:0,
            max:1,
            step:0.001,
            style:{width:"60px"},
            title:"Isotopic probability threshold relative to max (0 = all, 1 = most probable only)"
        },[])
        this.ratioInput.addEventListener("change",()=>{
            this.parameters.ratio=parseFloat(this.ratioInput.value)||0
            this.updateAll()
        })

        const clearBtn=CE("button",{type:"button",style:{fontSize:"0.75em",padding:"2px 6px"}},["Clear"])
        clearBtn.addEventListener("click",()=>{
            this.parameters.formula=""
            this.parameters.charge=0
            this.currentStoich=null
            //reset the widgets too: `parameters` alone leaves the typed
            //formula and charge on screen, out of sync with the cleared state
            if(this.formulaInput) this.formulaInput.value=""
            if(this.chargeInput) this.chargeInput.value=0
            //the spectrum has to be wiped BY HAND: with currentStoich null,
            //updatePlot returns early and would leave the old peaks standing
            this.clearPlot()
            this.updateAll()
        })

        wrap.append(formulaLabel,this.formulaInput,chargeLabel,this.chargeInput,ratioLabel,this.ratioInput,clearBtn)
        return wrap
    }

    buildPeriodicTable(){
        /* The scroll lives HERE, inside the table box: the column's other
           rows (inputs, readout) stay pinned while the table alone scrolls
           vertically when the dialog is short.

           The table is 591px of content (18*30 + 17*3). Its column is 610px
           wide (see leftCol in buildCenterArea), leaving ~19px of slack —
           just enough for the vertical scrollbar to sit without eating into
           the 591px, which would otherwise push the grid past the box and
           resurrect the phantom horizontal scrollbar this project already
           killed once. overflowX is hidden on purpose: if the dialog is
           truly too narrow, the PARENT center area scrolls sideways (as it
           did before), so the table never owns a horizontal scrollbar. */
        const wrap=CE("div",{style:{display:"block",height:"100%",minHeight:"0",overflowY:"auto",overflowX:"hidden"}},[])
        const table=CE("div",{style:{
            display:"grid",
            gridTemplateColumns:"repeat(18, 30px)",
            gridAutoRows:"30px",
            gap:"3px",
            alignContent:"start",
            justifyContent:"start",
            width:"max-content"
        }},[])

        const sorted=[...this.elements].sort((a,b)=>a.Z-b.Z)
        for(const el of sorted){
            const pos=this.tablePosition(el.Z)
            if(!pos) continue
            const btn=this.buildElementButton(el)
            btn.style.gridRow=`${pos[0]}`
            btn.style.gridColumn=`${pos[1]}`
            btn.dataset.group=String(pos[1])
            table.appendChild(btn)
        }

        wrap.appendChild(table)
        return wrap
    }

    /* Display position [row, col] in a 9-row grid (7 periods + 2 f-block rows).
       Computed from Z alone (elements.json carries no group/period field),
       so F/Ne land in columns 17/18 — never wrapped to the left. */
    tablePosition(Z){
        if(Z===1) return [1,1]
        if(Z===2) return [1,18]
        if(Z>=3&&Z<=10) return [2,Z<=4?Z-2:Z+8]
        if(Z>=11&&Z<=18) return [3,Z<=12?Z-10:Z]
        if(Z>=19&&Z<=36) return [4,Z-18]
        if(Z>=37&&Z<=54) return [5,Z-36]
        if(Z===55||Z===56) return [6,Z-54]
        if(Z>=57&&Z<=71) return [8,Z-57+3]
        if(Z>=72&&Z<=86) return [6,Z-68]
        if(Z===87||Z===88) return [7,Z-86]
        if(Z>=89&&Z<=103) return [9,Z-89+3]
        if(Z>=104&&Z<=118) return [7,Z-100]
        return null
    }

    categoryFor(Z){
        if(Z===1||(Z>=5&&Z<=8)||Z===14||Z===15||Z===16||Z===33||Z===34||Z===51||Z===52) return "nonmetal"
        if([9,17,35,53,85,117].includes(Z)) return "halogen"
        if([2,10,18,36,54,86,118].includes(Z)) return "noble"
        if([3,11,19,37,55,87].includes(Z)) return "alkali"
        if([4,12,20,38,56,88].includes(Z)) return "alkaline"
        if(Z>=57&&Z<=71) return "lanthanide"
        if(Z>=89&&Z<=103) return "actinide"
        if((Z>=21&&Z<=30)||(Z>=39&&Z<=48)||(Z>=72&&Z<=80)||(Z>=104&&Z<=112)) return "transition"
        return "post-transition"
    }

    categoryColor(cat){
        switch(cat){
            case "alkali": return "rgba(255,120,120,0.12)"
            case "alkaline": return "rgba(255,180,100,0.12)"
            case "transition": return "rgba(255,220,120,0.10)"
            case "post-transition": return "rgba(160,200,255,0.10)"
            case "nonmetal": return "rgba(120,220,150,0.12)"
            case "halogen": return "rgba(150,220,255,0.14)"
            case "noble": return "rgba(190,150,255,0.14)"
            case "lanthanide": return "rgba(255,160,220,0.10)"
            case "actinide": return "rgba(255,140,180,0.12)"
            default: return "var(--surface)"
        }
    }

    categoryAccent(cat){
        switch(cat){
            case "alkali": return "#e74c3c"
            case "alkaline": return "#e67e22"
            case "transition": return "#f1c40f"
            case "post-transition": return "#5dade2"
            case "nonmetal": return "#2ecc71"
            case "halogen": return "#3498db"
            case "noble": return "#9b59b6"
            case "lanthanide": return "#e84393"
            case "actinide": return "#d63031"
            default: return "var(--border)"
        }
    }

    buildElementButton(element){
        const count=this.currentStoich?.counts?.get(element)||0
        const isIon=this.currentStoich?.ionisation?.some(t=>t.group?.has(element))||false
        const cat=this.categoryFor(element.Z)

        const btn=CE("button",{
            type:"button",
            title:`${element.name} (${element.symbol}) - Z=${element.Z}\nLeft click: add\nRight click: remove\nCtrl+hover: per-isotope ±1\nCount: ${count}${isIon?" (in ion group)":""}`,
            style:{
                padding:"0",
                fontSize:"0.95em",
                fontWeight:"700",
                width:"30px",
                height:"30px",
                minWidth:"30px",
                minHeight:"30px",
                maxWidth:"30px",
                maxHeight:"30px",
                boxSizing:"border-box",
                background:count>0?isIon?"rgba(255,100,100,0.3)":"rgba(100,200,100,0.3)"
                    :count<0?"rgba(255,140,140,0.25)":this.categoryColor(cat),
                border:count>0?"1px solid var(--accent)":"1px solid var(--border)",
                borderLeft:`3px solid ${this.categoryAccent(cat)}`,
                borderRadius:"3px",
                color:count>0?isIon?"#ff8888":"#88ff88":count<0?"#ff9999":"var(--text)",
                whiteSpace:"nowrap",
                cursor:"pointer",
                display:"flex",
                alignItems:"center",
                justifyContent:"center",
                lineHeight:"1"
            }
        },[`${element.symbol}${count!==0?count:""}`])

        btn.addEventListener("click",(e)=>{
            e.preventDefault()
            this.modifyElement(element,1)
        })
        btn.addEventListener("contextmenu",(e)=>{
            e.preventDefault()
            this.modifyElement(element,-1)
        })
        /* Le MODIFICATEUR + survol ouvre la bande d'isotopes ronds. Sans
           modificateur, le survol ne fait rien — l'ajout d'un atome reste un
           simple clic. On mémorise le bouton survolé ET on ouvre si le
           modificateur est déjà là; `installModifierWatcher` couvre l'autre
           ordre (Ctrl pressé APRÈS être arrivé sur le bouton), que `mouseenter`
           seul ne rattraperait pas. */
        btn.addEventListener("mouseenter",(e)=>{
            this._hoveredBtn={element,anchor:btn}
            if(e.ctrlKey||e.altKey||e.metaKey) this.openIsotopeBand(element,btn)
        })
        btn.addEventListener("mouseleave",()=>{
            if(this._hoveredBtn?.anchor===btn) this._hoveredBtn=null
        })
        this.installModifierWatcher()
        this.elementButtons.set(element.symbol,btn)
        return btn
    }

    async modifyElement(element,delta){
        const table=await this.ensureTable()
        if(!this.currentStoich){
            this.currentStoich=new Stoichiometry({composition:new Map(),table})
        }
        /* Le clic NU opère sur l'ISOTOPE DE LA RÈGLE (pickA), jamais sur un
           isotope épinglé: enlever du carbone ne doit pas toucher le ¹³C écrit
           à la main. On cible donc `A`, et on recopie le byA courant à la
           place de l'écraser (l'ancien `new Map([[A,newCount]])` détruisait les
           isotopes épinglés du même élément). CLAMP à 0 sur la cible: un clic
           droit sur un élément nu ne descend jamais sous zéro, donc jamais de
           conjuguée qui flippe le signe sous le doigt. Les comptes négatifs ne
           viennent que des boutons isotopes explicites (`modifyIsotope`). */
        const rule=this.currentStoich.rule||"mostProbable"
        const A=element.pickA(rule)
        const currentByA=this.currentStoich.composition.get(element)
        const currentTarget=currentByA?.get(A)||0
        const newTarget=currentTarget+delta
        if(newTarget<0) return   //clamp à 0: on refuse, on ne force pas

        const newComposition=new Map(this.currentStoich.composition)
        const byA=new Map(currentByA||[])
        if(newTarget>0) byA.set(A,newTarget)
        else byA.delete(A)
        if(byA.size) newComposition.set(element,byA)
        else newComposition.delete(element)

        this.commitComposition(newComposition,table)
    }

    /* Le chemin EXPLICITE: ±1 sur un A choisi à la main, SANS clamp. C'est le
       seul endroit où un compte peut passer sous zéro (ex. ¹³C−1 avec du ¹²C
       restant → masse positive, pas de flip). La conjuguée s'applique ensuite
       comme partout: si la masse totale bascule négative, le signe retourne. */
    modifyIsotope(element,A,delta){
        this.ensureTable().then(table=>{
            if(!this.currentStoich){
                this.currentStoich=new Stoichiometry({composition:new Map(),table})
            }
            const currentByA=this.currentStoich.composition.get(element)
            const currentCount=currentByA?.get(A)||0
            const newCount=currentCount+delta

            const newComposition=new Map(this.currentStoich.composition)
            const byA=new Map(currentByA||[])
            if(newCount!==0) byA.set(A,newCount)
            else byA.delete(A)
            if(byA.size) newComposition.set(element,byA)
            else newComposition.delete(element)

            this.commitComposition(newComposition,table)
        })
    }

    /* La conjuguée est appliquée ICI, à chaque écriture de composition, que
       l'elle vienne de la frappe (`updateFromFormula` passe par `Formula.parse`,
       déjà conjugué) ou d'un clic. Un seul point d'injection pour « la
       conjuguaison partout, même au clic ». */
    commitComposition(newComposition,table){
        const conjugated=positiveMassConjugate(newComposition)
        this.currentStoich=new Stoichiometry({
            composition:conjugated,
            ionisation:this.currentStoich.ionisation,
            charge:this.currentStoich.charge,
            rule:this.currentStoich.rule,
            table
        })

        this.parameters.formula=this.currentStoich.toString()
        if(this.formulaInput) this.formulaInput.value=this.parameters.formula
        this.updateAll()
        /* La bande d'isotopes reste ouverte mais doit suivre les nouveaux
           comptes. On la rafraîchit ICI, après l'écriture — les clics des
           ronds appellent `modifyIsotope`, ASYNCHRONE (`ensureTable().then`),
           donc un refresh appeler synchrone après le clic lisait l'ANCIENNE
           composition et ne changeait rien. C'est le seul endroit où
           `currentStoich` est garanti à jour. */
        if(this.isotopeBandElement) this.refreshIsotopeBand(this.isotopeBandElement)
    }

    /* LA BANDE D'ISOTOPES — un rang de boutons ronds ancré sous un élément.

       Elle ne s'ouvre qu'au survol AVEC le modificateur enfoncé (voir
       `buildElementButton`), et se referme sur: fuite du modificateur, sortie
       du pointeur hors bouton+bande, Escape, ou clic extérieur. C'est le même
       cycle de vie que le menu `.fc-menu` de FormulaCollectionNode, transposé
       à une bande horizontale. Chaque rond ±1 sur SON isotope — clic gauche
       ajoute, clic droit retire — et c'est le SEUL chemin vers un compte
       négatif (pas de clamp ici). */
    openIsotopeBand(element,anchor){
        if(this.isotopeBandElement===element) return   //déjà ouverte pour lui
        this.closeIsotopeBand()
        this.isotopeBandElement=element

        const count=this.currentStoich?.counts?.get(element)||0
        const byA=this.currentStoich?.composition?.get(element)
        const band=CE("div",{className:"iso-band"},[])
        for(const isotope of element.isotopes){
            const A=isotope.A
            const here=byA?.get(A)||0
            const abundance=isotope.abundance
            const pct=abundance==null?"100":(abundance*100).toFixed(2)
            const round=CE("button",{
                type:"button",
                className:"iso-band-round",
                title:`${element.symbol} A=${A} — ${isotope.mass.toFixed(6)} u\nAbundance: ${pct}%\nCurrent: ${here}\nLeft click: +1, Right click: −1`,
                //le fond marque la présence de CET isotope, distinct du total
                style:{
                    background:here>0?"rgba(100,200,100,0.35)"
                        :here<0?"rgba(255,140,140,0.35)"
                        :"var(--surface)",
                    color:here>0?"#88ff88":here<0?"#ff8888":"var(--text)"
                }
            },[String(A)])
            round.addEventListener("click",(e)=>{
                e.preventDefault()
                this.modifyIsotope(element,A,1)
            })
            round.addEventListener("contextmenu",(e)=>{
                e.preventDefault()
                this.modifyIsotope(element,A,-1)
            })
            band.appendChild(round)
        }
        document.body.appendChild(band)
        this.isotopeBand=band

        /* ancre SOUS le bouton, SANS JEU — 1px de recouvrement, jamais
           d'écart. Le moindre trou laissait le pointeur sur un élément
           intermédiaire (le conteneur de la table), dont le pointerout
           fermait la bande avant qu'on l'atteigne. Le recouvrement garantit
           une transition directe bouton→bande, quel que soit le chemin. */
        const box=anchor.getBoundingClientRect()
        const width=band.getBoundingClientRect().width
        band.style.left=`${Math.max(4,Math.min(box.left,window.innerWidth-width-4))}px`
        band.style.top=`${Math.max(0,box.bottom-1)}px`

        /* Survol de la bande: on le sait pour ne pas la tuer au relâchement
           du modificateur une fois qu'on y est descendu. */
        this._bandHovered=false
        band.addEventListener("mouseenter",()=>{ this._bandHovered=true })
        band.addEventListener("mouseleave",()=>{ this._bandHovered=false })

        /* La bande survit à ses propres clics: on ne la referme pas sur un
           clic DANS la bande (sinon le premier ±1 la tuerait). Seul un clic
           en dehors la ferme. Le pointeur qui quitte bouton+bande la referme
           aussi — et le relâchement du modificateur, pour qu'un survol sans
           Ctrl ne la laisse pas traîner. */
        this._isoCloser=(event)=>{
            if(!band.contains(event.target)&&event.target!==anchor) this.closeIsotopeBand()
        }
        this._isoPointerOut=(event)=>{
            /* La DESTINATION compte, pas la source: `relatedTarget` est
               l'élément sur lequel le pointeur ARRIVE. anchor→bande et
               bande→anchor sont des transitions légitimes et doivent
               survivre; fermer sur `event.target` (l'élément QUITTÉ) tuait
               la bande dès que le chemin passait par un voisin — exactement
               ce qui se produit en descendant vers les ronds. relatedTarget
               null = pointeur hors fenêtre → on ferme. */
            const to=event.relatedTarget
            if(!to||(!band.contains(to)&&!anchor.contains(to)))
                this.closeIsotopeBand()
        }
        this._isoEscape=(event)=>{
            if(event.key==="Escape"){ event.stopPropagation(); this.closeIsotopeBand() }
        }
        this._isoKeyUp=(event)=>{
            if(event.ctrlKey||event.altKey||event.metaKey) return
            /* Modificateur relâché MAIS le pointeur est sur la bande ou sur
               le bouton ancre: la bande reste ouverte (sinon elle mourrait
               pile au moment où l'on descend vers elle, entre le survol et
               le clic). Si le pointeur est ailleurs, le pointerout l'a déjà
               fermée — ceci n'est qu'un filet de sécurité. */
            if(this._bandHovered||this._hoveredBtn?.anchor===anchor) return
            this.closeIsotopeBand()
        }
        setTimeout(()=>{
            globalThis.addEventListener("mousedown",this._isoCloser,true)
            globalThis.addEventListener("pointerout",this._isoPointerOut,true)
            globalThis.addEventListener("keydown",this._isoEscape,true)
            globalThis.addEventListener("keyup",this._isoKeyUp,true)
        },0)
    }

    /* Après un ±1, la bande reste ouverte mais son contenu change (les fonds
       marquent les nouveaux comptes). On reconstruit sans refermer/rouvrir le
       cycle de vie — juste les ronds. Appelé par `commitComposition`, où la
       composition est garantie à jour. */
    refreshIsotopeBand(element){
        if(this.isotopeBandElement!==element||!this.isotopeBand) return
        const byA=this.currentStoich?.composition?.get(element)
        const rounds=this.isotopeBand.querySelectorAll(".iso-band-round")
        element.isotopes.forEach((isotope,i)=>{
            const here=byA?.get(isotope.A)||0
            const round=rounds[i]
            if(!round) return
            round.style.background=here>0?"rgba(100,200,100,0.35)"
                :here<0?"rgba(255,140,140,0.35)"
                :"var(--surface)"
            round.style.color=here>0?"#88ff88":here<0?"#ff8888":"var(--text)"
        })
    }

    closeIsotopeBand(){
        if(!this.isotopeBand) { this.isotopeBandElement=null; return }
        this.isotopeBand.remove()
        this.isotopeBand=null
        this.isotopeBandElement=null
        this._bandHovered=false
        globalThis.removeEventListener("mousedown",this._isoCloser,true)
        globalThis.removeEventListener("pointerout",this._isoPointerOut,true)
        globalThis.removeEventListener("keydown",this._isoEscape,true)
        globalThis.removeEventListener("keyup",this._isoKeyUp,true)
    }

    buildPlotArea(){
        const wrap=CE("div",{style:{display:"grid",gridTemplateRows:"minmax(0,1fr)",gap:"4px",minHeight:"0"}},[])

        this.plotContainer=CE("div",{style:{width:"100%",height:"100%",minHeight:"0",overflow:"hidden",position:"relative"}},[])
        wrap.appendChild(this.plotContainer)

        this._resizeObserver=new ResizeObserver(()=>{
            if(this.plot){
                this.plot.drawGraph()
            }else if(this.currentStoich && this.plotContainer.clientWidth>0 && this.plotContainer.clientHeight>0){
                this.updatePlot()
            }
        })
        this._resizeObserver.observe(this.plotContainer)

        return wrap
    }

    buildInfoBar(){
        const wrap=CE("div",{style:{display:"grid",gridTemplateColumns:"repeat(4, 1fr)",gap:"4px",fontSize:"0.85em"}},[])

        this.monoMassEl=CE("div",{style:{color:"var(--accent)"}},["Mono: —"])
        this.avgMassEl=CE("div",{style:{color:"var(--text)"}},["Avg: —"])
        this.mzEl=CE("div",{style:{color:"var(--accent)"}},["m/z: —"])
        this.formulaEl=CE("div",{style:{color:"var(--text-muted)",fontFamily:"monospace"}},["—"])

        wrap.append(this.monoMassEl,this.avgMassEl,this.mzEl,this.formulaEl)
        return wrap
    }

    debouncedUpdateFromFormula(){
        clearTimeout(this._formulaDebounce)
        this._formulaDebounce=setTimeout(()=>this.updateFromFormula(),300)
    }

    async updateFromFormula(){
        if(!this.parameters.formula){
            this.currentStoich=null
            this.updateAll()
            return
        }
        try{
            const table=await this.ensureTable()
            const parsed=Formula.parse(this.parameters.formula,table)
            if(parsed){
                this.currentStoich=parsed
                if(this.parameters.charge!==0){
                    this.currentStoich=new Stoichiometry({
                        composition:this.currentStoich.composition,
                        ionisation:this.currentStoich.ionisation,
                        charge:this.parameters.charge,
                        rule:this.currentStoich.rule,
                        table
                    })
                }
                this.formulaInput.value=this.currentStoich.toString()
                if(this.chargeInput) this.chargeInput.value=this.currentStoich.charge
                this.updateAll()
            }
        }catch(err){
            console.warn("Formula parse error:",err)
        }
    }

    updateAll(){
        this.updatePeriodicTable()
        this.updateInfo()
        this.updatePlot()
    }

    updatePeriodicTable(){
        for(const [symbol,btn] of this.elementButtons){
            const el=this.elements.find(e=>e.symbol===symbol)
            if(el){
                /* Le compte affiché est le NET (le getter `counts` somme les
                   isotope-comptes, y compris négatifs). On l'écrit dès qu'il
                   diffère de zéro, donc un ¹³C−1 avec du ¹²C restant reste
                   lisible. Le survol + Ctrl ouvre la bande des isotopes. */
                const count=this.currentStoich?.counts?.get(el)||0
                const isIon=this.currentStoich?.ionisation?.some(t=>t.group?.has(el))||false
                btn.textContent=`${el.symbol}${count!==0?count:""}`
                btn.style.background=count>0?isIon?"rgba(255,100,100,0.3)":"rgba(100,200,100,0.3)"
                    :count<0?"rgba(255,140,140,0.25)":"var(--surface)"
                btn.style.color=count>0?isIon?"#ff8888":"#88ff88"
                    :count<0?"#ff9999":"var(--text)"
                btn.title=`${el.name} (${el.symbol}) - Z=${el.Z}\nLeft click: add\nRight click: remove\nCtrl+hover: per-isotope ±1\nCount: ${count}${isIon?" (in ion group)":""}`
            }
        }
    }

    computeAverageMass(stoich){
        let m=0
        for(const [el,byA] of stoich.composition){
            m+=el.averageMass*stoich.counts.get(el)
        }
        return m-stoich.charge*Stoichiometry.electronMass
    }

    updateInfo(){
        if(!this.currentStoich){
            this.monoMassEl.textContent="Mono: —"
            this.avgMassEl.textContent="Avg: —"
            this.mzEl.textContent="m/z: —"
            this.formulaEl.textContent="—"
            return
        }
        const mono=this.currentStoich.mass
        const avg=this.computeAverageMass(this.currentStoich)
        const mz=this.currentStoich.mz
        this.monoMassEl.textContent=`Mono: ${mono.toFixed(4)}`
        this.avgMassEl.textContent=`Avg: ${avg.toFixed(4)}`
        this.mzEl.textContent=`m/z: ${mz.toFixed(4)}`
        this.formulaEl.textContent=this.currentStoich.toString()
    }

    updatePlot(){
        if(!this.currentStoich||!this.plotContainer) return

        /* GARDE COMPTE NÉGATIF — miroir exact de `attribution.js`.

           Une composition à compte négatif (un « ¹³C−1 » posé à la main, une
           substitution) n'a pas d'enveloppe: `isotopologues` ne saurait pas la
           lire, et tenter l'énumération la rendrait fausse en silence. On
           montre la masse seule (déjà affichée par `updateInfo`) plutôt qu'une
           enveloppe qui mentirait. Le négatif n'est pas une erreur — c'est une
           composition signée. */
        const hasNegativeCount=[...this.currentStoich.composition.values()]
            .some(byA=>[...byA.values()].some(count=>count<0))
        if(hasNegativeCount){
            /* NETTOYAGE PAR clearPlot + MESSAGE DÉDIÉ — jamais `textContent`
               sur plotContainer: textContent supprime TOUS les enfants, y
               compris le div de Plot2D, alors que `this.plot` reste truthy.
               Au retour en composo positive, le rendu partait alors dans un
               conteneur détaché (clientWidth 0 → drawGraph sort en silence)
               et le message restait: l'enveloppe ne revenait plus. clearPlot
               retire aussi les barres orphelines que setTraces seul laissait
               dans le groupe .anchor. */
            this.clearPlot()
            this.plotNotice("Envelope suppressed: negative counts (mass only)")
            return
        }

        try{
            const isotopologues=[...this.currentStoich.isotopologues({
                ratio:this.parameters.ratio,
                limit:200
            })]

            if(isotopologues.length===0){
                //même mécanisme que le garde négatif: DOM du plot intact
                this.clearPlot()
                this.plotNotice("No isotopologues in range")
                return
            }

            const masses=isotopologues.map(i=>i.mz)
            const probs=isotopologues.map(i=>Math.exp(i.logProbability))
            const maxProb=Math.max(...probs)
            const normalized=probs.map(p=>p/maxProb)

            const wave=Wave.fromCoordinates(
                new Float64Array(masses),
                new Float64Array(normalized),
                {title:"Isotopic distribution"},
                ["m/z","Relative abundance"]
            )
            const trace=new XYTrace({
                id:"masscalc:isotopic-distribution",
                title:"Isotopic distribution",
                wave,
                options:{
                    color:"#2ecc71",
                    mode:"points",
                    marker:{shape:"circle",size:0},
                    line:{size:0}
                }
            })

            if(!this.plot){
                if(!(this.plotContainer.clientWidth>0&&this.plotContainer.clientHeight>0)){
                    // Container not ready yet, clear and wait for resize
                    this.plotNotice(null)
                    this.pendingTrace=trace
                    this.pendingBars=isotopologues
                    return
                }
                this.plot=new Plot2D([],"Isotopic Distribution",this.origin,this.plotContainer)
                const origDrawGraph=this.plot.drawGraph.bind(this.plot)
                const self=this
                this.plot.drawGraph=function(...args){
                    const out=origDrawGraph(...args)
                    if(self.pendingBars) self.drawPeakBars(self.pendingBars)
                    return out
                }
            }
            this.pendingTrace=trace
            this.pendingBars=isotopologues
            this.plot.setTraces([trace])
            this.plot.syncAxisLabels()

            this.plot.parameters.axis.bottom.autoDomain=true
            this.plot.parameters.axis.left.autoDomain=true
            this.plot.drawGraph()
            this.drawPeakBars(isotopologues)
            //L'ENVELOPPE EST REVENUE: masque le message d'un état précédent
            this.plotNotice(null)

        }catch(err){
            console.error("Plot update error:",err)
            this.pendingTrace=null
            this.pendingBars=null
            this.plotNotice("Error generating plot")
        }
    }

    /* CLEAR THE SPECTRE: with currentStoich null, updatePlot returns early,
       so it can never wipe the peaks on its own — the old spectrum would
       outlive the formula that made it. The .anchor group is built once and
       survives drawGraph, so the peak/glow layers are removed by hand and the
       traces are emptied before the redraw. pendingBars goes first so the
       redraw hook (which repaints from pendingBars) does not bring them back. */
    clearPlot(){
        this.pendingTrace=null
        this.pendingBars=null
        this.hidePeakTip()
        this.plotNotice(null)
        if(!this.plot) return
        const anchor=this.plot.graphSVG?.select(".anchor")
        if(anchor&&!anchor.empty()){
            anchor.select(".masscalc-bars").remove()
            anchor.select(".masscalc-glow").remove()
            anchor.select(".masscalc-hits").remove()
        }
        this.plot.setTraces([])
        this.plot.drawGraph()
    }

    /* MESSAGE SUR LE CONTOUR DU PLOT — élément DÉDIÉ, affiché/masqué.

       Jamais `plotContainer.textContent = …`: textContent détacherait le div
       de Plot2D et le tooltip tout en laissant `this.plot` truthy, et le
       prochain rendu dessinerait dans un document orphelin — l'enveloppe ne
       revenait plus après un état négatif. Un élément persistant rend le
       message bidirectionnel: on l'affiche en état « masqué », on le
       recouvre dès que l'enveloppe est de nouveau calculable. */
    plotNotice(text){
        if(!text){
            if(this._plotNotice) this._plotNotice.style.display="none"
            return
        }
        if(!this.plotContainer) return
        if(!this._plotNotice){
            this._plotNotice=CE("div",{className:"plot-notice"},[])
            stylize(this._plotNotice,{
                position:"absolute",
                inset:"0",
                display:"flex",
                alignItems:"center",
                justifyContent:"center",
                textAlign:"center",
                fontSize:"0.9em",
                fontStyle:"italic",
                color:"var(--text-muted)",
                pointerEvents:"none",
                zIndex:"5"
            })
            this.plotContainer.appendChild(this._plotNotice)
        }
        this._plotNotice.textContent=text
        this._plotNotice.style.display="flex"
    }

    /* Peak bars: narrow vertical bars drawn inside the .anchor group — same
       coordinates as the points (plotScales are graphzone-local, the anchor
       carries the margin translate). Gradient in objectBoundingBox so each
       bar runs its own ramp: white at the tip, green at 75%, transparent at
       the baseline. Re-painted after every drawGraph via the hook installed
       in updatePlot, so zoom/pan/resize keep them. */
    drawPeakBars(isotopologues){
        const graph=this.plot
        if(!graph?.graphSVG) return
        const zone=graph.graphzone
        if(!(zone.width>0&&zone.height>0)) return
        //a repaint swaps the hovered column for a fresh one without firing
        //pointerleave (the old node is simply detached): hide the tip here or
        //it would linger showing a peak that no longer exists
        this.hidePeakTip()
        const {xScale,yScale}=graph.plotScales()
        const anchor=graph.graphSVG.select(".anchor")
        if(anchor.empty()) return
        let barLayer=anchor.select(".masscalc-bars")
        if(barLayer.empty()) barLayer=anchor.append("g").attr("class","masscalc-bars")
        barLayer.selectAll("*").remove()
        // hover layer: the painted bars are only 3px wide — impossible to aim
        // at — so invisible wider rects sit ON TOP of them and drive a
        // .pick-tip tooltip (see showPeakTip). The layer is appended, hence
        // last, and wiped on every repaint like the bars, since .anchor
        // persists across drawGraph.
        let hitLayer=anchor.select(".masscalc-hits")
        if(hitLayer.empty()) hitLayer=anchor.append("g").attr("class","masscalc-hits")
        hitLayer.selectAll("*").remove()
        // <defs> must be appended (not selected-into-existence): d3's append
        // on an empty selection creates nothing, leaving fill="url(#...)"
        // dangling — SVG then refuses to paint the rect at all.
        let defs=anchor.select("defs")
        if(defs.empty()) defs=anchor.append("defs")
        const gradId=`masscalc-peak-gradient-${graph.graphSVG.attr("id")}`
        let gradient=defs.select(`#${gradId}`)
        if(gradient.empty()){
            gradient=defs.append("linearGradient")
                .attr("id",gradId)
                .attr("x1","0%").attr("x2","0%")
                .attr("y1","0%").attr("y2","100%")
            // hot white tip: two white stops to push the white further down,
            // then green, then fully transparent at the baseline
            gradient.append("stop").attr("offset","0%").attr("stop-color","#ffffff").attr("stop-opacity","1")
            gradient.append("stop").attr("offset","45%").attr("stop-color","#eafff3").attr("stop-opacity","1")
            gradient.append("stop").attr("offset","75%").attr("stop-color","#2ecc71").attr("stop-opacity","1")
            gradient.append("stop").attr("offset","100%").attr("stop-color","#2ecc71").attr("stop-opacity","0")
        }
        // soft vertical glow behind the bars: same x span as the tallest bar,
        // blurred white-green, fading down — painted first so bars sit on top
        let glowLayer=anchor.select(".masscalc-glow")
        if(glowLayer.empty()) glowLayer=anchor.insert("g",".masscalc-bars").attr("class","masscalc-glow")
        glowLayer.selectAll("*").remove()

        const maxProb=Math.exp(isotopologues[0].logProbability)
        const barWidth=3
        let glowTop=Infinity
        let glowBottom=-Infinity
        let glowX=0
        const hits=[]
        for(const iso of isotopologues){
            if(iso.logProbability<-20) continue
            const rel=Math.exp(iso.logProbability)/maxProb
            const px=xScale(iso.mz)
            const pyTop=yScale(rel)
            const pyBase=yScale(0)
            if(!Number.isFinite(px)||!Number.isFinite(pyTop)||!Number.isFinite(pyBase)) continue
            if(px<0||px>zone.width) continue
            hits.push({px,pyTop,pyBase,iso,rel})
            if(rel>=0.99){
                glowTop=Math.min(glowTop,Math.min(pyTop,pyBase))
                glowBottom=Math.max(glowBottom,Math.max(pyTop,pyBase))
                glowX=px
            }
            barLayer.append("rect")
                .attr("class","peak-bar")
                .attr("x",px-barWidth/2)
                .attr("y",Math.min(pyTop,pyBase))
                .attr("width",barWidth)
                .attr("height",Math.max(1,Math.abs(pyBase-pyTop)))
                .attr("fill",`url(#${gradId})`)
                .attr("stroke","none")
        }
        // the glow: a wider blurred copy of the tallest bar's span, so the
        // white tip blooms instead of ending on a hard pixel edge
        if(Number.isFinite(glowTop)&&Number.isFinite(glowBottom)&&glowBottom>glowTop){
            let glowDefs=anchor.select("defs")
            if(glowDefs.empty()) glowDefs=anchor.append("defs")
            const blurId=`masscalc-glow-blur-${graph.graphSVG.attr("id")}`
            let filter=glowDefs.select(`#${blurId}`)
            if(filter.empty()){
                filter=glowDefs.append("filter")
                    .attr("id",blurId)
                    .attr("x","-80%").attr("y","-20%")
                    .attr("width","260%").attr("height","140%")
                filter.append("feGaussianBlur")
                    .attr("stdDeviation","2.2")
            }
            const glowGradId=`masscalc-glow-gradient-${graph.graphSVG.attr("id")}`
            let glowGrad=glowDefs.select(`#${glowGradId}`)
            if(glowGrad.empty()){
                glowGrad=glowDefs.append("linearGradient")
                    .attr("id",glowGradId)
                    .attr("x1","0%").attr("x2","0%")
                    .attr("y1","0%").attr("y2","100%")
                glowGrad.append("stop").attr("offset","0%").attr("stop-color","#40e0d0").attr("stop-opacity","1")
                glowGrad.append("stop").attr("offset","60%").attr("stop-color","#40e0d0").attr("stop-opacity","0.6")
                glowGrad.append("stop").attr("offset","100%").attr("stop-color","#40e0d0").attr("stop-opacity","0")
            }
            glowLayer.append("rect")
                .attr("x",glowX-barWidth*1.5)
                .attr("y",glowTop)
                .attr("width",barWidth*3)
                .attr("height",Math.max(1,glowBottom-glowTop))
                .attr("fill",`url(#${glowGradId})`)
                .attr("stroke","none")
                .attr("opacity","0.55")
                .attr("filter",`url(#${blurId})`)
        }
        /* Hover columns: the painted bars are 3px wide — impossible to aim at.
           Each peak gets an invisible full-height column instead, so the whole
           vertical line over a peak is hittable. Its width is capped by the
           gap to the nearest neighbour (hits are sorted by x for this), so two
           close isotopologues share the space without fighting over the
           cursor: the tooltip always describes exactly one peak. */
        const HIT_MAX_WIDTH=16
        const ordered=[...hits].sort((a,b)=>a.px-b.px)
        for(let i=0;i<ordered.length;i++){
            const hit=ordered[i]
            const gapPrev=i>0?hit.px-ordered[i-1].px:Infinity
            const gapNext=i<ordered.length-1?ordered[i+1].px-hit.px:Infinity
            const width=Math.max(barWidth,Math.min(HIT_MAX_WIDTH,Math.min(gapPrev,gapNext)))
            hitLayer.append("rect")
                .attr("class","peak-hit")
                .attr("x",hit.px-width/2)
                .attr("y",0)
                .attr("width",width)
                .attr("height",zone.height)
                .attr("fill","transparent")
                // .anchor sets a stroke (main.css) and stroke INHERITS in SVG —
                // without this the invisible column paints a grey outline over
                // the gradient. fill="transparent" alone does not stop it.
                .attr("stroke","none")
                .attr("pointer-events","all")
                .on("pointerenter",(event)=>this.showPeakTip(hit,event))
                .on("pointermove",(event)=>this.positionPeakTip(event))
                .on("pointerleave",()=>this.hidePeakTip())
        }
    }

    /* The tooltip follows the .pick-tip pattern already used by the WebGL
       plot's pick overlay (a styled HTML div, not SVG text, so a long isotopic
       formula wraps instead of overflowing). One instance is reused and it
       lives in plotContainer — NOT in the SVG — so a repaint never detaches it.

       pointer-events:none is essential: with the default `auto`, parking the
       cursor over the tip would fire pointerleave on the hover column beneath
       it, which hides the tip, which re-exposes the column — an endless flicker. */
    ensurePeakTip(){
        if(this._peakTip) return this._peakTip
        this._peakTip=CE("div",{className:"pick-tip"},[])
        this._peakTip.style.display="none"
        this._peakTip.style.pointerEvents="none"
        this.plotContainer.appendChild(this._peakTip)
        return this._peakTip
    }

    showPeakTip(hit,event){
        const tip=this.ensurePeakTip()
        const iso=hit.iso
        tip.replaceChildren()
        const head=CE("div",{className:"pick-head"},[])
        const swatch=CE("span",{className:"pick-swatch"},[])
        stylize(swatch,{background:"#2ecc71"})
        head.appendChild(swatch)
        // the isotopic FORMULA: `notation` writes every mass number that is not
        // the default isotope, so a 13C peak reads "13C C5 H12 O6" while the
        // all-12C peak reads "C6 H12 O6" — exactly the composition at a glance
        const title=CE("span",{className:"pick-title"},[iso.notation||iso.key])
        // let a long formula wrap rather than be clipped by the nowrap default
        stylize(title,{whiteSpace:"normal",overflow:"visible"})
        head.appendChild(title)
        tip.appendChild(head)
        const charge=iso.charge||0
        const rows=[
            ["m/z",iso.mz.toFixed(5)],
            ["Mass",iso.ionMass.toFixed(5)],
            ["Abundance",(hit.rel*100).toFixed(2)+" %"]
        ]
        if(charge!==0) rows.push(["Charge",`${charge>0?"+":""}${charge}`])
        for(const [key,value] of rows){
            const row=CE("div",{className:"pick-row"},[])
            row.appendChild(CE("span",{className:"pick-key"},[key]))
            row.appendChild(CE("span",{className:"pick-val"},[value]))
            tip.appendChild(row)
        }
        tip.style.display="block"
        this.positionPeakTip(event)
    }

    //place the tip near the cursor, flipping it left/above when it would run
    //past the plot edge. Measured AFTER it is shown, so the first placement is
    //already correct (no first-frame jump).
    positionPeakTip(event){
        const tip=this._peakTip
        if(!tip||tip.style.display==="none") return
        const host=this.plotContainer.getBoundingClientRect()
        const gap=14
        let x=event.clientX-host.left+gap
        let y=event.clientY-host.top+gap
        const w=tip.offsetWidth
        const h=tip.offsetHeight
        if(x+w>host.width) x=event.clientX-host.left-w-gap
        if(y+h>host.height) y=event.clientY-host.top-h-gap
        tip.style.left=`${Math.max(0,x)}px`
        tip.style.top=`${Math.max(0,y)}px`
    }

    hidePeakTip(){
        if(this._peakTip) this._peakTip.style.display="none"
    }

    serializeState(){
        return {
            formula:this.parameters.formula,
            charge:this.parameters.charge,
            ratio:this.parameters.ratio
        }
    }

    restoreState(state){
        if(!state) return
        this.parameters.formula=state.formula||""
        this.parameters.charge=state.charge||0
        this.parameters.ratio=state.ratio??0.01
        if(this.dialog){
            this.render()
        }
    }

    suicide(options={}){
        this._resizeObserver?.disconnect()
        this.dialog?.suicide()
        super.suicide(options)
    }
}
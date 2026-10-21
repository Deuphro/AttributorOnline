import {CE,stylize} from "../util.js"

export class Dialog{
    static zIndex=1
    constructor(title,origin,destination){
        this.title=title
        this.events={
            broadcast:{
                selected:new CustomEvent("selected",{detail:{msg:"I've just been selected !!!",emitter:this}}),
                killed:new CustomEvent("killed",{detail:{msg:"",emitter:this}}),
            },
            listen:{
                selected(e){
                    console.log(e.detail.emitter.title+" a reÃ§u le focus")
                },
                killed(e){console.log("quelqu'un s'est fait tuÃ© !\n","il s'appelait ",e.detail.emitter.events.registrationId)},
                importDelimitedText(e){console.log(e)}
            }
        }
        this.origin=origin;
        this.destination=destination;
        this.DOMelt={};
        this.DOMelt.dismisser=CE('div',{className:"dismisser",pilot:this},[]);
        this.DOMelt.dismisser.handleClick=(e)=>e.target.pilot.suicide();
        this.DOMelt.folder=CE('div',{className:"accordion handler folder",pilot:this,handleClick:(e)=>e.target.pilot.toggleFolded()},[]);
        this.DOMelt.folder.setAttribute("role","button");
        this.DOMelt.folder.setAttribute("aria-expanded","true");
        this.DOMelt.folder.setAttribute("aria-label","Replier la fenÃªtre");
        this.DOMelt.label=CE('div',{className:"label",pilot:this,handleDblClick:(e)=>e.target.pilot.toggleMaximized(e)},[title.toString()]);
        this.DOMelt.label.handleMouseDown=(e)=>e.target.pilot.drag(e);
        this.DOMelt.label.handleClick=(e)=>this.focus(e)
        this.DOMelt.tiler=CE('div',{className:"tiler",pilot:this},[]);
        this.DOMelt.tiler.handleClick=(e)=>{
            e.stopPropagation()
            if(this.DOMelt.tiler.classList.contains("disabled")){
                return
            }
            e.target.pilot.gridSiblings()
        };
        this.DOMelt.tiler.setAttribute("role","button");
        this.DOMelt.tiler.setAttribute("aria-label","Ranger les fenÃªtres du panneau en grille");
        this.DOMelt.tiler.title="Disposer toutes les fenÃªtres de ce panneau en grille";
        if(!destination?.classList?.contains("center")){
            this.DOMelt.tiler.classList.add("disabled")
            this.DOMelt.tiler.setAttribute("aria-disabled","true")
            this.DOMelt.tiler.title="Seul le panneau central peut Ãªtre rangÃ© en grille"
        }
        this.DOMelt.handler=CE('div',{},[this.DOMelt.label,this.DOMelt.folder,this.DOMelt.tiler,this.DOMelt.dismisser]);
        this.DOMelt.content=CE('div',{className:"popup content"},[]);
        this.DOMelt.window=CE('div',{className:"popup container",pilot:this},[
            this.DOMelt.handler,
            this.DOMelt.content
        ]);
        stylize(this.DOMelt.window,{
            position:"absolute",
            "z-index":"1",
            tabIndex:0,
            top:"35%",
            left:"35%",
            width:"30%",
            height:"30%",
            display:"grid",
            "grid-template-rows":"auto 1fr",
            padding:"0.2em",
            overflow:"hidden",
            resize:"both",
            "min-height":"2.2em",
            "min-width":"2.2em"
        });
        stylize(this.DOMelt.handler,{
            display:"grid",
            "grid-template-columns":"1fr 1em 1em 1em",
            "border-radius":"10px",
            padding:"0em"
        })
        stylize(this.DOMelt.content,{
            position:"relative",
            width:"100%",
            height:"100%",
            "border-radius":"10px",
            padding:"0em",
            overflow:"hidden"
        })
        stylize(this.DOMelt.label,{
            cursor:"move",
            "white-space":"nowrap",
            overflow:"hidden"
        })
        stylize(this.DOMelt.dismisser,{
            height:"1em",
            width:"1em",
            "align-self":"center"
        })
        stylize(this.DOMelt.folder,{
            height:"1em",
            width:"1em",
            "align-self":"center"
        })
        stylize(this.DOMelt.tiler,{
            height:"1em",
            width:"1em",
            "align-self":"center"
        })
        this.DOMelt.window.handleResize=(e)=>e.target.pilot.resize(e)
        this.DOMelt.window.handleMouseDown=(e)=>this.focus(e)
        destination.appendChild(this.DOMelt.window)
        this.DOMelt.window.setAttribute("tabindex","0")
        this.DOMelt.window.setAttribute("role","dialog")
        this.DOMelt.window.setAttribute("aria-label",title.toString())
        this.DOMelt.window.handleFocus=(e)=>this.focus(e)
        this.focus()
    }
    focus(event){
        if(Dialog.focused!==this){
            Dialog.focused?.DOMelt.window.classList.remove("selected")
            Dialog.focused=this
        }
        this.DOMelt.window.classList.add("selected")
        this.DOMelt.window.style.zIndex=String(++Dialog.zIndex)
        if(event||!this.DOMelt.window.contains(document.activeElement)){
            dispatchEvent(this.events.broadcast.selected)
        }
    }
    blur(){
        if(Dialog.focused!==this) return
        this.DOMelt.window.classList.remove("selected")
        Dialog.focused=null
    }
    setFolderFoldedState(folded){
        this.DOMelt.folder.style.backgroundColor=folded?"transparent":"rgba(172,255,47,0.18)"
        this.DOMelt.folder.setAttribute("aria-expanded",folded?"false":"true")
        this.DOMelt.folder.setAttribute("aria-label",folded?"DÃ©plier la fenÃªtre":"Replier la fenÃªtre")
    }
    fold(){
        if(this.folded) return
        this.folded=true
        const windowStyle=this.DOMelt.window.style
        this.unfoldedSize={
            height:windowStyle.height,
            minHeight:windowStyle.minHeight,
            resize:windowStyle.resize,
            bottom:windowStyle.bottom,
            gridTemplateRows:windowStyle.gridTemplateRows
        }
        /* LE CONTENU DOIT DISPARAÎTRE, ET PAS SEULEMENT ÊTRE "CACHÉ".

           `hidden` ne suffit pas: `AttributionForestMethods` pose un
           `display:"grid"` EN LIGNE sur ce même bloc, et une propriété en ligne
           bat la règle `[hidden]{display:none}` du navigateur. Le contenu
           restait donc visible — et, avec son `height:100%`, il continuait de
           nourrir la hauteur `auto` de la fenêtre: la fenêtre repliée
           CONTINUAIT DE GRANDIR au lieu de se réduire à sa barre de titre.

           Le masque effectif est donc porté par la feuille de style
           (`.popup.container.folded > .popup.content{display:none!important}`),
           qui, elle, bat la propriété en ligne — et qui se retire tout seul au
           dépliement, sans avoir à se rappeler la valeur du display. */
        this.DOMelt.content.hidden=true
        this.DOMelt.window.classList.add("folded")
        windowStyle.height="auto"
        windowStyle.minHeight="0"
        windowStyle.bottom="auto"
        windowStyle.resize="none"
        windowStyle.gridTemplateRows="auto"
        this.setFolderFoldedState(true)
    }
    unfold(){
        if(!this.folded) return
        this.folded=false
        const windowStyle=this.DOMelt.window.style
        this.DOMelt.content.hidden=false
        /* LE MASQUE EFFECTIF EST PORTÉ PAR LA FEUILLE DE STYLE, ET PAS PAR LE
           `display` en ligne: le contenu peut être stylé en ligne (le graphe
           d'attribution pose `display:grid`), et un `display` en ligne
           écarté ici serait écrasé ou désaligné. `.folded` retiré, la feuille
           rend la main au style du contenu. */
        this.DOMelt.window.classList.remove("folded")
        windowStyle.height=this.unfoldedSize.height
        windowStyle.minHeight=this.unfoldedSize.minHeight
        windowStyle.bottom=this.unfoldedSize.bottom
        windowStyle.resize=this.unfoldedSize.resize
        windowStyle.gridTemplateRows=this.unfoldedSize.gridTemplateRows
        this.setFolderFoldedState(false)
        /* LE CONTENU REVIENT AVEC DES DIMENSIONS RÉELLES, ET LES GRAPHES
           DOIVENT LE RELEVOIR.

           Pendant le repli, le contenu était en `display:none`: le conteneur
           d'un graphe mesurait donc 0×0, et son `drawGraph` sortait
           aussitôt — le SVG et le canvas gardaient donc la taille du dernier
           état visible, ou le néant si le graphe n'avait jamais été dessiné.

           Le `ResizeObserver` de l'application voit bien le changement de
           taille (0 → N) et redessine, mais c'est une observation, pas une
           garantie: elle se produit au mieux au cadre suivant, et elle peut
           être manquée si l'élément n'était pas encore observé. On demande
           donc le redessin explicitement, ici, sur le bloc qui vient de
           réapparaître. */
        requestAnimationFrame(()=>this.notifyContentResized())
    }
    /* APPELLE LES GESTIONNAIRES DE REDIMENSIONNEMENT DU CONTENU.

       `handleResize` est le crochet que le projet pose sur les éléments
       observés (`Plot2D`, `Plot2DWebGL`): l'entrée de l'observateur n'est
       utilisée que pour son `target`, un objet factice suffit donc. La
       FENÊTRE elle-même est écartée: son crochet repositionne la fenêtre
       dans son panneau, ce qui n'a rien à faire avec un dépliement. */
    notifyContentResized(){
        const root=this.DOMelt.content
        if(!root) return
        const walk=(elt)=>{
            for(const child of elt.children){
                if(child.handleResize){
                    try{
                        child.handleResize({target:child})
                    }catch(error){
                        console.error("Dialog: the redraw of a folded graph failed",error)
                    }
                    /* PAS DE RÉCURSION SOUS UN ÉLÉMENT QUI A DÉJÀ UN CROCHET:
                       ce crochet est censé avertir les descendants (le cadre du
                       graphe d'attribution appelle lui-même le redessin du
                       `Plot2DWebGL` qu'il contient) — le descendre une
                       deuxième fois redessinerait deux fois le même
                       graphique. */
                    continue
                }
                walk(child)
            }
        }
        walk(root)
    }
    toggleFolded(){
        if(this.folded){
            this.unfold()
        }else{
            this.fold()
        }
    }
    toggleMaximized(event){
        event.preventDefault()
        event.stopPropagation()
        const windowStyle=this.DOMelt.window.style
        if(!this.maximized){
            this.preMaximizeState={
                folded:Boolean(this.folded),
                styles:{
                    top:windowStyle.top,
                    right:windowStyle.right,
                    bottom:windowStyle.bottom,
                    left:windowStyle.left,
                    width:windowStyle.width,
                    height:windowStyle.height,
                    minWidth:windowStyle.minWidth,
                    minHeight:windowStyle.minHeight,
                    resize:windowStyle.resize
                }
            }
            /* LE DÉPLIEMENT DU MAXIMISE NE DOIT PAS GÂTER LA TAILLE
               ENREGISTRÉE.

               `unfold()` enregistre les styles COURANTS comme taille dépliée:
               or, ici, on déplie une fenêtre REPLIÉE, dont les styles
               sont justement ceux du repli ("auto", "0px", "none"). La
               sauvegarde serait donc écrasée, et le prochain dépliement
               rendrait une fenêtre à hauteur `auto` — le symptôme que
               l'on vient justement de corriger. */
            const keptUnfoldedSize=this.unfoldedSize?{...this.unfoldedSize}:null
            if(this.folded) this.unfold()
            if(keptUnfoldedSize) this.unfoldedSize=keptUnfoldedSize
            this.maximized=true
            this.DOMelt.window.classList.add("maximized")
            windowStyle.top="0px"
            windowStyle.left="0px"
            windowStyle.width="100%"
            windowStyle.height="100%"
            windowStyle.right="auto"
            windowStyle.bottom="auto"
            windowStyle.minWidth="0"
            windowStyle.minHeight="0"
            windowStyle.resize="none"
            this.DOMelt.folder.setAttribute("aria-label","Restaurer la fenÃªtre")
        }else{
            this.maximized=false
            this.DOMelt.window.classList.remove("maximized")
            const saved=this.preMaximizeState
            for(const [property,value] of Object.entries(saved.styles)){
                windowStyle[property]=value
            }
            if(saved.folded){
                /* LE CONTENU REPART MASQUÉ: la feuille de style fait le masque
                   effectif (le `display` en ligne du graphe d'attribution
                   battrait `[hidden]`), et `.folded` la remet en place.

                   Les dimensions EN LIGNE sont remises ici aussi: `unfold()`
                   les avait restaurées au dépliement, et une fenêtre repliée
                   qui garderait `grid-template-rows: auto 1fr` garderait une
                   rangée pour un contenu masqué. La hauteur `auto`, elle,
                   revient à la seule barre de titre. */
                this.DOMelt.content.hidden=true
                this.DOMelt.window.classList.add("folded")
                this.folded=true
                windowStyle.height="auto"
                windowStyle.minHeight="0"
                windowStyle.bottom="auto"
                windowStyle.resize="none"
                windowStyle.gridTemplateRows="auto"
                this.setFolderFoldedState(true)
            }else{
                this.DOMelt.content.hidden=false
                this.folded=false
                this.setFolderFoldedState(false)
                /* LA FENÊTRE RETROUVE SA TAILLE D'AVANT LE MAXIMISE: le
                   contenu, lui, vient de changer de dimensions — les graphes
                   doivent s'y remettre. */
                requestAnimationFrame(()=>this.notifyContentResized())
            }
        }
    }
    suicide(){
        /* UN DRAG INTERROMPU PAR LA FERMETURE. `document.onmousemove` n'était
           effacé que dans `onmouseup` : fermer le dialogue AU MILIEU du
           glisser laissait le gestionnaire en place, et il écrivait ensuite des
           `style.left/top` sur une fenêtre DÉTACHÉE — à chaque mouvement de
           souris, pour le reste de la session. */
        this.stopDrag()
        this.DOMelt.window.remove()
        dispatchEvent(this.events.broadcast.killed)
    }
    /* L'ARRÊT EST UN NOM, parce qu'il a trois appelants: la fin normale du
       glisser, la fermeture du dialogue, et la perte de focus de la fenêtre —
       un relâchement hors de la fenêtre ne livre jamais `mouseup`. */
    stopDrag(){
        document.onmousemove=null
        document.onmouseup=null
        if(this._onWindowBlur){
            window.removeEventListener("blur",this._onWindowBlur)
            this._onWindowBlur=null
        }
    }
    gridSiblings(){
        const destination=this.destination
        if(!destination){
            return
        }
        const siblings=[...destination.querySelectorAll(".popup.container")]
            .filter(window=>window.isConnected)
        if(siblings.length===0){
            return
        }
        const columns=Math.ceil(Math.sqrt(siblings.length))
        const rows=Math.ceil(siblings.length/columns)
        const width=100/columns
        const height=100/rows
        siblings.forEach((window,index)=>{
            const pilot=window.pilot
            if(!pilot){
                return
            }
            const column=index%columns
            const row=Math.floor(index/columns)
            if(pilot.maximized){
                pilot.toggleMaximized({preventDefault(){},stopPropagation(){}})
            }
            const style=window.style
            style.left=`${column*width}%`
            style.top=`${row*height}%`
            style.width=`${width}%`
            style.height=`${height}%`
            style.right="auto"
            style.bottom="auto"
        })
        this.focus()
    }
    drag(e){
        const boundary={
            width:this.destination.offsetWidth,
            height:this.destination.offsetHeight
        }
        e.preventDefault();
        let dx=e.clientX;
        let dy=e.clientY;
        const pilot=e.target.pilot
        document.onmousemove=(e)=>{
            e.preventDefault();
            dx-=e.clientX;
            dy-=e.clientY;
            let gap={
                left:pilot.DOMelt.window.offsetLeft-dx,
                right:boundary.width-(pilot.DOMelt.window.offsetLeft-dx+pilot.DOMelt.window.offsetWidth),
                top:pilot.DOMelt.window.offsetTop-dy,
                bottom:boundary.height-(pilot.DOMelt.window.offsetTop-dy+pilot.DOMelt.window.offsetHeight)
            }
            if(gap.left>=0 && gap.right>=0){
                pilot.DOMelt.window.style.left=`${100*gap.left/boundary.width}%`;
                pilot.DOMelt.window.style.right=`${100*gap.right/boundary.width}%`;
            }
            if(gap.top>=0 && gap.bottom>=0){
                pilot.DOMelt.window.style.top=`${100*gap.top/boundary.height}%`;
                if(!pilot.folded){
                    pilot.DOMelt.window.style.bottom=`${100*gap.bottom/boundary.height}%`;
                }
            }
            dx=e.clientX;
            dy=e.clientY;
        }
        document.onmouseup=(e)=>{
            e.preventDefault();
            this.stopDrag();
        }
        this._onWindowBlur=()=>this.stopDrag();
        window.addEventListener("blur",this._onWindowBlur);
    }
    resize(e){
        if(this.folded) return
        let gap={
            left:e.target.offsetLeft,
            right:e.target.pilot.destination.offsetWidth-(e.target.offsetLeft+e.target.offsetWidth),
            top:e.target.offsetTop,
            bottom:e.target.pilot.destination.offsetHeight-(e.target.offsetTop+e.target.offsetHeight)
        }
        e.target.style.left=`${100*(Math.max(gap.left,0)/e.target.pilot.destination.offsetWidth)}%`;
        e.target.style.right=`${100*(Math.max(gap.right,0)/e.target.pilot.destination.offsetWidth)}%`;
        e.target.style.top=`${100*(Math.max(gap.top,0)/e.target.pilot.destination.offsetHeight)}%`;
        e.target.style.bottom=`${100*(Math.max(gap.bottom,0)/e.target.pilot.destination.offsetHeight)}%`;
        if(gap.bottom<1 || gap.right){
            e.target.style.height="";
            e.target.style.width="";
        }
    }
}
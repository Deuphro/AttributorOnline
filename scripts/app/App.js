import {$,CE,stylize,SingleJsonFile} from "../util.js"
import {save as saveSession,import as importSessionData} from "../sessions.js"
import {defaultMenu} from "../../resources/config.js"
import {loadTable} from "../chemistry.js"
import {History} from "../core/index.js"
import {Flow} from "../flow/Flow.js"
import {MainMenu} from "../flow/MainMenu.js"
import {MainFlowMenu} from "../flow/MainFlowMenu.js"
import {Channel} from "../flow/Channel.js"
import {Table} from "../ui/Table.js"
import {Dialog} from "../ui/Dialog.js"
import {Accordion,accordionRows} from "../ui/Accordion.js"
import {buildNode} from "../utils/index.js"
import {registerNodeTypes} from "./registerNodeTypes.js"
import {clearLocalSession,debounce,exportSkeleton,parseSkeleton,readLocalSession,readPreferences,saveLocalSession,savePreferences,writeSession} from "../sessionStore.js"
import {restoreSession} from "./restoreSession.js"
import {OrbiSpinner,CycloSpinner} from "./Spinners.js"

registerNodeTypes()

export class App{
    /* The periodic table belongs to the App, and the App LOADS it itself.

       `table` is an optional injection point: pass a table to test with a
       fixture, or to run two Apps against different masses (NIST, AME,
       enriched isotopes). Left out, the App fetches data/elements.json once
       and owns the result.

       The load is NOT awaited by the constructor: the interface must be usable
       the instant it appears. So this.table is null for a few hundred
       milliseconds and tableReady is the promise that settles it. Any node
       that needs the table AWAITS tableReady - it never reads this.table
       without awaiting, or it would report "no table" for a table merely still
       in flight. A load failure resolves tableReady to null and says so once,
       instead of leaving a promise that rejects into nowhere.

       WHY HERE, and not in main.js: main.js starts the program, it does not
       know what a session is made of. Making IT fetch the table meant writing
       down, in the bootstrap, a list of what the App needs - the first line of
       a second source of truth that would grow with every feature. Inside the
       App the list stays implicit: whatever a node asks the origin for, the
       origin is the one that provides it.

       This is a deliberate PRAGMATIC choice, not the ideal architecture. Two
       things are knowingly left rough, and both are one refactor away:
         - the table is loaded even for a session that never parses a formula.
           Making it lazy (a getter that fetches on first access) would remove
           the 72 Ko from a pure-data session; it costs an await in every
           consumer, which is why it is not done yet.
         - every App fetches its own copy, so "New session" re-downloads the
           file. Sharing one instance per window would fix it, at the price of
           a module-level cache - the very global this was moved away from. */
    constructor({table=null,tableUrl="../data/elements.json"}={}){
        this.table=table
        this.tableError=null
        this.tableReady=table
            ?Promise.resolve(table)
            :loadTable(tableUrl).then(
                loaded=>{this.table=loaded; return loaded},
                err=>{
                    this.tableError=err.message??String(err)
                    console.error("[App] le tableau pÃ©riodique n'a pas pu Ãªtre chargÃ©:",err)
                    return null
                }
            )
        this.channel=new Channel(this)
        this.history=new History()
        /* THE PATTERNS, and they are on the App on purpose.

           A pattern is a shape the user cut out of a flow and expects to
           paste LATER — possibly after the session that produced it has been
           closed. So it cannot belong to the Flow (an import replaces that
           instance) nor to a node (a deleted node would take it down). The App
           is the only thing that outlives both.

           A Map, not an array: patterns are pasted by name, and a list would
           make every paste a scan for a string the user typed. */
        this.patterns=new Map()
        this.parameters={
            topContent:{
                folded: false,
                height:125,
            },
            botContent:{
                folded: false,
                height:100,
                
            },
            leftContent:{
                folded:false,
                width:250,
            },
            rightContent:{
                folded:false,
                width:250,
            }
        }
        this.topContent=[
            CE('div',{id:"topContent", className:"horizontal content"},[
                "",
                CE('div',{height:"200px",width:"100px",border:"1px solid black",color:'red'},[""])/*,
                CE('button',{pilot:this,handleClick:(e)=>{
                    e.target.pilot.channel.register("choco",new Dialog("choco",e.target.pilot,e.target.pilot.main))
                    e.target.pilot.tata=new Table(fakeData(10),["ttl","an other","a third","anotheronetocheckeverythingis ok","and a last one that is super long !"],e.target.pilot,e.target.pilot.channel.get("choco").DOMelt.content)
                }},[" Please click here for a table test"]),
                CE('button',{pilot:this,handleClick:(e)=>{
                    e.target.pilot.channel.register("lata",new Dialog("lata",e.target.pilot,e.target.pilot.midCentralContent))
                    e.target.pilot.yoyo=new Plot2D([],"yoyo",e.target.pilot,e.target.pilot.channel.get("lata").DOMelt.content)
                }},[" Please click here for a graph test"])*/
            ])
        ]
        this.flowWorkspace=CE('div',{className:"flow workspace"},[])
        this.topContent[0].appendChild(this.flowWorkspace)
        this.midCentralContent=CE('div',{className:"vertical center content"},[
            ""
        ])
        this.midContent=[
            CE('div',{id:"left",className:"vertical left panel"},[
                CE('div',{className:"vertical left content"},[""])
            ]),
            CE('div',{id:"leftSeptum", className:"left septum vertical"},[
                CE('div',{className:"vertical resizer",pilot:this,handleMouseDown:(e)=>e.target.pilot.resizerHookLeft(e)},[]),
                CE('div',{className:"vertical wrapper",pilot:this,handleClick:(e)=>{e.target.pilot.foldLeft(!e.target.pilot.parameters.leftContent.folded)}},[]),
                CE('div',{className:"vertical resizer",pilot:this,handleMouseDown:(e)=>e.target.pilot.resizerHookLeft(e)},[])
            ]),
            CE('div',{id:"center",className:"vertical center panel"},[
                this.midCentralContent
            ]),
            CE('div',{id:"rightSeptum", className:"right septum vertical"},[
                CE('div',{className:"vertical resizer",pilot:this,handleMouseDown:(e)=>e.target.pilot.resizerHookRight(e)},[]),
                CE('div',{className:"vertical wrapper",pilot:this,handleClick:(e)=>{e.target.pilot.foldRight(!e.target.pilot.parameters.rightContent.folded)}},[]),
                CE('div',{className:"vertical resizer",pilot:this,handleMouseDown:(e)=>e.target.pilot.resizerHookRight(e)},[])
            ]),
            CE('div',{id:"right",className:"vertical right panel"},[
                CE('div',{className:"vertical right content"},[""])
            ])
        ]
        this.botContent=[
            CE('div',{id:"botContent", className:"horizontal content"},[
                ""
            ])
        ]
        this.menu=CE('div',{id:"mainMenu",className:"menu"},[])
        this.top=CE('div',{id:"top",className:"horizontal top panel"},this.topContent)
        this.topSeptum=CE('div',{id:"topSeptum",className:"top horizontal septum"},[
            CE('div',{className:"horizontal resizer",pilot:this,handleMouseDown:(e)=>e.target.pilot.resizerHookTop(e)},[]),
            CE('div',{className:"horizontal wrapper",pilot:this,handleClick:(e)=>{e.target.pilot.foldTop(!e.target.pilot.parameters.topContent.folded)}},[]),
            CE('div',{className:"horizontal resizer",pilot:this,handleMouseDown:(e)=>e.target.pilot.resizerHookTop(e)},[])
        ])
        this.mid=CE('div',{id:"mid",className:"horizontal mid panel"},this.midContent)
        this.botSeptum=CE('div',{id:"botSeptum",className:"bot horizontal septum"},[
            CE('div',{className:"horizontal resizer",pilot:this,handleMouseDown:(e)=>e.target.pilot.resizerHookBot(e)},[]),
            CE('div',{className:"horizontal wrapper",pilot:this,handleClick:(e)=>{e.target.pilot.foldBot(!e.target.pilot.parameters.botContent.folded)}},[]),
            CE('div',{className:"horizontal resizer",pilot:this,handleMouseDown:(e)=>e.target.pilot.resizerHookBot(e)},[])
        ])
        this.bot=CE('div',{id:"bot",className:"horizontal bot panel"},this.botContent)
        this.mainInterface=CE('div',{id:"mainInterface", className:"container"},[
            this.top,
            this.topSeptum,
            this.mid,
            this.botSeptum,
            this.bot
        ])
        this.main=CE('div',{id:"main",className:"app"},[
            this.menu,
            this.mainInterface
        ])

        this.setupOnWindow()
        this.setupSessionStore()
        /*
        this.channel.register("Data manager",new Accordion("Data manager",this,$(".vertical.left.content")))
        this.channel.get('Data manager').toggle()
        this.channel.get('Data manager').DOMelt.content.appendChild(
            CE('div',{},["test",CE('div',{id:"Gloubidi",style:{height:"300px"}},[])])
        )
        */
        this.channel.register("mainMenu",new MainMenu(defaultMenu.mainMenu,"mainMenu",this,this.menu))
        this.channel.register("mainFlowMenu",new MainFlowMenu(defaultMenu.mainFlowMenu,"mainFlowMenu",this,this.flowWorkspace))
        this.channel.register("mainFlow",new Flow("mainFlow",this,this.flowWorkspace))
        /*
        this.channel.register('node',new Node('Node with no inputs',[],[[0],[0],[0]],this,this.channel.get('mainFlow')), 'Node with no inputs')
        this.channel.register('node', new NodeWithAccordion('Filter node',[{}],[{}],this,this.channel.get('mainFlow'),{x:200,y:10}), 'Filter node')
        this.channel.register('node', new Node('Display node',[{}],[],this,this.channel.get('mainFlow'),{x:400,y:10}), 'Display node')
        */
    }
    /* Les six écritures de `grid-template-rows` ci-dessous recopient la rangée
       du milieu. C'est du STYLE EN LIGNE: il gagne contre la feuille de style,
       donc un `1fr` nu ici réintroduirait le bug du panneau bot poussé hors de
       la fenêtre — mais seulement après un redimensionnement, un repli, ou une
       session restaurée, ce qui le rend beaucoup plus dur à relier à sa cause.
       `minmax(0,1fr)` partout, comme dans main.css. */
    foldTop(v){
        if(v){
            this.parameters.topContent.folded=true;
            this.mainInterface.style["grid-template-rows"]=`0px 5px minmax(0,1fr) 5px ${this.parameters.botContent.height*(!this.parameters.botContent.folded)}px`
        }else{
            this.parameters.topContent.folded=false;
            this.mainInterface.style["grid-template-rows"]=`${this.parameters.topContent.height}px 5px minmax(0,1fr) 5px ${this.parameters.botContent.height*(!this.parameters.botContent.folded)}px`
        }
    }
    resizeHeightTop(v){
        this.parameters.topContent.height=v
        this.mainInterface.style["grid-template-rows"]=`${v}px 5px minmax(0,1fr) 5px ${this.parameters.botContent.height*(!this.parameters.botContent.folded)}px`
    }
    resizerHookTop(e){
        e.preventDefault();
        let dy=e.clientY;
        const pilot=e.target.pilot
        document.onmousemove=(e)=>{
            pilot.mainInterface.style.transition="0ms";
            pilot.resizeHeightTop(pilot.parameters.topContent.height-dy+e.clientY);
            dy=e.clientY;
        }
        document.onmouseup=(e)=>{
            document.onmousemove=null;
            document.onmouseup=null;
            pilot.mainInterface.style.transition="300ms";
        }
    }
    foldBot(v){
        if(v){
            this.parameters.botContent.folded=true;
            this.mainInterface.style["grid-template-rows"]=`${this.parameters.topContent.height*(!this.parameters.topContent.folded)}px 5px minmax(0,1fr) 5px 0px`
        }else{
            this.parameters.botContent.folded=false;
            this.mainInterface.style["grid-template-rows"]=`${this.parameters.topContent.height*(!this.parameters.topContent.folded)}px 5px minmax(0,1fr) 5px ${this.parameters.botContent.height}px`
        }
    }
    resizeHeightBot(v){
        this.parameters.botContent.height=v;
        this.mainInterface.style["grid-template-rows"]=`${this.parameters.topContent.height*(!this.parameters.topContent.folded)}px 5px minmax(0,1fr) 5px ${v}px`
    }
    resizerHookBot(e){
        e.preventDefault();
        let dy=e.clientY;
        const pilot=e.target.pilot
        document.onmousemove=(e)=>{
            pilot.mainInterface.style.transition="0ms";
            pilot.resizeHeightBot(pilot.parameters.botContent.height+dy-e.clientY)
            dy=e.clientY;
        }
        document.onmouseup=(e)=>{
            document.onmousemove=null;
            document.onmouseup=null;
            pilot.mainInterface.style.transition="300ms";
        }
    }
    foldLeft(v){
        if(v){
            this.parameters.leftContent.folded=true;
            this.mid.style["grid-template-columns"]=`0px 5px 1fr 5px ${this.parameters.rightContent.width*(!this.parameters.rightContent.folded)}px`
        }else{
            this.parameters.leftContent.folded=false;
            this.mid.style["grid-template-columns"]=`${this.parameters.leftContent.width}px 5px 1fr 5px ${this.parameters.rightContent.width*(!this.parameters.rightContent.folded)}px`
        }
    }
    resizeWidthLeft(v){
        this.parameters.leftContent.width=v;
        this.mid.style["grid-template-columns"]=`${v}px 5px 1fr 5px ${this.parameters.rightContent.width*(!this.parameters.rightContent.folded)}px`
    }
    resizerHookLeft(e){
        e.preventDefault();
        let dx=e.clientX;
        const pilot=e.target.pilot
        document.onmousemove=(e)=>{
            pilot.mid.style.transition="0ms";
            pilot.resizeWidthLeft(pilot.parameters.leftContent.width-dx+e.clientX);
            dx=e.clientX;
        }
        document.onmouseup=(e)=>{
            document.onmousemove=null;
            document.onmouseup=null;
            pilot.mid.style.transition="300ms";
        }
    }
    foldRight(v){
        if(v){
            this.parameters.rightContent.folded=true;
            this.mid.style["grid-template-columns"]=`${this.parameters.leftContent.width*(!this.parameters.leftContent.folded)}px 5px 1fr 5px 0px`
        }else{
            this.parameters.rightContent.folded=false;
            this.mid.style["grid-template-columns"]=`${this.parameters.leftContent.width*(!this.parameters.leftContent.folded)}px 5px 1fr 5px ${this.parameters.rightContent.width}px`
        }
    }
    resizeWidthRight(v){
        this.parameters.rightContent.width=v;
        this.mid.style["grid-template-columns"]=`${this.parameters.leftContent.width*(!this.parameters.leftContent.folded)}px 5px 1fr 5px ${v}px`
    }
    resizerHookRight(e){
        e.preventDefault();
        let dx=e.clientX;
        const pilot=e.target.pilot
        document.onmousemove=(e)=>{
            pilot.mid.style.transition="0ms";
            pilot.resizeWidthRight(pilot.parameters.rightContent.width+dx-e.clientX)
            dx=e.clientX;
        }
        document.onmouseup=(e)=>{
            document.onmousemove=null;
            document.onmouseup=null;
            pilot.mid.style.transition="300ms";
        }
    }
    /* REMET LA COLONNE DANS L'ORDRE CHOISI, après un rechargement.

       Un squelette se restaure dans l'ordre du FICHIER, qui est l'ordre de
       création des nœuds — pas l'ordre dans lequel l'utilisateur a ensuite
       rangé ses panneaux. Sans ce passage, chaque rechargement remettrait la
       colonne dans l'ordre de naissance et défait silencieusement le
       rangement.

       Le tri est fait ici, sur le panneau entier, et non au retour de chaque
       accordéon: à cet instant-là un accordéon ne connaît pas le nombre de
       ceux qui doivent encore arriver, et se placer « au rang 2 » d'une liste
       qui n'en contient qu'un le mettrait à la fin.

       Un accordéon sans rang écrit revient APRÈS ceux qui en ont un: un
       nœud créé depuis le dernier enregistrement se range donc en bas de la
       colonne, ce qui est aussi ce qu'on voit à l'écran quand on vient de
       le créer. Un rang infini fait exactement cela, et le tri des tableaux
       étant stable, ceux qui n'ont pas de rang entre eux gardent l'ordre
       d'arrivée — donc un simple .sort() suffit, et il n'y a rien à suivre. */
    /* LE TRI EST FAIT ICI, ET C'EST ICI QUE ÇA COMPTE — voir la note sur
       resolveAfterRestore(): un accordéon n'existe qu'une fois son nœud
       enregistré, et son rang n'arrive qu'à la fin de l'import. */
    applyPanelOrder(){
        for(const panel of this.main.querySelectorAll(".vertical.left.content,.vertical.right.content")){
            const rows=accordionRows(panel)
            if(rows.length<2){
                continue
            }
            const ranks=rows.map(container=>container.accordion?.pendingPanelOrder)
            if(!ranks.some(rank=>Number.isInteger(rank))){
                //personne n'a de rang: le panneau est dans l'ordre où les
                //accordéons sont arrivés, et le laisser tel quel est exact
                continue
            }
            const sorted=rows
                .map((container,arrival)=>({container,rank:ranks[arrival],arrival}))
                .sort((a,b)=>(a.rank??Infinity)-(b.rank??Infinity)||a.arrival-b.arrival)
                .map(entry=>entry.container)
            /* On INSÈRE chaque accordéon devant son successeur plutôt que de
               les pousser tous à la fin dans l'ordre: chaque appendChild
               détache le nœud de sa place, ce qui fait scintiller toute la
               colonne à chaque étape. Insérer devant le suivant ne touche
               qu'un nœud, et le résultat est le même. */
            /* On NE SE SERT PAS DU SUIVANT comme point d'insertion: le nœud
               qu'on vient de déplacer a déplacé le suivant avec lui, et la
               ancre cherchée n'est plus où on l'attendait — la colonne sortait
               alors dans un ordre qui n'était celui d'aucun rang.

               On avance donc d'un CURSEUR, qui est toujours un nœud déjà
               placé donc jamais déplacé ensuite: c'est la seule ancre qui ne
               bouge pas pendant qu'on la cherche. */
            let cursor=panel.firstChild
            for(const container of sorted){
                while(cursor&&cursor!==container){
                    const next=cursor.nextSibling
                    panel.insertBefore(container,cursor)
                    cursor=next
                }
                cursor=container.nextSibling
            }
        }
    }
    applyPanelParameters(){
        const p=this.parameters
        if(!p?.topContent||!p?.botContent||!p?.leftContent||!p?.rightContent){
            return
        }
        //apply the saved layout (fold states and sizes) without animation
        this.mainInterface.style.transition="0ms"
        this.mid.style.transition="0ms"
        this.foldTop(Boolean(p.topContent.folded))
        if(!p.topContent.folded&&typeof p.topContent.height==="number"){
            this.resizeHeightTop(p.topContent.height)
        }
        this.foldBot(Boolean(p.botContent.folded))
        if(!p.botContent.folded&&typeof p.botContent.height==="number"){
            this.resizeHeightBot(p.botContent.height)
        }
        this.foldLeft(Boolean(p.leftContent.folded))
        if(!p.leftContent.folded&&typeof p.leftContent.width==="number"){
            this.resizeWidthLeft(p.leftContent.width)
        }
        this.foldRight(Boolean(p.rightContent.folded))
        if(!p.rightContent.folded&&typeof p.rightContent.width==="number"){
            this.resizeWidthRight(p.rightContent.width)
        }
        this.mainInterface.style.transition="300ms"
        this.mid.style.transition="300ms"
    }
    setupOnWindow(destination='body'){
        this.destination=destination;
        $(this.destination).appendChild(this.main);
        this.main.addEventListener('click',(e)=>{
            //console.log(e.target)
            if(e.target.handleClick){e.target.handleClick(e)}
        })
        this.main.addEventListener('dblclick',(e)=>{
            if(e.target.handleDblClick){e.target.handleDblClick(e)}
        })
        this.main.addEventListener('mousedown',(e)=>{
            const dialog=e.target.closest?.(".popup.container")
            if(!dialog){
                Dialog.focused?.blur()
            }
            let target=e.target
            while(target&&target!==this.main&&!target.handleMouseDown){
                target=target.parentElement
            }
            if(target?.handleMouseDown){target.handleMouseDown(e)}
        })
        this.main.addEventListener('mouseup',function(e){
            if(e.target.handleMouseUp){e.target.handleMouseUp(e)}
        })
        this.main.addEventListener('keydown',(e)=>{
            if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="z"){
                e.preventDefault()
                if(e.shiftKey){
                    this.history.redo()
                }else{
                    this.history.undo()
                }
                return
            }
            if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="y"){
                e.preventDefault()
                this.history.redo()
                return
            }
            if(e.target.handleKeyDown){e.target.handleKeyDown(e)}
        })
        this.main.addEventListener('blur',(e)=>{
            if(e.target.handleBlur){e.target.handleBlur(e)}
        },true)
        this.main.addEventListener('focusin',(e)=>{
            let target=e.target
            while(target&&target!==this.main&&!target.handleFocus){
                target=target.parentElement
            }
            if(target?.handleFocus){target.handleFocus(e)}
        })
        this.main.addEventListener('input',(e)=>{
            if(e.target.handleInput){e.target.handleInput(e)}
        })
        this.main.addEventListener('scroll',(e)=>{
            if(e.target.handleScroll){e.target.handleScroll(e)}
        },true)
        this.main.addEventListener('change',(e)=>{
            if(e.target.handleChange){e.target.handleChange(e)}
        })
        this.main.addEventListener('contextmenu',(e)=>{
            if(e.target.handleContextmenu){e.target.handleContextmenu(e)}
        })
        const observeResizeHandlers=(elt,obs)=>{
            if(elt.handleResize){
                obs.observe(elt)
            }
            for(let child of elt.children){
                observeResizeHandlers(child,obs)
            }
        }
        //kept on the instance: the autosave registers its own resize listeners
        //through it, and a second copy of this walker is a second thing to keep
        //in step with the first
        this.observeResizeHandlers=observeResizeHandlers
        this.resizeObserver=new ResizeObserver((entries)=>{
            for(const entry of entries){
                entry.target.handleResize?.(entry)
            }
        })
        this.mutObserver=new MutationObserver((mutationsList)=>{
            for(const mutation of mutationsList){
                for(const node of mutation.addedNodes){
                    if(node.nodeType===1){
                        observeResizeHandlers(node,this.resizeObserver)
                    }
                }
            }
        })
        observeResizeHandlers(this.main,this.resizeObserver)
        this.mutObserver.observe(this.main,{childList:true,subtree:true})
    }
    msConvert(){
        let message="Server is ready"
        const sendToServer=(fileList)=>{
            let fileNumber=0
            for(let file of fileList){
                fileNumber++
                requestPOST('https://attributor.fr/uploads',file,(data)=>{
                    for(let item of senderContainer.children[2].children){
                        if(item.textContent==file.name){
                            let textFileName=file.name.replace('.raw','.txt')
                            item.lastChild.remove()
                            item.appendChild(
                                CE('button',{style:{"margin-left":"10px"},
                                handleClick:(e)=>{
                                    window.location.href=`https://attributor.fr/uploads/outputs/${textFileName}`
                                }
                                },["Download "+textFileName])
                            )
                            fileNumber--
                            if(fileNumber==0){
                                senderContainer.lastChild.textContent="Files ready to download"
                            }
                        }
                    }
                })
            }
        }
        let sendList=CE('div',{style:{height:"100%"}},["Files to be sent to server:"])
        let selectedFiles=[]
        const addFileSendList=(files)=>{
            selectedFiles=files
            sendList.replaceChildren()
            sendCommand.firstChild.disabled=false
            for(let file of files){
                sendList.appendChild(CE('div',{style:{"margin-bottom":"1px"}},[file.name]))
            }
        }
        let msConvertDialog=new Dialog("Send .raw to a server for conversion",this,this.main)
        const dropzone=CE('div',{className:"dropzone"},["Drop .raw files here"])
        dropzone.addEventListener("dragover",(e)=>{
            e.preventDefault()
            dropzone.classList.add("dragover")
        })
        dropzone.addEventListener("dragleave",()=>{
            dropzone.classList.remove("dragover")
        })
        dropzone.addEventListener("drop",(e)=>{
            e.preventDefault()
            dropzone.classList.remove("dragover")
            addFileSendList(e.dataTransfer.files)
        })
        let loaderElement=CE('input',{type:"file",multiple:true,accept:".raw",handleChange:(e)=>{addFileSendList(e.target.files)}},["Select a raw file"])
        let sendCommand=CE('div',{},[
            CE('button',{handleClick:(e)=>{
                sendToServer(selectedFiles)
                e.target.disabled=true
                for(let item of senderContainer.children[2].children){
                    item.appendChild(new OrbiSpinner())
                }
                senderContainer.lastChild.textContent="Files sent to server, waiting for conversion..."
            }},["Send to Server"])
        ])
        let senderContainer=CE('div',{
            style:{
                width:"100%",
                height:"100%",
                display:"grid",
                "grid-template-rows":"auto auto minmax(0,1fr) auto auto"},
                "justify-items": "stretch",
                "align-items": "stretch"
            },[dropzone,
                loaderElement,
                sendList,
                sendCommand,
                CE('div',{style:{"text-align":"center"}},[message])
            ])
        msConvertDialog.DOMelt.content.appendChild(senderContainer)
    }
    loadDelimitedText(onValidate){
        let DelimitedTextLoader=new Dialog("Load delimited text file",this,this.main)
        let prevLength=500
        let dataVessel={
            dims:[0,0],
            raw:"",
            processed:[],
            labels:["x","y"],
            processRaw(){
                if(this.reader){
                    this.raw=this.reader.result
                    delete this.reader
                }
                let lines=this.raw.split(RegExp(lineSeparator.value))
                this.dims[0]=lines.length
                for(let k in lines){
                    lines[k]=lines[k].split(RegExp(colSeparator.value))
                    this.dims[1]=Math.max(this.dims[1],lines[k].length)
                    lines[k].forEach((e,i,a)=>{a[i]=parseFloat(e)})
                }
                this.processed=lines
            }
        }
        const validate=()=>{
            dataVessel.processRaw()
            const source={
                lineSeparator:lineSeparator.value,
                columnSeparator:colSeparator.value,
                fileName:dataVessel.fileName||"",
                raw:dataVessel.raw,
                labels:[...(dataVessel.labels??["x","y"])],
                pairs:dataVessel.processed
                    .filter(line=>Number.isFinite(line[0])&&Number.isFinite(line[1]))
                    .map(line=>[line[0],line[1]])
            }
            if(onValidate){
                onValidate(source)
            }
            DelimitedTextLoader.DOMelt.dismisser.click()
        }
        const readFile=(file,data)=>{
            if (!file) {
                return
            }
            data.reader = new FileReader()
            data.reader.onload = ()=>{
                data.fileName=file.name
                updatePreviews(data)
            }
            data.reader.readAsText(file)
        }
        const readSingleFile=(e,data)=>{
            readFile(e.target.files[0],data)
        }
        const updatePreviews=(vessel)=>{
            vessel.processRaw()
            rawPreview.textContent=vessel.raw.slice(0,prevLength)
            procPreview.innerHTML=""
            let cropData=vessel.processed.slice(0,15)
            cropData.pop()
            let ellipsisRow=[]
            for(let k in cropData[0]){ellipsisRow.push("...")}
            cropData.push(ellipsisRow)
            if(!Array.isArray(vessel.labels)){
                vessel.labels=["x","y"]
            }
            new Table(cropData,[...vessel.labels],this,procPreview,{mutable:{hRuler:true},onTitleChange:(labels)=>{vessel.labels=[...labels]}})
        }
        const dropzone=CE('div',{className:"dropzone"},["Drop a text file here"])
        dropzone.addEventListener("dragover",(e)=>{
            e.preventDefault()
            dropzone.classList.add("dragover")
        })
        dropzone.addEventListener("dragleave",()=>{
            dropzone.classList.remove("dragover")
        })
        dropzone.addEventListener("drop",(e)=>{
            e.preventDefault()
            dropzone.classList.remove("dragover")
            readFile(e.dataTransfer.files[0],dataVessel)
        })
        const loaderElement=CE('input',{type:"file",handleChange:(e)=>{readSingleFile(e,dataVessel)}},["Select a text file"])
        let rawPreview=CE('div',{style:{margin:"5px","border-radius":"5px",border:"1px solid white",padding:"5px"}},["Here is the preview of the raw data"])
        rawPreview.setAttribute("contenteditable","true")
        rawPreview.handleInput=(e)=>{
            dataVessel.raw=e.target.textContent+dataVessel.raw.slice(prevLength)
            updatePreviews(dataVessel)
        }
        let procPreview=CE('div',{style:{margin:"5px","border-radius":"5px",border:"1px solid white",padding:"5px"}},["Here is the preview of the processed data"])
        const lineSeparator=CE('select',{handleInput:(e)=>{updatePreviews(dataVessel)}},[
            CE('option',{value:"\\r\\n|\\r|\\n"},["auto/guess"]),
            CE('option',{value:"\r\n"},["CRLF"]),
            CE('option',{value:"\r"},["CR"]),
            CE('option',{value:"\n"},["LF"]),
        ])
        const colSeparator=CE('select',{handleInput:(e)=>{updatePreviews(dataVessel)}},[
            CE('option',{value:"\\t|,|\\s+"},["auto/guess"]),
            CE('option',{value:"\t"},["tab"]),
            CE('option',{value:","},["comma"]),
            CE('option',{value:"\\s+"},["whitespace"]),
        ])
        const validator=CE('button',{handleClick:(e)=>{validate()}},["Load"])
        const command=CE('div',{width:"100%"},[
            CE('label',{for:"loaderCommands"},["Lines separator"]),
            lineSeparator,
            CE('br',{},[]),
            CE('label',{for:"loaderCommands"},["Columns separator"]),
            colSeparator,
            CE('br',{},[]),
            CE('div',{style:{"text-align":"right"}},[validator])
        ])
        const loaderContainer=CE('div',{
            style:{
                width:"100%",
                height:"100%",
                display:"grid",
                "grid-template-rows":"auto auto minmax(0, 1fr) auto"},
                "justify-items": "stretch",
                "align-items": "stretch"
        },[
            dropzone,
            loaderElement,
            CE('div',{style:{
                overflow:"auto",
                "min-height":"0",
                display:"grid",
                "grid-template-columns":"1fr 1fr"
            }},[
                rawPreview,
                procPreview
            ]),
            command
        ])
        DelimitedTextLoader.DOMelt.content.appendChild(loaderContainer)
    }
    loadThermoRaw(onValidate){
        let ThermoRawLoader=new Dialog("Load Thermo .raw file",this,this.main)
        let dataVessel={
            fileName:"",
            raw:new Uint8Array(0),
            scanMetadata:null
        }
        let fileInfo=CE('div',{style:{margin:"5px",padding:"5px",border:"1px solid white",borderRadius:"5px"}},["No file loaded"])
        const options={
            dataType:"auto",
            firstScan:1,
            lastScan:0,
            msLevelFilter:0,
            rtMin:0,
            rtMax:0
        }
        const validate=()=>{
            if(!dataVessel.raw.length){
                this.notice?.("No file selected","Please select a Thermo .raw file first.")
                return
            }
            const source={
                fileName:dataVessel.fileName||"",
                raw:dataVessel.raw,
                options:options
            }
            if(onValidate){
                onValidate(source)
            }
            ThermoRawLoader.DOMelt.dismisser.click()
        }
        const readFile=(file,data)=>{
            if (!file || !file.name.endsWith(".raw")) {
                return
            }
            data.reader = new FileReader()
            data.reader.onload = ()=>{
                data.fileName=file.name
                data.raw=new Uint8Array(data.reader.result)
                data.scanMetadata=null
                updatePreview(data)
                quickScanMetadata(data)
            }
            data.reader.readAsArrayBuffer(file)
        }
        const readSingleFile=(e,data)=>{
            readFile(e.target.files[0],data)
        }
        const updatePreview=(vessel)=>{
            if(vessel.fileName){
                let previewText=`File: ${vessel.fileName} (${(vessel.raw.length/1024/1024).toFixed(2)} MB)`
                if(vessel.scanMetadata){
                    const scanCount=vessel.scanMetadata.scanCount||0
                    const rtMin=vessel.scanMetadata.rtMin?.toFixed(2)||0
                    const rtMax=vessel.scanMetadata.rtMax?.toFixed(2)||0
                    const msLevels=vessel.scanMetadata.msLevels||[]
                    previewText+=` | Scans: ${scanCount} | RT: ${rtMin}–${rtMax} min | MS levels: ${msLevels.join(", ")}`
                }
                fileInfo.textContent=previewText
            }else{
                fileInfo.textContent="No file loaded"
            }
        }
        const updateOptionsFromMetadata=()=>{
            if(dataVessel.scanMetadata){
                const meta=dataVessel.scanMetadata
                options.firstScan=meta.firstScan
                options.lastScan=meta.lastScan
                options.rtMin=meta.rtMin
                options.rtMax=meta.rtMax
                firstScanInput.min=meta.firstScan
                firstScanInput.max=meta.lastScan
                firstScanInput.value=meta.firstScan
                lastScanInput.min=meta.firstScan
                lastScanInput.max=meta.lastScan
                lastScanInput.value=meta.lastScan
                rtMinInput.min=meta.rtMin
                rtMinInput.max=meta.rtMax
                rtMinInput.placeholder=meta.rtMin.toFixed(2)
                rtMinInput.value=""
                rtMaxInput.min=meta.rtMin
                rtMaxInput.max=meta.rtMax
                rtMaxInput.placeholder=meta.rtMax.toFixed(2)
                rtMaxInput.value=""
                msLevelOptions.length=1
                for(const ml of meta.msLevelsPresent||[1]){
                    msLevelOptions.push(CE("option",{value:String(ml)},[`MS${ml} only`]))
                }
            }
        }
        const quickScanMetadata=(data)=>{
            if(!data.raw.length) return
            import("../workerPool.js").then(({computePool})=>{
                computePool.run("parseThermoRaw",{
                    data:Array.from(data.raw),
                    options:{dataType:"auto",firstScan:1,lastScan:0,msLevelFilter:0,rtMin:0,rtMax:0,metadataOnly:true}
                }).then(result=>{
                    if(result.scanMetadata){
                        data.scanMetadata=result.scanMetadata
                        updatePreview(data)
                        updateOptionsFromMetadata()
                        const meta=result.scanMetadata
                        metaInfo.textContent=`Scans: ${meta.firstScan}-${meta.lastScan} (${meta.scanCount} total) | RT: ${meta.rtMin.toFixed(2)}-${meta.rtMax.toFixed(2)} min | MS levels: ${(meta.msLevelsPresent||[1]).join(", ")} | Centroid: ${meta.centroidScanCount} | Profile: ${meta.profileScanCount}`
                    }
                }).catch(err=>{
                    console.error("Quick scan metadata failed:",err)
                })
            })
        }
        const dropzone=CE('div',{className:"dropzone"},["Drop a Thermo .raw file here"])
        dropzone.addEventListener("dragover",(e)=>{
            e.preventDefault()
            dropzone.classList.add("dragover")
        })
        dropzone.addEventListener("dragleave",()=>{
            dropzone.classList.remove("dragover")
        })
        dropzone.addEventListener("drop",(e)=>{
            e.preventDefault()
            dropzone.classList.remove("dragover")
            readFile(e.dataTransfer.files[0],dataVessel)
        })
        const loaderElement=CE('input',{type:"file",accept:".raw",handleChange:(e)=>{readSingleFile(e,dataVessel)}},["Select a .raw file"])
        
        const dataTypeSelect=CE("select",{value:options.dataType,handleInput:e=>{
            options.dataType=e.target.value
        }},[
            CE("option",{value:"auto"},["Auto (centroid -> profile)"]),
            CE("option",{value:"centroid"},["Centroid only"]),
            CE("option",{value:"profile"},["Profile only (centroided)"]),
            CE("option",{value:"profile_raw"},["Profile raw (all points)"])
        ])
        
        const firstScanInput=CE("input",{type:"number",min:1,value:options.firstScan,style:{width:"80px"},handleInput:e=>{
            options.firstScan=Math.max(1,parseInt(e.target.value)||1)
        }},[])
        const lastScanInput=CE("input",{type:"number",min:0,value:options.lastScan,style:{width:"80px"},handleInput:e=>{
            options.lastScan=Math.max(0,parseInt(e.target.value)||0)
        }},[])
        
        const msLevelOptions=[CE("option",{value:"0"},["All MS levels"])]
        const msLevelSelect=CE("select",{value:String(options.msLevelFilter),handleInput:e=>{
            options.msLevelFilter=parseInt(e.target.value)
        }},msLevelOptions)
        
        const rtMinInput=CE("input",{type:"number",min:0,step:0.01,value:options.rtMin,style:{width:"80px"},handleInput:e=>{
            options.rtMin=Math.max(0,parseFloat(e.target.value)||0)
        }},[])
        const rtMaxInput=CE("input",{type:"number",min:0,step:0.01,value:options.rtMax,style:{width:"80px"},handleInput:e=>{
            options.rtMax=Math.max(0,parseFloat(e.target.value)||0)
        }},[])
        
        const metaInfo=CE("div",{style:{fontSize:"12px",padding:"8px",border:"1px solid #444",borderRadius:"5px",marginTop:"5px"}},[""])
        
        const validator=CE('button',{pilot:this,handleClick:e=>{validate()}},["Load spectra"])
        const loaderContainer=CE('div',{
            style:{
                width:"100%",
                display:"grid",
                gap:"8px",
                padding:"10px"
            }
        },[
            fileInfo,
            dropzone,
            loaderElement,
            metaInfo,
            CE("label",{style:{display:"grid",gap:"4px",fontSize:"13px"}},["Data type",dataTypeSelect]),
            CE("label",{style:{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"5px",fontSize:"13px"}},["First scan",firstScanInput,"Last scan",lastScanInput]),
            CE("label",{style:{display:"grid",gap:"4px",fontSize:"13px"}},["MS level filter",msLevelSelect]),
            CE("label",{style:{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"5px",fontSize:"13px"}},["RT min (min)",rtMinInput,"RT max (min)",rtMaxInput]),
            validator
        ])
        ThermoRawLoader.DOMelt.content.appendChild(loaderContainer)
    }
    saveSession(options={}){
        if(typeof options === "boolean"){
            options={download:options}
        }
        const json=saveSession(this)
        if(options.download){
            SingleJsonFile(json)
        }
        if(options.localStorage){
            /* The SKELETON, not the full session, and the difference is not a
               detail. A full session carries the file text AND the parsed pairs
               AND the resolved outputs, and measures about three times as much:
               5000 points of a real spectrum is already 4 MB complete, which is
               the entire browser budget for the whole site. The skeleton keeps
               the text, and the resolve rebuilds the rest - so a durable copy of
               the same spectrum is 0.14 MB and a handful of them fit.

               The full session is what goes to a FILE, where there is no budget
               and being able to reopen without re-running a kernel is worth it. */
            saveLocalSession(exportSkeleton(this))
        }
        return json
    }
    /* The durable copy comes back the way a reload does: as a skeleton, through
       the same two steps, with the same guarantees. One code path means one set
       of bugs, and the alternative - a second restore for the local copy - is a
       second thing to keep in step with the first. */
    openLocalCopy(){
        const document=parseSkeleton(readLocalSession())
        if(!document){
            throw new Error(
                "There is no local copy to open. \"Save (local)\" in the File menu makes one."
            )
        }
        this.dispose()
        let restored=null
        try{
            restored=restoreSession(document)
        }catch(error){
            //the skeleton is dropped rather than kept: one this build cannot read
            //would fail again on every opening, with no way past it
            console.error("[App] the local copy could not be opened:",error)
            clearLocalSession()
        }
        if(!restored){
            //never leave the user with nothing: an empty app beats no app
            globalThis.Attributor=new App()
            return globalThis.Attributor
        }
        globalThis.Attributor=restored
        restored.applyPanelParameters()
        restored.applyPanelOrder()
        restored.resolveAfterRestore()
        return restored
    }
    /* The one way this app talks instead of writing to the console.

       It exists because the two failures that matter - a storage budget
       exceeded, a local copy that cannot be read - are both invisible from the
       outside: the app keeps working perfectly, and the user only finds out
       later that nothing was saved. A Dialog is what this codebase already has
       for saying something, so it is what this uses. */
    notice(title,text){
        const dialog=new Dialog(title,this,this.main)
        stylize(dialog.DOMelt.window,{
            width:"420px",
            top:"35%",
            left:"35%"
        })
        dialog.DOMelt.content.appendChild(
            CE("div",{style:{padding:"10px",lineHeight:"1.5"}},[text])
        )
        return dialog
    }
    /* THE AUTOSAVE, and the two places it listens from.

       It hangs off historyChanged rather than off the nodes: every command
       already goes through History, so this one event catches a move, a node
       created or deleted, a link, a trim, an arrangement - everything - without
       a single node having to remember to announce itself. A node dragged by
       hand is not a command (it becomes one on mouseup), which is why the drag
       records its own history entry rather than relying on this. */
    setupSessionStore(){
        //read FIRST: a stored panel size is only worth restoring onto a panel
        //that is about to exist
        this.applyStoredPreferences()
        //one debounced writer for the whole app. 400 ms is long enough to
        //coalesce a drag into a single write, and short enough that closing the
        //tab right after an edit still keeps it
        this.saveSessionSoon=debounce(()=>{
            writeSession(this)
        },{name:"the session"})
        globalThis.addEventListener("historyChanged",this.saveSessionSoon)
        /* Not everything the skeleton remembers is an undoable act: folding a
           widget, dragging a ruler, a checkbox. None of those record a command,
           so the writes above would only ever catch up at the NEXT structural
           change - and anything done in the last moment before the tab closes
           would be lost outright. One forced write on the way out is what makes
           "nothing is lost" true instead of nearly true. */
        this.flushOnPageHide=()=>{
            this.saveSessionSoon?.flush()
        }
        globalThis.addEventListener("pagehide",this.flushOnPageHide)
        //the panel geometry is NOT in the history stack: a resize is not an
        //undoable act, so the septa announce themselves instead
        this.savePreferencesSoon=debounce(()=>{
            savePreferences(this)
        },{name:"the panel layout"})
        for(const septum of [this.topSeptum,this.botSeptum]){
            septum.handleResize=()=>this.savePreferencesSoon()
            this.observeResizeHandlers?.(septum,this.resizeObserver)
        }
    }
    applyStoredPreferences(){
        const stored=readPreferences()
        if(!stored){
            return
        }
        for(const key of ["topContent","botContent","leftContent","rightContent"]){
            const value=stored[key]
            //a stored value is merged, never replaced: a build that added a
            //panel must not lose the key it does not know about
            if(this.parameters[key]&&value&&typeof value==="object"){
                Object.assign(this.parameters[key],value)
            }
        }
        //the file's layout wins over this: App.importSession calls
        //applyPanelParameters() after, on the session it just read
        this.applyPanelParameters()
    }
    /* The reload gesture. A skeleton carries no data - the pairs, the inputs and
       the outputs were all left out on purpose - so restoring the shape is only
       half the job. The graph is already painted by the time this runs, and the
       resolve happens behind it: that is what turns "the same picture, empty"
       into "the same picture, back". */
    resolveAfterRestore(){
        const flow=this.channel.get("mainFlow")
        if(!flow?.nodeSet?.size){
            //the columns are still sorted on this path: a session that only
            //ever rearranged its panels has no flow to resolve, and would
            //otherwise come back in birth order — the one case where the
            //early return above would silently undo the user's arrangement
            this.applyPanelOrder()
            return Promise.resolve()
        }
        /* The panels go back into the user's order HERE, and not at the end of
           the import: a node's accordion is built when it is REGISTERED, and
           the rank arrives later still, in restoreAfterImport. Sorting between
           those two moments would sort an empty column — which is exactly what
           it did, and the arrangement was lost on every reload. This is the
           first point where every panel of the session exists. */
        this.applyPanelOrder()
        return flow.resolveFlow()
            .then(()=>{
                //the statuses just settled: save them, so a second reload
                //restores a graph that says "resolved" and not one that says
                //"floating" on every node
                this.saveSessionSoon?.()
            })
            .catch(error=>{
                //a kernel that fails marks its own node and does not reject the
                //chain, so reaching here means something else went wrong: the
                //graph is on screen and usable, which is what matters
                console.error("[App] the restored flow did not resolve cleanly:",error)
            })
    }
    dispose(){
        //idempotent teardown of the whole app (used before replacing it with an
        //imported session): stops the observers, the menus and the channel
        if(this.disposed){
            return
        }
        this.disposed=true
        //the autosave must not outlive the app it describes: a pending write
        //would put an app back that is no longer on screen, and a pagehide
        //listener left attached would keep writing a session the user deleted
        this.saveSessionSoon?.cancel()
        globalThis.removeEventListener("historyChanged",this.saveSessionSoon)
        globalThis.removeEventListener("pagehide",this.flushOnPageHide)
        this.resizeObserver?.disconnect()
        this.mutObserver?.disconnect()
        this.channel.get("mainMenu")?.dispose?.()
        this.channel.get("mainFlowMenu")?.dispose?.()
        this.channel.shutDown()
        this.main?.remove()
    }
    async importSession(options={}){
        if(typeof options === "string"){
            options={json:options}
        }
        let json=options.json
        if(options.localStorage){
            json=readLocalSession()
            if(!json){
                throw new Error("There is no local copy to open. \"Save (local)\" makes one.")
            }
        }
        if(options.file){
            json=await options.file.text()
        }
        if(options.filePicker){
            const input=CE('input',{type:"file",accept:"application/json"},[])
            json=await new Promise((resolve,reject)=>{
                input.addEventListener("change",async()=>{
                    const file=input.files?.[0]
                    if(!file){
                        reject(new Error("No session file selected"))
                        return
                    }
                    try{
                        resolve(await file.text())
                    }catch(error){
                        reject(error)
                    }
                },{once:true})
                input.click()
            })
        }
        if(typeof json !== "string"){
            throw new TypeError("importSession expects json, file, localStorage, or filePicker")
        }
        //tear the current app down BEFORE creating the imported one: the new app
        //attaches itself to the DOM and broadcasts events in its constructor, so
        //the old channel listeners must be gone already (no cross-talk, no leaks)
        this.dispose()
        const importedApp=await importSessionData(json,{
            createApp:()=>new App(),
            createNode:({data,app,flow})=>buildNode(data,app,flow),
            createLink:({flow,inputNode,inputIndex,outputNode,outputIndex})=>{
                return flow.createLink(inputNode,inputIndex,outputNode,outputIndex)
            },
            //mainFlow already exists (built by the App constructor); any other
            //flow stored in the session file is created here on the fly
            createFlow:(flowData,app)=>{
                return new Flow(flowData.label??"flow",app,app.flowWorkspace)
            }
        })
        globalThis.Attributor=importedApp
        //restore the saved panel layout (fold states and sizes)
        importedApp.applyPanelParameters()
        /* and the order the user gave the panels within each column. This path
           does not go through resolveAfterRestore() — an imported file needs
           no resolve, it carries its data — so the sort is asked for here,
           where the import is over and every panel exists. */
        importedApp.applyPanelOrder()
        return importedApp
    }
    about(){
        let aboutDialog=new Dialog("About Attributor",this,this.main)
        stylize(aboutDialog.DOMelt.window,{
            width:"20%",
            height:"20%",
            top:"40%",
            left:"40%"
        })
        aboutDialog.DOMelt.content.appendChild(CE('div',{style:{
            width:"100%",
            height:"100%",
            display:"grid",
            "grid-template-rows":"auto auto auto",
            "place-items":"center",
            "text-align":"center"
        }},[
            new OrbiSpinner(50,50),
            CE("div",{},[
                CE("div",{},["Attributor Alpha version 0.1.0"]),
                CE("div",{},["This software is under development and may contain bugs."]),
                CE("div",{},["Please report any issues to the developers."])
            ]),
            CE("div",{},[new CycloSpinner(15)]),
            CE("div",{},[new CycloSpinner(15),new CycloSpinner(15)])
        ]))
        /* Where the work goes, stated where somebody goes looking for it.

           The honest version is three sentences, not a paragraph: nothing leaves
           the machine, a durable copy can be deleted with one button, and a large
           spectrum may be refused by the browser's budget. Anything longer stops
           being read. */
        this.notice(
            "Where your data goes",
            "Your work is kept in this browser only. Nothing is sent to a server, and no one else can read it. "+
            "\"New session\" deletes all of it: the current session, the local copy, and the window layout. "+
            "Use \"Export session\" for anything you want to keep on disk."
        )
    }
}


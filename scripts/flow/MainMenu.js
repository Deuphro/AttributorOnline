import {Menu} from "./Menu.js"
import {exportSkeleton,purgeAll} from "../sessionStore.js"

export class MainMenu extends Menu{
    constructor(configObject,title,origin,destination){
        super(configObject,title,origin,destination)
        this.undoItem=null
        this.redoItem=null
        for(const elt of this.container.querySelectorAll(".parent")){
            const text=elt.firstChild?.textContent??""
            if(text==="Undo") this.undoItem=elt
            if(text==="Redo") this.redoItem=elt
        }
        this.historyChangedHandler=(e)=>this.updateUndoRedo(e.detail.msg)
        globalThis.addEventListener("historyChanged",this.historyChangedHandler)
        this.updateUndoRedo({canUndo:false,canRedo:false,undoLabel:null,redoLabel:null})
        this.events={
            broadcast:{
                poppedUp:new CustomEvent("poppedUp",{detail:{msg:"I've just popped up",emitter:this}}),
                killed:new CustomEvent("killed",{detail:{msg:"I've just been killed !!!",emitter:this}}),
            },
            listen:{
            importDelimitedText(e){
                origin.loadDelimitedText(source=>{
                    dispatchEvent(new CustomEvent('createNode',{detail:{msg:{
                        title:source.fileName||'Delimited text',
                        type:'delimitedText',
                        source
                    }}}))
                })
            },
            importThermoRaw(e){
                origin.loadThermoRaw(source=>{
                    dispatchEvent(new CustomEvent('createNode',{detail:{msg:{
                        title:source.fileName||'Thermo .raw file',
                        type:'thermoRaw',
                        source
                    }}}))
                })
            },
            msConvert(e){origin.msConvert()},
            undo(e){origin.history.undo()},
            redo(e){origin.history.redo()},
            exportSession(e){
                const {format,target}=e.detail.msg
                if(format==="json" && target==="file"){
                    origin.saveSession({download:true})
                }
            },
            async importSession(e){
                const {format,source}=e.detail.msg
                if(format==="json" && source==="file"){
                    await origin.importSession({filePicker:true})
                }
            },
            about(e){origin.about()},
            newSession(e){
                origin.saveSessionSoon?.cancel()
                purgeAll()
                origin.dispose()
                globalThis.Attributor=new origin.constructor()
            },
            saveLocalSession(e){
                try{
                    const bytes=exportSkeleton(origin).length
                    origin.saveSession({localStorage:true})
                    origin.notice(
                        "Saved locally",
                        `${(bytes/1e6).toFixed(2)} MB kept in this browser: the graph, your `+
                        `settings and the text of your file. It is not on your disk, and `+
                        `"New session" deletes it - use "Export session" for anything you keep.`
                    )
                }catch(error){
                    origin.notice("Not saved", error.message)
                }
            },
            openLocalSession(e){
                try{
                    origin.openLocalCopy()
                }catch(error){
                    origin.notice("Could not open the local copy",error.message)
                }
            },
        }}
    }
    updateUndoRedo({canUndo,canRedo,undoLabel,redoLabel}={}){
        if(this.undoItem){
            this.undoItem.firstChild.textContent=canUndo&&undoLabel?`Undo: ${undoLabel}`:"Undo"
            this.undoItem.style.opacity=canUndo?"1":"0.4"
        }
        if(this.redoItem){
            this.redoItem.firstChild.textContent=canRedo&&redoLabel?`Redo: ${redoLabel}`:"Redo"
            this.redoItem.style.opacity=canRedo?"1":"0.4"
        }
    }
    dispose(){
        if(this.historyChangedHandler){
            globalThis.removeEventListener("historyChanged",this.historyChangedHandler)
            this.historyChangedHandler=null
        }
        super.dispose()
    }
}
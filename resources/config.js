const defaultMenu={
    mainMenu:{
        File:{
            "New session":(e)=>{dispatchEvent(new CustomEvent('newSession',{detail:{msg:""}}))},
              "Save (local)":(e)=>{dispatchEvent(new CustomEvent('saveLocalSession',{detail:{msg:""}}))},
              "Open local copy":(e)=>{dispatchEvent(new CustomEvent('openLocalSession',{detail:{msg:""}}))},
              hr:{},
              //these two were labelled "flow" and always were about the whole
              //session: the graph, its settings, the loaded data, the panel
              //layout. The label was the only thing out of date.
              "Import session":(e)=>{dispatchEvent(new CustomEvent('importSession',{detail:{msg:{format:"json",source:"file"}}}))},
              "Export session":(e)=>{dispatchEvent(new CustomEvent('exportSession',{detail:{msg:{format:"json",target:"file"}}}))},
        },
        Edit:{
            Undo:(e)=>{dispatchEvent(new CustomEvent('undo',{detail:{msg:""}}))},
            Redo:(e)=>{dispatchEvent(new CustomEvent('redo',{detail:{msg:""}}))}
        },
        Data:{
            Load:{
                //JSON:(e)=>{},
                "Delimited Text":(e)=>{dispatchEvent(new CustomEvent('importDelimitedText',{detail:{msg:""}}))},
            },
            hr:{},
            'Use msConvert':(e)=>{dispatchEvent(new CustomEvent('msConvert',{detail:{msg:""}}))}
        },
        View:{
            Reset:{},
            Expose:{}
        },
        About:(e)=>{dispatchEvent(new CustomEvent('about',{detail:{msg:""}}))}
    },
    mainFlowMenu:{
        "Data":{
            "Simple XY file":()=>{dispatchEvent(new CustomEvent('createNode',{detail:{msg:{title:'Simple XY file',type:'delimitedText'}}}))},
        },
        "Operation":{
            "+1 on each pair element":()=>{dispatchEvent(new CustomEvent('createNode',{detail:{msg:{title:'Operation +1',type:'operation'}}}))},
            "F-KMD":()=>{dispatchEvent(new CustomEvent('createNode',{detail:{msg:{title:'F-KMD',type:'fkmd'}}}))},
            "Trimmer":()=>{dispatchEvent(new CustomEvent('createNode',{detail:{msg:{title:'Trimmer',type:'trimmer'}}}))},
            //One entry for the two stages: the persistence classifier and the
            //anti-radio width filter answer ONE question - which points are
            //peaks - and asking for it took three cables when they were separate
            //nodes. The kernels stay in their own files; only the node merged.
            "Peak picking":()=>{dispatchEvent(new CustomEvent('createNode',{detail:{msg:{title:'Peak picking',type:'peakPicking'}}}))},
        },
        "Display":{
            "Simple XY plot":()=>{dispatchEvent(new CustomEvent('createNode',{detail:{msg:{title:'Simple XY plot',type:'simpleXYPlot'}}}))},
        },
        "Random and test":{
            "Random simple":()=>{dispatchEvent(new CustomEvent('createNode',{detail:{msg:{title:'Random',type:'random'}}}))},
            "Random with accordion":()=>{dispatchEvent(new CustomEvent('createNode',{detail:{msg:{title:'Random with accordion',type:'randomAccordion'}}}))},
            "Random with accordion and graph":()=>{dispatchEvent(new CustomEvent('createNode',{detail:{msg:{title:'Random with accordion and graph',type:'randomAccordionGraph'}}}))},
            "Right accordion with graph":()=>{dispatchEvent(new CustomEvent('createNode',{detail:{msg:{title:'Right accordion with graph',type:'rightAccordionGraph'}}}))},
        },
        "Flow":{
            Resolve:(e)=>{dispatchEvent(new CustomEvent('resolveFlow',{detail:{msg:""}}))},
            //forget every node the user placed by hand and lay the whole flow
            //out again: no overlap, shortest drawing, fewest crossed cables
            "Arrange nodes":(e)=>{dispatchEvent(new CustomEvent('arrangeFlow',{detail:{msg:""}}))},
            hr:{},
            /* La sélection multiple: un clic nu ne garde qu'un nœud, Ctrl/Cmd
               en ajoute un, et un glissement emporte tout le groupe. "Select
               all" est un raccourci pour le cas où la boîte de sélection
               n'existe pas encore — il n'y en a pas. */
            "Select all":(e)=>{dispatchEvent(new CustomEvent('selectAllNodes',{detail:{msg:""}}))},
            "Clear selection":(e)=>{dispatchEvent(new CustomEvent('clearNodeSelection',{detail:{msg:""}}))},
            hr:{},
            /* Un patron, c'est une FORME réutilisable: les nœuds avec leurs
               réglages, sans les données. Le nom est demandé parce qu'un
               patron sans nom ne se retrouve pas — et parce que ce menu ne
               peut pas lister des noms qu'il ne connaît pas encore. */
            "Save selection as pattern...":(e)=>{
                const name=prompt("Name for this pattern:","pattern")
                if(name&&name.trim()){
                    dispatchEvent(new CustomEvent('copySelectionAsPattern',{detail:{msg:{name:name.trim()}}}))
                }
            },
            "Paste pattern...":(e)=>{
                /* La liste est lue sur l'App, qui est la seule chose qui
                   detient les patrons. Un menu bâti depuis config.js est un
                   arbre statique: il ne peut pas faire pousser une entrée par
                   patron sans devenir une seconde liste, qui dérive. */
                const patterns=[...(globalThis.Attributor?.patterns?.keys()??[])]
                if(patterns.length===0){
                    alert("No pattern saved yet. Select some nodes, then \"Save selection as pattern...\".")
                    return
                }
                const name=prompt(`Paste which pattern?\n\n${patterns.join("\n")}`,patterns[0])
                if(name&&name.trim()){
                    dispatchEvent(new CustomEvent('pastePattern',{detail:{msg:{name:name.trim()}}}))
                }
            }
        },
        "Tools":{
            "Chat":()=>{dispatchEvent(new CustomEvent('createNode',{detail:{msg:{title:'Chat',type:'chat'}}}))}
        }
    }
}

export {defaultMenu}
const defaultMenu={
    mainMenu:{
        File:{
            "New session":(e)=>{dispatchEvent(new CustomEvent('newSession',{detail:{msg:""}}))},
              "Import flow":(e)=>{dispatchEvent(new CustomEvent('importSession',{detail:{msg:{format:"json",source:"file"}}}))},
              "Export flow":(e)=>{dispatchEvent(new CustomEvent('exportSession',{detail:{msg:{format:"json",target:"file"}}}))},
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
            "Persistent Homology":()=>{dispatchEvent(new CustomEvent('createNode',{detail:{msg:{title:'Persistent Homology',type:'persistentHomology0D'}}}))},
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
            Resolve:(e)=>{dispatchEvent(new CustomEvent('resolveFlow',{detail:{msg:""}}))}
        }
    }
}

export {defaultMenu}
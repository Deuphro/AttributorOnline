const defaultMenu={
    mainMenu:{
        File:{
            "New session":{},
              Import:(e)=>{dispatchEvent(new CustomEvent('importSession',{detail:{msg:{format:"json",source:"file"}}}))},
              Export:(e)=>{dispatchEvent(new CustomEvent('exportSession',{detail:{msg:{format:"json",target:"file"}}}))},
        },
        Edit:{
            Undo:(e)=>{dispatchEvent(new CustomEvent('undo',{detail:{msg:""}}))}
        },
        Data:{
            Load:{
                //JSON:(e)=>{},
                "Delimited Text":(e)=>{dispatchEvent(new CustomEvent('importDelimitedText',{detail:{msg:""}}))},
                hr:{},
                'Use msConvert':(e)=>{dispatchEvent(new CustomEvent('msConvert',{detail:{msg:""}}))}
            },
            Save:{
                JSON:{},
                CSV:{}
            },
            "Make new":{}
        },
        View:{
            Reset:{},
            Expose:{}
        },
        About:{},
        CopyStabTest:(e)=>{console.log(this)}
    },
    mainFlowMenu:{
        "Data":{
            "Simple XY file":()=>{dispatchEvent(new CustomEvent('createNode',{detail:{msg:{title:'Lapin'}}}))},
        },
        "Display":{
            "Simple XY plot":()=>{dispatchEvent(new CustomEvent('createNode',{detail:{msg:{title:'Simple XY plot'}}}))},
        },
        "Random":{
            "Random simple":()=>{dispatchEvent(new CustomEvent('createNode',{detail:{msg:{title:'Random',type:'random'}}}))},
            "Random with accordion":()=>{dispatchEvent(new CustomEvent('createNode',{detail:{msg:{title:'Random with accordion',type:'randomAccordion'}}}))},
            "Random with accordion and graph":()=>{dispatchEvent(new CustomEvent('createNode',{detail:{msg:{title:'Random with accordion and graph',type:'randomAccordionGraph'}}}))},
        },
        "Flow":{
            Resolve:(e)=>{dispatchEvent(new CustomEvent('resolveFlow',{detail:{msg:""}}))},
            "Export to JSON":(e)=>{dispatchEvent(new CustomEvent('exportFlow',{detail:{msg:""}}))},
            "Import from JSON":(e)=>{dispatchEvent(new CustomEvent('importFlow',{detail:{msg:""}}))},
        }
    }
}

export {defaultMenu}
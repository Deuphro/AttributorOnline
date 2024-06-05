const defaultMenu={
    mainMenu:{
        File:{
            "New session":{},
            Import:(e)=>{dispatchEvent(new CustomEvent('clickImport',{detail:{msg:"This is SPARTAAAA !!!"}}))},
            Export:{}
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
    }
}

export {defaultMenu}
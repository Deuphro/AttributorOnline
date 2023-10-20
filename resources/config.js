const defaultMenu={
    mainMenu:{
        File:{
            "New session":{},
            Import:(e)=>{dispatchEvent(new CustomEvent('clickImport',{detail:{msg:"This is SPARTAAAA !!!"}}))},
            Export:{}
        },
        Edit:{},
        Data:{
            Load:{
                JSON:(e)=>{},
                "Delimited Text":(e)=>{dispatchEvent(new CustomEvent('importDelimitedText',{detail:{msg:"ça marche!"}}))},
                hr:{},
                msConverter:{}
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
        About:{}
    }
}

export {defaultMenu}
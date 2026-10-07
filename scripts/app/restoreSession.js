import {App} from "./App.js"
import {import as importSessionData} from "../sessions.js"
import {importOptions} from "../sessionStore.js"
import {buildNode} from "../utils/index.js"

export function restoreSession(document){
    let created=null
    const options=importOptions(document,{
        createApp:()=>{
            created=new App()
            return created
        },
        buildNode
    })
    if(!options){
        return null
    }
    try{
        /* The panel order is applied by resolveAfterRestore(), not here: a
           node's accordion is built when the node is REGISTERED, and it only
           learns its rank in restoreAfterImport, which runs later still. A
           sort placed here would sort an empty column. */
        return importSessionData(JSON.stringify(document),options)
    }catch(error){
        /* The import builds a WHOLE app before anything can fail: it draws its
           menus, its field and its panels. Falling back without taking that one
           down first is what leaves two .app#main in the body, the second one
           sitting on top of the first. */
        created?.dispose()
        throw error
    }
}


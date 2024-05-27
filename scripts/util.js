//a function to select html elements
const $=(e)=>{ return document.querySelector(e); }

//a function to create a HTML element
function CE(tag,props,child){
    let res=document.createElement(tag);
    for (let k of Object.keys(props)){
        if(k=="style"){
            for(let j of Object.keys(props[k])){res.style[j]=props[k][j]}
        }else{
            res[k]=props[k]
        }
    }
    for (let elt of child) {
        if(typeof elt ==='string'){
            res.innerText=elt
        } else if(elt===null){
        } else{
            res.appendChild(elt)
        }
    }
    return res
}

//function to transfert style to CSS
const stylize=(target,styleObject)=>{
    for(let prop of Object.keys(styleObject)){
        target.style[prop]=styleObject[prop]
    }
}

function fakeData(n){
    let res=[];
    let line=[];
    let c=0;
    for(let k=0;k<(10*n);k++){
        line=[];
        for(let j=0;j<10*n/1;j++){
            c++;
            line.push(c);
        }
        res.push([...line]);
    }
    return res
}

function DC(obj,visited=new WeakMap()){
    if(visited.has(obj)){
        return visited.get(obj)
    }
    if(typeof obj!=="object"||obj===null){
        const clone=obj
        return clone
    }
    if(obj instanceof Set){
        let clone=new Set()
        visited.set(obj,clone)
        for(let item of obj){
            clone.add(DC(item,visited))
        }
        return clone
    }
    if (obj instanceof Map) {
        let clone = new Map()
        visited.set(obj, clone)
        for (let [key, value] of obj) {
            clone.set(DC(key, visited), DC(value, visited))
        }
        for(let sym of Object.getOwnPropertySymbols(obj)){
            clone[sym]=DC(obj[sym],visited)
        }
        for(let key in obj){
            if(Object.prototype.hasOwnProperty.call(obj,key)){
                if(clone[key] instanceof Function){
                    clone[key]=DC(obj[key],visited).bind(clone)
                }else{
                    clone[key]=DC(obj[key],visited)
                }
            }
        }
        return clone
    }
    if(obj instanceof Event && obj.type){
        let clone=new CustomEvent(obj.type,{detail:DC(obj.detail,visited)})
        visited.set(obj,clone)
        return clone
    }
    if(obj instanceof Node){
        let clone=obj.cloneNode(false)
        visited.set(obj,clone)
        Object.setPrototypeOf(clone, Object.getPrototypeOf(obj))
        for(let key in obj){
            if(Object.prototype.hasOwnProperty.call(obj,key)){
                if(clone[key] instanceof Function){
                    clone[key]=DC(obj[key],visited).bind(clone)
                }else{
                    clone[key]=DC(obj[key],visited)
                }
            }
        }
        for(let child of obj.childNodes){
            clone.appendChild(DC(child,visited))
        }
        return clone
    }
    if(obj instanceof Float64Array){
        const n=obj.length
        let clone=new Float64Array(n)
        visited.set(obj,clone)
        for(let k=0;k<n;k++){
            clone[k]=obj[k]
        }
        return clone
    }
    let clone=Array.isArray(obj)? [] : {}
    visited.set(obj,clone)
    Object.setPrototypeOf(clone, Object.getPrototypeOf(obj))
    for(let sym of Object.getOwnPropertySymbols(obj)){
        clone[sym]=DC(obj[sym],visited)
    }
    for(let key in obj){
        if(Object.prototype.hasOwnProperty.call(obj,key)){
            if(clone[key] instanceof Function){
                clone[key]=DC(obj[key],visited).bind(clone)
            }else{
                clone[key]=DC(obj[key],visited)
            }
        }
    }
    return clone
}

function serializeHTML(elt){//NOT FINISHED
    let dummyObj={}
    dummyObj.tag=elt.tagName
    dummyObj.attributes={}
    for(let att of elt.attributes){
        if(att.name=="class"){
            dummyObj.attributes["className"]=att.value
        }else{
            dummyObj.attributes[att.name]=att.value
        }
    }
    return JSON.stringify(dummyObj)
}

function requestPOST(url,data){
    const options={
        method:"POST",
        headers:{"Content-Type":"application/json",},
        body:data//JSON.stringify(data)
    }
    fetch(url,options)
        .then(response=>{
            if(!response.ok){
                throw new Error('HTTP request error')
            }
            return response.text()
        })
        .then(data=>{
            console.log("HTTP POST data: ", data)
        })
        .catch(error=>{
            console.error("HTTP POST error: ", error)
        })
}

export {$,CE,stylize,fakeData,DC,serializeHTML,requestPOST}
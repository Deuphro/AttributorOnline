//a function to select html elements
const $=(e)=>{ return document.querySelector(e); }

//a function to create a HTML element
const CE=(tag,props,child)=>{
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
    for(let k=0;k<(100*n);k++){
        line=[];
        for(let j=0;j<100*n/1;j++){
            c++;
            line.push(c);
        }
        res.push([...line]);
    }
    return res
}

const DC=(obj,visited=new Map())=>{
    //console.log(obj)
    if(visited.has(obj)){
        //console.log("deja vu et stocké cloné en", visited.get(obj))
        return visited.get(obj)
    }
    if(typeof obj!=="object"||obj===null){
        return obj
    }
    if(obj instanceof Node){
        let clone=obj.cloneNode(false)
        visited.set(obj,clone)
        Object.setPrototypeOf(clone, Object.getPrototypeOf(obj))
        for(let key in obj){
            if(Object.prototype.hasOwnProperty.call(obj,key)){
                clone[key]=DC(obj[key],visited)
            }
        }
        for(let child of obj.childNodes){
            clone.appendChild(DC(child),visited)
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
            clone[key]=DC(obj[key],visited)
        }
    }
    return clone
}

export {$,CE,stylize,fakeData,DC}
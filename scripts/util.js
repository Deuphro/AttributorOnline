import "./interface.js"

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

function serializeApp(obj) {
    const seen = new WeakMap();
    let idCounter = 0;
    const constructors = new Set();

    function getId(obj) {
        if (!seen.has(obj)) {
            seen.set(obj, idCounter++);
        }
        return seen.get(obj);
    }

    function replacer(key, value) {
        if (value instanceof Function) {///PRENDRE EN COMPTE LES FONCTION CLASSIQUES SANS PROTOTYPE
            const isArrowFunction = value.prototype === undefined;
            return { __type: 'Function', source: value.toString(), isArrow: isArrowFunction };
        }
        if (value instanceof Set) {
            return { __type: 'Set', values: [...value].map(v => replacer('', v)) };
        }
        if (value instanceof Map) {
            return { __type: 'Map', values: [...value.entries()].map(([k, v]) => [replacer('', k), replacer('', v)]) };
        }
        if (value instanceof Node) {
            if (value.nodeType === Node.TEXT_NODE) {
                return { __type: 'TextNode', textContent: value.textContent };
            }
            if (value.nodeType === Node.COMMENT_NODE) {
                return { __type: 'CommentNode', textContent: value.textContent };
            }
            const node = {
                __type: 'Node',
                nodeType: value.nodeType,
                nodeName: value.nodeName,
                attributes: {},
                properties: {},
                children: []
            };
            for (let attr of value.attributes || []) {
                node.attributes[attr.name] = attr.value;
            }
            for (let prop in value) {
                if (value.hasOwnProperty(prop)) {
                    node.properties[prop] = replacer('', value[prop]);
                }
            }
            for (let child of value.childNodes || []) {
                node.children.push(replacer('', child));
            }
            return node;
        }
        if (value instanceof Event) {
            return {
                __type: 'Event',
                eventType: value.type,
                eventInit: {
                    bubbles: value.bubbles,
                    cancelable: value.cancelable,
                    composed: value.composed,
                    detail: value.detail
                }
            };
        }
        if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) {
                return { __ref: getId(value) };
            }
            const id = getId(value);
            const constructorName = value.constructor ? value.constructor.name : 'Object';
            constructors.add(constructorName);
            const clone = Array.isArray(value) ? [] : { __id: id, __constructor: constructorName };
            for (let sym of Object.getOwnPropertySymbols(value)) {
                clone[sym] = replacer(sym, value[sym]);
            }
            for (let k in value) {
                if (Object.prototype.hasOwnProperty.call(value, k)) {
                    clone[k] = replacer(k, value[k]);
                }
            }
            return clone;
        }
        return value;
    }

    const serializedObj = JSON.stringify(obj, replacer);
    console.log(constructors)
    return JSON.stringify({
        data: serializedObj,
        constructors: Array.from(constructors)
    });
}

function deserializeApp(json) {
    const parsed = JSON.parse(json);
    const constructorsList = parsed.constructors;
    const data = parsed.data;

    const refs = new Map();
    const unresolvedFunctions = [];

    function reviver(key, value) {
        if (value && value.__type === 'Function') {
            console.log(value)
            const source = value.source.trim();
            if (value.isArrow) {
                return eval(source);
            } else {
                const fnBodyIndex = source.indexOf('{');
                if (fnBodyIndex === -1) {
                    return new Function(); // Empty function if body is not found
                }
                const fnHead = source.slice(0, fnBodyIndex).trim();
                const fnBody = source.slice(fnBodyIndex + 1, source.lastIndexOf('}'));
                const params = fnHead.slice(fnHead.indexOf('(') + 1, fnHead.indexOf(')'));
                return new Function(params, fnBody);
            }
        }
        if (value && value.__type === 'Set') {
            const set = new Set(value.values.map(v => reviver('', v)));
            return set;
        }
        if (value && value.__type === 'Map') {
            const map = new Map(value.values.map(([k, v]) => [reviver('', k), reviver('', v)]));
            return map;
        }
        if (value && value.__type === 'TextNode') {
            return document.createTextNode(value.textContent);
        }
        if (value && value.__type === 'CommentNode') {
            return document.createComment(value.textContent);
        }
        if (value && value.__type === 'Node') {
            const node = document.createElement(value.nodeName);
            for (let attr in value.attributes) {
                node.setAttribute(attr, value.attributes[attr]);
            }
            unresolvedFunctions.push({ node, properties: value.properties });
            for (let child of value.children) {
                node.appendChild(reviver('', child));
            }
            return node;
        }
        if (value && value.__type === 'Event') {
            const event = new CustomEvent(value.eventType, value.eventInit);
            return event;
        }
        if (value && value.__ref !== undefined) {
            return refs.get(value.__ref);
        }
        if (value && value.__id !== undefined) {
            const Constructor = constructorsList[value.__constructor] || Object;
            const instance = new Constructor();
            Object.setPrototypeOf(instance, Constructor.prototype);
            refs.set(value.__id, instance);
            delete value.__id;
            delete value.__constructor;
            return Object.assign(instance, value);
        }
        return value;
    }

    const obj = JSON.parse(data, reviver);

    // Resolve node functions after initial parsing
    unresolvedFunctions.forEach(({ node, properties }) => {
        for (let prop in properties) {
            node[prop] = reviver('', properties[prop]);
        }
    });

    return obj;
}

function SingleJsonFile(jsonStr){
    const blob = new Blob([jsonStr],{type:'application/json'})
    const url=window.URL.createObjectURL(blob)
    const fakeLink=document.createElement('a')
    fakeLink.href=url
    fakeLink.download='elJson.json'
    fakeLink.click()
    window.URL.revokeObjectURL(url)
}

function requestPOST(url,data,callback=()=>{}){
    let body=data
    let headers={}
    if(data instanceof File){
        const formData=new FormData()
        formData.append('file',data)
        body=formData
    }else{
        headers['Content-Type'] = 'application/json'
        body = JSON.stringify(data)
    }
    const options={
        method:"POST",
        headers:headers,
        body:body
    }
    fetch(url,options)
        .then(response=>{
            if(!response.ok){
                throw new Error('HTTP request error')
            }
            console.log("the response :",response)
            return response.text()
        })
        .then(data=>{
            //console.log("HTTP POST data: ", data)
            callback(data)
        })
        .catch(error=>{
            console.error("HTTP POST error: ", error)
        })
}

export {$,CE,stylize,fakeData,DC,requestPOST,serializeApp,deserializeApp,SingleJsonFile}
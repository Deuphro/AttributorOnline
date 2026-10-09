import {Node} from "../core/index.js"
import {Dialog} from "../ui/Dialog.js"
import {CE,stylize} from "../util.js"

export class ChatNode extends Node{
    constructor(title,origin,destinationFlow,position={x:180,y:10}){
        super(title,[],[],origin,destinationFlow,position)
        this.status="floating"
        /* What the user typed, kept apart from the live connection:
           `parameters` is what a session stores, and this.socket is what this
           visit owns. Serialising a live WebSocket would put a connection
           object in the session file. */
        this.parameters.url=""
        this.parameters.nick=""
        this.parameters.room=""
        this.socket=null
        /* The backoff is exponential, as in the prototype, and CAPPED: a server
           that is down must not leave a retry loop running in a background tab
           for the rest of the session. */
        this.reconnectAttempt=0
        this.maxReconnectAttempts=10
        this.reconnectTimer=null
        this.dialog=null
    }
    /* The URL to dial: what the user typed, or the page's own host.

       Deriving it from the page is what makes the prototype work with no setup
       on the same host, and the choice of wss on https is not cosmetic — a
       secure page may not open an insecure socket, and the browser refuses it
       with an error nobody reads. The field stays editable for every other
       case, rather than the host being hard-coded and working on exactly one
       machine. */
    effectiveUrl(){
        if(this.parameters.url?.trim()){
            return this.parameters.url.trim()
        }
        const protocol=location.protocol==="https:"?"wss:":"ws:"
        return `${protocol}//${location.host}`
    }
    registered(e){
        const {channel,registrationName,label,caster}=e.detail.msg
        if(caster!==this||this.dialog){
            return
        }
        /* A Dialog, like every graph: the chat can be dragged, folded and
           closed with the same gestures as the rest. It is NOT an Accordion —
           a chat that collapsed when the panel scrolled past would be
           unusable, and the side panels are where the field toggles live. */
        this.dialog=new Dialog(label,this.origin,this.origin.botContent[0])
        /* Chat window must not be closable via the dismiss button —
           the only way to leave is deleting the ChatNode itself,
           which properly tears down the WebSocket and timers. */
        this.dialog.DOMelt.dismisser.remove()
        stylize(this.dialog.DOMelt.window,{
            top:"0%",
            right:"0%",
            width:"25%",
            height:"100%"
        })
        channel.register(`${registrationName}:chat`,this.dialog,`${label} chat`)
        this.render()
        this.connect()
    }
    render(){
        const content=this.dialog.DOMelt.content
        content.replaceChildren()
        stylize(content,{
            display:"grid",
            //a row for the connection bar, one for the log, one for the input
            "grid-template-rows":"auto minmax(0,1fr) auto",
            height:"100%",
            minHeight:"0",
            overflow:"hidden",
            padding:"4px",
            gap:"4px"
        })
        /* --- the bar: where we are, and whether we are connected ---------- */
        this.statusLabel=CE("div",{className:"chat-status"},["Not connected"])
        //a field per setting, each writing straight to `parameters`: no apply
        //button, because a chat that needs confirming before it remembers your
        //nick is a chat you use twice
        const urlField=CE("input",{
            type:"text",
            value:this.parameters.url,
            placeholder:"ws://host — empty means this page",
            title:"WebSocket URL of the chat server. Leave empty to use this page's own host."
        },[])
        urlField.addEventListener("change",()=>{
            this.parameters.url=urlField.value.trim()
        })
        const nickField=CE("input",{
            type:"text",size:8,
            value:this.parameters.nick,
            placeholder:"nick",
            title:"The name you post under"
        },[])
        nickField.addEventListener("change",()=>{
            this.parameters.nick=nickField.value.trim()
        })
        const roomField=CE("input",{
            type:"text",size:8,
            value:this.parameters.room,
            placeholder:"room",
            title:"The room to join. Leave empty to see the list of rooms."
        },[])
        roomField.addEventListener("change",()=>{
            this.parameters.room=roomField.value.trim()
        })
        const joinButton=CE("button",{type:"button"},["Join"])
        joinButton.addEventListener("click",()=>{
            //a full reconnect, not a re-join: the URL or the nick may have
            //changed, and the old socket is pointed at the wrong place
            this.disconnect()
            this.reconnectAttempt=0
            this.connect()
        })
        const bar=CE("div",{className:"chat-bar"},[
            this.statusLabel,urlField,nickField,roomField,joinButton
        ])
        /* --- the log ------------------------------------------------------- */
        this.log=CE("div",{className:"chat-log"},[])
        /* --- the input ----------------------------------------------------- */
        this.inputField=CE("input",{
            type:"text",
            placeholder:"Your message...   (Enter to send)",
            maxLength:500
        },[])
        this.inputField.addEventListener("keydown",(event)=>{
            if(event.key!=="Enter"){
                return
            }
            /* Enter POSTS and never inserts a newline: the box is one line
               tall and Enter is the only way to send. Without preventDefault
               the key would also reach whatever form encloses the dialog. */
            event.preventDefault()
            this.send()
        })
        content.append(bar,this.log,this.inputField)
    }
    append(text,className=""){
        if(!this.log){
            return
        }
        const line=CE("div",{className:`chat-line ${className}`},[])
        /* The prototype builds its lines with innerHTML, which would let
           anyone in the room inject markup into this page. Here the text goes
           in as TEXT, always: a chat room is untrusted input, and the only
           thing that changes is a CSS class we chose ourselves. */
        line.textContent=text
        this.log.appendChild(line)
        //stick to the bottom, the way a log reads
        this.log.scrollTop=this.log.scrollHeight
    }
    setStatus(text,connected){
        if(this.statusLabel){
            this.statusLabel.textContent=text
        }
        /* The node's own colour follows the connection, so the FIELD says the
           chat is down even when the chat window is hidden behind something
           else. */
        this.status=connected?"resolved":"floating"
    }
    connect(){
        const nick=this.parameters.nick.trim()
        if(!nick){
            /* No nick, no connection. Asking is better than posting as
               "Anonyme", which is what the server would default to: a room
               full of anonymes is a room where nobody can tell who said what. */
            this.setStatus("A nick is required",false)
            return
        }
        const url=this.effectiveUrl()
        let socket
        try{
            socket=new WebSocket(url)
        }catch(error){
            /* A malformed URL THROWS here rather than firing onerror, and an
               uncaught throw would leave the node claiming to be connecting to
               a URL that does not exist. */
            this.setStatus(`Cannot open ${url}`,false)
            return
        }
        this.socket=socket
        this.setStatus("Connecting...",false)
        socket.addEventListener("open",()=>{
            this.reconnectAttempt=0
            /* A named room is joined straight away; with no room, the server
               sends its list, which is exactly what an empty field asks for.
               Joining on open rather than on submit is what makes a restored
               session rejoin the room it was in. */
            if(this.parameters.room.trim()){
                this.transmit({type:"join_room",room:this.parameters.room.trim(),name:nick})
            }
        })
        socket.addEventListener("message",(event)=>{
            let data
            try{
                data=JSON.parse(event.data)
            }catch{
                //a server speaking another protocol is not a crash
                return
            }
            this.onServerMessage(data)
        })
        socket.addEventListener("close",()=>{
            this.socket=null
            this.setStatus("Disconnected",false)
            this.scheduleReconnect()
        })
        socket.addEventListener("error",()=>{
            /* `error` is ALWAYS followed by `close`, so the retry is scheduled
               there. Handling it here as well would double the attempts and
               make the backoff mean nothing. */
            this.setStatus("Connection failed",false)
        })
    }
    /* The backoff lives here rather than inside the socket, because a server
       that REFUSES every connection still fires `close`. With no schedule of
       its own, one refused connection leaves the node dead until a reload. */
    scheduleReconnect(){
        if(this.reconnectTimer||this.reconnectAttempt>=this.maxReconnectAttempts){
            return
        }
        const delay=Math.min(1000*2**this.reconnectAttempt,30000)+Math.random()*1000
        this.reconnectAttempt++
        this.setStatus(
            `Reconnecting in ${Math.round(delay/1000)}s (${this.reconnectAttempt}/${this.maxReconnectAttempts})`,
            false
        )
        this.reconnectTimer=setTimeout(()=>{
            this.reconnectTimer=null
            this.connect()
        },delay)
    }
    onServerMessage(data){
        if(data.type==="rooms"){
            this.renderRoomList(data.rooms??[])
            return
        }
        if(data.type==="room_created"){
            this.parameters.room=data.room
            this.transmit({type:"join_room",room:data.room,name:this.parameters.nick.trim()})
            return
        }
        if(data.type==="room_joined"){
            this.parameters.room=data.room
            this.log?.replaceChildren()
            for(const message of data.messages??[]){
                this.append(`${message.user} : ${message.text}`)
            }
            this.setStatus(`#${data.room}`,true)
            return
        }
        if(data.type==="users"){
            this.setStatus(`#${this.parameters.room} — ${(data.users??[]).length} connected`,true)
            return
        }
        if(data.type==="message"){
            this.append(`${data.message.user} : ${data.message.text}`)
            return
        }
        if(data.type==="system"){
            this.append(data.text,"system")
            return
        }
        if(data.type==="error"){
            /* The server's own complaints go in the log: it is the only way a
               user learns that their nick was taken or the room is full. */
            this.append(data.text,"system")
        }
    }
    renderRoomList(rooms){
        if(this.parameters.room.trim()||rooms.length===0){
            return
        }
        /* Only while there is no room yet: once one is joined, the panel is a
           conversation, not a directory. */
        const list=CE("div",{className:"chat-rooms"},[])
        for(const room of rooms){
            const button=CE("button",{type:"button"},[
                `#${room.name} — ${room.users} connected`
            ])
            button.addEventListener("click",()=>{
                this.parameters.room=room.id
                this.transmit({type:"join_room",room:room.id,name:this.parameters.nick.trim()})
            })
            list.appendChild(button)
        }
        this.log?.replaceChildren(list)
    }
    /* The one place a frame is written, so the "am I connected" test cannot be
       forgotten at one call site and honoured at another. */
    transmit(payload){
        if(!this.socket||this.socket.readyState!==WebSocket.OPEN){
            this.append("Not connected.","system")
            return false
        }
        this.socket.send(JSON.stringify(payload))
        return true
    }
    send(){
        const text=this.inputField.value.trim()
        if(!text){
            return
        }
        if(this.transmit({type:"message",text})){
            /* Cleared ONLY on a successful send: wiping the box on a dead
               socket would throw away what the user just typed. */
            this.inputField.value=""
        }
    }
    disconnect(){
        if(this.reconnectTimer){
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer=null
        }
        if(this.socket){
            /* close(), not a terminate: the server needs the close frame to
               drop the user from its room list and to tell everyone else. */
            this.socket.close()
            this.socket=null
        }
    }
    serializeState(){
        /* Only the three fields the user typed. The socket, the log and the
           retry counter belong to THIS visit: storing them would make the
           session file large, unserialisable, and meaningless on reload. */
        return {
            url:this.parameters.url,
            nick:this.parameters.nick,
            room:this.parameters.room
        }
    }
    restoreState(state){
        if(!state){
            return
        }
        this.parameters.url=state.url??""
        this.parameters.nick=state.nick??""
        this.parameters.room=state.room??""
        /* The chat is NOT reopened on a reload: a page that starts talking to a
           server on its own is a page that cannot be opened quietly. The node
           returns with its room and nick filled in, and the user presses
           Join — which is also the only moment a nick is really theirs. */
        this.status="floating"
    }
    suicide(options={}){
        /* The pending retry MUST be cleared: a node deleted with a reconnect
           scheduled would come back as a socket nobody can see or close. */
        this.disconnect()
        this.dialog?.suicide()
        super.suicide(options)
    }
}


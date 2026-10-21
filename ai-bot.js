/* AItributor: the Ollama brain behind a chat room.

   It used to be a whole process of its own that dialled the chat server as a
   client. That shape only works for ONE shared room: a private 1-to-1 room is
   spawned and killed as the user comes and goes, and a process per room would
   mean forking, IPC and reaping for something that is two objects and a fetch.

   So the bot is now a plain instance living inside the chat server: one for the
   public "ai" room, one per private room. `ask()` is the whole interface.

   State: Ollama's /api/chat is stateless — the conversation lives HERE, in
   `history`, and is resent on every call. That is what makes several rooms share
   one loaded model without them bleeding into each other, and it is why nothing
   has to be told to Ollama that a room exists.

   Documentation mode: when enabled, every question is searched against the
   Attributor FRONTPAGE. If nothing matches (coverage < threshold), the bot
   refuses to answer rather than hallucinate. When chunks match, they are injected
   as the ONLY source the model may use. */

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434/api/chat";
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || "qwen2.5-coder:3b";
const BOT_NAME = process.env.AI_BOT_NAME || "AItributor";

const { search, context } = require("./knowledge.js");

/* One model serves many rooms, but Ollama only runs OLLAMA_NUM_PARALLEL
   requests at a time (4 by default) and queues the rest. The queue below is
   PER BOT, so a busy public room can never make a private room wait behind it
   for longer than a single generation. */
const DEFAULT_TIMEOUT = 120000;
const MAX_HISTORY_MESSAGES = 40;

const DEFAULT_SYSTEM_PROMPT = `Tu es ${BOT_NAME}, un assistant IA spécialisé dans le code et le développement.
Tu réponds de manière concise et utile, en français.
Tu es dans un salon de chat, réponds naturellement sans trop de formatage.`;

const DOC_SYSTEM_PROMPT = `Tu es ${BOT_NAME}, l'assistant de la documentation Attributor.
Tu as accès aux extraits de documentation ci-dessous pour répondre aux questions sur Attributor.
Utilise cette documentation comme source PRINCIPALE pour les questions sur Attributor (nœuds, paramètres, workflows, etc.).
Si la documentation ne couvre PAS le point, tu PEUX répondre à partir de tes connaissances générales, mais indique-le clairement.
Ne complète jamais, n'invente jamais un paramètre, un nœud ou une fonctionnalité Attributor qui n'est pas écrit dans les extraits.
Réponds dans la langue de la question. Garde les identifiants de nœuds, noms de paramètres et noms de menus tels quels.`;

const RELAXED_DOC_SYSTEM_PROMPT = `Tu es ${BOT_NAME}, un assistant IA pour Attributor et le développement en général.
Tu as accès à la documentation Attributor (extraits ci-dessous) ET à tes connaissances générales.
Pour les questions sur Attributor : privilégie la documentation fournie. Si elle ne couvre pas le point, complète avec tes connaissances en le signalant.
Pour les autres sujets (code, science, général) : réponds normalement avec tes connaissances.
Sois concis, utile, et réponds en français.`;

class AiBot {
    constructor({name=BOT_NAME,model=DEFAULT_MODEL,systemPrompt=DEFAULT_SYSTEM_PROMPT,timeout=DEFAULT_TIMEOUT,useDocs=false,strictDocs=false}={}){
        this.name=name
        this.model=model
        this.baseSystemPrompt=systemPrompt
        this.timeout=timeout
        this.useDocs=useDocs
        this.strictDocs=strictDocs
        this.history=[]
        /* Serialises this bot's own calls. Two messages typed in the same
           second must not produce two answers racing to be appended in the
           order they finished rather than the order they were asked. */
        this.queue=Promise.resolve()
        this.destroyed=false
    }
    /* The conversation as Ollama wants it, trimmed so a long chat cannot grow
       the prompt until the context window overflows. */
    ollamaMessages(){
        let sys
        if(this.useDocs){
            sys = this.strictDocs ? DOC_SYSTEM_PROMPT : RELAXED_DOC_SYSTEM_PROMPT
        }else{
            sys = this.baseSystemPrompt
        }
        return [
            {role:"system",content:sys},
            ...this.history.slice(-MAX_HISTORY_MESSAGES)
        ]
    }
    /* Ask the model something. Resolves with { answer, sources } or null if
       the bot was killed while the request was in flight. */
    async ask(text){
        const question=String(text||"").trim()
        if(!question||this.destroyed){
            return { answer: null, sources: null }
        }
        let docContext = null;
        let sources = null;
        let docsFound = false;
        if(this.useDocs){
            const results = search(question);
            if(results){
                docsFound = true;
                docContext = context(results, question);
                sources = results.map(r => ({
                    node: r.chunk.node,
                    title: r.chunk.title,
                    anchor: r.chunk.anchor,
                    coverage: Math.round(r.coverage * 100)
                }));
            }
        }
        let finalQuestion
        if(docContext){
            finalQuestion = `${docContext}\n\nQuestion : ${question}`
        }else if(this.useDocs && this.strictDocs){
            // Strict mode: refuse if no docs match
            return { answer: "La documentation Attributor ne couvre pas ce point.", sources: null };
        }else{
            // Relaxed mode or no docs mode: just ask the question
            finalQuestion = question
        }
        /* The queue is chained, not awaited in a loop: several messages can be
           waiting and each still resolves with its own answer. */
        const run=this.queue.then(()=>this.callOllama(finalQuestion))
        this.queue=run.catch(()=>null)
        const answer = await run;
        return { answer, sources };
    }
    async callOllama(question){
        this.history.push({role:"user",content:question})
        const controller=new AbortController()
        const timer=setTimeout(()=>controller.abort(),this.timeout)
        let answer=null
        try{
            const response=await fetch(OLLAMA_URL,{
                method:"POST",
                headers:{"Content-Type":"application/json"},
                signal:controller.signal,
                body:JSON.stringify({
                    model:this.model,
                    stream:false,
                    /* Keeping the model resident between questions is what makes
                       a private room answer in about a second instead of
                       reloading several gigabytes each time. */
                    keep_alive:"30m",
                    messages:this.ollamaMessages(),
                    options:{
                        temperature:0.3,
                        top_p:0.9,
                        num_predict:500
                    }
                })
            })
            if(!response.ok){
                throw new Error(`Ollama HTTP ${response.status}: ${await response.text()}`)
            }
            const data=await response.json()
            answer=(data.message?.content||data.response||"").trim()||null
            if(answer){
                this.history.push({role:"assistant",content:answer})
            }
        } finally {
            clearTimeout(timer)
        }
        if(this.destroyed){
            /* The room was closed while Ollama was thinking. The answer is
               dropped and the turn is rolled back, so a bot that is brought
               back for the same room does not replay a conversation nobody
               ever saw. */
            this.history.pop()
            return null
        }
        return answer
    }
    /* Put something in the bot's mouth without asking the model for it. The
       greeting is ours, but the conversation that follows must still know it
       happened, or the first user message answers a bot that has not said
       hello yet. */
    seed(text){
        if(this.destroyed||!text){
            return
        }
        this.history.push({role:"assistant",content:text})
    }
    /* Free the conversation. The model itself stays warm in Ollama's cache —
       unloading it would make the next private room pay the load again. */
    destroy(){
        this.destroyed=true
        this.history=[]
        this.queue=Promise.resolve()
    }
}

module.exports={AiBot,BOT_NAME,DEFAULT_SYSTEM_PROMPT,DOC_SYSTEM_PROMPT,RELAXED_DOC_SYSTEM_PROMPT,OLLAMA_URL}

// Importation des modules nécessaires
console.log(process.env)
const http = require('http');
const https = require('https')
const { exec , spawn } = require('child_process');
const path=require('path')
const fs=require("fs")

// Configuration du serveur HTTP
const hostname = '0.0.0.0';
const port = 443;
const SSLoptions={
    key:fs.readFileSync('/etc/letsencrypt/live/attributor.fr/privkey.pem'),
    cert:fs.readFileSync('/etc/letsencrypt/live/attributor.fr/fullchain.pem')
}

function splitBuffer(buffer, boundary) {
    const parts = [];
    let start = buffer.indexOf(boundary) + boundary.length + 2; // Skip the initial CRLF
    let end = buffer.indexOf(boundary, start);
    while (end !== -1) {
        parts.push(buffer.slice(start, end));
        start = end + boundary.length + 2; // Skip the boundary and CRLF
        end = buffer.indexOf(boundary, start);
    }
    return parts;
}

function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.wav': 'audio/wav',
        '.mp3': 'audio/mpeg',
        '.mp4': 'video/mp4',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ttf': 'font/ttf',
        '.eot': 'application/vnd.ms-fontobject',
        '.otf': 'font/otf',
        '.wasm': 'application/wasm'
    };
    return mimeTypes[ext] || 'application/octet-stream';
}

function serveStaticFileLimited(req, res) {
    const filePathMap = {
        '/': 'index.html',
        '/styles/main.css': 'styles/main.css',
        '/scripts/main.js': 'scripts/main.js',
        "/scripts/interface.js":"scripts/interface.js",
        "/scripts/util.js":"scripts/util.js",
        '/XOP/rust-extension/pkg/attribrustor.js':'XOP/rust-extension/pkg/attribrustor.js',
        '/XOP/rust-extension/pkg/attribrustor_bg.wasm':'XOP/rust-extension/pkg/attribrustor_bg.wasm',
        "/resources/config.js":"resources/config.js",
        "/scripts/formats.js":"scripts/formats.js",
        "/resources/pattern.svg":"resources/pattern.svg"
    }
    const filePath = filePathMap[req.url]
    console.log("This file is served by serveStaticFileLimited: ",req.url)
    if(filePath){
        fs.readFile(path.join(__dirname, filePath), (err, data) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('File not found');
            } else {
                const mimeType = getMimeType(filePath);
                res.writeHead(200, { 'Content-Type': mimeType });
                res.end(data);
            }
        });
    }
}

function serveStaticFile(req, res) {
    const filePath = req.url
    console.log("This file is served by serveStaticFile: ",req.url)
    if(req.url){
        fs.readFile(path.join(__dirname, filePath), (err, data) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('File not found');
            } else {
                const mimeType = getMimeType(filePath);
                res.writeHead(200, { 'Content-Type': mimeType });
                res.end(data);
            }
        });
    }
}

// Création du serveur HTTP
const server = https.createServer(SSLoptions,(req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); // Permettre les requêtes de n'importe quelle origine
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    if (req.method === 'GET') {
        console.log(req.url)
        if(req.url.match("/uploads/outputs")){
            serveStaticFile(req,res)
        }else{
            serveStaticFileLimited(req, res)
        }
    }else if(req.method === 'POST'){
        console.log(req.url)
        if(req.url.match("/uploads/outputs")){
            console.log("on est bien dans le Post avec l'url pour DL")
            serveStaticFile(req,res)
        }else if(req.headers['content-type'].includes('multipart/form-data')){
            let boundary=Buffer.from('--'+req.headers['content-type'].split('boundary=')[1])
            let chunks=[]
            req.on('data',chunk=>{chunks.push(chunk)})
            req.on('end',()=>{
                let body=Buffer.concat(chunks)
                let parts = splitBuffer(body,boundary)
                parts.forEach(part=>{
                    const headerEnd=part.indexOf('\r\n\r\n')
                    if(headerEnd !== -1){
                        const header = part.slice(0,headerEnd).toString()
                        const content=part.slice(headerEnd+4,part.length-2)
                        if(header.includes('Content-Disposition')){
                            const nameMatch=header.match(/name="([^"]+)"/)
                            const filenameMatch=header.match(/filename="([^"]+)"/)
                            const contentTypeMatch=header.match(/Content-Type: (.+)/)
                            if(filenameMatch && contentTypeMatch){
                                const fileName=filenameMatch[1]
                                const filePath=path.join(__dirname,'uploads',fileName)
                                fs.writeFileSync(filePath,content)//,{encoding:'binary'})
                                res.writeHead(201, { 'Content-Type': "text/html" })
                                res.write(`${fileName} is on the server waiting for msConvert.\r\n`)
                                const winePath = '/usr/bin/wine'; // Assurez-vous que c'est le chemin correct vers l'exécutable wine
                                const msconvertPath = path.join(__dirname, 'msConverter', 'msconvert.exe'); // Chemin absolu vers msconvert.exe
                                const inputFilePath = path.join(__dirname, 'uploads', fileName); // Chemin absolu vers le fichier d'entrée
                                const outputDirPath = path.join(__dirname, 'uploads', 'outputs'); // Chemin absolu vers le répertoire de sortie
                                // Arguments pour le processus spawn
                                const args = [msconvertPath, inputFilePath, '-o', outputDirPath, '--text'];
                                const child = spawn(winePath, args)
                                child.stdout.on('data', (data) => {
                                    console.log(`stdout: ${data}`);
                                });
                                child.stderr.on('data', (data) => {
                                    console.error(`stderr: ${data}`);
                                });
                                child.on('close', (code) => {
                                    console.log(`Child process exited with code ${code}`);
                                    if(code===0){
                                        const textFileName=fileName.replace(".raw",".txt")
                                        res.write(`${fileName} has been correctly converted and is ready for download.`)
                                        res.end(textFileName)
                                    }else{
                                        res.write(`${fileName} has NOT been correctly converted.`)
                                        res.end()
                                    }
                                })
                            }
                        }
                    }
                    
                })
            })
        }else if(true){
            fs.readFile("test.txt", (err, data) => {
                console.log(err,data)
                if (err) {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('File not found');
                } else {
                    res.writeHead(200, { 'Content-Type': "text/html" });
                    res.end(data);
                }
            })
        }else{
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/plain');
            res.end(`Oui c'est une requete POST !!!`);
        }
    } else {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'text/plain');
        res.end('Unauthorize command.\n');
    }
});

// Démarre le serveur
server.listen(port, hostname, () => {
    console.log(`Server started at https://${hostname}:${port}/`);
});

//http redirection by creating another server
const httpServer=http.createServer((req,res)=>{
    res.writeHead(301,{"Location":`https://${req.headers.host}${req.url}`})
    res.end()
})

httpServer.listen(80,hostname,()=>{
    console.log('HTTP Server is running on port 80 and redirecting to HTTPS')
})
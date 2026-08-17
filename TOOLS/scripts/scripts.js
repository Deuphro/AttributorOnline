const disclaimer=document.createElement('p')
disclaimer.innerText="Data Collected\nWhen using the service, certain technical data may be automatically collected, including your IP address, for security, diagnostic, and proper service operation purposes.\nThis data is not used for commercial purposes and is not shared with third parties.\n"
document.body.appendChild(disclaimer)


const msC2Att=document.createElement('div')
msC2Att.innerHTML="<h1>msConverter text to Attributor text (simple spectrum)</h1>"
document.body.appendChild(msC2Att)
const dropzone=document.createElement('div')
dropzone.innerHTML="Drop .txt file·s here"
dropzone.classList.add("dropzone")
msC2Att.appendChild(dropzone)
const outzone=document.createElement("div")
outzone.classList.add("outzone")
outzone.innerHTML="<h2>Retrieve files here</h2>"
msC2Att.appendChild(outzone)
const output=document.createElement('ul')
outzone.appendChild(output)

// Placeholder de transformation
function processFile(text) {
    // TODO: remplacer par ta logique
    const regex=/^\s*binary:\s*\[\d+\]\s+((?:\d+\.?\d*\s*)+)/gm
    const matches=[...text.matchAll(regex)]
    const floatSeries = matches.map(match => match[1].trim());
    const mass=floatSeries[0].split(" ")
    const intensity=floatSeries[1].split(" ")
    let res=""
    for(let k in mass){
        res+=mass[k]+"\t"+intensity[k]+"\n"
    }
    return res;
}

dropzone.addEventListener("dragover", e => {
    e.preventDefault();
    dropzone.classList.add("dragover");
});

dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("dragover");
});

dropzone.addEventListener("drop", e => {
    e.preventDefault();
    dropzone.classList.remove("dragover");

    const files = e.dataTransfer.files;

    for (const file of files) {
        if (!file.name.endsWith(".txt")) continue;

        const reader = new FileReader();
        reader.onload = () => {
            const processedText = processFile(reader.result);

            const blob = new Blob([processedText], { type: "text/plain" });
            const url = URL.createObjectURL(blob);

            const li = document.createElement("li");
            const link = document.createElement("a");

            link.href = url;
            link.download = "processed_" + file.name;
            link.textContent = link.download;

            li.appendChild(link);
            output.appendChild(li);
        };

        reader.readAsText(file);
    }
});
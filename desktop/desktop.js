// main.js

const { app, BrowserWindow,screen } = require('electron');

function createWindow() {
  // Crée une fenêtre de navigateur.
  const {width,height}=screen.getPrimaryDisplay().workAreaSize
  const mainWindow = new BrowserWindow({
    width: width,
    height: height,
    webPreferences: {
      nodeIntegration: true
    }
  });

  // Charge le fichier index.html.
  mainWindow.loadFile('../index.html');
  mainWindow.setMenu(null)

  // Ouvre les DevTools.
  //mainWindow.webContents.openDevTools();
}

// Cet événement sera déclenché lorsque Electron aura terminé
// l'initialisation et est prêt à créer des fenêtres de navigateur.
app.on('ready', createWindow);

// Quitte l'application lorsque toutes les fenêtres sont fermées.
app.on('window-all-closed', () => {
  // Sur macOS, il est courant pour les applications et leur barre de menu
  // de rester actives jusqu'à ce que l'utilisateur quitte explicitement avec Cmd + Q.
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // Sur macOS, il est courant de recréer une fenêtre dans l'application
  // lorsque l'icône du dock est cliquée et qu'il n'y a pas d'autres fenêtres ouvertes.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

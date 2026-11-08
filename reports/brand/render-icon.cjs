const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

app.setPath('userData', path.resolve(__dirname, '../../frontend/desktop/out/icon-render-cache'));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, offscreen: true } });
  try {
    await window.loadURL('data:text/html,<html></html>');
    for (const name of ['utrainerbuddy-icon', 'utrainerbuddy-mark']) {
      const svg = await fs.readFile(path.join(__dirname, `${name}.svg`));
      const uri = `data:image/svg+xml;base64,${svg.toString('base64')}`;
      const sizes = await window.webContents.executeJavaScript(`(async () => {
        const image = new Image();
        image.src = ${JSON.stringify(uri)};
        await image.decode();
        return [1024,512,256,128,64,48,32,24,16].map(size => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = size;
          canvas.getContext('2d').drawImage(image,0,0,size,size);
          return {size, data: canvas.toDataURL('image/png').split(',')[1]};
        });
      })()`);
      for (const item of sizes) {
        await fs.writeFile(path.join(__dirname, `${name}-${item.size}.png`), Buffer.from(item.data, 'base64'));
      }
    }
    console.log('Rendered both SVGs at nine sizes.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});

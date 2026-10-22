// Renders resources/icon.png (512px) with Electron's own Chromium. Run: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('fs')
const { join } = require('path')
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 512, height: 512, transparent: true, frame: false, webPreferences: { offscreen: true } })
  const html = `<body style="margin:0;background:transparent"><canvas id=c width=512 height=512></canvas><script>
  const c=document.getElementById('c').getContext('2d');const A=[56,214,255];const rgba=(a)=>'rgba('+A[0]+','+A[1]+','+A[2]+','+a+')';
  c.beginPath();c.roundRect(16,16,480,480,110);const bg=c.createRadialGradient(256,200,20,256,256,360);bg.addColorStop(0,'#0e2236');bg.addColorStop(1,'#04080d');c.fillStyle=bg;c.fill();
  c.lineWidth=3;c.strokeStyle=rgba(.45);c.stroke();
  c.save();c.translate(256,256);
  const g=c.createRadialGradient(0,0,10,0,0,230);g.addColorStop(0,rgba(.55));g.addColorStop(.5,rgba(.12));g.addColorStop(1,rgba(0));c.fillStyle=g;c.fillRect(-256,-256,512,512);
  c.lineCap='round';
  [[200,10,3,0.9],[160,8,7,0.7],[108,16,4,0.9]].forEach(([r,w,n,al],k)=>{c.lineWidth=w;for(let i=0;i<n;i++){const s=Math.PI*2/n;c.strokeStyle=rgba(al);c.beginPath();c.arc(0,0,r,i*s+.2+k*.4,(i+1)*s-.2+k*.4);c.stroke();}});
  for(let i=0;i<72;i++){const a=i/72*Math.PI*2;const l=(i%6==0)?26:14;c.strokeStyle=rgba(.5);c.lineWidth=3;c.beginPath();c.moveTo(Math.cos(a)*226,Math.sin(a)*226);c.lineTo(Math.cos(a)*(226-l*.6),Math.sin(a)*(226-l*.6));c.stroke();}
  const cg=c.createRadialGradient(0,0,0,0,0,90);cg.addColorStop(0,'rgba(255,255,255,1)');cg.addColorStop(.4,rgba(.95));cg.addColorStop(1,rgba(0));c.fillStyle=cg;c.beginPath();c.arc(0,0,90,0,7);c.fill();
  c.lineWidth=4;c.strokeStyle='rgba(255,255,255,.8)';c.beginPath();c.arc(0,0,46,0,7);c.stroke();
  c.restore();</script></body>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 600))
  const img = await win.webContents.capturePage()
  writeFileSync(join(__dirname, '..', 'resources', 'icon.png'), img.toPNG())
  console.log('icon written', img.getSize())
  app.quit()
})

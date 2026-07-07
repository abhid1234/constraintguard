const puppeteer = require('puppeteer-core');
const path = require('path');

const CHROME = '/Users/abhijitdas/.cache/puppeteer/chrome/mac_arm-143.0.7499.169/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const FPS = 30, DUR = 67, N = FPS * DUR;
const FILE = 'file://' + path.resolve(__dirname, 'launch-video.html');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: ['--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=1', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.goto(FILE, { waitUntil: 'networkidle0' });
  const t0 = Date.now();
  for (let f = 0; f < N; f++) {
    const t = f / FPS;
    await page.evaluate((t) => window.render(t), t);
    await page.screenshot({ path: path.join(__dirname, 'frames', `f${String(f).padStart(4, '0')}.png`) });
    if (f % 60 === 0) console.log(`  frame ${f}/${N}  (${((Date.now()-t0)/1000).toFixed(0)}s)`);
  }
  await browser.close();
  console.log(`  done: ${N} frames in ${((Date.now()-t0)/1000).toFixed(0)}s`);
})();

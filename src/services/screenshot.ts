import puppeteer from 'puppeteer';

export async function takeScreenshot(url: string): Promise<Buffer> {
  console.log(`📸 Taking screenshot of ${url}...`);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 630 });
    // Use 'domcontentloaded' instead of 'networkidle2' — 3D apps load GLB models
    // from CDNs (poly.pizza etc.) which can trickle in and keep the network busy
    // well past the 30s timeout. The settle time below handles asset loading.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Settle time for React hydration, 3D scene loading, and WebGL rendering.
    // Three.js / WebGL apps need time to load models and render frames.
    await new Promise((r) => setTimeout(r, 5000));

    const screenshot = await page.screenshot({ type: 'png' });
    console.log(`✅ Screenshot taken (${(screenshot as Buffer).length} bytes)`);
    return screenshot as Buffer;
  } finally {
    await browser.close();
  }
}

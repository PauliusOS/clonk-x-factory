import fs from 'fs';
import path from 'path';

// Load the logo at startup and convert to base64 data URI
const logoPath = path.join(process.cwd(), 'public', 'clonk.webp');
const logoBase64 = fs.readFileSync(logoPath).toString('base64');
const logoDataUri = `data:image/webp;base64,${logoBase64}`;

function buildBadgeScript(): string {
  return `
<script>
(function() {
  var d = document, b = d.createElement('a');
  b.href = 'https://vibed.inc';
  b.target = '_blank';
  b.rel = 'noopener noreferrer';
  b.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:99999;display:flex;align-items:center;gap:8px;padding:8px 14px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.08);text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;font-size:13px;color:#374151;transition:box-shadow 0.2s,border-color 0.2s;cursor:pointer;';
  b.onmouseenter = function() { b.style.boxShadow = '0 2px 8px rgba(0,0,0,0.12)'; b.style.borderColor = '#d1d5db'; };
  b.onmouseleave = function() { b.style.boxShadow = '0 1px 3px rgba(0,0,0,0.08)'; b.style.borderColor = '#e5e7eb'; };
  var img = d.createElement('img');
  img.src = '${logoDataUri}';
  img.style.cssText = 'width:18px;height:18px;border-radius:4px;flex-shrink:0;';
  img.alt = 'vibed.inc';
  var t = d.createElement('span');
  t.textContent = 'keep building on vibed.inc';
  t.style.cssText = 'white-space:nowrap;font-weight:500;';
  b.appendChild(img);
  b.appendChild(t);
  d.body.appendChild(b);
})();
</script>`;
}

/**
 * Injects a floating "keep building on vibed.inc" badge into the app's index.html.
 * Reads clonk.webp from public/ and embeds it as a webp data URI directly in the script.
 * Modifies the files array in-place.
 */
export function injectVibedBadge(files: { path: string; content: string }[]): void {
  const indexFile = files.find((f) => f.path === 'index.html');
  if (!indexFile) {
    console.warn('⚠️ No index.html found — skipping badge injection');
    return;
  }

  const badgeScript = buildBadgeScript();

  if (indexFile.content.includes('</body>')) {
    indexFile.content = indexFile.content.replace('</body>', `${badgeScript}\n</body>`);
  } else {
    indexFile.content += badgeScript;
  }

  console.log('🏷️ Injected vibed.inc badge into index.html');
}

const BADGE_LOGO_BASE64 = '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';

const BADGE_SCRIPT = `
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
  img.src = 'data:image/png;base64,${BADGE_LOGO_BASE64}';
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

/**
 * Injects a floating "keep building on vibed.inc" badge into the app's index.html.
 * Modifies the files array in-place by appending the badge script before </body>.
 */
export function injectVibedBadge(files: { path: string; content: string }[]): void {
  const indexFile = files.find((f) => f.path === 'index.html');
  if (!indexFile) {
    console.warn('⚠️ No index.html found — skipping badge injection');
    return;
  }

  if (indexFile.content.includes('</body>')) {
    indexFile.content = indexFile.content.replace('</body>', `${BADGE_SCRIPT}\n</body>`);
  } else {
    // Fallback: append to end
    indexFile.content += BADGE_SCRIPT;
  }

  console.log('🏷️ Injected vibed.inc badge into index.html');
}

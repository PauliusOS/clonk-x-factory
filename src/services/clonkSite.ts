// Publishes deployed app entries to the clonk.ai gallery via Convex HTTP action
interface AppEntry {
  appName: string;
  description: string;
  vercelUrl: string;
  githubUrl: string;
  username: string;
  template: 'react' | 'convex' | 'threejs';
  screenshot?: Buffer;
}

export async function publishToClonkSite(entry: AppEntry): Promise<string | null> {
  const apiUrl = process.env.CLONK_SITE_API_URL;
  const apiKey = process.env.CLONK_SITE_API_KEY;
  if (!apiUrl || !apiKey) {
    console.log('⏭️ Skipping clonk.ai publish (CLONK_SITE_API_URL or CLONK_SITE_API_KEY not set)');
    return null;
  }

  const params = new URLSearchParams({
    appName: entry.appName,
    description: entry.description,
    vercelUrl: entry.vercelUrl,
    githubUrl: entry.githubUrl,
    username: entry.username,
    template: entry.template,
  });

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
  };

  let body: Buffer | null = null;
  if (entry.screenshot && entry.screenshot.length > 0) {
    headers['Content-Type'] = 'image/png';
    body = entry.screenshot;
  }

  const res = await fetch(`${apiUrl}/api/publish?${params}`, {
    method: 'POST',
    headers,
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Clonk site API returned ${res.status}: ${text}`);
  }

  const { pageUrl } = await res.json() as { pageUrl?: string };
  return pageUrl ?? null;
}

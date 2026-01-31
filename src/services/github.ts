import axios from 'axios';

const GITHUB_API = 'https://api.github.com';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

export async function createGitHubRepo(
  appName: string,
  description: string,
  files: { path: string; content: string }[]
): Promise<string> {
  console.log(`📦 Creating GitHub repo: ${appName}`);

  // Create repository
  const repoResponse = await axios.post(
    `${GITHUB_API}/user/repos`,
    {
      name: appName,
      description: description,
      public: true,
      auto_init: false,
    },
    {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
      },
    }
  );

  const repoFullName = repoResponse.data.full_name;
  const repoUrl = repoResponse.data.html_url;

  console.log(`✅ Created repo: ${repoUrl}`);

  // Upload files
  console.log(`📝 Uploading ${files.length} files...`);

  for (const file of files) {
    try {
      await axios.put(
        `${GITHUB_API}/repos/${repoFullName}/contents/${file.path}`,
        {
          message: `Add ${file.path}`,
          content: Buffer.from(file.content).toString('base64'),
        },
        {
          headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
          },
        }
      );
      console.log(`  ✓ Uploaded ${file.path}`);
    } catch (error: any) {
      const msg = error.response
        ? `${error.response.status} ${error.response.statusText || ''}`
        : error.message;
      console.error(`  ✗ Failed to upload ${file.path}: ${msg}`);
    }
  }

  console.log(`✅ All files uploaded to ${repoUrl}`);
  return repoUrl;
}

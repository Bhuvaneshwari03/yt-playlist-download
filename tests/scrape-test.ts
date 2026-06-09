import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs-extra';

async function runTest() {
  const scraperPath = path.join(process.cwd(), 'scraper', 'index.ts');
  const testUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'; // Rick Astley - Never Gonna Give You Up
  const type = 'video';

  console.log('Running test for single video scraper...');

  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', `"${scraperPath}"`, `"${testUrl}"`, `"${type}"`], {
      shell: true,
      env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true' }
    });

    child.stdout.on('data', (data) => {
      console.log(`STDOUT: ${data}`);
    });

    child.stderr.on('data', (data) => {
      console.error(`STDERR: ${data}`);
    });

    child.on('close', async (code) => {
      if (code === 0) {
        console.log('Scraper test finished successfully.');
        
        // Verify if data was created
        const dataDir = path.join(process.cwd(), 'data');
        const files = await fs.readdir(dataDir);
        if (files.length > 0) {
          console.log(`Success: Found ${files.length} files in data/ directory.`);
          const latestFile = files.sort().reverse()[0];
          const content = await fs.readJson(path.join(dataDir, latestFile));
          console.log('Latest file content:', JSON.stringify(content, null, 2));
          resolve(true);
        } else {
          console.error('Failure: No files found in data/ directory.');
          reject('No files created');
        }
      } else {
        console.error(`Scraper test failed with code ${code}`);
        reject(`Failed with code ${code}`);
      }
    });
  });
}

runTest().catch(console.error);

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs-extra';

async function runPlaylistTest() {
  const scraperPath = path.join(process.cwd(), 'scraper', 'index.ts');
  const testUrl = 'https://youtube.com/playlist?list=PLC3y8-rFHvwgg3vaYJgHGnModB54rxOk3'; // React Redux Tutorial by Codevolution (120+ videos)
  const type = 'playlist';

  console.log('Running test for playlist scraper on: ' + testUrl);

  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', `"${scraperPath}"`, `"${testUrl}"`, `"${type}"`], {
      shell: true,
      env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true' }
    });

    child.stdout.on('data', (data) => {
      const line = data.toString();
      // Only print important scraper logs so stdout is clean
      if (line.includes('Scroll round') || line.includes('Scraping') || line.includes('Successfully') || line.includes('Warning') || line.includes('Ending scroll loop')) {
        console.log(`SCRAPER LOG: ${line.trim()}`);
      }
    });

    child.stderr.on('data', (data) => {
      console.error(`SCRAPER STDERR: ${data.toString().trim()}`);
    });

    child.on('close', async (code) => {
      if (code === 0) {
        console.log('Playlist scraper test finished successfully.');
        
        // Verify data
        const dataDir = path.join(process.cwd(), 'data');
        const files = await fs.readdir(dataDir);
        if (files.length > 0) {
          const latestFile = files.sort().reverse()[0];
          const content = await fs.readJson(path.join(dataDir, latestFile));
          console.log(`Verification: Scraped ${content.length} videos.`);
          if (content.length > 100) {
            console.log('SUCCESS: Successfully loaded more than 100 videos! Total count = ' + content.length);
            // Print a sample of items to check names
            console.log('First 5 items:', JSON.stringify(content.slice(0, 5), null, 2));
            console.log('Last 5 items:', JSON.stringify(content.slice(-5), null, 2));
            resolve(true);
          } else {
            console.error('FAILURE: Capped at ' + content.length + ' videos (should be >100).');
            reject('Capped at 100 or less');
          }
        } else {
          console.error('Failure: No files found in data/ directory.');
          reject('No files created');
        }
      } else {
        console.error(`Playlist scraper test failed with code ${code}`);
        reject(`Failed with code ${code}`);
      }
    });
  });
}

runPlaylistTest().catch(console.error);

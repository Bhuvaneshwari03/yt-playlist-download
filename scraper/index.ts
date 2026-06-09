import puppeteer from 'puppeteer';
import fs from 'fs-extra';
import path from 'path';

const url = process.argv[2];
const type = process.argv[3]; // 'playlist' or 'video'

if (!url) {
  console.error('URL is required');
  process.exit(1);
}

async function getChromePath() {
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  ];

  for (const p of paths) {
    if (await fs.pathExists(p)) {
      return p;
    }
  }
  return null;
}

async function scrape() {
  const executablePath = await getChromePath();
  if (!executablePath) {
    console.error('Chrome not found. Please install Google Chrome or update the paths in scraper/index.ts');
    process.exit(1);
  }

  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    executablePath,
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized'],
  });

  const [page] = await browser.pages();

  try {
    console.log(`Navigating to: ${url}`);
    
    // Set a realistic user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    await page.goto(url, { waitUntil: 'load', timeout: 60000 }).catch(e => console.log('Navigation warning:', e.message));

    // Wait for the page to stabilize
    await new Promise(resolve => setTimeout(resolve, 3000));

    let videoLinks: { url: string; status: boolean }[] = [];

    if (type === 'playlist') {
      console.log('Scraping playlist mode...');
      
      // Wait for playlist items specifically
      try {
        await page.waitForSelector('ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer', { timeout: 15000 });
      } catch (e) {
        console.log('Warning: Standard playlist selectors not found, attempting general extraction.');
      }

      // Extract all video links found in the playlist area
      const links = await page.evaluate(() => {
        // Look for links that contain "watch?v=" and are inside the playlist container
        const anchors = document.querySelectorAll('ytd-playlist-video-renderer a#video-title, ytd-playlist-panel-video-renderer a.ytd-playlist-panel-video-renderer, a#video-title');
        const urls = Array.from(anchors).map(a => (a as HTMLAnchorElement).href);
        return [...new Set(urls)].filter(link => link && link.includes('watch?v='));
      });

      videoLinks = links.map(link => ({
        // Clean URL to remove playlist noise for individual links
        url: link.split('&list=')[0].split('&pp=')[0].split('&index=')[0], 
        status: true
      }));

      if (videoLinks.length === 0) {
        console.log('No playlist items found with specific selectors. Trying fallback...');
        const fallbackLinks = await page.evaluate(() => {
          const allLinks = Array.from(document.querySelectorAll('a')).map(a => a.href);
          return [...new Set(allLinks)].filter(l => l.includes('watch?v=') && (l.includes('list=') || l.includes('index=')));
        });
        videoLinks = fallbackLinks.map(link => ({
          url: link.split('&list=')[0].split('&pp=')[0].split('&index=')[0],
          status: true
        }));
      }
    } else {
      console.log('Scraping single video mode...');
      // In single video mode, we only want the primary URL, cleaned of playlist parameters
      const cleanUrl = url.split('&list=')[0].split('&pp=')[0].split('&index=')[0];
      videoLinks = [{
        url: cleanUrl,
        status: true
      }];
    }

    if (videoLinks.length === 0) {
      throw new Error('No video links found for the selected mode.');
    }

    const timestamp = new Date().getTime();
    const fileName = `scrape_${timestamp}.json`;
    const filePath = path.join(process.cwd(), 'data', fileName);

    await fs.ensureDir(path.join(process.cwd(), 'data'));
    await fs.writeJson(filePath, videoLinks, { spaces: 2 });

    console.log(`Successfully scraped ${videoLinks.length} videos in ${type} mode.`);
    console.log(`Data saved to: ${filePath}`);

  } catch (error: any) {
    console.error('Scraping failed:', error.message || error);
    process.exit(1);
  } finally {
    console.log('Closing browser in 3 seconds...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    await browser.close().catch(() => {});
  }
}

scrape().catch(err => {
  console.error('Fatal Error:', err);
  process.exit(1);
});

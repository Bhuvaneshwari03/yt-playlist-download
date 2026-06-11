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

    let videoLinks: { name: string; url: string; status: boolean }[] = [];

    if (type === 'playlist') {
      console.log('Scraping playlist mode...');
      
      // Wait for playlist items specifically
      try {
        await page.waitForSelector('ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer', { timeout: 15000 });
      } catch (e) {
        console.log('Warning: Standard playlist selectors not found, attempting general extraction.');
      }

      // Extract all video links and names found in the playlist area
      const items = await page.evaluate(() => {
        const anchors = document.querySelectorAll('ytd-playlist-video-renderer a#video-title, ytd-playlist-panel-video-renderer a.ytd-playlist-panel-video-renderer, a#video-title');
        const seen = new Set<string>();
        return Array.from(anchors).reduce((acc: { url: string; name: string }[], a) => {
          const href = (a as HTMLAnchorElement).href;
          const name = (a as HTMLElement).title || (a as HTMLElement).innerText.trim();
          if (href && href.includes('watch?v=') && !seen.has(href)) {
            seen.add(href);
            acc.push({ url: href, name });
          }
          return acc;
        }, []);
      });

      videoLinks = items.map(item => ({
        name: item.name || 'Unknown',
        url: item.url.split('&list=')[0].split('&pp=')[0].split('&index=')[0],
        status: false
      }));

      if (videoLinks.length === 0) {
        console.log('No playlist items found with specific selectors. Trying fallback...');
        const fallbackItems = await page.evaluate(() => {
          const allLinks = Array.from(document.querySelectorAll('a'));
          const seen = new Set<string>();
          return allLinks.reduce((acc: { url: string; name: string }[], a) => {
            const href = a.href;
            const name = a.title || a.innerText.trim();
            if (href.includes('watch?v=') && (href.includes('list=') || href.includes('index=')) && !seen.has(href)) {
              seen.add(href);
              acc.push({ url: href, name });
            }
            return acc;
          }, []);
        });
        videoLinks = fallbackItems.map(item => ({
          name: item.name || 'Unknown',
          url: item.url.split('&list=')[0].split('&pp=')[0].split('&index=')[0],
          status: false
        }));
      }
    } else {
      console.log('Scraping single video mode...');
      const cleanUrl = url.split('&list=')[0].split('&pp=')[0].split('&index=')[0];
      const pageTitle = await page.title();
      const videoName = pageTitle.replace(' - YouTube', '');
      videoLinks = [{
        name: videoName || 'Unknown',
        url: cleanUrl,
        status: false
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
    console.log(`__FILE__:${fileName}`);

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

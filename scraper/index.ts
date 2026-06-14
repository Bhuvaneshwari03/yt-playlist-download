import { chromium } from 'playwright';
import fs from 'fs-extra';
import path from 'path';

const url = process.argv[2];
const type = process.argv[3]; // 'playlist' or 'video'

let targetListId: string | null = null;
try {
  const parsedUrl = new URL(url);
  targetListId = parsedUrl.searchParams.get('list');
} catch { }

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
  const browser = await chromium.launch({
    executablePath,
    headless: false,
    args: ['--start-maximized'],
  });

  const context = await browser.newContext({
    viewport: null,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    console.log(`Navigating to: ${url}`);

    await page.goto(url, { waitUntil: 'load', timeout: 60000 }).catch(e => console.log('Navigation warning:', e.message));

    // Wait for the page to stabilize
    await new Promise(resolve => setTimeout(resolve, 3000));

    let videoLinks: { name: string; url: string; status: boolean }[] = [];

    if (type === 'playlist' || url.includes('/playlist?') || (url.includes('list=') && !url.includes('watch?v='))) {
      console.log('Scraping playlist mode...');
      const isPlaylistOnly = url.includes('/playlist?') || (url.includes('list=') && !url.includes('watch?v='));

      // Wait for playlist items
      try {
        await page.waitForSelector('ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, yt-lockup-view-model', { timeout: 15000 });
      } catch {
        console.log('Warning: Standard playlist selectors not found, attempting general extraction.');
      }

      // Auto-scroll playlist panel to load all items
      console.log('Auto-scrolling playlist to load all videos...');
      let prevCount = 0;
      let unchangedRounds = 0;
      const maxRounds = 1000;

      for (let i = 0; i < maxRounds; i++) {
        const count = await page.evaluate(() => {
          window.scrollTo(0, document.documentElement.scrollHeight);
          const app = document.querySelector('ytd-app');
          if (app) app.scrollTop = app.scrollHeight;
          
          const panels = document.querySelectorAll('ytd-playlist-panel-renderer #contents, ytd-playlist-panel-renderer #items, #playlist-items');
          for (const panel of Array.from(panels)) {
            const p = panel as HTMLElement;
            if (p.offsetParent !== null) {
              p.scrollTop = p.scrollHeight;
            }
          }

          const continuationItem = document.querySelector('ytd-continuation-item-renderer');
          if (continuationItem) {
            continuationItem.scrollIntoView({ block: 'center', behavior: 'smooth' });
            // Wait a moment for it to be actionable
            setTimeout(() => {
              const btn = continuationItem.querySelector('button, a') as HTMLElement;
              if (btn) btn.click();
              else (continuationItem as HTMLElement).click();
            }, 500);
          }

          const items = document.querySelectorAll('ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, yt-lockup-view-model');
          return items.length;
        });

        console.log(`Scroll round ${i + 1}: Found ${count} video elements...`);

        if (count === 0) {
          await new Promise(r => setTimeout(r, 3000));
        } else if (count === prevCount) {
          unchangedRounds++;
          if (unchangedRounds >= 5) {
            console.log('Video count unchanged. Ending scroll loop.');
            break;
          }
        } else {
          unchangedRounds = 0;
        }
        prevCount = count;
        
        await new Promise(r => setTimeout(r, 2000));
      }

      // Extract playlist items
      const items = await page.evaluate(() => {
        const result = [];
        const seenUrls = new Set();
        
        // Target the specific container for playlist videos to avoid 'Related' videos
        const containers = [
          'ytd-playlist-video-list-renderer', // Dedicated playlist page
          'ytd-playlist-panel-renderer',      // Watch page playlist panel
          'ytd-section-list-renderer'         // Fallback
        ];
        
        let root = document as unknown as ParentNode;
        for (const selector of containers) {
          const found = document.querySelector(selector);
          if (found && (found as HTMLElement).offsetParent !== null) {
            root = found;
            break;
          }
        }

        const itemSelectors = [
          'ytd-playlist-video-renderer',
          'ytd-playlist-panel-video-renderer',
          'yt-lockup-view-model',
          'ytd-grid-video-renderer'
        ];
        
        const listItems = root.querySelectorAll(itemSelectors.join(', '));

        for (const item of listItems) {
          // If we found a container but this item is outside of it (e.g. related videos), skip it
          // This is a safety check if root is still document
          if (root === document) {
            const isRelated = item.closest('#related, #items, ytd-watch-next-secondary-results-renderer');
            if (isRelated) continue;
          }

          // Skip if it's a private or deleted video - more robust check
          const textContent = item.textContent || '';
          if (textContent.includes('[Private video]') || textContent.includes('[Deleted video]')) continue;

          // Find the video link - be more generic
          const allLinks = Array.from(item.querySelectorAll('a'));
          const videoLinkEl = allLinks.find(a => {
            const href = a.href || '';
            return href.includes('watch?v=') && !href.includes('googleadservices');
          });

          if (!videoLinkEl) continue;

          try {
            const u = new URL(videoLinkEl.href);
            const v = u.searchParams.get('v');
            if (!v) continue;

            const cleanUrl = `https://www.youtube.com/watch?v=${v}`;
            if (seenUrls.has(cleanUrl)) continue;
            seenUrls.add(cleanUrl);

            // Try to find the title in common places
            const titleSelectors = [
              '#video-title',
              '#video-title-link',
              '.yt-core-attributed-string--link-inherit',
              '.video-title',
              'h3 a',
              'a.yt-simple-endpoint.ytd-playlist-video-renderer'
            ];
            
            let name = '';
            for (const selector of titleSelectors) {
                const el = item.querySelector(selector);
                const text = el?.textContent?.trim();
                // Basic check to skip duration-only strings (e.g., "9:34")
                if (text && !/^\d{1,2}:\d{2}(:\d{2})?$/.test(text) && text.length > 5) {
                    name = text;
                    break;
                }
            }
            
            if (!name) {
                // If still no name, try any link text that isn't a duration
                const links = Array.from(item.querySelectorAll('a'));
                for (const a of links) {
                    const text = a.textContent?.trim();
                    if (text && !/^\d{1,2}:\d{2}(:\d{2})?$/.test(text) && text.length > 5) {
                        name = text;
                        break;
                    }
                }
            }

            result.push({ url: cleanUrl, name: name || 'Unknown Video' });
          } catch { }
        }
        return result;
      });

      videoLinks = items.map(item => ({
        name: item.name,
        url: item.url,
        status: false
      }));

    } else {
      console.log('Scraping single video mode...');
      
      let cleanUrl = url;
      try {
        const u = new URL(url);
        const v = u.searchParams.get('v');
        if (v) {
          cleanUrl = `https://www.youtube.com/watch?v=${v}`;
        } else if (u.hostname === 'youtu.be') {
          cleanUrl = `https://www.youtube.com/watch?v=${u.pathname.slice(1)}`;
        }
      } catch {
        cleanUrl = url.split('&list=')[0].split('?list=')[0];
      }

      // Wait for title
      try {
        await page.waitForSelector('h1.ytd-watch-metadata, yt-formatted-string.ytd-video-primary-info-renderer', { timeout: 15000 });
      } catch { }

      let videoName = '';
      try {
        videoName = await page.evaluate(() => {
          const el = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, yt-formatted-string.ytd-video-primary-info-renderer');
          return el?.textContent?.trim() || '';
        });
      } catch { }

      if (!videoName) {
        const pageTitle = await page.title().catch(() => '');
        videoName = pageTitle.replace(' - YouTube', '').trim();
      }

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

    // Output each video incrementally so the frontend can live-update
    for (const video of videoLinks) {
      console.log(`__VIDEO__:${JSON.stringify(video)}`);
      await new Promise(r => setTimeout(r, 200));
    }

    await fs.ensureDir(path.join(process.cwd(), 'data'));
    await fs.writeJson(filePath, videoLinks, { spaces: 2 });

    console.log(`Successfully scraped ${videoLinks.length} videos in ${type} mode.`);
    console.log(`__FILE__:${fileName}`);

  } catch (error: unknown) {
    console.error('Scraping failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    console.log('Closing browser in 3 seconds...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    await browser.close().catch(() => { });
  }
}

scrape().catch(err => {
  console.error('Fatal Error:', err);
  process.exit(1);
});

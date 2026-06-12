import puppeteer from 'puppeteer';
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

      // Wait for playlist items
      try {
        await page.waitForSelector('ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, yt-lockup-view-model', { timeout: 15000 });
      } catch (e) {
        console.log('Warning: Standard playlist selectors not found, attempting general extraction.');
      }

      // Auto-scroll playlist panel to load all items (YouTube lazy-loads ~100 at a time)
      console.log('Auto-scrolling playlist to load all videos...');
      let prevCount = 0;
      let unchangedRounds = 0;
      const maxRounds = 1000;

      for (let i = 0; i < maxRounds; i++) {
        const count = await page.evaluate(() => {
          // Scroll standard playlist pages which scroll on window/body/app
          window.scrollTo(0, document.documentElement.scrollHeight);
          const app = document.querySelector('ytd-app');
          if (app) app.scrollTop = app.scrollHeight;
          if (document.scrollingElement) {
            document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
          }

          // Also scroll playlist panel if it exists and is visible
          const panels = document.querySelectorAll('ytd-playlist-panel-renderer #contents, ytd-playlist-panel-renderer #items, #playlist-items');
          for (const panel of Array.from(panels)) {
            const p = panel as HTMLElement;
            if (p.offsetParent !== null) {
              p.scrollTop = p.scrollHeight;
            }
          }

          // Click continuation element to trigger YouTube's lazy load
          const continuationItem = document.querySelector('ytd-continuation-item-renderer');
          if (continuationItem) {
            continuationItem.scrollIntoView({ block: 'center' });
            (continuationItem as HTMLElement).click();
          }

          // Count currently rendered playlist items (both classic and modern layout)
          const items = document.querySelectorAll('ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, yt-lockup-view-model');
          return items.length;
        });

        console.log(`Scroll round ${i + 1}: Found ${count} video elements...`);

        if (count === 0) {
          await new Promise(r => setTimeout(r, 3000));
        } else if (count === prevCount) {
          unchangedRounds++;
          if (unchangedRounds >= 10) {
            console.log('Video count unchanged for 10 consecutive rounds. Ending scroll loop.');
            break;
          }
        } else {
          unchangedRounds = 0;
        }
        prevCount = count;
        
        // Wait for network to settle after potential continuation click
        await new Promise(r => setTimeout(r, 3000));
        await page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
      }

      // Extract playlist items only from the playlist container
      const items = await page.evaluate((targetListId) => {
        const container =
          document.querySelector('ytd-playlist-panel-renderer') ||
          document.querySelector('ytd-playlist-video-list-renderer') ||
          document.querySelector('#playlist-items') ||
          document.querySelector('ytd-section-list-renderer');
        if (!container) return [];

        const listItems = container.querySelectorAll('ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, yt-lockup-view-model');
        const result = [];

        for (const item of listItems) {
          // Skip recommended shelves and channels
          if (item.closest('horizontal-shelf-view-model, ytd-shelf-renderer, ytd-reel-shelf-renderer, ytd-rich-shelf-renderer, ytd-watch-next-secondary-results-renderer')) {
            continue;
          }

          // Find all links containing watch?v= within this item
          const links = Array.from(item.querySelectorAll('a'));
          let bestUrl = '';
          let bestName = '';
          let bestScore = -1;

          for (const a of links) {
            const href = a.href;
            if (!href || !href.includes('watch?v=')) continue;
            try {
              const u = new URL(href);
              const linkList = u.searchParams.get('list');
              if (targetListId && linkList && linkList !== targetListId) {
                continue;
              }

              u.searchParams.delete('list');
              u.searchParams.delete('pp');
              u.searchParams.delete('index');
              u.searchParams.delete('si');
              const cleaned = u.toString();

              // Get text content and attributes
              const titleEl = a.querySelector('yt-formatted-string, #video-title, .yt-core-attributed-string');
              const nameCandidate = (titleEl?.textContent || a.textContent || a.title || a.getAttribute('title') || '').replace(/\s+/g, ' ').trim();

              // Compute score inline to avoid ESBuild name helpers reference error
              let score = -1;
              if (nameCandidate) {
                const lower = nameCandidate.toLowerCase();
                if (lower === 'unknown' || lower === 'play all') {
                  score = 0;
                } else if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(nameCandidate)) {
                  score = 1;
                } else if (nameCandidate.length < 3) {
                  score = 2;
                } else {
                  score = 10;
                }
              }

              if (score > bestScore) {
                bestScore = score;
                bestName = nameCandidate;
                bestUrl = cleaned;
              }
            } catch { }
          }

          if (bestUrl) {
            result.push({ url: bestUrl, name: bestName || 'Unknown' });
          }
        }
        return result;
      }, targetListId);

      videoLinks = items.map(item => ({
        name: item.name || 'Unknown',
        url: item.url,
        status: false
      }));

      // Fallback: generic extraction from all links
      if (videoLinks.length === 0) {
        console.log('No playlist items found with specific selectors. Trying fallback...');
        const fallbackItems = await page.evaluate((targetListId) => {
          const links = document.querySelectorAll('a');
          const result = [];

          // Map to track the best name/score for each unique video URL
          const urlMap = new Map();

          for (const el of links) {
            const a = el as HTMLAnchorElement;
            const href = a.href;
            if (!href || !href.includes('watch?v=')) continue;
            // Skip recommended shelves and channels
            if (a.closest('horizontal-shelf-view-model, ytd-shelf-renderer, ytd-reel-shelf-renderer, ytd-rich-shelf-renderer, ytd-watch-next-secondary-results-renderer')) {
              continue;
            }
            try {
              const u = new URL(href);
              const linkList = u.searchParams.get('list');
              if (targetListId && linkList && linkList !== targetListId) {
                continue;
              }

              u.searchParams.delete('list');
              u.searchParams.delete('pp');
              u.searchParams.delete('index');
              u.searchParams.delete('si');
              const cleaned = u.toString();

              const titleEl = a.querySelector('yt-formatted-string, #video-title, .yt-core-attributed-string');
              const nameCandidate = (titleEl?.textContent || a.textContent || a.title || a.getAttribute('title') || '').replace(/\s+/g, ' ').trim();

              // Compute score inline to avoid ESBuild name helpers reference error
              let score = -1;
              if (nameCandidate) {
                const lower = nameCandidate.toLowerCase();
                if (lower === 'unknown' || lower === 'play all') {
                  score = 0;
                } else if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(nameCandidate)) {
                  score = 1;
                } else if (nameCandidate.length < 3) {
                  score = 2;
                } else {
                  score = 10;
                }
              }

              if (!urlMap.has(cleaned) || score > urlMap.get(cleaned).score) {
                urlMap.set(cleaned, { name: nameCandidate, score });
              }
            } catch { }
          }

          // Convert map back to list in order of appearance
          const seen = new Set();
          for (const el of links) {
            const a = el as HTMLAnchorElement;
            const href = a.href;
            if (!href || !href.includes('watch?v=')) continue;
            // Skip recommended shelves and channels
            if (a.closest('horizontal-shelf-view-model, ytd-shelf-renderer, ytd-reel-shelf-renderer, ytd-rich-shelf-renderer, ytd-watch-next-secondary-results-renderer')) {
              continue;
            }
            try {
              const u = new URL(href);
              const linkList = u.searchParams.get('list');
              if (targetListId && linkList && linkList !== targetListId) {
                continue;
              }

              u.searchParams.delete('list');
              u.searchParams.delete('pp');
              u.searchParams.delete('index');
              u.searchParams.delete('si');
              const cleaned = u.toString();

              if (seen.has(cleaned)) continue;
              seen.add(cleaned);

              const entry = urlMap.get(cleaned);
              if (entry) {
                result.push({ url: cleaned, name: entry.name });
              }
            } catch { }
          }

          return result;
        }, targetListId);
        videoLinks = fallbackItems.map(item => ({
          name: item.name || 'Unknown',
          url: item.url,
          status: false
        }));
      }
    } else {
      console.log('Scraping single video mode...');
      const cleanUrl = url.split('&list=')[0].split('&pp=')[0].split('&index=')[0];

      // Wait for title element or player metadata to load to ensure frame stability
      try {
        await page.waitForSelector('h1.ytd-watch-metadata, yt-formatted-string.ytd-video-primary-info-renderer', { timeout: 15000 });
      } catch (e) {
        console.log('Warning: Video title element not found, attempting direct title extraction.');
      }

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

  } catch (error: any) {
    console.error('Scraping failed:', error.message || error);
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

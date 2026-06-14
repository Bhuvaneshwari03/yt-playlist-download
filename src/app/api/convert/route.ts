import { NextRequest, NextResponse } from 'next/server';
import { chromium, type Browser, type Download, type Page } from 'playwright';
import path from 'path';
import fs from 'fs-extra';

export const runtime = 'nodejs';

declare global {
  interface Window {
    __downloadURL?: string;
  }
}

interface VideoItem {
  name: string;
  url: string;
  status?: boolean;
}

interface ConvertResult {
  fileName: string;
  filePath: string;
  bytes: number;
}

interface ConvertRequest {
  videoUrl?: string;
  videoIndex?: number;
  videos?: VideoItem[];
  jsonFilename?: string;
  downloadDir?: string;
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
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

function resolveDownloadDir(downloadDir?: string) {
  const fallback = path.join(process.cwd(), 'temp_downloads');
  if (!downloadDir || !downloadDir.trim()) return fallback;
  const requested = downloadDir.trim();
  return path.isAbsolute(requested)
    ? requested
    : path.join(/* turbopackIgnore: true */ process.cwd(), requested);
}

function sanitizeFileName(fileName: string) {
  return fileName
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'download.mp3';
}

async function uniqueFilePath(directory: string, fileName: string) {
  const parsed = path.parse(sanitizeFileName(fileName));
  const ext = parsed.ext || '.mp3';
  const base = parsed.name || 'download';
  let candidate = path.join(directory, `${base}${ext}`);
  let counter = 1;

  while (await fs.pathExists(candidate)) {
    candidate = path.join(directory, `${base} (${counter})${ext}`);
    counter += 1;
  }

  return candidate;
}

async function savePlaywrightDownload(download: Download, downloadDir: string, fallbackName: string): Promise<ConvertResult> {
  const filePath = await uniqueFilePath(downloadDir, download.suggestedFilename() || fallbackName);
  await fs.ensureDir(downloadDir);
  await download.saveAs(filePath);

  const stat = await fs.stat(filePath);
  if (stat.size < 100) {
    throw new Error(`Downloaded file too small (${stat.size} bytes).`);
  }

  return {
    fileName: path.basename(filePath),
    filePath,
    bytes: stat.size,
  };
}

async function safeClick(page: Page, selector: string | ReturnType<Page['locator']>, options: { timeout?: number; retries?: number } = {}) {
  const { timeout = 10000, retries = 2 } = options;
  const locator = typeof selector === 'string' ? page.locator(selector).first() : selector;

  for (let i = 0; i <= retries; i++) {
    try {
      await locator.waitFor({ state: 'visible', timeout });
      await locator.scrollIntoViewIfNeeded({ timeout });
      await locator.click({ timeout });
      return true;
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return false;
}

async function clickConverterDownload(page: Page) {
  const selectors = [
    '.form__download a',
    '.form__download button',
    'a[href*="download"]',
    'button[class*="download"]',
    'button:has-text("Download")',
    'a:has-text("Download")'
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.isVisible()) {
        const text = (await locator.textContent().catch(() => ''))?.toLowerCase() || '';
        const href = await locator.getAttribute('href').catch(() => null);
        
        // Skip links that are likely ads or not the actual download
        if (href && (href.includes('javascript') || href.startsWith('#'))) continue;

        if (text.includes('download') || href) {
          await safeClick(page, locator);
          return true;
        }
      }
    } catch (e) {
      continue;
    }
  }

  return false;
}

async function markDownloaded(jsonFilename: string | undefined, videoIndex: number) {
  if (!jsonFilename) return;

  const jsonPath = path.join(process.cwd(), 'data', path.basename(jsonFilename));
  if (!(await fs.pathExists(jsonPath))) return;

  const jsonData = JSON.parse(await fs.readFile(jsonPath, 'utf-8'));
  if (jsonData[videoIndex]) {
    jsonData[videoIndex].status = true;
  }
  await fs.writeJson(jsonPath, jsonData, { spaces: 2 });
}

async function prepareConverterPage(page: Page) {
  await page.setExtraHTTPHeaders({
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  });

  await page.addInitScript(() => {
    window.__downloadURL = undefined;
    window.open = () => null;

    const origFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      return origFetch(input, init).then(async (response) => {
        const ct = response.headers.get('content-type') || '';
        if (ct.includes('json')) {
          try {
            const clone = response.clone();
            const data = await clone.json();
            if (typeof data.downloadURL === 'string' && data.downloadURL.length > 0) {
              window.__downloadURL = data.downloadURL;
            }
          } catch {}
        }
        return response;
      });
    };
  });
}

async function convertOne(page: Page, videoUrl: string, videoIndex: number, downloadDir: string): Promise<ConvertResult> {
  // Ensure we have a clean video URL (no list/index params)
  let cleanUrl = videoUrl;
  try {
    const u = new URL(videoUrl);
    const v = u.searchParams.get('v');
    if (v) {
      cleanUrl = `https://www.youtube.com/watch?v=${v}`;
    }
  } catch {}

  const maxRetries = 2;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`Retry attempt ${attempt} for video ${videoIndex + 1}`);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      await page.goto('https://yt2mp3.gs', { waitUntil: 'networkidle', timeout: 60000 });
      await page.evaluate(() => {
        window.__downloadURL = undefined;
      });

      // Clear any potential overlays or dialogs that might block clicks
      await page.evaluate(() => {
        const overlays = document.querySelectorAll('.modal, .overlay, .popup, [class*="modal"], [class*="popup"], #disclaimer, .consent-banner');
        overlays.forEach(el => {
          if ((el as HTMLElement).style) (el as HTMLElement).style.display = 'none';
        });
      });

      const mp3Btn = page.locator('.form__formats button').first();
      try {
        await mp3Btn.waitFor({ state: 'visible', timeout: 5000 });
        const isActive = await mp3Btn.evaluate((el) => el.classList.contains('active'));
        if (!isActive) await safeClick(page, mp3Btn);
      } catch {
        // If MP3 button not found or already active, just continue
      }

      await page.waitForSelector('input#video', { timeout: 20000 });
      await page.click('input#video', { clickCount: 3 });
      await page.keyboard.press('Backspace');
      await page.type('input#video', cleanUrl, { delay: 10 });
      
      const submitBtn = page.locator('button[type="submit"]').first();
      await safeClick(page, submitBtn);

      // Wait for result or error with longer timeout
      const resultOrError = await Promise.race([
        page.waitForSelector('.form__download', { timeout: 300000 }).then(() => 'success'),
        page.waitForSelector('.error, .alert-danger, #error', { timeout: 45000 }).then(() => 'error').catch(() => null),
        page.evaluate(async () => {
          for (let i = 0; i < 45; i++) {
            const text = document.body.innerText.toLowerCase();
            if (text.includes('invalid link') || text.includes('error occurred') || text.includes('not supported') || text.includes('too large')) return 'error';
            await new Promise(r => setTimeout(r, 1000));
          }
          return null;
        })
      ]);

      if (resultOrError === 'error') {
        const errorMsg = await page.evaluate(() => {
          const el = document.querySelector('.error, .alert-danger, #error');
          return el?.textContent?.trim() || 'Invalid link or converter error';
        });
        throw new Error(errorMsg);
      }

      // Wait for the download section to be fully ready
      await page.waitForSelector('.form__download', { state: 'visible', timeout: 300000 });
      await new Promise(resolve => setTimeout(resolve, 2000));

      const browserDownloadPromise = page.waitForEvent('download', { timeout: 45000 }).catch(() => null);
      const clickedDownload = await clickConverterDownload(page);
      
      if (!clickedDownload) {
        // Fallback: try obtaining the URL from the window property
        let downloadUrl: string | null = null;
        for (let j = 0; j < 60; j++) {
          downloadUrl = await page.evaluate(() => window.__downloadURL || null);
          if (downloadUrl) break;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        if (downloadUrl) {
          const fullDownloadUrl = await page.evaluate((baseUrl) => {
            const section = document.querySelector('.form__download');
            const videoId = section?.getAttribute('data-id') || '';
            const fmtBtn = document.querySelector('.form__formats button.active');
            const fmt = fmtBtn?.textContent?.trim().toLowerCase() || 'mp3';
            return `${baseUrl}&v=${videoId}&f=${fmt}&r=${window.location.hostname}`;
          }, downloadUrl);

          const fetchResult = await page.evaluate(async (url) => {
            try {
              const response = await fetch(url, {
                headers: {
                  Accept: 'audio/webm,audio/ogg,audio/wav,audio/*;q=0.9,application/ogg;q=0.7,video/*;q=0.6,*/*;q=0.5',
                  'Accept-Language': 'en-US,en;q=0.9',
                  Range: 'bytes=0-',
                },
                credentials: 'omit',
              });

              if (!response.ok) return { error: `HTTP ${response.status}` };
              
              const contentType = response.headers.get('content-type') || '';
              if (contentType.includes('text/html')) return { error: 'Unexpected HTML response' };

              const buffer = await response.arrayBuffer();
              return {
                data: Array.from(new Uint8Array(buffer)),
                contentDisposition: response.headers.get('content-disposition') || '',
              };
            } catch (err: any) {
              return { error: err.message || 'Fetch failed' };
            }
          }, fullDownloadUrl);

          if (fetchResult.error) throw new Error(fetchResult.error);

          const fileBuffer = Buffer.from(fetchResult.data!);
          const cdMatch = fetchResult.contentDisposition?.match(/filename\*?=(?:UTF-8''|")?([^";]+)"?/i);
          const rawName = cdMatch ? decodeURIComponent(cdMatch[1]) : `video_${videoIndex + 1}.mp3`;
          const filePath = await uniqueFilePath(downloadDir, rawName);
          await fs.ensureDir(downloadDir);
          await fs.writeFile(filePath, fileBuffer);

          return { fileName: path.basename(filePath), filePath, bytes: fileBuffer.length };
        }
        
        throw new Error('Could not obtain download link after successful conversion.');
      }

      const browserDownload = await browserDownloadPromise;
      if (browserDownload) {
        return savePlaywrightDownload(browserDownload, downloadDir, `video_${videoIndex + 1}.mp3`);
      }

      throw new Error('Conversion finished but download did not start.');

    } catch (error: any) {
      lastError = error;
      console.error(`Attempt ${attempt + 1} failed for video ${videoIndex + 1}:`, error.message);
      if (attempt === maxRetries) throw error;
    }
  }

  throw lastError || new Error('Unknown error');
}

function streamEvent(controller: ReadableStreamDefaultController<Uint8Array>, payload: unknown) {
  controller.enqueue(new TextEncoder().encode(`${JSON.stringify(payload)}\n`));
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ConvertRequest;
    const videos: VideoItem[] = Array.isArray(body.videos)
      ? body.videos
      : body.videoUrl
        ? [{ name: `Video ${Number(body.videoIndex || 0) + 1}`, url: body.videoUrl }]
        : [];

    if (videos.length === 0) {
      return NextResponse.json({ error: 'At least one video URL is required' }, { status: 400 });
    }

    const executablePath = await getChromePath();
    if (!executablePath) {
      return NextResponse.json({ error: 'Chrome not found. Please install Google Chrome.' }, { status: 500 });
    }

    const downloadDir = resolveDownloadDir(body.downloadDir);

    if (!Array.isArray(body.videos)) {
      const browser = await chromium.launch({
        executablePath,
        headless: false,
        args: ['--start-maximized'],
      });

      try {
        const context = await browser.newContext({
          viewport: null,
          acceptDownloads: true,
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        });
        const page = await context.newPage();
        await prepareConverterPage(page);
        const result = await convertOne(page, videos[0].url, Number(body.videoIndex || 0), downloadDir);
        await markDownloaded(body.jsonFilename, Number(body.videoIndex || 0));
        return NextResponse.json({ ...result, index: Number(body.videoIndex || 0) });
      } finally {
        await browser.close().catch(() => {});
      }
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let browser: Browser | undefined;
        try {
          await fs.ensureDir(downloadDir);
          streamEvent(controller, { type: 'start', total: videos.length, downloadDir });

          browser = await chromium.launch({
            executablePath,
            headless: false,
            args: ['--start-maximized'],
          });

          const context = await browser.newContext({
            viewport: null,
            acceptDownloads: true,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          });
          const page = await context.newPage();
          await prepareConverterPage(page);

          for (let i = 0; i < videos.length; i += 1) {
            if (videos[i].status) {
              streamEvent(controller, { type: 'skip', index: i });
              continue;
            }

            // Small cooldown between videos to prevent browser lag
            if (i > 0) {
              await new Promise(r => setTimeout(r, 2000));
            }

            streamEvent(controller, { type: 'progress', index: i, status: 'converting', name: videos[i].name });

            try {
              const result = await convertOne(page, videos[i].url, i, downloadDir);
              await markDownloaded(body.jsonFilename, i);
              streamEvent(controller, { type: 'saved', index: i, ...result });
            } catch (error: unknown) {
              streamEvent(controller, {
                type: 'error',
                index: i,
                error: getErrorMessage(error, `Video ${i + 1} failed`),
              });
            }
          }

          streamEvent(controller, { type: 'done', downloadDir });
        } catch (error: unknown) {
          streamEvent(controller, { type: 'fatal', error: getErrorMessage(error, 'Conversion failed') });
        } finally {
          await browser?.close().catch(() => {});
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error: unknown) {
    console.error('Conversion error:', error);
    return NextResponse.json({ error: getErrorMessage(error, 'Conversion failed') }, { status: 500 });
  }
}

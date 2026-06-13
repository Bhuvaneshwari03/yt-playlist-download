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

async function clickConverterDownload(page: Page) {
  const candidates = page.locator('.form__download a, .form__download button, a[href*="download"], button[class*="download"]');
  const count = await candidates.count();

  for (let i = 0; i < count; i += 1) {
    const candidate = candidates.nth(i);
    if (!(await candidate.isVisible().catch(() => false))) continue;

    const text = (await candidate.textContent().catch(() => ''))?.toLowerCase() || '';
    const href = await candidate.getAttribute('href').catch(() => null);
    if (text.includes('download') || href) {
      await candidate.click();
      return true;
    }
  }

  const firstVisible = page.locator('.form__download a:visible, .form__download button:visible').first();
  if (await firstVisible.isVisible().catch(() => false)) {
    await firstVisible.click();
    return true;
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
  await page.goto('https://yt2mp3.gs', { waitUntil: 'networkidle', timeout: 45000 });
  await page.evaluate(() => {
    window.__downloadURL = undefined;
  });

  const mp3Btn = await page.$('.form__formats button:first-child');
  if (mp3Btn) {
    const isActive = await page.evaluate((el) => el.classList.contains('active'), mp3Btn);
    if (!isActive) await mp3Btn.click();
  }

  await page.waitForSelector('input#video', { timeout: 15000 });
  await page.click('input#video', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type('input#video', videoUrl, { delay: 15 });
  await page.click('button[type="submit"]');
  await page.waitForSelector('.form__download', { timeout: 300000 });

  const browserDownloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
  const clickedDownload = await clickConverterDownload(page);
  if (!clickedDownload) {
    throw new Error('Converter download button was not found.');
  }

  const browserDownload = await browserDownloadPromise;
  if (browserDownload) {
    return savePlaywrightDownload(browserDownload, downloadDir, `video_${videoIndex + 1}.mp3`);
  }

  let downloadUrl: string | null = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    downloadUrl = await page.evaluate(() => window.__downloadURL || null);
    if (downloadUrl) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!downloadUrl) {
    throw new Error('Could not obtain download URL from converter.');
  }

  const fullDownloadUrl = await page.evaluate((baseUrl) => {
    const section = document.querySelector('.form__download');
    const videoId = section?.getAttribute('data-id') || '';
    const fmtBtn = document.querySelector('.form__formats button.active');
    const fmt = fmtBtn?.textContent?.trim().toLowerCase() || 'mp3';
    return `${baseUrl}&v=${videoId}&f=${fmt}&r=${window.location.hostname}`;
  }, downloadUrl);

  const result = await page.evaluate(async (url) => {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'audio/webm,audio/ogg,audio/wav,audio/*;q=0.9,application/ogg;q=0.7,video/*;q=0.6,*/*;q=0.5',
          'Accept-Language': 'en-US,en;q=0.9',
          Range: 'bytes=0-',
        },
        credentials: 'omit',
      });

      if (!response.ok) {
        return { error: `HTTP ${response.status}` };
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/html') || contentType.includes('text/plain')) {
        const text = await response.text();
        return { error: `Unexpected response: ${text.slice(0, 200)}` };
      }

      const contentDisposition = response.headers.get('content-disposition') || '';
      const buffer = await response.arrayBuffer();
      return {
        data: Array.from(new Uint8Array(buffer)),
        contentDisposition,
      };
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : 'Fetch failed' };
    }
  }, fullDownloadUrl);

  if (result.error) {
    throw new Error(result.error);
  }

  const fileBuffer = Buffer.from(result.data!);
  if (fileBuffer.length < 100) {
    throw new Error(`Downloaded file too small (${fileBuffer.length} bytes).`);
  }

  const cdMatch = result.contentDisposition?.match(/filename\*?=(?:UTF-8''|")?([^";]+)"?/i);
  const rawName = cdMatch ? decodeURIComponent(cdMatch[1]) : `video_${videoIndex + 1}.mp3`;
  const filePath = await uniqueFilePath(downloadDir, rawName);

  await fs.ensureDir(downloadDir);
  await fs.writeFile(filePath, fileBuffer);

  return {
    fileName: path.basename(filePath),
    filePath,
    bytes: fileBuffer.length,
  };
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

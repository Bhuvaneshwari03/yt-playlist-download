import { NextRequest, NextResponse } from 'next/server';
import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs-extra';

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

export async function POST(req: NextRequest) {
  try {
    const { videoUrl, jsonFilename, videoIndex } = await req.json();

    if (!videoUrl) {
      return NextResponse.json({ error: 'Video URL is required' }, { status: 400 });
    }

    const executablePath = await getChromePath();
    if (!executablePath) {
      return NextResponse.json({ error: 'Chrome not found. Please install Google Chrome.' }, { status: 500 });
    }

    console.log('Launching browser...');
    const browser = await puppeteer.launch({
      executablePath,
      headless: false,
      defaultViewport: null,
      args: ['--start-maximized'],
    });

    const [page] = await browser.pages();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    // Inject hooks before page scripts run
    await page.evaluateOnNewDocument(() => {
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

    console.log('Navigating to yt2mp3.gs...');
    await page.goto('https://yt2mp3.gs', { waitUntil: 'networkidle0', timeout: 30000 });

    console.log('Ensuring MP3 format...');
    const mp3Btn = await page.$('.form__formats button:first-child');
    if (mp3Btn) {
      const isActive = await page.evaluate(el => el.classList.contains('active'), mp3Btn);
      if (!isActive) await mp3Btn.click();
    }

    await page.waitForSelector('input#video', { timeout: 10000 });
    await page.type('input#video', videoUrl, { delay: 50 });

    console.log('Clicking Convert...');
    await page.click('button[type="submit"]');

    console.log('Waiting for .form__download...');
    await page.waitForSelector('.form__download', { timeout: 300000 });
    await new Promise(r => setTimeout(r, 2000));

    // Retrieve captured download URL
    console.log('Checking for captured download URL...');
    let downloadUrl: string | null = null;

    for (let attempt = 0; attempt < 30; attempt++) {
      downloadUrl = await page.evaluate(() => window['__downloadURL'] || null);
      if (downloadUrl) {
        console.log('Got download URL from fetch hook on attempt', attempt + 1, ':', downloadUrl);
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    if (!downloadUrl) {
      throw new Error('Could not obtain download URL (fetch hook failed)');
    }

    // Construct the full download URL with all params (same as yt2mp3.gs click handler)
    const fullDownloadUrl = await page.evaluate((baseUrl) => {
      const section = document.querySelector('.form__download');
      const videoId = section?.getAttribute('data-id') || '';
      const fmtBtn = document.querySelector('.form__formats button.active');
      const fmt = fmtBtn?.textContent?.trim().toLowerCase() || 'mp3';
      return baseUrl + '&v=' + videoId + '&f=' + fmt + '&r=' + window.location.hostname;
    }, downloadUrl);

    console.log('Full download URL:', fullDownloadUrl);

    // Download through the browser's own fetch (passes TLS, cookies, headers, fingerprint)
    console.log('Downloading via browser fetch...');
    const result = await page.evaluate(async (url) => {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          return { error: 'HTTP ' + response.status };
        }
        const ct = response.headers.get('content-type') || '';
        if (ct.includes('text/html') || ct.includes('text/plain')) {
          const text = await response.text();
          return { error: 'HTML response: ' + text.slice(0, 200) };
        }
        const cd = response.headers.get('content-disposition') || '';
        const buffer = await response.arrayBuffer();
        const bytes = Array.from(new Uint8Array(buffer));
        return { data: bytes, contentType: ct, contentDisposition: cd };
      } catch (err: any) {
        return { error: err.message || 'Fetch failed' };
      }
    }, fullDownloadUrl);

    if (result.error) {
      throw new Error(result.error);
    }

    const fileBuffer = Buffer.from(result.data!);
    const respContentType = result.contentType || 'audio/mpeg';
    const respContentDisposition = result.contentDisposition || '';

    console.log('Downloaded via browser:', fileBuffer.length, 'bytes, type:', respContentType);

    if (fileBuffer.length < 100) {
      throw new Error('Downloaded file too small (' + fileBuffer.length + ' bytes)');
    }

    if (fileBuffer.length > 2) {
      const magic = fileBuffer.slice(0, 3).toString('hex');
      const isValid = magic.startsWith('494433') || magic.startsWith('fff');
      console.log('Magic bytes:', magic, 'Valid MP3:', isValid);
    }

    // Extract filename from Content-Disposition
    const cdMatch = respContentDisposition.match(/filename="?(.+?)"?$/);
    const fileName = cdMatch ? cdMatch[1] : `video_${videoIndex + 1}.mp3`;

    const isAudioVideo = respContentType.startsWith('audio/') || respContentType.startsWith('video/');
    const contentType = isAudioVideo ? respContentType : 'audio/mpeg';

    if (jsonFilename) {
      const jsonPath = path.join(process.cwd(), 'data', jsonFilename);
      if (await fs.pathExists(jsonPath)) {
        const jsonData = JSON.parse(await fs.readFile(jsonPath, 'utf-8'));
        if (jsonData[videoIndex]) {
          jsonData[videoIndex].status = true;
        }
        await fs.writeJson(jsonPath, jsonData, { spaces: 2 });
      }
    }

    await browser.close();

    return new NextResponse(fileBuffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'X-Updated-Index': String(videoIndex),
      },
    });
  } catch (error: any) {
    console.error('Conversion error:', error);
    return NextResponse.json({ error: error.message || 'Conversion failed' }, { status: 500 });
  }
}
